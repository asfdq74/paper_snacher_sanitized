// 查看下载进度
//
//   node scripts\progress.mjs              # 看一次
//   node scripts\progress.mjs --watch      # 每 30 秒刷新
//   node scripts\progress.mjs --watch 10   # 每 10 秒刷新
//
// 数据来源：清单 json + downloads_*/*.pdf + state/*_log.jsonl
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { STATE, MANIFESTS, ts, resolveDownloadPath } from './lib.mjs';

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const LIST = path.resolve(getArg('--list', path.join(MANIFESTS, 'newlist3_sd.json')));
const OUT = resolveDownloadPath(getArg('--dir', 'downloads_scidir'));
const LOG = path.resolve(getArg('--log', path.join(STATE, 'scidir_log.jsonl')));
const OUTLOG = path.join(STATE, 'scidir_out.log');

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

function runningProcesses() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*scidir*' } | Measure-Object).Count"],
      { encoding: 'utf8', timeout: 15000 });
    return parseInt(out.trim() || '0', 10);
  } catch { return -1; }
}

const fmtDur = ms => {
  if (!isFinite(ms) || ms <= 0) return '-';
  const h = Math.floor(ms / 3600000), m = Math.round((ms % 3600000) / 60000);
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分钟`;
};
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));

function report() {
  const items = JSON.parse(fs.readFileSync(LIST, 'utf8'));
  const total = items.length;

  let files = [];
  try { files = fs.readdirSync(OUT).filter(f => f.endsWith('.pdf')); } catch {}
  const haveIds = new Set(files.map(f => f.slice(0, -4)));
  const missingIds = items.filter(it => !haveIds.has(String(it.id))).map(it => String(it.id));

  const log = readJsonl(LOG);
  const latest = new Map();
  for (const e of log) latest.set(String(e.id), e);

  const now = Date.now();
  const lastTs = log.length ? new Date(log[log.length - 1].ts).getTime() : 0;
  const idleSec = lastTs ? Math.round((now - lastTs) / 1000) : -1;

  const recent = log.filter(e => now - new Date(e.ts).getTime() < 10 * 60 * 1000);
  const recentOk = recent.filter(e => e.status === 'ok');

  // 用最近 30 篇的单篇耗时中位数推算 ETA。
  // 不能用"墙钟完成数"——中间停过、测过的话，空闲时间会被算进速率里，ETA 会离谱。
  const lastN = log.filter(e => e.status === 'ok').slice(-30).map(e => e.secs || 0).sort((a, b) => a - b);
  const medianSecs = lastN.length ? lastN[Math.floor(lastN.length / 2)] : 0;
  const DELAY_SECS = parseFloat(getArg('--delay', '3')) || 3;
  const perItem = medianSecs + DELAY_SECS + 0.5;   // 单篇耗时 + 篇间隔 + 少量开销

  const remaining = missingIds.length;
  const etaMs = remaining * perItem * 1000;
  const perMin = perItem > 0 ? 60 / perItem : 0;

  const tally = {};
  for (const e of latest.values()) tally[e.status] = (tally[e.status] || 0) + 1;

  const fails = [...latest.values()].filter(e => e.status !== 'ok')
    .sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 8);

  const procs = runningProcesses();
  const pct = total ? ((haveIds.size / total) * 100).toFixed(1) : '0';

  const L = [];
  L.push('='.repeat(64));
  L.push(` ScienceDirect 进度   清单 ${path.basename(LIST)}`);
  L.push('='.repeat(64));
  L.push(` 清单总数     ${total}`);
  L.push(` 已下载       ${haveIds.size}      （${OUT}）`);
  L.push(` 剩余         ${remaining}`);
  L.push(` 完成率       ${pct}%`);
  L.push('');
  L.push(` 后台进程     ${procs > 0 ? `运行中（node x${procs}）` : procs === 0 ? '未运行' : '无法确定'}`);
  L.push(` 最近活动     ${lastTs ? new Date(lastTs).toLocaleTimeString() + `（${idleSec} 秒前）` : '（无日志）'}`);
  L.push(` 输出日志     ${OUTLOG}`);
  L.push('');
  L.push(` 近 10 分钟完成  ${recentOk.length} 篇`);
  if (lastN.length) {
    L.push(` 单篇耗时        中位 ${medianSecs}s，最快 ${lastN[0]}s，最慢 ${lastN[lastN.length - 1]}s（近 ${lastN.length} 篇）`);
  }
  L.push(` 折算速率        ${perMin.toFixed(1)} 篇/分钟（含 ${DELAY_SECS}s 篇间隔）`);
  L.push(` 预计剩余        ${fmtDur(etaMs)}　（预计完成 ${new Date(now + etaMs).toLocaleString()}）`);
  L.push('');
  L.push(' 状态分布（每个 id 取最新一次）');
  for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
    L.push(`   ${pad(k, 16)} ${v}`);
  }
  L.push('');
  L.push(' 最近 6 条');
  for (const e of log.slice(-6)) {
    L.push(`   ${new Date(e.ts).toLocaleTimeString()}  id=${pad(e.id, 8)} ${pad(e.status, 15)} ${pad(e.secs + 's', 5)} ${e.note || ''}`);
  }
  if (fails.length) {
    L.push('');
    L.push(' 最近失败（会重试的）');
    for (const e of fails) L.push(`   ${new Date(e.ts).toLocaleTimeString()}  id=${pad(e.id, 8)} ${pad(e.status, 15)} ${e.note || ''}`);
  }
  L.push('='.repeat(64));
  return L.join('\n');
}

if (args.includes('--watch')) {
  const every = Math.max(5, parseInt(getArg('--watch', '30'), 10) || 30);
  for (;;) {
    process.stdout.write('\x1Bc');
    console.log(report());
    console.log(`（每 ${every} 秒刷新，Ctrl+C 退出）`);
    await new Promise(r => setTimeout(r, every * 1000));
  }
} else {
  console.log(report());
}
