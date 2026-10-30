// Wiley 批量下载（Example University WebVPN + /doi/pdfdirect）
//
//   node scripts/wiley.mjs login      # 有头窗口登录 WebVPN，导出会话 cookie
//   node scripts/wiley.mjs check      # 只跑 1 篇，验证链路
//   node scripts/wiley.mjs download   # 离屏浏览器批量下载
//   node scripts/wiley.mjs close      # 关闭本项目浏览器实例
//   登录验证码选项：--captcha auto|manual --captcha-profile human --captcha-max 2
//
// 限速：默认每篇间隔 10s；滚动请求闸门可通过 --per-10min 设置，
//       设为 0 可禁用（仍保留每篇间隔）。
// 403：仅对非 paywall 的 HTTP 403 清理 profile/cookie 并自动重登；
//      默认最多重登 2 次，可用 --auto-relogin-max 调整。
//
// 退出码：0 正常；10 = WebVPN 会话失效，需要重新 login
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, MANIFESTS, SCRATCH, sleep, ts, stamp, parseArgs, opt, num, logLine, isValidPdf, isPdfBuf,
  wvUrl, launchBrowser, connect, closeOurBrowsers, closeProfiles,
  injectCookies, loadCookieFile, requireList, resolveDownloadPath,
} from './lib.mjs';
import {
  MOTION_PROFILES, createCasLoginController, readCredentials, captchaOptionsFromArgs,
} from './webvpn-auth.mjs';

const args = parseArgs();
const cmd = args._[0] || 'download';

const DEFAULT_LIST = path.join(MANIFESTS, 'wiley_papers.json');
const DEFAULT_OUT = 'downloads_wiley';
const COOKIE_FILE = path.join(SCRATCH, 'wiley_cookies.json');
const LOG = path.resolve(opt(args, 'log', path.join(SCRATCH, 'wiley_log.jsonl')));
const FAIL_DIR = path.join(SCRATCH, 'wiley_fail');
const PROFILE = path.join(ROOT, opt(args, 'profile', '.browser_profile_wiley'));
const LOGIN_PROFILE = path.join(ROOT, opt(args, 'login-profile', '.browser_profile_wiley_login'));
const LOGIN_PORT = num(args, 'login-port', 9230);
const DL_PORT = num(args, 'port', 9231);

const HOST = 'onlinelibrary.wiley.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0';
// 注意：不要用 wengine-vpn 之类"WebVPN 注入标记"判断网关错误——
// WebVPN 会给每个转发回来的 HTML 页面注入脚本，任何被拒的页面都会被误判成 502。
const WV_ERR = /502 Bad Gateway|504 Gateway Time-out|WebVPN.*(错误|失败)/i;
// Wiley 的付费墙文案：出现这些说明机构没有该刊订阅，重试无意义
const PAYWALL = /Get access to the full version|View access options|Purchase Instant Access|48-Hour online access|Add to Cart/i;
const CAS_MATCH = /auth4\.webvpn\.edu\.cn|icas\.webvpn\.edu\.cn|cas_auth|casLogin|统一身份认证/i;
const NET_ERR = /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_TIMED_OUT|ERR_NETWORK|ERR_EMPTY_RESPONSE|ERR_INTERNET_DISCONNECTED|ERR_ADDRESS_UNREACHABLE|ERR_PROXY|ERR_SOCKET_NOT_CONNECTED|ERR_ABORTED/i;

const bodyText = p => p.evaluate(() => (document.body ? document.body.innerText.slice(0, 3000) : '')).catch(() => '');
const doiOf = it => (String(it.url || '').match(/10\.\d{4,9}\/\S+/) || [])[0] || '';

async function bailForRelogin(reason) {
  try { await closeProfiles([PROFILE, LOGIN_PROFILE], { quiet: true }); } catch {}
  console.log('\n============================================================');
  console.log(` WebVPN 会话失效（${reason}）—— 需要重新登录。`);
  console.log('  运行:  node scripts/wiley.mjs login');
  console.log('============================================================');
  process.exit(10);
}

