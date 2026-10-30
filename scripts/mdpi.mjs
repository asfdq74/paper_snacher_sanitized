// MDPI 批量下载（开放获取，走浏览器会话，规避 Akamai 拦截）
// 用法: node scripts/mdpi.mjs --list data/manifests/newlist21_papers.json --outdir <PROJECT_ROOT>\downloads\downloads_mdpi [--max N] [--only id1,id2]
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, MANIFESTS, SCRATCH, sleep, ts, stamp, parseArgs, opt, num, logLine, isValidPdf,
  launchBrowser, connect, closeProfiles, requireList, resolveDownloadPath,
} from './lib.mjs';

const args = parseArgs();
const LIST = path.resolve(opt(args, 'list', path.join(MANIFESTS, 'newlist21_papers.json')));
const OUT = resolveDownloadPath(opt(args, 'outdir', 'downloads_mdpi'));
const PORT = num(args, 'port', 9230);
const PROFILE = path.join(ROOT, opt(args, 'profile', '.browser_profile_mdpi'));
const LOG = path.join(SCRATCH, 'mdpi_log.jsonl');
const TMP = path.join(SCRATCH, 'mdpi_tmp_dl');
const DELAY = num(args, 'delay', 1200);
const MAX = num(args, 'max', 0);
const ONLY = String(opt(args, 'only', '')).split(',').map(s => s.trim()).filter(Boolean);
const SHARD = opt(args, 'shard', '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0';
const DL_TIMEOUT = num(args, 'dltimeout', 90000);

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(TMP, { recursive: true });

// ---- DOI → 落地页（doi.org 302）----
const URL_CACHE = path.join(SCRATCH, 'mdpi_urls.json');
const urlCache = fs.existsSync(URL_CACHE) ? JSON.parse(fs.readFileSync(URL_CACHE, 'utf8')) : {};
const saveCache = () => { try { fs.writeFileSync(URL_CACHE, JSON.stringify(urlCache, null, 1)); } catch {} };

async function resolveLanding(doi) {
  if (urlCache[doi]) return urlCache[doi];
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch(`https://doi.org/${doi}`, { redirect: 'manual', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
      const loc = r.headers.get('location');
      if (loc) { urlCache[doi] = loc; return loc; }
    } catch {}
    await sleep(1000 * attempt);
  }
  return null;
}

// ---- 列表 / 断点续传 / 分片 ----
if (!requireList(LIST, { hint: '提示: MDPI 清单里每行需要 id + url(DOI)，例如 data\\manifests\\newlist21_papers.json' })) process.exit(2);
const items = JSON.parse(fs.readFileSync(LIST, 'utf8')).filter(it => !ONLY.length || ONLY.includes(it.id));
const done = new Set(fs.readdirSync(OUT).filter(f => f.endsWith('.pdf') && isValidPdf(path.join(OUT, f))).map(f => f.slice(0, -4)));
let todo = items.filter(it => !done.has(it.id));
if (SHARD) {
  const [i, n] = SHARD.split('/').map(Number);
  const before = todo.length;
  todo = todo.filter((_, idx) => idx % n === (i - 1) % n);
  console.log(`分片 ${SHARD}：剩余 ${before} 篇中本实例负责 ${todo.length} 篇`);
}
todo = todo.slice(0, MAX || undefined);

console.log('================================================================');
console.log(' MDPI 批量下载（浏览器会话内触发下载）');
console.log(`  清单 ${path.basename(LIST)} → 输出 ${OUT}`);
console.log(`  共 ${items.length} 篇，已完成 ${done.size} 篇，本次 ${todo.length} 篇`);
console.log('================================================================');

await closeProfiles([PROFILE], { quiet: true }); // 只清自己的 profile，避免误杀 SciDir 任务
await launchBrowser({ profile: PROFILE, port: PORT, offscreen: true, label: 'mdpi' });
const { ctx, page } = await connect(PORT);
ctx.setDefaultTimeout(30000);
const cdp = await ctx.newCDPSession(page);
await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: TMP, eventsEnabled: true }).catch(() => {});

async function downloadOne(id, pdfUrl, landing) {
  await page.goto(landing, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  const before = new Set(fs.readdirSync(TMP));
  await page.goto(pdfUrl, { waitUntil: 'commit', timeout: 60000 }).catch(() => {});
  const deadline = Date.now() + DL_TIMEOUT;
  while (Date.now() < deadline) {
    const fresh = fs.readdirSync(TMP).filter(f => !before.has(f) && f.toLowerCase().endsWith('.pdf'));
    const partial = fs.readdirSync(TMP).some(f => f.endsWith('.crdownload'));
    if (fresh.length && !partial) {
      const src = path.join(TMP, fresh[0]);
      const s1 = fs.statSync(src).size;
      await sleep(1200);
      if (fs.existsSync(src) && fs.statSync(src).size === s1) {
        if (isValidPdf(src)) {
          const dst = path.join(OUT, `${id}.pdf`);
          fs.renameSync(src, dst);
          return { ok: true, size: fs.statSync(dst).size };
        }
        fs.rmSync(src, { force: true });
        return { ok: false, note: '下载内容不是 PDF' };
      }
    }
    await sleep(1000);
  }
  return { ok: false, note: '下载超时' };
}

const summary = {};
let idx = 0;
for (const it of todo) {
  idx++;
  const doi = (it.url.match(/10\.\d{4,9}\/\S+/) || [])[0];
  const t0 = Date.now();
  let status = 'error', note = '';
  try {
    const landing = await resolveLanding(doi);
    if (!landing) status = 'doi_failed';
    else {
      let res = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        res = await downloadOne(it.id, landing.replace(/\/$/, '') + '/pdf', landing);
        if (res.ok) break;
        console.log(`      ${res.note}，重试 ${attempt}/3`);
        await sleep(3000 * attempt);
      }
      if (res?.ok) { status = 'ok'; note = `${res.size}b`; }
      else { status = 'failed'; note = res?.note || ''; }
    }
  } catch (e) { note = String(e.message || e).slice(0, 100); }
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  summary[status] = (summary[status] || 0) + 1;
  console.log(`${ts()} [${idx}/${todo.length}] id=${it.id} ${status} (${secs}s) ${note}`);
  logLine(LOG, { ts: stamp(), id: it.id, status, note, secs: +secs });
  if (idx % 20 === 0) saveCache();
  await sleep(DELAY);
}
saveCache();
console.log('SUMMARY', JSON.stringify(summary));
console.log('浏览器保持打开（下次运行会复用）。');
process.exit(0);
