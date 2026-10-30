// 一次性探针：验证"点击 View PDF + 捕获浏览器 download 事件"能否绕过 WebVPN 的 embed 壳
// 用法: node scripts/_probe_click.mjs [PII]
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, STATE, sleep, ts, parseArgs, opt,
  wvUrl, launchBrowser, connect, pickFingerprint, loadCookieFile, injectCookies, isPdfBuf,
} from './lib.mjs';

const args = parseArgs();
const PII = args._[0] || opt(args, 'pii', 'S0022247X22010034'); // 用已确认可下载的那篇做基准
const PORT = 9231;
const PROFILE = path.join(ROOT, '.browser_profile_scidir');
const TMP = path.join(STATE, 'probe_dl');
fs.mkdirSync(TMP, { recursive: true });

const log = (...a) => console.log(ts(), ...a);

await launchBrowser({ profile: PROFILE, port: PORT, headless: true, offscreen: false, label: 'probe' });
const { ctx, page } = await connect(PORT, { stealthUa: true, fp: pickFingerprint() });
ctx.setDefaultTimeout(30000);

const cdp = await ctx.newCDPSession(page);
await cdp.send('Browser.setDownloadBehavior', {
  behavior: 'allow', downloadPath: TMP, eventsEnabled: true,
}).catch(e => log('setDownloadBehavior 失败', String(e).slice(0, 60)));

const cookies = loadCookieFile(path.join(STATE, 'scidir_cookies.json'));
if (cookies.length) log(`注入 cookie ${await injectCookies(ctx, cookies)} 个`);

// 钩住 window.open / location 赋值，看点击后页面自己做了什么
await page.addInitScript(() => {
  window.__calls = [];
  const ow = window.open;
  window.open = function (...a) { window.__calls.push(['open', String(a[0])]); return ow.apply(this, a); };
  try {
    const proto = window.location.constructor.prototype;
    const d = Object.getOwnPropertyDescriptor(proto, 'href');
    if (d && d.set) {
      Object.defineProperty(window.location, 'href', {
        set(v) { window.__calls.push(['href', String(v)]); d.set.call(window.location, v); },
        get: d.get,
      });
    }
  } catch {}
  const of = window.fetch;
  window.fetch = function (u, o) { try { window.__calls.push(['fetch', String(u).slice(0, 160)]); } catch {} return of.apply(this, arguments); };
});

// 事件监听
const events = { downloads: [], newPages: [], pdfResponses: [] };
ctx.on('download', d => {
  events.downloads.push(d);
  log('★ download 事件：', d.suggestedFilename(), '←', d.url().slice(0, 100));
});
ctx.on('page', p => {
  events.newPages.push(p);
  log('★ 新标签页：', p.url().slice(0, 100));
});
ctx.on('response', async r => {
  const ct = (r.headers()['content-type'] || '').toLowerCase();
  if (!ct.includes('pdf') && !/pdfft|\.pdf/i.test(r.url())) return;
  events.pdfResponses.push(r);
  log(`  resp ${r.status()} ct=${ct.slice(0, 30)} ${r.url().slice(0, 90)}`);
});

const articleUrl = wvUrl('www.sciencedirect.com', `/science/article/pii/${PII}`);
log('打开文章页…');
for (let attempt = 1; attempt <= 6; attempt++) {
  await page.goto(articleUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
  await sleep(5000);
  const t = await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 300) : '')).catch(() => '');
  if (/502 Bad Gateway|Proxy\d+\.webvpn\.edu\.cn/i.test(t)) {
    log(`  第 ${attempt} 次遇到 WebVPN 502，10s 后重试…`);
    await sleep(10000);
    continue;
  }
  if (/cas\/login|统一身份认证/i.test(page.url() + t)) {
    log('  会话失效，需要重新登录'); process.exit(10);
  }
  break;
}
log('落地:', page.url().slice(0, 90));

// 找 "View PDF" 按钮：它是个没有 href 的 <a>，点击由页面 JS 处理
// 注意：accessbar 渲染较慢（WebVPN 下可能 30s+），所以轮询久一点
let btn = null;
for (let i = 0; i < 25; i++) {
  btn = await page.evaluate(() => {
    const cands = Array.from(document.querySelectorAll('a, button'));
    const el = cands.find(x => /^\s*view pdf\s*$/i.test((x.textContent || '').trim()))
      || cands.find(x => /view pdf/i.test((x.textContent || '').trim()));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName, text: (el.textContent || '').trim().slice(0, 20),
      ariaDisabled: el.getAttribute('aria-disabled'), href: el.getAttribute('href'),
      visible: r.width > 0 && r.height > 0, cls: (el.className || '').toString().slice(0, 60),
    };
  }).catch(() => null);
  if (btn) break;
  await sleep(3000);
}
log('View PDF 按钮:', JSON.stringify(btn));

const before = new Set(fs.readdirSync(TMP));
if (btn) {
  // 等按钮 enabled（ScienceDirect 的 accessbar 会延迟启用）
  for (let i = 0; i < 10; i++) {
    const ready = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('a, button'))
        .find(x => /view pdf/i.test((x.textContent || '').trim()));
      return el ? el.getAttribute('aria-disabled') !== 'true' : false;
    }).catch(() => false);
    if (ready) break;
    await sleep(1500);
  }
  const handle = await page.evaluateHandle(() => Array.from(document.querySelectorAll('a, button'))
    .find(x => /^\s*view pdf\s*$/i.test((x.textContent || '').trim()))
    || Array.from(document.querySelectorAll('a, button')).find(x => /view pdf/i.test((x.textContent || '').trim()))
    || null);
  const el = handle.asElement();
  if (el) {
    await el.scrollIntoViewIfNeeded().catch(() => {});
    log('执行真实点击…');
    await el.click({ noWaitAfter: true }).catch(e => log('click 失败', String(e).slice(0, 80)));
  } else log('DOM 里找不到该元素');
} else {
  log('没有可点的按钮 —— 该文可能没有 View PDF（无权限/未订阅）');
}

// 等待结果
for (let i = 0; i < 12; i++) {
  await sleep(5000);
  const fresh = fs.readdirSync(TMP).filter(f => !before.has(f));
  if (events.downloads.length || fresh.length) break;
}

const fresh = fs.readdirSync(TMP).filter(f => !before.has(f));
log('--- 结果 ---');
const calls = await page.evaluate(() => window.__calls || []).catch(() => []);
log('页面 JS 调用记录:', JSON.stringify(calls).slice(0, 500));
log('download 事件数:', events.downloads.length);
log('新标签页数:', events.newPages.length);
log('临时目录新文件:', fresh);
for (const f of fresh) {
  const p = path.join(TMP, f);
  const buf = fs.readFileSync(p);
  log(`  ${f}  ${buf.length} bytes  是PDF=${isPdfBuf(buf)}  头=${buf.slice(0, 5).toString('latin1')}`);
}
const pages = ctx.pages();
for (const p of pages) {
  const t = await p.evaluate(() => (document.body ? document.body.innerText.slice(0, 120) : '')).catch(() => '');
  const hasEmbed = await p.evaluate(() => !!document.querySelector('embed[type="application/pdf"]')).catch(() => false);
  log(`标签页 ${p.url().slice(0, 80)} | embed壳=${hasEmbed} | ${t.replace(/\s+/g, ' ').slice(0, 60)}`);
}
await page.screenshot({ path: path.join(STATE, 'probe_click.png') }).catch(() => {});
log('截图: state/probe_click.png');
process.exit(0);