async function wipeWileySession(reason) {
  console.log(ts(), `清理 Wiley profile 和 cookie（${reason}）…`);
  const profiles = [...new Set([PROFILE, LOGIN_PROFILE])];
  try { await closeProfiles(profiles, { quiet: true }); } catch {}
  const boundary = path.resolve(ROOT) + path.sep;
  for (const profile of profiles) {
    const resolved = path.resolve(profile);
    if (!resolved.startsWith(boundary) || !path.basename(resolved).startsWith('.browser_profile_')) {
      throw new Error(`拒绝清理不安全的 profile 路径: ${resolved}`);
    }
    if (fs.existsSync(resolved)) {
      fs.rmSync(resolved, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 500,
      });
      console.log('  已删除 profile:', path.basename(resolved));
    }
  }
  fs.mkdirSync(path.dirname(COOKIE_FILE), { recursive: true });
  fs.writeFileSync(COOKIE_FILE, '[]');
  console.log('  已清空 cookie 文件:', path.basename(COOKIE_FILE));
}

async function sessionState(page) {
  const url = page.url();
  if (CAS_MATCH.test(url)) return 'login';
  const t = await bodyText(page);
  if (CAS_MATCH.test(t.slice(0, 300))) return 'login';
  if (WV_ERR.test(t)) return 'gateway';
  return 'ok';
}

