// 共用工具：浏览器、CDP、cookie、PDF 校验、日志
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
export const STATE = path.join(ROOT, 'state');   // 运行时状态：登录 cookie、API key、日志
export const DATA = path.join(ROOT, 'data');     // 清单与源表
export const INPUTS = path.join(DATA, 'inputs');
export const MANIFESTS = path.join(DATA, 'manifests');
export const REPORTS = path.join(DATA, 'reports');
export const SCRATCH = STATE;                    // 兼容旧引用
export const DOWNLOAD_ROOT = process.env.PAPER_SNACHER_DOWNLOAD_ROOT
  ? path.resolve(process.env.PAPER_SNACHER_DOWNLOAD_ROOT)
  : path.join(ROOT, 'downloads');

export function resolveDownloadPath(value, fallback = DOWNLOAD_ROOT) {
  const candidate = value || fallback;
  return path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(DOWNLOAD_ROOT, candidate);
}

const EMBEDDED_CONTEXTS = new Map();

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const ts = () => new Date().toLocaleTimeString();
export const stamp = () => new Date().toISOString();

// 无头模式下 Edge 会把 UA 写成 HeadlessChrome/xxx，ScienceDirect 的风控直接识别它。
// 用真实 Edge 的 UA 模式覆盖（保留 Edg/ 后缀以贴合本机真实浏览器）。
// 指纹池：每个会话随机取一组 UA/平台/版本，避免"同一指纹连续高频访问"。
// 全部基于真实 Edge on Windows 的形态，只改版本号与窗口尺寸。
export const FINGERPRINTS = [
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0', ver: '153', full: '153.0.4234.32', size: '1400,950' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0', ver: '152', full: '152.0.4234.64', size: '1366,900' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0', ver: '151', full: '151.0.4234.102', size: '1512,982' },
  { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0', ver: '150', full: '150.0.4234.87', size: '1280,860' },
];
export function pickFingerprint() {
  return FINGERPRINTS[Math.floor(Math.random() * FINGERPRINTS.length)];
}
export const STEALTH_UA = FINGERPRINTS[0].ua;

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

export const opt = (args, name, def) => (args[name] === undefined ? def : args[name]);
export const num = (args, name, def) => parseInt(opt(args, name, def), 10);

export function logLine(file, obj) {
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(obj) + '\n'); } catch {}
}

// 清单缺失时，列出可用的候选清单，方便直接换 --list
export function listCandidates({ wantSdUrl = false } = {}) {
  const out = [];
  const dirs = [MANIFESTS, DATA, ROOT].filter(d => {
    try { return fs.statSync(d).isDirectory(); } catch { return false; }
  });
  for (const dir of dirs) {
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json') || f.startsWith('package')) continue;
    const full = path.join(dir, f);
    try {
      const arr = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (!Array.isArray(arr) || !arr.length || !arr[0].id) continue;
      const withSd = arr.filter(x => x.sdUrl).length;
      if (wantSdUrl && !withSd) continue;
      const rel = path.relative(ROOT, full).replace(/\\/g, '\\');
      out.push(`${rel}  (${arr.length} 条${withSd ? `, 含 sdUrl ${withSd}` : ''})`);
    } catch {}
  }
  }
  return out;
}

export function requireList(file, { wantSdUrl = false, hint = '' } = {}) {
  if (fs.existsSync(file)) return true;
  console.log(`找不到清单: ${file}`);
  const cands = listCandidates({ wantSdUrl });
  if (cands.length) {
    console.log('可用的清单（用 --list <文件名> 指定）:');
    for (const c of cands) console.log('  ' + c);
  }
  if (hint) console.log(hint);
  return false;
}

export function isValidPdf(file) {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < 10 * 1024) return false;
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(5);
    fs.readSync(fd, b, 0, 5, 0);
    fs.closeSync(fd);
    return b.toString('latin1') === '%PDF-';
  } catch { return false; }
}

export const isPdfBuf = b => b && b.length > 10 * 1024 && b.slice(0, 5).toString('latin1') === '%PDF-';

// ---------- Example University WebVPN URL 改写 ----------
const WV_KEY = Buffer.from('wrdvpnisthebest!');
export function wvToken(host) {
  const c = crypto.createCipheriv('aes-128-cfb', WV_KEY, WV_KEY);
  let out = c.update(Buffer.from(host, 'utf8').toString('hex'), 'hex', 'hex');
  return '77726476706e69737468656265737421' + out + c.final('hex');
}
export const WEBVPN_BASE_URL = process.env.WEBVPN_BASE_URL ||
  'https://webvpn.example.edu/';
export const wvUrl = (host, pathAndQuery) =>
  `${WEBVPN_BASE_URL.replace(/\/+$/, '')}/https/${wvToken(host)}/${String(pathAndQuery).replace(/^\/+/, '')}`;

