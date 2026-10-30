// ScienceDirect 批量下载（Example University WebVPN）
//   node scripts/scidir.mjs login     # 有头登录，导出会话 cookie
//   node scripts/scidir.mjs download  # 离屏浏览器批量下载（--list --outdir --rotate ...）
//   node scripts/scidir.mjs api       # 官方 Elsevier API（需要 key / insttoken）
//   node scripts/scidir.mjs close     # 关闭本项目所有浏览器实例
//   登录验证码选项：--captcha auto|manual --captcha-profile human --captcha-max 2
//
// 退出码：0 正常；10 = WebVPN 会话失效，需要重新 login
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, MANIFESTS, SCRATCH, sleep, ts, stamp, parseArgs, opt, num, logLine, isValidPdf, isPdfBuf,
  wvUrl, launchBrowser, connect, closeOurBrowsers, cdpAlive, pickFingerprint,
  closeProfiles,
  readCookies, injectCookies, loadCookieFile, cookieHeader, WEBVPN_COOKIE_RE,
  requireList, resolveDownloadPath,
} from './lib.mjs';
import {
  MOTION_PROFILES, createCasLoginController, readCredentials,
} from './webvpn-auth.mjs';

const args = parseArgs();
const cmd = args._[0] || 'download';

const DEFAULT_LIST = path.join(MANIFESTS, 'newlist3_sd.json');
const DEFAULT_OUT = 'downloads_scidir';
const COOKIE_FILE = path.join(SCRATCH, 'scidir_cookies.json');
const LOG = path.join(SCRATCH, 'scidir_log.jsonl');
const FAIL_DIR = path.join(SCRATCH, 'scidir_fail');
// 直连模式（CARSI）下，下载窗口直接复用登录用的 profile：
// 机构会话不只存在 cookie 里（Elsevier 还在 localStorage 存凭证），
// 换个 profile 只注入 cookie 会被判定为"换了设备"，表现为整段 no_access。
const PROFILE = path.join(ROOT, opt(args, 'profile',
  args.direct ? '.browser_profile_scidir_login' : '.browser_profile_scidir'));
const LOGIN_PROFILE = path.join(ROOT, opt(args, 'login-profile',
  args.direct ? '.browser_profile_scidir_login' : '.browser_profile_scidir'));
const LOGIN_PORT = num(args, 'login-port', 9226);
// 直连模式下下载端口 = 登录端口：这样下载会复用登录后仍开着的那个浏览器窗口，
// 保住 _shibsession_elsevier 这类"关浏览器即失效"的会话 cookie。
const DL_PORT = num(args, 'port', args.direct ? 9226 : 9227);

const CF_MATCH = /are you a human|are you a robot|captcha challenge|just a moment|verify you are human|checking your browser|正在验证/i;

// 直连模式（--direct）：不走Example University WebVPN，直接用 ScienceDirect 官方域名。
// 配合 CARSI 机构登录的会话使用，适合在家/宿舍等没有校园网出口的场景。
// 默认仍走 WebVPN，行为不变。
const DIRECT = !!args.direct;
const sd = p => (DIRECT ? `https://www.sciencedirect.com${p}` : wvUrl('www.sciencedirect.com', p));

// 下载窗口尺寸：--size 覆盖指纹池里的默认尺寸。
// 登录窗口单独使用 --login-size，默认 1400x950，与验证码测试脚本保持一致。
const WIN_SIZE = (() => {
  const v = String(opt(args, 'size', '') || '').trim();
  return /^\d{3,4},\d{3,4}$/.test(v) ? v : '';
})();
const LOGIN_SIZE = (() => {
  const v = String(opt(args, 'login-size', '1400,950') || '').trim();
  return /^\d{3,4},\d{3,4}$/.test(v) ? v : '1400,950';
})();
const BLOCK_MATCH = /there was a problem providing the content you requested|contact our support team for more information/i;
const NET_ERR = /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_TIMED_OUT|ERR_NETWORK|ERR_EMPTY_RESPONSE|ERR_INTERNET_DISCONNECTED|ERR_ADDRESS_UNREACHABLE|ERR_PROXY|ERR_SOCKET_NOT_CONNECTED/i;
const TEST_PII = 'S0022247X22010034';

const bodyText = p => p.evaluate(() => (document.body ? document.body.innerText.slice(0, 2500) : '')).catch(() => '');