// ============ login ============
async function doLogin() {
  const captchaMode = String(opt(args, 'captcha', 'auto')).toLowerCase();
  const captchaProfile = String(opt(args, 'captcha-profile', 'human'));
  const captchaMaxAttempts = Math.max(1, Math.min(2, num(args, 'captcha-max', 2) || 2));
  if (!['auto', 'manual'].includes(captchaMode)) {
    console.log('--captcha 只能是 auto 或 manual');
    process.exit(2);
  }
  if (!MOTION_PROFILES.includes(captchaProfile)) {
    console.log(`未知 --captcha-profile: ${captchaProfile}`);
    process.exit(2);
  }

  const credentials = await readCredentials({
    prompt: !args['no-prompt'],
    noPrompt: !!args['no-prompt'],
  });

  console.log('============================================================');
  console.log(' 登录 WebVPN（会弹出有头窗口）');
  console.log(' 登录成功后自动导出会话 cookie，并关闭该窗口');
  console.log(` 验证码 ${captchaMode}｜轨迹 ${captchaProfile}｜最多 ${captchaMaxAttempts} 次`);
  if (!credentials.username || !credentials.password) {
    console.log(' 未完整提供账号密码；验证码通过后缺失项需在浏览器中手动填写');
  }
  console.log('============================================================');

  await closeProfiles([PROFILE, LOGIN_PROFILE], { quiet: true });
  await launchBrowser({ profile: LOGIN_PROFILE, port: LOGIN_PORT, offscreen: false, label: 'wiley-login' });
  const { ctx, page } = await connect(LOGIN_PORT);
  const auth = createCasLoginController(page, {
    credentials,
    captchaMode,
    captchaProfile,
    captchaMaxAttempts,
    ...captchaOptionsFromArgs(args),
    browserAutofill: !args['no-browser-autofill'],
    label: 'wiley-webvpn-login',
    logger: console.log,
  });

  const deadline = Date.now() + 25 * 60 * 1000;
  let saved = false;
  let last = 0;
  let firstNav = true;
  let lastNavAt = 0;
  let gatewayRetries = 0;

  async function navigateLoginTarget() {
    lastNavAt = Date.now();
    return page.goto(wvUrl(HOST, '/'), {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    }).catch(() => null);
  }

  while (Date.now() < deadline) {
    // CAS 登录完成前不重复导航，避免刷新滑块或清空登录表单。
    if (firstNav) {
      firstNav = false;
      await navigateLoginTarget();
    }

    const authResult = await auth.poll();
    const authState = authResult.state;
    if (authState?.gateway && Date.now() - lastNavAt > 15000 && gatewayRetries < 6) {
      gatewayRetries++;
      console.log(ts(), `WebVPN 网关 502/504，重试 ${gatewayRetries}/6…`);
      await navigateLoginTarget();
    }

    const st = await sessionState(page);
    if (st === 'ok') {
      const all = await ctx.cookies();
      fs.writeFileSync(COOKIE_FILE, JSON.stringify(all, null, 1));
      const webvpn = all.filter(c => /webvpn\.edu\.cn|webvpn/.test(c.domain || ''));
      console.log(`会话已保存：cookie ${all.length} 个（WebVPN 相关 ${webvpn.length}）→ ${COOKIE_FILE}`);
      saved = true;
      break;
    }

    if (Date.now() - last > 60000) {
      last = Date.now();
      console.log(ts(), st === 'gateway'
        ? 'WebVPN 网关 502/504，重试…'
        : authState?.captchaVisible ? '验证码处理中…' : '等待登录…');
    }
    await sleep(3000);
  }

  await closeProfiles([LOGIN_PROFILE], { quiet: true });
  if (!saved) { console.log('未在时限内登录成功，会话未保存'); process.exit(3); }
  console.log('登录窗口已关闭，可以开始下载了。');
}
// ============ download ============
async function doDownload() {
  const LIST = path.resolve(opt(args, 'list', DEFAULT_LIST));
  const OUT = resolveDownloadPath(opt(args, 'outdir', DEFAULT_OUT));
  const DELAY = num(args, 'delay', 10000);         // 每篇基础间隔（毫秒）
  const WINDOW_MAX = Math.max(0, num(args, 'per-10min', 60)); // 0 = 禁用
  const visible = !!args.visible;
  const MAX = num(args, 'max', 0);
  const ONLY = String(opt(args, 'only', '')).split(',').map(s => s.trim()).filter(Boolean);
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(FAIL_DIR, { recursive: true });

  if (!requireList(LIST, { hint: 'Wiley 清单需要含 url 字段（doi.org 链接），例如 data\\manifests\\wiley_papers.json' })) process.exit(2);
  const allItems = JSON.parse(fs.readFileSync(LIST, 'utf8'));
  const items = allItems.filter(it => doiOf(it) && (!ONLY.length || ONLY.includes(it.id)));
  const done = new Set(fs.readdirSync(OUT).filter(f => f.endsWith('.pdf') && isValidPdf(path.join(OUT, f))).map(f => f.slice(0, -4)));
  const todo = items.filter(it => !done.has(it.id)).slice(0, MAX || undefined);
  const eta = Math.round(todo.length * (DELAY + 2500) / 60000);

  console.log('================================================================');
  console.log(' Wiley 批量下载（Example University WebVPN → /doi/pdfdirect）');
  console.log(`  清单 ${path.basename(LIST)} → 输出 ${OUT}`);
  console.log(`  共 ${items.length} 篇，已完成 ${done.size} 篇，本次 ${todo.length} 篇`);
  const windowText = WINDOW_MAX ? `滚动 10 分钟 ≤ ${WINDOW_MAX} 次` : '滚动请求闸门已禁用';
  console.log(`  限速 ${DELAY / 1000}s/篇 且 ${windowText}｜预估 ${eta} 分钟`);
  console.log('  校园网断线会自动等待；会话过期会退出并以退出码 10 触发登录窗口');
  console.log('================================================================');
  if (!todo.length) { console.log('没有需要下载的条目。'); return; }

  let ctx;
  let page;
  async function openDownloadBrowser() {
    // 只关自己的浏览器实例。用 closeOurBrowsers 会把 SciDir 那边正在跑的
    // 浏览器一起杀掉，直接打断另一个批次的下载（两个批次可能并行）。
    await closeProfiles([PROFILE], { quiet: true });
    await launchBrowser({
      profile: PROFILE,
      port: DL_PORT,
      offscreen: !visible,
      newWindow: visible,
      label: visible ? 'wiley-visible' : 'wiley',
    });
    ({ ctx, page } = await connect(DL_PORT));
    ctx.setDefaultTimeout(60000);

    const cookies = loadCookieFile(COOKIE_FILE);
    if (cookies.length) {
      const n = await injectCookies(ctx, cookies);
      console.log(ts(), `已注入会话 cookie ${n} 个`);
    } else {
      console.log(ts(), `未找到 ${COOKIE_FILE}（建议先运行 login）`);
    }

    // 预热：先落地到 Wiley 首页，再开始抓取
    await page.goto(wvUrl(HOST, '/'), { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
    await sleep(3000);
    const warm = await sessionState(page);
    if (warm === 'login') await bailForRelogin('首页被重定向到统一身份认证');
    if (warm === 'gateway') {
      console.log(ts(), 'WebVPN 网关 502，等待 15s 重试…');
      await sleep(15000);
      await page.goto(wvUrl(HOST, '/'), { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
      await sleep(3000);
      if ((await sessionState(page)) !== 'ok') await bailForRelogin('WebVPN 网关持续 502');
    }
  }

  await openDownloadBrowser();
  console.log(ts(), '会话就绪，开始下载');

  // ---- 滚动 10 分钟限速闸门 ----
  const WINDOW_MS = 10 * 60 * 1000;
  const stamps = [];
  async function rateGate() {
    if (!WINDOW_MAX) return;
    for (;;) {
      const now = Date.now();
      while (stamps.length && now - stamps[0] > WINDOW_MS) stamps.shift();
      if (stamps.length < WINDOW_MAX) { stamps.push(Date.now()); return; }
      const wait = WINDOW_MS - (now - stamps[0]) + 500;
      console.log(ts(), `滚动 10 分钟已 ${stamps.length} 次请求，等 ${Math.round(wait / 1000)}s…`);
      await sleep(wait);
    }
  }

  function classify(buf) {
    const txt = buf.slice(0, 4000).toString('utf8');
    if (CAS_MATCH.test(txt)) return 'login';
    if (WV_ERR.test(txt)) return 'gateway';
    // 付费墙文案常在正文中后段，这里扫全文（HTML 通常几百 KB）
    if (PAYWALL.test(buf.toString('utf8'))) return 'paywall';
    return 'no_access';
  }

  // 首选 context.request（二进制直传，不经 base64）；失败再退回页面内 fetch
  async function fetchPdf(doi) {
    const url = wvUrl(HOST, `/doi/pdfdirect/${doi}?download=true`);
    try {
      const r = await ctx.request.get(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'application/pdf,text/html;q=0.9,*/*;q=0.8',
          Referer: wvUrl(HOST, `/doi/${doi}`),
        },
        timeout: 180000,
        maxRedirects: 8,
      });
      const buf = Buffer.from(await r.body());
      if (isPdfBuf(buf)) return { ok: true, buf, via: 'request' };
      const kind = classify(buf);
      if (kind !== 'no_access') return { kind, via: 'request', status: r.status() };
      // 再试一次页面内 fetch（有些响应 ctx.request 拿不到、浏览器能拿到）
      const alt = await fetchInPage(url);
      if (alt?.buf) return { ok: true, buf: alt.buf, via: 'page' };
      return { kind, via: 'request', status: r.status(), len: buf.length };
    } catch (e) {
      const msg = String(e.message || e);
      if (NET_ERR.test(msg)) return { kind: 'net', err: msg.slice(0, 60) };
      return { kind: 'err', err: msg.slice(0, 60) };
    }
  }

  async function fetchInPage(url) {
    return await page.evaluate(async ([u, ms]) => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), ms);
        const r = await fetch(u, { credentials: 'include', signal: ctrl.signal });
        clearTimeout(t);
        const buf = new Uint8Array(await r.arrayBuffer());
        const magic = String.fromCharCode.apply(null, buf.slice(0, 5));
        if (magic !== '%PDF-') return { status: r.status, len: buf.length };
        let s = '';
        const chunk = 32768;
        for (let i = 0; i < buf.length; i += chunk) s += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
        return { status: r.status, len: buf.length, b64: btoa(s) };
      } catch (e) { return { err: String(e).slice(0, 120) }; }
    }, [url, 180000]).catch(e => ({ err: String(e.message || e).slice(0, 120) }))
      .then(r => (r && r.b64 ? { buf: Buffer.from(r.b64, 'base64') } : r));
  }

  async function dumpFail(id, tag) {
    try {
      await page.screenshot({ path: path.join(FAIL_DIR, `${id}_${tag}.png`) }).catch(() => {});
      fs.writeFileSync(path.join(FAIL_DIR, `${id}_${tag}.txt`), `URL: ${page.url()}\n\n${(await bodyText(page)).slice(0, 1200)}`);
    } catch {}
  }

  const summary = {};
  let idx = 0;
  let gatewayStreak = 0;
  let autoReloginCount = 0;
  let fatalBlocked403 = false;
  const MAX_AUTO_RELOGIN = Math.max(0, num(args, 'auto-relogin-max', 2));

  for (const it of todo) {
    idx++;
    const doi = doiOf(it);
    const t0 = Date.now();
    let result = { status: 'error', note: '' };

    await rateGate();
    try {
      let attempt = 0;
      for (;;) {
        attempt++;
        const res = await fetchPdf(doi);
        if (res.ok) {
          const file = path.join(OUT, `${it.id}.pdf`);
          fs.writeFileSync(file + '.part', res.buf);
          fs.renameSync(file + '.part', file);
          result = { status: 'ok', note: `${res.buf.length}b via ${res.via}` };
          break;
        }
        if (res.kind === 'login') { await dumpFail(it.id, 'login'); await bailForRelogin(`下载 ${doi} 时被重定向到统一身份认证`); }
        if (res.kind === 'no_access' && Number(res.status) === 403) {
          await dumpFail(it.id, 'blocked_403');
          logLine(LOG, {
            ts: stamp(), id: it.id, doi, status: 'relogin_403',
            note: `HTTP 403 风控页 len=${res.len || 0}`, secs: 0,
          });
          if (autoReloginCount >= MAX_AUTO_RELOGIN) {
            result = {
              status: 'blocked_403',
              note: `连续 403，已自动重登 ${autoReloginCount} 次，停止批次`,
            };
            fatalBlocked403 = true;
            break;
          }
          autoReloginCount++;
          console.log(ts(), `[${it.id}] HTTP 403 → 清理 profile 并重新登录 WebVPN（${autoReloginCount}/${MAX_AUTO_RELOGIN}）`);
          try {
            await wipeWileySession(`HTTP 403（${doi}）`);
            await doLogin();
            await openDownloadBrowser();
            gatewayStreak = 0;
            attempt = 0;
            continue;
          } catch (e) {
            result = { status: 'blocked_403', note: `自动重登失败: ${String(e.message || e).slice(0, 100)}` };
            fatalBlocked403 = true;
            break;
          }
        }
        if (res.kind === 'gateway' || res.kind === 'net' || res.kind === 'err') {
          gatewayStreak++;
          if (gatewayStreak >= 5) { await dumpFail(it.id, 'gateway'); await bailForRelogin(`连续 ${gatewayStreak} 次网关/网络异常`); }
          if (attempt >= 3) { result = { status: 'net_error', note: res.err || res.kind }; break; }
          console.log(`  [${it.id}] ${res.kind}，${10 * attempt}s 后重试 ${attempt}/3`);
          await sleep(10000 * attempt);
          continue;
        }
        // paywall：机构没订这本刊，重试无意义；no_access：其他无法识别的拒绝
        await dumpFail(it.id, res.kind === 'paywall' ? 'paywall' : 'no_access');
        result = { status: res.kind, note: `status=${res.status || '?'} len=${res.len || 0}` };
        break;
      }
    } catch (e) {
      result = { status: 'error', note: String(e.message || e).slice(0, 120) };
    }

    if (result.status !== 'ok') gatewayStreak = 0; else gatewayStreak = 0;
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    summary[result.status] = (summary[result.status] || 0) + 1;
    console.log(`${ts()} [${idx}/${todo.length}] id=${it.id} ${result.status} (${secs}s) ${result.note || ''}  ${doi}`);
    logLine(LOG, { ts: stamp(), id: it.id, doi, status: result.status, note: result.note, secs: +secs });

    if (fatalBlocked403) {
      console.log(ts(), '自动重登后仍持续 403，停止批次。');
      await closeProfiles([PROFILE, LOGIN_PROFILE], { quiet: true });
      process.exitCode = 3;
      break;
    }

    // 间隔抖动 ±25%，避免机械节奏
    const jitter = DELAY * (0.75 + Math.random() * 0.5);
    await sleep(jitter);
  }

  console.log('SUMMARY', JSON.stringify(summary));
  console.log(`失败样本已存到 ${FAIL_DIR}`);
  console.log('浏览器保持打开（下次运行会复用）。');
}

