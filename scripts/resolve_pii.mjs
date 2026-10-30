// 把清单里的 DOI 解析成 ScienceDirect 直链（doi.org 302 → PII），生成 *_sd.json
// 用法: node scripts/resolve_pii.mjs --src newlist3_papers.json --out newlist3_sd.json
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, MANIFESTS, STATE, sleep, ts, parseArgs, opt, num, stamp, logLine } from './lib.mjs';

const args = parseArgs();
const SRC = path.resolve(opt(args, 'src', path.join(MANIFESTS, 'newlist_papers.json')));
const OUT = path.resolve(opt(args, 'out', SRC.replace(/_papers\.json$/, '_sd.json')));
const CONC = num(args, 'conc', 6);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0';
const LOG = path.join(STATE, 'resolve_log.jsonl');

if (!fs.existsSync(SRC)) { console.log('找不到清单:', SRC); process.exit(2); }
const items = JSON.parse(fs.readFileSync(SRC, 'utf8'));

const cache = {};
if (fs.existsSync(OUT)) {
  for (const it of JSON.parse(fs.readFileSync(OUT, 'utf8'))) {
    const pii = (it.sdUrl || '').split('/pii/')[1];
    if (pii) cache[it.id] = pii;
  }
}
const apply = () => {
  for (const it of items) if (cache[it.id]) it.sdUrl = `https://www.sciencedirect.com/science/article/pii/${cache[it.id]}`;
};
apply();
const save = () => fs.writeFileSync(OUT, JSON.stringify(items, null, 1));

const todo = items.filter(it => !cache[it.id]);
console.log(`待解析 ${todo.length} / 共 ${items.length} 篇（并发 ${CONC}）`);
if (!todo.length) { save(); console.log('全部已解析'); process.exit(0); }

async function resolveOne(doi) {
  try {
    const r = await fetch(`https://doi.org/${doi}`, { redirect: 'manual', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
    const loc = r.headers.get('location') || '';
    const m = loc.match(/\/pii\/([A-Z0-9]+)/i) || loc.match(/\/(S[0-9A-Z]{10,})(?:[/?]|$)/i);
    return m ? m[1].toUpperCase() : null;
  } catch { return null; }
}

let idx = 0, ok = 0, fail = 0, doneCount = 0;
async function worker() {
  for (;;) {
    const i = idx++;
    if (i >= todo.length) return;
    const it = todo[i];
    const doi = (it.url?.match(/10\.\d{4,9}\/\S+/) || [])[0];
    let pii = null;
    if (doi) for (let attempt = 1; attempt <= 3 && !pii; attempt++) { pii = await resolveOne(doi); if (!pii) await sleep(1500); }
    if (pii) { cache[it.id] = pii; ok++; } else fail++;
    doneCount++;
    if (doneCount % 50 === 0) { console.log(`${ts()} 进度 ${doneCount}/${todo.length}（成功 ${ok} 失败 ${fail}）`); save(); }
    await sleep(120);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
apply();
save();
logLine(LOG, { ts: stamp(), src: path.basename(SRC), ok, fail });
console.log(`完成：成功 ${ok}，失败 ${fail} → ${OUT}`);