async function bailForRelogin(reason) {
  // 先彻底关掉离屏窗口，否则下一步启动有屏登录窗口会被"转交"给这个不可见窗口
  try { await closeProfiles([PROFILE, LOGIN_PROFILE], { quiet: true }); } catch {}
  console.log('\n============================================================');
  if (DIRECT) {
    console.log(` CARSI 机构会话失效（${reason}）—— 需要重新登录。`);
    console.log('  运行:  node scripts/scidir.mjs login --direct');
  } else {
    console.log(` WebVPN 会话失效（${reason}）—— 需要重新登录。`);
    console.log('  运行:  node scripts/scidir.mjs login');
  }
  console.log('============================================================');
  process.exit(10);
}

// ============ login ============
// 彻底清掉所有 cookie：两个浏览器 profile（下载 + 登录）连同导出的 cookie 文件。
// 风控时用它，清完必须重新登录 WebVPN —— 等于换一套全新身份重来。
async function wipeAllCookies(reason) {
  console.log(ts(), `清理全部 cookie（${reason}）…`);
  const profiles = [...new Set([PROFILE, LOGIN_PROFILE])];
  try { await closeProfiles(profiles, { quiet: true }); } catch {}
  for (const p of profiles) {
    try {
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
        console.log('  已删除 profile:', path.basename(p));
      }
    } catch (e) { console.log('  删除失败:', path.basename(p), e.message); }
  }
  try {
    fs.writeFileSync(COOKIE_FILE, '[]');
    console.log('  已清空 cookie 文件:', path.basename(COOKIE_FILE));
  } catch (e) { console.log('  清空 cookie 文件失败:', e.message); }
}

function readArticleLoginState(page) {
  return page.evaluate(() => {
    const h = document.documentElement ? document.documentElement.innerHTML : '';
    const t = document.body ? document.body.innerText : '';
    const absPath = /\/abs\//.test(location.pathname);
    const md5 = (h.match(/"md5":"([0-9a-f]{16,})"/) || [])[1] || '';
    return {
      login: /cas\/login|icas\.webvpn/i.test(location.href) || /统一身份认证/.test(t.slice(0, 200)),
      captcha: /are you a robot|captcha challenge/i.test(t),
      cf: /just a moment|checking your browser|verify you are human/i.test(t) || /just a moment/i.test(document.title),
      needOrg: /access through your organization/i.test(t),
      md5,
      absPath,
      entitled: !absPath && md5.length >= 16,
      url: location.href.slice(0, 70),
    };
  }).catch(() => null);
}

async function waitForArticleEntitlement(page, ctx, {
  targetUrl, credentials, captchaMode, captchaProfile, captchaMaxAttempts, label,
}) {
  const auth = createCasLoginController(page, {
    credentials,
    captchaMode,
    captchaProfile,
    captchaMaxAttempts,
    browserAutofill: !credentials?.username || !credentials?.password,
    label,
    logger: console.log,
  });
  const deadline = Date.now() + 25 * 60 * 1000;
  let last = 0;
  let firstNav = true;
  let lastNavAt = 0;
  let gatewayRetries = 0;

  async function navigateTarget() {
    lastNavAt = Date.now();
    await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    }).catch(() => {});
  }

  while (Date.now() < deadline) {
    if (page.isClosed()) {
      console.log('登录页面已关闭，停止等待。');
      return false;
    }
    // Login/CAPTCHA 期间只保留用户正在操作的那一页，避免刷新吞掉验证码或表单。
    if (firstNav) {
      firstNav = false;
      await navigateTarget();
    }

    const authResult = await auth.poll();
    const authState = authResult.state;
    if (authState?.gateway && Date.now() - lastNavAt > 15000 && gatewayRetries < 6) {
      gatewayRetries++;
      console.log(ts(), `认证网关 502/504，重试 ${gatewayRetries}/6…`);
      await navigateTarget();
    }

    const st = await readArticleLoginState(page);
    if (st?.entitled) {
      const all = await ctx.cookies();
      fs.writeFileSync(COOKIE_FILE, JSON.stringify(all, null, 1));
      const webvpn = all.filter(c => WEBVPN_COOKIE_RE.test(c.domain || ''));
      console.log(`会话已保存：cookie ${all.length} 个（Example University相关 ${webvpn.length}）→ ${COOKIE_FILE}`);
      return true;
    }

    if (Date.now() - last > 60000) {
      console.log(ts(), st?.login
        ? (authState?.captchaVisible ? '验证码处理中…' : '等待统一身份认证…')
        : st?.captcha ? '等待人机验证…'
        : st?.cf ? 'Cloudflare 挑战中…'
        : st?.needOrg ? '等你点 Access through your organization 并登录…'
        : st?.absPath ? '已登录但还没有机构权限（页面在 /abs/ 摘要页），请完成机构登录…'
        : `等待文章页…（${st?.url || ''}）`);
      last = Date.now();
    }
    await sleep(DIRECT ? 3000 : 4000);
  }
  return false;
}

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
  if (DIRECT) {
    console.log(' CARSI 机构登录（直连模式，不走 WebVPN）');
    console.log(' 窗口打开后请照做：');
    console.log('   1) 点蓝色按钮  Access through your organization');
    console.log('   2) 在机构搜索框里输入  Example University  并选中');
    console.log('   3) 用Example University统一身份认证账号登录');
    console.log('   4) 回到文章页，看到 PDF 按钮即成功');
  } else {
    console.log(' 登录 WebVPN（会弹出有头窗口）');
    console.log(' 登录成功后自动导出会话 cookie，并关闭该窗口');
  }
  console.log(` 验证码 ${captchaMode}｜轨迹 ${captchaProfile}｜最多 ${captchaMaxAttempts} 次`);
  if (!credentials.username || !credentials.password) {
    console.log(' 未完整提供账号密码；将使用浏览器已保存的登录信息');
  }
  console.log('============================================================');

  await closeProfiles([PROFILE, LOGIN_PROFILE], { quiet: true });
  await launchBrowser({ profile: LOGIN_PROFILE, port: LOGIN_PORT, offscreen: false, size: LOGIN_SIZE, label: 'scidir-login' });
  const { ctx, page } = await connect(LOGIN_PORT);
  const ok = await waitForArticleEntitlement(page, ctx, {
    targetUrl: sd(`/science/article/pii/${TEST_PII}`),
    credentials,
    captchaMode,
    captchaProfile,
    captchaMaxAttempts,
    label: DIRECT ? 'scidir-carsi-login' : 'scidir-webvpn-login',
  });
  if (!ok) {
    console.log('未在时限内完成登录，会话未保存');
    process.exit(3);
  }

  if (DIRECT) {
    console.log('登录窗口保持打开 —— 下载会复用它，请不要手动关闭。');
  } else {
    await closeProfiles([LOGIN_PROFILE], { quiet: true });
    console.log('登录窗口已关闭，可以开始下载了。');
  }
}

