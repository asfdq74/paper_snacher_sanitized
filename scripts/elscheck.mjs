// Elsevier API 通不通？换网络/换出口后先跑这个（3 秒出结论）
//
//   node scripts/elscheck.mjs
//
// 判定逻辑：
//   摘要接口 200 + 全文接口 200   → 完全可用，可以用 api 命令批量下
//   摘要接口 200 + 全文接口 403   → key 正常，但缺机构授权（insttoken）或不在校园网
//   摘要接口也失败               → key 本身有问题
import fs from 'node:fs';
import path from 'node:path';
import { STATE, ts } from './lib.mjs';

const KEY_FILE = path.join(STATE, 'elsevier_key.txt');
const INSTTOKEN_FILE = path.join(STATE, 'elsevier_insttoken.txt');
const DOI = '10.1016/j.cclet.2023.108544';

if (!fs.existsSync(KEY_FILE)) { console.log(`找不到 ${KEY_FILE}`); process.exit(2); }
const KEY = fs.readFileSync(KEY_FILE, 'utf8').trim();
const INSTTOKEN = fs.existsSync(INSTTOKEN_FILE) ? fs.readFileSync(INSTTOKEN_FILE, 'utf8').trim() : '';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function egressIp() {
  for (const u of ['https://ipinfo.io/ip', 'https://ip.3322.net', 'https://ifconfig.me/ip']) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'curl/8' } });
      const t = (await r.text()).trim();
      if (/^\d+\.\d+\.\d+\.\d+$/.test(t)) return { ip: t, src: u };
    } catch {}
  }
  return { ip: '', src: '' };
}

async function call(url, accept) {
  const h = { Accept: accept, 'User-Agent': 'elscheck/1.0' };
  if (KEY) h['X-ELS-APIKey'] = KEY;
  if (INSTTOKEN) h['X-ELS-Insttoken'] = INSTTOKEN;
  try {
    const r = await fetch(url, { headers: h, redirect: 'follow', signal: AbortSignal.timeout(60000) });
    const buf = Buffer.from(await r.arrayBuffer());
    const magic = buf.slice(0, 5).toString('latin1');
    return { status: r.status, ct: (r.headers.get('content-type') || '').split(';')[0], len: buf.length, magic, body: buf.slice(0, 260).toString('utf8') };
  } catch (e) { return { status: 0, err: String(e.message || e).slice(0, 80) }; }
}

const ip = await egressIp();
console.log(ts(), '出口 IP:', ip.ip || '(取不到)', ip.src ? `via ${ip.src}` : '');
const isCampus = /^202\.116\./.test(ip.ip) || /^10\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\./.test(ip.ip);
console.log('         校园网段判断:', ip.ip ? (isCampus ? '✓ 看起来在Example University网段内' : '✗ 不在Example University网段（校园网出口一般是 203.0.113.x）') : '(无法判断)');
console.log('         insttoken:', INSTTOKEN ? '已配置' : '未配置');
console.log('');

const abs = await call(`https://api.elsevier.com/content/abstract/doi/${DOI}`, 'application/json');
await sleep(600);
const pdf = await call(`https://api.elsevier.com/content/article/doi/${DOI}?httpAccept=application%2Fpdf`, 'application/pdf');

const absOk = abs.status === 200;
const pdfOk = pdf.status === 200 && pdf.magic === '%PDF-';
console.log(`摘要接口 : ${abs.status} ${abs.ct || ''} ${abs.len}B ${absOk ? '✓' : '✗'}`);
console.log(`全文接口 : ${pdf.status} ${pdf.ct || ''} ${pdf.len}B ${pdfOk ? '✓ ' + pdf.magic : '✗'}`);
if (!absOk && abs.body) console.log('  摘要响应:', abs.body.replace(/\s+/g, ' ').slice(0, 200));
if (!pdfOk && pdf.body) console.log('  全文响应:', pdf.body.replace(/\s+/g, ' ').slice(0, 200));
console.log('');

if (absOk && pdfOk) {
  console.log('结论：API 全文可用 → 可以直接跑');
  console.log('  node scripts\\scidir.mjs api --list data\\manifests\\newlist3_sd.json --outdir E:\\paper_snacherdl\\downloads_api');
  process.exit(0);
}
if (absOk && !pdfOk) {
  console.log('结论：key 正常，但全文接口被拒。原因只有两个：');
  console.log('  1) 缺 insttoken（机构令牌）——需要图书馆向 Elsevier 申请，个人拿不到；');
  console.log('  2) 当前出口不在 Elsevier 认可的本校 IP 段内。');
  console.log('  换出口后重跑本脚本；出口要变成 203.0.113.x 才算走对路。');
  process.exit(3);
}
console.log('结论：连摘要接口都失败，key 本身可能有问题（或被限流）。');
process.exit(4);