// ---------- 浏览器进程管理 ----------
function listOurEdge() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*paper_snacher*' } | Select-Object -ExpandProperty ProcessId`],
      { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch { return []; }
}

export async function closeOurBrowsers({ quiet = false } = {}) {
  for (const [port, entry] of [...EMBEDDED_CONTEXTS]) {
    try { await entry.ctx.close(); } catch {}
    EMBEDDED_CONTEXTS.delete(port);
  }
  const before = listOurEdge();
  if (!quiet) console.log(`关闭旧浏览器进程（${before.length} 个）…`);
  const kill = like => {
    try {
      execFileSync('powershell', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*paper_snacher*'${like} } | ForEach-Object { taskkill /F /T /PID $_.ProcessId 2>&1 | Out-Null }`],
        { timeout: 30000, stdio: 'ignore' });
    } catch {}
  };
  kill(" -and $_.CommandLine -notlike '*--type=*'");
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    if (!listOurEdge().length) break;
    kill('');
  }
  const after = listOurEdge();
  if (!quiet) console.log(after.length ? `仍有 ${after.length} 个残留` : '浏览器已全部关闭，profile 已释放');
}

export async function cdpAlive(port) {
  if (EMBEDDED_CONTEXTS.has(port)) return true;
  try { return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
}

export function edgeArgs({
  profile, port, headless = false, offscreen = false, size = '1400,950',
  newWindow = false,
}) {
  const args = [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    '--no-first-run', '--no-default-browser-check', `--window-size=${size}`];
  if (headless) args.push('--headless=new');
  // 窗口位置随机化 + 语言随机化，避免每次启动参数完全一致的指纹
  args.push(offscreen
    ? `--window-position=-3200,${Math.floor(Math.random() * -800) - 2400}`
    : `--window-position=${Math.floor(Math.random() * 200) + 40},${Math.floor(Math.random() * 120) + 30}`);
  args.push(`--lang=${['zh-CN', 'en-US', 'zh-TW'][Math.floor(Math.random() * 3)]}`);
  if (newWindow) args.push('--new-window');
  args.push('about:blank');
  return args;
}


export async function launchBrowser({
  profile, port, headless = false, offscreen = false, size = '1400,950',
  label = '', newWindow = false,
}) {
  if (process.env.PAPER_SNACHER_BROWSER_MODE === 'playwright') {
    if (EMBEDDED_CONTEXTS.has(port)) return;
    const { chromium } = await import('playwright-core');
    const embeddedArgs = edgeArgs({
      profile, port, headless, offscreen, size, newWindow,
    }).filter(arg =>
      !/^--(user-data-dir|remote-debugging-port|remote-allow-origins|headless)=/.test(arg)
      && arg !== 'about:blank'
    );
    console.log(ts(), `启动内嵌浏览器${label ? '(' + label + ')' : ''}${headless ? ' [无头]' : offscreen ? ' [离屏]' : ''}…`);
    const ctx = await chromium.launchPersistentContext(profile, {
      executablePath: EDGE,
      headless,
      viewport: null,
      acceptDownloads: true,
      args: embeddedArgs,
    });
    EMBEDDED_CONTEXTS.set(port, { ctx, profile, label });
    return;
  }

  if (await cdpAlive(port)) return;
  const args = edgeArgs({ profile, port, headless, offscreen, size, newWindow });
  console.log(ts(), `启动浏览器${label ? '(' + label + ')' : ''}${headless ? ' [无头]' : offscreen ? ' [离屏]' : ''}…`);
  const ps = `Start-Process -FilePath "${EDGE}" -ArgumentList ${args.map(a => `'${a}'`).join(',')}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    // 关键：同 profile 已有实例时，新启动会被"转交"给旧窗口（表现为窗口不出现/仍在离屏位置）
    // 因此每次启动前，先清掉占用该 profile 的残留实例
    killByProfile(profile);
    await sleep(1500);
    try { execFileSync('powershell', ['-NoProfile', '-Command', ps], { timeout: 20000 }); }
    catch { spawn(EDGE, args, { detached: true, stdio: 'ignore' }).unref(); }
    for (let i = 0; i < 20; i++) { await sleep(1000); if (await cdpAlive(port)) return; }
    console.log(ts(), `第 ${attempt} 次启动未生效，清理同 profile 残留后重试…`);
    killByProfile(profile);
    await sleep(4000);
  }
  throw new Error('浏览器启动超时');
}

export function killByProfile(profile) {
  try {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${path.basename(profile)}*' } | ForEach-Object { taskkill /F /T /PID $_.ProcessId 2>&1 | Out-Null }`],
      { timeout: 30000, stdio: 'ignore' });
  } catch {}
}