// ============ download ============
async function doDownload() {
  const LIST = path.resolve(opt(args, 'list', DEFAULT_LIST));
  const OUT = resolveDownloadPath(opt(args, 'outdir', DEFAULT_OUT));
  const DELAY = num(args, 'delay', 2500);
  const ROTATE = num(args, 'rotate', 9);
  const MAX = num(args, 'max', 0);
  const ONLY = String(opt(args, 'only', '')).split(',').map(s => s.trim()).filter(Boolean);
  const HEADLESS = !!args.headless;
  // --visible：有屏模式。默认是离屏（窗口挪到屏幕外，眼不见为净）。
  // 有屏的好处是能直接看到浏览器在干什么（风控页/登录页/卡在哪），
  // 也不受某些"离屏窗口被系统挂起"的影响。
  const VISIBLE = !!args.visible || !!args.headful;
  // 直连 + CARSI 会话时不要伪造 UA：登录窗口用的是真实 Edge UA，
  // 下载窗口换成指纹池里的假 UA 会让机构会话失效（实测表现为整段 no_access）。
  const NO_STEALTH = DIRECT || !!args['no-stealth'];
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(FAIL_DIR, { recursive: true });

  if (!requireList(LIST, { wantSdUrl: true, hint: 'SciDir 需要带 sdUrl 的清单（由 DOI 解析出 PII 后生成），例如 data\\manifests\\newlist3_sd.json' })) process.exit(2);
  const allItems = JSON.parse(fs.readFileSync(LIST, 'utf8'));
  const items = allItems.filter(it => it.sdUrl && (!ONLY.length || ONLY.includes(it.id)));
  const done = new Set(fs.readdirSync(OUT).filter(f => f.endsWith('.pdf') && isValidPdf(path.join(OUT, f))).map(f => f.slice(0, -4)));

  // "已确认无权限"名单：这些 id 永远下不到 PDF，若不记住会**每一轮都排在队首重试**。
  // 实测 3 篇就刷了 226 条日志、约 450 个请求，还都打在已被 WAF 盯上的 IP 上。
  // 文件名跟着清单走，避免不同批次互相污染；想重试删掉它，或用 --retry-no-access。
  const NOACCESS_FILE = path.join(SCRATCH, `noaccess_${path.basename(LIST).replace(/\.json$/i, '')}.txt`);
  const loadNoAccess = () => {
    try {
      return new Set(fs.readFileSync(NOACCESS_FILE, 'utf8').split('\n').map(s => s.trim()).filter(Boolean));
    } catch { return new Set(); }
  };
  const noAccess = args['retry-no-access'] ? new Set() : loadNoAccess();
  const markNoAccess = id => {
    try { fs.appendFileSync(NOACCESS_FILE, String(id) + '\n'); } catch {}
  };

  const todo = items
    .filter(it => !done.has(it.id) && !noAccess.has(String(it.id)))
    .slice(0, MAX || undefined);

  console.log('================================================================');
  console.log(' ScienceDirect 批量下载（Example University WebVPN）');
  console.log(`  清单 ${path.basename(LIST)} → 输出 ${OUT}`);
  console.log(`  共 ${items.length} 篇，已完成 ${done.size} 篇，本次 ${todo.length} 篇`);
  if (noAccess.size) {
    console.log(`  已知无权限跳过 ${noAccess.size} 篇（${path.basename(NOACCESS_FILE)}；重试加 --retry-no-access）`);
  }
  console.log(`  流程 登录(有屏) → 下载｜每 ${ROTATE} 篇轮换会话｜间隔 ${DELAY}ms`);
  console.log('================================================================');
  if (!todo.length) { console.log('没有需要下载的条目。'); return; }

  const loginCredentials = await readCredentials({ prompt: false, noPrompt: true });
  const loginCaptchaMode = String(opt(args, 'captcha', 'auto')).toLowerCase();
  const loginCaptchaProfile = String(opt(args, 'captcha-profile', 'human'));
  const loginCaptchaMax = Math.max(1, Math.min(2, num(args, 'captcha-max', 2) || 2));
  if (!['auto', 'manual'].includes(loginCaptchaMode)) {
    console.log('--captcha 只能是 auto 或 manual');
    process.exit(2);
  }
  if (!MOTION_PROFILES.includes(loginCaptchaProfile)) {
    console.log(`未知 --captcha-profile: ${loginCaptchaProfile}`);
    process.exit(2);
  }

  let fp = pickFingerprint();
  console.log(ts(), '启动后先完成 WebVPN/CAS 登录，再进入论文下载。');
  if (HEADLESS) console.log(ts(), '登录阶段需要可见页面，--headless 仅影响后续会话轮换。');
  await closeProfiles([PROFILE, LOGIN_PROFILE], { quiet: true });
  await launchBrowser({
    profile: PROFILE,
    port: DL_PORT,
    headless: false,
    offscreen: false,
    size: LOGIN_SIZE,
    label: 'scidir-login',
  });
  let { browser, ctx, page } = await connect(DL_PORT, { stealthUa: !NO_STEALTH, fp });
  ctx.setDefaultTimeout(30000);

  let cookies = loadCookieFile(COOKIE_FILE);
  if (cookies.length) {
    const n = await injectCookies(ctx, cookies);
    console.log(ts(), `已注入历史会话 cookie ${n} 个`);
  }

  const loginOk = await waitForArticleEntitlement(page, ctx, {
    targetUrl: sd(`/science/article/pii/${TEST_PII}`),
    credentials: loginCredentials,
    captchaMode: loginCaptchaMode,
    captchaProfile: loginCaptchaProfile,
    captchaMaxAttempts: loginCaptchaMax,
    label: DIRECT ? 'scidir-carsi-download-login' : 'scidir-webvpn-download-login',
  });
  if (!loginOk) {
    console.log('登录未完成，下载不会启动。');
    process.exitCode = 3;
    return;
  }
  cookies = loadCookieFile(COOKIE_FILE);


  let global502 = 0;

  // 轮换或重新登录后的轻量预热，不用于首次登录页面。
  async function warmup() {
    const home = sd('/');
    await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await sleep(1500 + Math.random() * 1500);
    const t = await bodyText(page);
    if (/502 Bad Gateway|Proxy\d+\.webvpn\.edu\.cn/i.test(t)) {
      console.log(ts(), '预热时遇到 WebVPN 502，等待 10s 后重试…');
      await sleep(10000);
      await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    }
  }

  async function rotate(reason) {
    console.log(ts(), `轮换会话（${reason}）…`);
    let savedCf = [];
    try {
      const all = await ctx.cookies();
      savedCf = all.filter(c => /sciencedirect\.com|elsevier/i.test(c.domain || '')
        && /^(cf_clearance|__cf_bm|cf_chl|acw_tc|ak_bmsc|bm_(sv|mi|te|vg))$/i.test(c.name));
      const toDelete = all.filter(c => /sciencedirect\.com|elsevier|els-cdn|elseviercdn|linkinghub/i.test(c.domain || '')
        && !savedCf.some(k => k.name === c.name && k.domain === c.domain));
      const s = await ctx.newCDPSession(page).catch(() => null);
      if (s) {
        for (const c of toDelete) {
          await s.send('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path }).catch(() => {});
        }
      }
    } catch {}
    await closeProfiles([PROFILE], { quiet: true });
    await sleep(2000);
    fp = pickFingerprint();
    console.log(ts(), `新指纹: Edge/${fp.ver} 窗口 ${fp.size}`);
    await launchBrowser({
      profile: PROFILE,
      port: DL_PORT,
      headless: HEADLESS,
      offscreen: !HEADLESS && !DIRECT && !VISIBLE,
      size: WIN_SIZE || fp.size,
      label: 'scidir',
    });
    ({ ctx, page } = await connect(DL_PORT, { stealthUa: !NO_STEALTH, fp }));
    ctx.setDefaultTimeout(30000);
    if (cookies.length) await injectCookies(ctx, cookies);
    if (savedCf.length) {
      const n = await injectCookies(ctx, savedCf);
      console.log(ts(), `已还原 CF 凭证 ${n} 个`);
    }
    await warmup();
    console.log(ts(), '新会话已就绪');
  }

  async function navigate(url, id) {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(e => e);
      if (!(r instanceof Error)) return 'ok';
      const msg = String(r.message || '');
      if (NET_ERR.test(msg) || /ERR_ABORTED/.test(msg)) {
        if (attempt === 6) return 'net_error';
        console.log(`  [${id}] 网络异常，重试 ${attempt}/6`);
        await sleep(3000 * attempt);
        continue;
      }
      return 'error:' + msg.slice(0, 60);
    }
    return 'net_timeout';
  }

  async function dumpFail(id, tag) {
    try {
      await page.screenshot({ path: path.join(FAIL_DIR, `${id}_${tag}.png`) }).catch(() => {});
      fs.writeFileSync(path.join(FAIL_DIR, `${id}_${tag}.txt`), `URL: ${page.url()}\n\n${(await bodyText(page)).slice(0, 1200)}`);
    } catch {}
  }

  async function fetchPdfInPage(url) {
    return await page.evaluate(async ([u, ms]) => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), ms);
        const r = await fetch(u, { credentials: 'include', signal: ctrl.signal });
        clearTimeout(t);
        const ct = r.headers.get('content-type') || '';
        const buf = new Uint8Array(await r.arrayBuffer());
        const magic = String.fromCharCode.apply(null, buf.slice(0, 5));
        if (!r.ok || magic !== '%PDF-') return { status: r.status, ct, len: buf.length, magic };
        let s = '';
        const chunk = 32768;
        for (let i = 0; i < buf.length; i += chunk) s += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
        return { status: r.status, ct, len: buf.length, b64: btoa(s) };
      } catch (e) { return { err: String(e).slice(0, 120) }; }
    }, [url, 180000]).catch(e => ({ err: String(e.message || e).slice(0, 120) }));
  }

  async function processItem(it, depth = 0) {
    const pii = it.sdUrl.split('/pii/')[1];
    const articleUrl = sd(`/science/article/pii/${pii}`);
    let blocked = 0, gateway = 0, prompted = false, promptedAt = 0, lastRemind = 0;
    const loginDeadline = Date.now() + 30 * 60 * 1000;

    for (;;) {
      const nav = await navigate(articleUrl, it.id);
      if (nav !== 'ok') { await dumpFail(it.id, 'nav'); return { status: 'nav_' + nav, note: '' }; }
      // 人味：落地后随机停留 1.5-3.5s（真实用户阅读摘要的时间），而非立即抓取
      await sleep(1500 + Math.random() * 2000);
      const text = await bodyText(page);
      if (/502 Bad Gateway|504 Gateway Time-out|Proxy\d+\.webvpn\.edu\.cn/i.test(text)) {
        gateway++; global502++;
        console.log(`  [${it.id}] WebVPN 502（第 ${gateway} 次）`);
        if (gateway >= 3 || global502 >= 5) await bailForRelogin(`502 ×${gateway}`);
        await sleep(Math.min(30000, 3000 * gateway));
        continue;
      }
      if (BLOCK_MATCH.test(text)) {
        blocked++;
        throttle = Math.min(8, throttle + 1); // 被风控 → 全局降速
        console.log(`  [${it.id}] 风控页（第 ${blocked} 次）—— 清理全部 cookie 并重新登录 WebVPN`);
        await dumpFail(it.id, 'blocked');
        // 立刻落一条日志：看门狗靠它感知风控，不必等脚本退出
        logLine(LOG, { ts: stamp(), id: it.id, status: 'blocked', note: '风控页 → 清理全部 cookie 并重新登录', secs: 0 });
        // 不再"换会话退避重试"，直接清空所有 cookie 并交回登录流程：
        // 退出码 10 → 入口脚本弹出有屏登录窗口 → 登完自动继续。
        await wipeAllCookies('风控页');
        await bailForRelogin('风控页（全部 cookie 已清理）');
      }
      const title = await page.title().catch(() => '');
      if (CF_MATCH.test(title) || CF_MATCH.test(text)) {
        console.log(`  [${it.id}] 人机验证，等待自动通过…`);
        await sleep(6000);
        continue;
      }
      // 抓 md5/pid 要重试：WebVPN 慢的时候页面还没渲染出那段 JSON，
      // 原来只等 1.5~3.5s 就判"找不到"，实测有 13/716 篇这样被误判（同刊其它篇都成功）。
      let params = null;
      for (let probe = 1; probe <= 4; probe++) {
        params = await page.evaluate(() => {
          const h = document.documentElement ? document.documentElement.innerHTML : '';
          const t = document.body ? document.body.innerText : '';
          return {
            md5: (h.match(/"md5":"([0-9a-f]{16,})"/) || [])[1] || '',
            pid: (h.match(/"pid":"([^"]+)"/) || [])[1] || '',
            login: /cas\/login|icas\.webvpn\.edu\.cn|auth4\.webvpn\.edu\.cn|统一身份认证/i.test(location.href + t.slice(0, 300)),
            paywall: /purchase pdf|get access|does not subscribe/i.test(t),
          };
        }).catch(() => null);
        // 已经判定是"没订阅"就别再等——重试只对"页面还没渲染完"有用
        if (params?.md5 || params?.login || params?.paywall) break;
        if (probe < 4) {
          const wait = 3000 * probe;
          console.log(`  [${it.id}] 页面还没出 md5，等 ${wait / 1000}s 重试（${probe}/4）`);
          await sleep(wait);
        }
      }
      if (params?.md5) {
        it.md5 = params.md5; it.pid = params.pid;
        const pdfUrl = `${sd(`/science/article/pii/${pii}/pdfft`)}?md5=${params.md5}&pid=${encodeURIComponent(params.pid)}`;
        await sleep(800 + Math.random() * 1200); // 点 View PDF 前的犹豫时间
        await page.goto(pdfUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
        await sleep(2500 + Math.random() * 1500);
        for (let attempt = 1; attempt <= 3; attempt++) {
          const stubUrl = page.url();
          if (BLOCK_MATCH.test(await bodyText(page))) {
            // 与文章页风控同一套处理：不换会话、不退避重试，
            // 直接清空全部 cookie 并交回登录流程（退出码 10 → 有屏登录窗口）。
            console.log(`  [${it.id}] PDF 阶段风控页 —— 清理全部 cookie 并重新登录 WebVPN`);
            await dumpFail(it.id, 'blocked_pdf');
            logLine(LOG, { ts: stamp(), id: it.id, status: 'blocked', note: 'PDF 阶段风控 → 清理全部 cookie 并重新登录', secs: 0 });
            await wipeAllCookies('PDF 阶段风控页');
            await bailForRelogin('PDF 阶段风控页（全部 cookie 已清理）');
          }
          const res = await fetchPdfInPage(stubUrl);
          if (res?.b64) {
            const buf = Buffer.from(res.b64, 'base64');
            const file = path.join(OUT, `${it.id}.pdf`);
            fs.writeFileSync(file + '.part', buf);
            fs.renameSync(file + '.part', file);
            return { status: 'ok', note: `${buf.length}b` };
          }
          await sleep(4000);
          await page.goto(pdfUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
          await sleep(3000);
        }
        await dumpFail(it.id, 'pdffail');
        return { status: 'pdf_failed', note: 'no bytes' };
      }
      if (!params?.login) {
        await dumpFail(it.id, 'noparams');
        return { status: 'no_pdf_params', note: params?.paywall ? 'no_access' : 'md5 not found' };
      }
      if (Date.now() > loginDeadline) { await dumpFail(it.id, 'login'); return { status: 'need_login', note: '登录超时' }; }
      // 离屏窗口不可见，无法在里面登录 —— 交给入口脚本弹出可见的登录窗口
      await dumpFail(it.id, 'need_login');
      await bailForRelogin('需要登录 WebVPN');
    }
  }

  const summary = {};
  let idx = 0, sinceRotate = 0, sinceRest = 0;
  let throttle = 1; // 风控后自动降速倍率
  let blockedStreak = 0;
  const COOLDOWN_SHORT = num(args, 'cooldown', 10) * 60 * 1000;   // 首次风控冷静 10 分钟
  const COOLDOWN_LONG = num(args, 'cooldown-long', 30) * 60 * 1000; // 连续风控冷静 30 分钟
  const MAX_PER_HOUR = num(args, 'max-per-hour', 0);                 // 每小时成功上限，0=不限制
  let okTimes = [];
  const REST_EVERY = num(args, 'rest-every', 30);
  const REST_MIN = num(args, 'rest-min', 30);

  for (const it of todo) {
    idx++;
    const t0 = Date.now();
    let result;
    try { result = await processItem(it); }
    catch (e) { result = { status: 'error', note: String(e.message || e).slice(0, 120) }; }
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    summary[result.status] = (summary[result.status] || 0) + 1;
    console.log(`${ts()} [${idx}/${todo.length}] id=${it.id} ${result.status} (${secs}s) ${result.note || ''}`);
    logLine(LOG, { ts: stamp(), id: it.id, status: result.status, note: result.note, secs: +secs });
    // 判定为"没订阅"就记进名单，下一轮不再浪费请求
    if (result.status === 'no_pdf_params' && /no_access/.test(result.note || '')) {
      markNoAccess(it.id);
    }
    if (result.status === 'ok') {
      global502 = 0;
      blockedStreak = 0;
      if (throttle > 1 && sinceRotate % 15 === 0 && sinceRotate > 0) { throttle = Math.max(1, throttle - 0.5); console.log(ts(), `连续无风控，降速倍率恢复到 ${throttle}x`); }
      if (ROTATE > 0 && ++sinceRotate >= ROTATE) { sinceRotate = 0; await rotate(`连续 ${ROTATE} 篇`); }
      if (REST_EVERY > 0 && ++sinceRest >= REST_EVERY) {
        sinceRest = 0;
        const rest = (REST_MIN + Math.random() * 60) * 1000;
        console.log(ts(), `☕ 休息 ${Math.round(rest / 1000)}s（模拟人类操作节奏）…`);
        await sleep(rest);
      }
    }
    if (result.status === 'blocked') {
      blockedStreak++;
      // 实测：风控一旦触发会持续约 30 分钟，期间重试全是白费——直接全局冷静
      const cooldown = blockedStreak >= 2 ? COOLDOWN_LONG : COOLDOWN_SHORT;
      console.log(ts(), `⚠ 风控第 ${blockedStreak} 次，全局冷静 ${Math.round(cooldown / 60000)} 分钟（期间不发请求）…`);
      const until = Date.now() + cooldown;
      while (Date.now() < until) {
        await sleep(Math.min(60000, until - Date.now()));
        console.log(ts(), `    冷静中…剩余 ${Math.round((until - Date.now()) / 60000)} 分钟`);
      }
      await rotate('冷静期结束');
    }

    // 每小时上限（默认关闭；设了才生效）—— 风控本质是"单位时间量"，
    // 想稳就把 --max-per-hour 设成 60 左右
    if (MAX_PER_HOUR > 0 && result.status === 'ok') {
      okTimes.push(Date.now());
      okTimes = okTimes.filter(t => Date.now() - t < 3600000);
      if (okTimes.length >= MAX_PER_HOUR) {
        const wait = 3600000 - (Date.now() - okTimes[0]) + 2000;
        console.log(ts(), `本小时已达 ${MAX_PER_HOUR} 篇上限，等 ${Math.round(wait / 60000)} 分钟…`);
        await sleep(wait);
        okTimes = [];
      }
    }
    // 人味抖动 + 自适应降速
    const jitter = DELAY * throttle * (0.6 + Math.random() * 0.8);
    await sleep(jitter);
  }
  console.log('SUMMARY', JSON.stringify(summary));
  console.log('浏览器保持打开（下次运行会复用）。');
  if (!summary.ok) process.exitCode = 3;
}

// ============ api ============
async function doApi() {
  const LIST = path.resolve(opt(args, 'list', DEFAULT_LIST));
  const OUT = resolveDownloadPath(opt(args, 'outdir', 'downloads_api'));
  const KEY_FILE = path.join(SCRATCH, 'elsevier_key.txt');
  const INSTTOKEN_FILE = path.join(SCRATCH, 'elsevier_insttoken.txt');
  const VIA = opt(args, 'via', 'direct');
  const CONC = num(args, 'conc', 4);
  const DELAY = num(args, 'delay', 150);
  const MAX = num(args, 'max', 0);
  const DRY = !!args['dry-run'];
  const FAIL_ON_ERROR = !!args['fail-on-error'];

  if (!fs.existsSync(KEY_FILE)) { console.log(`找不到 API key: ${KEY_FILE}`); process.exit(2); }
  const API_KEY = fs.readFileSync(KEY_FILE, 'utf8').trim();
  const INSTTOKEN = fs.existsSync(INSTTOKEN_FILE) ? fs.readFileSync(INSTTOKEN_FILE, 'utf8').trim() : '';
  let cookie = '';
  if (VIA === 'webvpn') {
    const cs = loadCookieFile(COOKIE_FILE).filter(c => WEBVPN_COOKIE_RE.test(c.domain || ''));
    if (!cs.length) { console.log(`via=webvpn 需要 ${COOKIE_FILE}（先运行 login）`); process.exit(2); }
    cookie = cookieHeader(cs);
  }
  console.log(`Elsevier API｜key ${API_KEY.slice(0, 6)}…${INSTTOKEN ? ' +insttoken' : ''}｜via=${VIA}${DRY ? ' (dry-run)' : ''}`);

  fs.mkdirSync(OUT, { recursive: true });
  const items = JSON.parse(fs.readFileSync(LIST, 'utf8')).filter(it => it.sdUrl);
  const done = new Set(fs.readdirSync(OUT).filter(f => f.endsWith('.pdf') && isValidPdf(path.join(OUT, f))).map(f => f.slice(0, -4)));
  const todo = items.filter(it => !done.has(it.id)).slice(0, MAX || undefined);
  console.log(`共 ${items.length} 篇，已完成 ${done.size} 篇，本次 ${todo.length} 篇`);

  let idx = 0;
  const summary = {};
  async function worker() {
    for (;;) {
      const i = idx++;
      if (i >= todo.length) return;
      const it = todo[i];
      const pii = it.sdUrl.split('/pii/')[1];
      const doi = `10.1016/${pii}`; // 仅用于展示；真实 DOI 从清单取
      const realDoi = (it.url.match(/10\.\d{4,9}\/\S+/) || [])[0] || doi;
      const apiPath = `content/article/doi/${realDoi}?httpAccept=application%2Fpdf`;
      const url = VIA === 'webvpn' ? wvUrl('api.elsevier.com', apiPath) : `https://api.elsevier.com/${apiPath}`;
      const t0 = Date.now();
      let status = 'error', note = '';
      try {
        const resp = await fetch(url, {
          headers: {
            'X-ELS-APIKey': API_KEY,
            ...(INSTTOKEN ? { 'X-ELS-Insttoken': INSTTOKEN } : {}),
            ...(cookie ? { cookie } : {}),
            accept: 'application/pdf',
            'user-agent': 'paper-snacher/1.0 (academic use)',
          },
          signal: AbortSignal.timeout(60000),
        });
        const buf = Buffer.from(await resp.arrayBuffer());
        if (resp.ok && isPdfBuf(buf)) {
          if (!DRY) {
            const file = path.join(OUT, `${it.id}.pdf`);
            fs.writeFileSync(file + '.part', buf);
            fs.renameSync(file + '.part', file);
          }
          status = 'ok'; note = `${buf.length}b`;
        } else {
          const head = buf.toString('utf8').replace(/\s+/g, ' ').slice(0, 120);
          status = resp.status === 401 ? 'bad_key' : resp.status === 403 ? 'not_entitled'
            : resp.status === 429 ? 'quota' : resp.status === 404 ? 'not_found' : `http_${resp.status}`;
          note = head;
        }
      } catch (e) { note = String(e.message).slice(0, 80); }
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      summary[status] = (summary[status] || 0) + 1;
      console.log(`${ts()} [${i + 1}/${todo.length}] id=${it.id} ${status} (${secs}s) ${note}`);
      logLine(LOG, { ts: stamp(), route: 'api', id: it.id, status, note, secs: +secs });
      await sleep(DELAY);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  console.log('SUMMARY', JSON.stringify(summary));
  if (FAIL_ON_ERROR && Object.entries(summary).some(([status, count]) => status !== 'ok' && count > 0)) {
    process.exitCode = 3;
  }
}

if (cmd === 'login') await doLogin();
else if (cmd === 'download') await doDownload();
else if (cmd === 'api') await doApi();
else if (cmd === 'close') await closeOurBrowsers();
else { console.log('用法: node scripts/scidir.mjs <login|download|api|close> [options]'); process.exit(1); }
process.exit(process.exitCode || 0);