// ============ check ============
async function doCheck() {
  const LIST = path.resolve(opt(args, 'list', DEFAULT_LIST));
  const allItems = JSON.parse(fs.readFileSync(LIST, 'utf8'));
  const only = String(opt(args, 'only', '')).split(',').map(s => s.trim()).filter(Boolean);
  const selected = only.length
    ? allItems.filter(item => only.includes(item.id))
    : args._[1]
      ? allItems.filter(item => item.id === args._[1])
      : allItems.slice(0, 1);
  if (!selected.length) { console.log('清单里找不到该 id'); process.exit(2); }

  const visible = !!args.visible;
  console.log(`验证 ${selected.length} 篇：${selected.map(item => item.id).join(', ')}`);
  await closeProfiles([PROFILE], { quiet: true });
  await launchBrowser({
    profile: PROFILE,
    port: DL_PORT,
    offscreen: !visible,
    newWindow: visible,
    label: visible ? 'wiley-check-visible' : 'wiley-check',
  });
  const { ctx, page } = await connect(DL_PORT);
  const cookies = loadCookieFile(COOKIE_FILE);
  if (cookies.length) await injectCookies(ctx, cookies);
  await page.goto(wvUrl(HOST, '/'), { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
  await sleep(2500);
  console.log('会话状态:', await sessionState(page));

  for (const item of selected) {
    const doi = doiOf(item);
    const url = wvUrl(HOST, `/doi/pdfdirect/${doi}?download=true`);
    const result = { id: item.id, doi, pdfStatus: null, contentType: '', length: 0, paywall: false, login: false };
    console.log(`验证：id=${item.id} doi=${doi}`);
    try {
      const r = await ctx.request.get(url, {
        headers: { 'User-Agent': UA, Accept: 'application/pdf,*/*' },
        timeout: 180000,
      });
      const buf = Buffer.from(await r.body());
      const magic = buf.slice(0, 5).toString('latin1');
      const html = buf.toString('utf8');
      Object.assign(result, {
        pdfStatus: r.status(),
        contentType: r.headers()['content-type'] || '',
        length: buf.length,
        isPdf: magic === '%PDF-',
        paywall: PAYWALL.test(html),
        login: CAS_MATCH.test(html),
      });
      console.log(`ctx.request -> status=${result.pdfStatus} ct=${result.contentType} len=${result.length} magic=${magic}`);

      if (!result.isPdf) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
        await sleep(2000);
        const text = (await bodyText(page)).replace(/\s+/g, ' ').slice(0, 500);
        result.finalUrl = page.url();
        result.pageText = text;
        result.paywall ||= PAYWALL.test(text);
        result.login ||= CAS_MATCH.test(page.url()) || CAS_MATCH.test(text);
        console.log('页面态:', result.finalUrl.slice(0, 120), '|', text.slice(0, 240));
      }
    } catch (e) {
      result.error = String(e.message || e).slice(0, 160);
      console.log('ctx.request 失败:', result.error);
    }
    console.log('CHECK_RESULT', JSON.stringify(result));
  }
  console.log('浏览器保持打开。');
}

// ============ main ============
if (cmd === 'login') await doLogin();
else if (cmd === 'download') await doDownload();
else if (cmd === 'check') await doCheck();
else if (cmd === 'close') { await closeOurBrowsers({ quiet: true }); console.log('已关闭本项目所有浏览器实例。'); }
else { console.log('用法: node scripts/wiley.mjs <login|check|download|close> [--list ... --outdir ... --delay 10000]'); process.exit(1); }