// 只关闭指定 profile 的实例（避免误杀同时运行的 MDPI 任务）
export async function closeProfiles(profiles, { quiet = false } = {}) {
  const wantedProfiles = new Set(profiles.map(p => path.resolve(p).toLowerCase()));
  for (const [port, entry] of [...EMBEDDED_CONTEXTS]) {
    if (!wantedProfiles.has(path.resolve(entry.profile).toLowerCase())) continue;
    try { await entry.ctx.close(); } catch {}
    EMBEDDED_CONTEXTS.delete(port);
  }
  for (const p of profiles) {
    const name = path.basename(p);
    if (!quiet) console.log(`关闭占用 ${name} 的浏览器实例…`);
    killByProfile(p);
  }
  for (let i = 0; i < 15; i++) {
    await sleep(800);
    let busy = false;
    for (const p of profiles) {
      try {
        const out = execFileSync('powershell', ['-NoProfile', '-Command',
          `(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${path.basename(p)}*' }).Count`],
          { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] });
        if (parseInt(out.trim() || '0', 10) > 0) busy = true;
      } catch {}
    }
    if (!busy) break;
    for (const p of profiles) killByProfile(p);
  }
  if (!quiet) console.log('指定 profile 的浏览器已关闭');
}

export async function connect(port, { stealthUa = false, fp = null } = {}) {
  const embedded = EMBEDDED_CONTEXTS.get(port);
  let browser = null;
  let ctx;
  if (embedded) {
    ctx = embedded.ctx;
  } else {
    const { chromium } = await import('playwright-core');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    ctx = browser.contexts()[0] || (await browser.newContext());
  }
  const pages = ctx.pages().filter(p => !p.isClosed());
  const page = pages.find(p => p.url() === 'about:blank') || pages[0] || (await ctx.newPage());
  if (stealthUa) {
    // 无头模式下 Edge 的 UA 是 HeadlessChrome/xxx，ScienceDirect 风控直接识别。
    // 用 CDP 覆盖 UA + Client Hints，并在页面脚本里抹掉 navigator.webdriver。
    const fp_ = fp || { ua: STEALTH_UA, ver: '153', full: '153.0.4234.32' };
    const s = await ctx.newCDPSession(page);
    const brands = [
      { brand: 'Microsoft Edge', version: fp_.ver },
      { brand: 'Chromium', version: fp_.ver },
      { brand: 'Not)A;Brand', version: '99' },
    ];
    await s.send('Network.setUserAgentOverride', {
      userAgent: fp_.ua,
      platform: 'Win32',
      userAgentMetadata: {
        brands, mobile: false, platform: 'WINDOWS', platformVersion: '10.0.0',
        architecture: 'x86', bitness: '64', model: '', uaFullVersion: fp_.full,
      },
    }).catch(() => {});
    await page.addInitScript(() => {
      try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {}
      try { Object.defineProperty(navigator, 'userAgent', { get: () => fp_.ua }); } catch {}
    });
  }
  return { browser, ctx, page };
}

// ---------- cookie ----------
export const WEBVPN_COOKIE_RE = /webvpn\.edu\.cn|webvpn|icas|auth4/i;

export async function readCookies(ctx, re = WEBVPN_COOKIE_RE) {
  try { return (await ctx.cookies()).filter(c => re.test(c.domain || '')); } catch { return []; }
}

export async function injectCookies(ctx, cookies) {
  if (!cookies?.length) return 0;
  const page = ctx.pages()[0] || (await ctx.newPage());
  const s = await ctx.newCDPSession(page).catch(() => null);
  if (!s) return 0;
  let n = 0;
  for (const c of cookies) {
    const host = (c.domain || '').replace(/^\./, '');
    if (!host) continue;
    const ok = await s.send('Network.setCookie', {
      name: c.name, value: c.value, url: `https://${host}${c.path || '/'}`,
      secure: !!c.secure, httpOnly: !!c.httpOnly,
      sameSite: c.sameSite === 'None' ? 'None' : (c.sameSite || 'Lax'),
    }).catch(() => null);
    if (ok) n++;
  }
  return n;
}

export function loadCookieFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}

export const cookieHeader = cookies => cookies.map(c => `${c.name}=${c.value}`).join('; ');

// ---------- 带重试的 fetch ----------
export async function fetchWithRetry(url, { headers = {}, attempts = 4, timeoutMs = 60000, backoffMs = 2000, onBlocked } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const resp = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
      if (resp.status === 429 || resp.status === 502 || resp.status === 503) {
        if (onBlocked) onBlocked(resp.status, attempt);
        await sleep(backoffMs * attempt);
        continue;
      }
      return resp;
    } catch (e) {
      if (attempt === attempts) return { error: e };
      await sleep(backoffMs * attempt);
    }
  }
  return { error: new Error('retry exhausted') };
}
