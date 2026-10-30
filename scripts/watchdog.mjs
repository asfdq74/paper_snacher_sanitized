// 下载看门狗：盯着 scidir 批量下载，只在该报警的时候报警。
//
//   node scripts\watchdog.mjs --mode webvpn
//   node scripts\watchdog.mjs --mode carsi --restart
//
// 四条判据（与用户约定一致）：
//   1) 后台进程不在了
//   2) 剩余数量长时间不减少（卡住）
//   3) 连续失败（最近窗口内连续 non-ok）
//   4) 全部完成
//
// 报警：写 state\watchdog_alerts.log + 写 state\watchdog_status.txt + Windows 托盘通知
//
// 参数：
//   --mode carsi|webvpn   决定进程匹配与重启入口（默认 webvpn）
//   --interval 10         检查间隔（秒）
//   --stall-min 10        剩余数量多少分钟不变算卡住
//   --fail-streak 5       最近窗口内连续失败多少篇算异常
//   --fail-window 15      判据 3 只看最近多少分钟的日志（关键：避开历史日志）
//   --restart             进程死了自动重启下载
//   --block-restart       遇到风控页自动"清理 + 重启"
//   --block-trigger 2     最近窗口内出现几次风控就触发清理重启
//   --block-cooldown 0    两次清理重启之间的间隔（分钟，0 = 见一次清一次）
//   --quiet               不打印心跳，只输出告警
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, MANIFESTS, STATE, connect, resolveDownloadPath } from './lib.mjs';

const args = process.argv.slice(2);
const getArg = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const has = n => args.includes(n);

const MODE = getArg('--mode', 'webvpn');

// 每个模式只动自己的东西。关键：杀进程/删 profile 都按模式限定，
// 否则 SciDir 的风控清理会把 Wiley 的浏览器一起干掉。
const MODES = {
  webvpn: {
    label: 'SciDir / WebVPN',
    nodeMatch: '*scidir.mjs*',
    cmdMatch: '*SciDir*',
    edgeMatch: '*browser_profile_scidir*',
    entry: '开始下载-SciDir.cmd',
    port: 9227,
    profiles: ['.browser_profile_scidir', '.browser_profile_scidir_login'],
    cookieFile: 'scidir_cookies.json',
    blockText: /there was a problem providing the content you requested|contact our support team for more information/i,
  },
  carsi: {
    label: 'SciDir / CARSI',
    nodeMatch: '*scidir.mjs*',
    cmdMatch: '*SciDir*',
    edgeMatch: '*browser_profile_scidir*',
    entry: '开始下载-SciDir-CARSI.cmd',
    port: 9226,
    profiles: ['.browser_profile_scidir_login'],   // 直连模式下登录和下载共用同一个 profile
    cookieFile: 'scidir_cookies.json',
    blockText: /there was a problem providing the content you requested|contact our support team for more information/i,
  },
  wiley: {
    label: 'Wiley',
    nodeMatch: '*wiley.mjs*',
    cmdMatch: '*Wiley*',
    edgeMatch: '*browser_profile_wiley*',
    entry: '开始下载-Wiley-Advanced.cmd',
    port: 9231,
    profiles: ['.browser_profile_wiley', '.browser_profile_wiley_login'],
    cookieFile: 'wiley_cookies.json',
    blockText: /just a moment|checking your browser|access denied|request blocked|unusual traffic|are you a robot/i,
  },
};
if (!MODES[MODE]) {
  console.log(`未知 --mode ${MODE}，可选：${Object.keys(MODES).join(' / ')}`);
  process.exit(2);
}
const M = MODES[MODE];
const INTERVAL = Math.max(5, parseInt(getArg('--interval', '10'), 10) || 10) * 1000;
const STALL_MIN = parseFloat(getArg('--stall-min', '10')) || 10;
const FAIL_STREAK = parseInt(getArg('--fail-streak', '5'), 10) || 5;
const FAIL_WINDOW = parseFloat(getArg('--fail-window', '15')) || 15;
const RESTART = has('--restart');
const BLOCK_RESTART = has('--block-restart');
const BLOCK_TRIGGER = parseInt(getArg('--block-trigger', '2'), 10) || 2;
// 默认不冷却：见到风控就清理重启。只保留 15 秒的硬地板，
// 防止新进程还没起来的窗口期被反复判定，导致几十秒内刷出几百个进程。
const BLOCK_COOLDOWN_MS = Math.max(15000, (parseFloat(getArg('--block-cooldown', '0')) || 0) * 60000);
// IP 级封禁（Akamai 通常 30 分钟 TTL）下，清理完立刻重启只会继续撞同一堵墙，
// 而且每次撞击都会让封禁续期。所以清理后必须静默等待。
const QUIET = has('--quiet');

const IDX = MODE === 'wiley'
  ? { list: 'list2_papers.json', out: 'downloads_wiley2', log: 'wiley_log.jsonl', outlog: 'wiley_out.log' }
  : { list: 'newlist3_sd.json', out: 'downloads_scidir', log: 'scidir_log.jsonl', outlog: 'scidir_out.log' };
const LIST = path.resolve(getArg('--list', path.join(MANIFESTS, IDX.list)));
const OUT = resolveDownloadPath(getArg('--dir', IDX.out));
const LOG = path.resolve(getArg('--log', path.join(STATE, IDX.log)));
const ALERTS = path.join(STATE, 'watchdog_alerts.log');
const STATUS = path.join(STATE, 'watchdog_status.txt');
const CMD = path.join(ROOT, M.entry);
const RESTART_COOLDOWN_MS = 3 * 60 * 1000;
const OUTLOG = path.join(STATE, IDX.outlog);
const PORT = parseInt(getArg('--port', String(M.port)), 10);
const BLOCK_TEXT = M.blockText;

// ---- 直接读下载浏览器当前页面：风控页出现后能立刻发现，不必等这一篇处理完 ----
let cdp = null;
async function pageBlockedNow() {
  try {
    if (!cdp) {
      const c = await connect(PORT);
      cdp = c.page;
    }
    const txt = await cdp.evaluate(() => {
      const t = document.body ? document.body.innerText : '';
      const h = document.documentElement ? document.documentElement.innerHTML : '';
      return (t + ' ' + h).slice(0, 6000);
    });
    return BLOCK_TEXT.test(txt);
  } catch {
    cdp = null;
    return null;   // 连不上（窗口关了/在重启）不作判断
  }
}

const fmt = ms => {
  if (!isFinite(ms) || ms <= 0) return '-';
  const h = Math.floor(ms / 3600000), m = Math.round((ms % 3600000) / 60000);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
};

function ps(cmd) {
  try { return execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 15000 }).trim(); }
  catch { return ''; }
}

function procInfo() {
  const out = ps(`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '${M.nodeMatch}' } | ForEach-Object { $_.CommandLine }`);
  const lines = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return {
    total: lines.length,
    downloading: lines.filter(l => /download/.test(l)).length,
    loggingIn: lines.filter(l => /login/.test(l)).length,
  };
}

function notify(title, msg) {
  try {
    const t = JSON.stringify(title), m = JSON.stringify(msg);
    execFileSync('powershell', ['-NoProfile', '-Command', `
      try {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        $n = New-Object System.Windows.Forms.NotifyIcon
        $n.Icon = [System.Drawing.SystemIcons]::Warning
        $n.Visible = $true
        $n.ShowBalloonTip(20000, ${t}, ${m}, 'Warning')
        Start-Sleep -Seconds 7
        $n.Dispose()
      } catch {}
    `], { timeout: 25000 });
  } catch {}
}

// ---------------------------------------------------------------- 风控处置

/** sinceMs 之后的风控次数：jsonl 状态（主）+ out.log 字样（辅） */
function blockedRecent(sinceMs) {
  const cutoff = sinceMs;
  let fromJson = 0;
  try {
    const log = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    fromJson = log.filter(e => /blocked/.test(e.status) && new Date(e.ts).getTime() >= cutoff).length;
  } catch {}
  let fromOut = 0;
  let lastLine = '';
  try {
    const lines = fs.readFileSync(OUTLOG, 'utf8').split('\n').slice(-400);
    for (const l of lines) {
      const m = l.match(/^(\d{2}:\d{2}:\d{2})/);
      if (m && /风控|blocked/i.test(l)) {
        const t = new Date(); const [hh, mm, ss] = m[1].split(':').map(Number);
        t.setHours(hh, mm, ss, 0);
        if (t.getTime() >= cutoff) { fromOut++; lastLine = l.trim(); }
      }
    }
  } catch {}
  return { total: fromJson + fromOut, fromJson, fromOut, lastLine };
}

function killAll() {
  const out = [];
  const script = `
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
      Where-Object { $_.CommandLine -like '${M.nodeMatch}' } |
      ForEach-Object { taskkill /F /T /PID $_.ProcessId 2>&1 | Out-Null }
    Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
      Where-Object { $_.CommandLine -like '${M.cmdMatch}' } |
      ForEach-Object { taskkill /F /T /PID $_.ProcessId 2>&1 | Out-Null }
    Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" |
      Where-Object { $_.CommandLine -like '${M.edgeMatch}' } |
      ForEach-Object { taskkill /F /T /PID $_.ProcessId 2>&1 | Out-Null }
  `;
  try { ps(script); out.push(`已结束 ${M.label} 的 node/cmd/edge 进程（只动本模式）`); }
  catch (e) { out.push('杀进程失败: ' + e.message); }
  return out;
}

/** 清理**全部** cookie：把该模式涉及的所有浏览器 profile 连同导出的 cookie 文件全清空。
 *  与 scripts/scidir.mjs 的 wipeAllCookies() 行为对齐 —— 清完必须重新登录。 */
function clean(mode) {
  const done = [];
  // 1) 删掉全部相关 profile（cookie / localStorage / 站点数据都在里面）
  for (const name of (M.profiles || [])) {
    const full = path.join(ROOT, name);
    if (!full.startsWith(ROOT)) { done.push('跳过越界路径: ' + name); continue; }
    if (!fs.existsSync(full)) { continue; }
    try { fs.rmSync(full, { recursive: true, force: true }); done.push('已删除 profile ' + name); }
    catch (e) { done.push('删 ' + name + ' 失败: ' + e.message); }
  }
  // 2) 导出成文件的 cookie 也清空
  if (M.cookieFile) {
    try {
      const f = path.join(STATE, M.cookieFile);
      const before = fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) || []).length : 0;
      fs.writeFileSync(f, '[]');
      done.push(`已清空 ${M.cookieFile}（原有 ${before} 个 cookie）`);
    } catch (e) { done.push('清空 cookie 文件失败: ' + e.message); }
  }
  return done;
}

function relaunch() {
  try {
    ps(`Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','"${CMD}"' -WindowStyle Hidden`);
    return true;
  } catch (e) { console.log('  重启失败: ' + e.message); return false; }
}

const fired = new Set();
function alert(key, title, msg) {
  if (fired.has(key)) return;
  fired.add(key);
  const line = `[${new Date().toLocaleString()}] ${title} :: ${msg}`;
  try { fs.appendFileSync(ALERTS, line + '\n'); } catch {}
  console.log('ALERT  ' + line);
  notify(title, msg);
}
const clear = key => fired.delete(key);

function readState() {
  const total = JSON.parse(fs.readFileSync(LIST, 'utf8')).length;
  let files = 0;
  try { files = fs.readdirSync(OUT).filter(f => f.endsWith('.pdf')).length; } catch {}

  let log = [];
  try {
    log = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {}

  // 只取最近 FAIL_WINDOW 分钟内的记录——这是修掉"历史失败被算成连续失败"的关键
  const cutoff = Date.now() - FAIL_WINDOW * 60000;
  const recent = log.filter(e => new Date(e.ts).getTime() >= cutoff);

  let streak = 0;
  const streakEntries = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    // A paywall is an expected terminal result for an unsubscribed journal.
    // It also proves the session is working, so it ends a failure streak.
    if (recent[i].status === 'ok' || recent[i].status === 'paywall') break;
    streak++;
    streakEntries.unshift(recent[i]);
  }
  const streakIds = streakEntries.map(e => `${e.id}(${e.status})`);
  const allNoAccess = streak > 0 && streakEntries.every(e => /no_access/.test(e.note || ''));
  const paywalls = recent.filter(e => e.status === 'paywall').length;

  const oks = log.filter(e => e.status === 'ok').slice(-30).map(e => e.secs || 0).sort((a, b) => a - b);
  const median = oks.length ? oks[Math.floor(oks.length / 2)] : 0;
  const lastTs = log.length ? new Date(log[log.length - 1].ts).getTime() : 0;

  return {
    total, files, remaining: total - files, streak, streakIds,
    allNoAccess, paywalls, median, lastTs,
  };
}

console.log(`watchdog(mode=${MODE} / ${M.label}) 启动`);
console.log(`  间隔 ${INTERVAL / 1000}s | 卡住阈值 ${STALL_MIN}min | 连续失败 ${FAIL_STREAK} 篇（看最近 ${FAIL_WINDOW}min 日志）`);
console.log(`  监视日志 → ${path.basename(LOG)}   清单 → ${path.basename(LIST)}`);
console.log(`  告警 → ${ALERTS}`);
console.log(`  重启入口 → ${path.basename(CMD)}${RESTART ? '（已启用自动重启）' : '（仅告警，不自动重启）'}`);
console.log(`  遇风控清理 → 全部 cookie：profile [${(M.profiles || []).join(', ')}] + ${M.cookieFile || '-'}`);

let lastRemaining = -1;
let lastChangeAt = Date.now();
let deadStreak = 0;
let lastRestartAt = 0;
let lastBlockCleanAt = 0;
let done = false;
let blockEvents = 0;

for (;;) {
  const s = readState();
  const p = procInfo();

  if (s.remaining !== lastRemaining) {
    if (lastRemaining >= 0 && s.remaining < lastRemaining) {
      clear('stall'); clear('dead');
    }
    lastRemaining = s.remaining;
    lastChangeAt = Date.now();
  }

  const status = [
    `time=${new Date().toLocaleString()}`,
    `mode=${MODE}`,
    `remaining=${s.remaining}/${s.total}`,
    `downloaded=${s.files}`,
    `median_secs=${s.median}`,
    `fail_streak=${s.streak}`,
    `paywalls=${s.paywalls}`,
    `procs=${p.total}(dl=${p.downloading},login=${p.loggingIn})`,
    `since_last_log=${s.lastTs ? Math.round((Date.now() - s.lastTs) / 1000) + 's' : 'n/a'}`,
    `idle_remaining=${fmt(Date.now() - lastChangeAt)}`,
  ].join('  ');
  try { fs.writeFileSync(STATUS, status + '\n'); } catch {}
  if (!QUIET) console.log(status);

  // 4) 全部完成
  if (s.remaining <= 0) {
    alert('done', '论文下载完成', `全部 ${s.total} 篇已完成 → ${OUT}`);
    done = true;
    break;
  }

  // 1) 进程不在了（连续两次确认，避开 .cmd 重启之间的空档）
  if (p.total === 0) {
    deadStreak++;
    if (deadStreak >= 2) {
      alert('dead', '下载进程已停止', `剩余 ${s.remaining} 篇。${RESTART ? 'watchdog 正在尝试重启…' : '需要手动重跑 ' + path.basename(CMD)}`);
      if (RESTART && Date.now() - lastRestartAt > RESTART_COOLDOWN_MS) {
        lastRestartAt = Date.now();
        try {
          execFileSync('powershell', ['-NoProfile', '-Command',
            `Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','"${CMD}"' -WindowStyle Hidden`], { timeout: 20000 });
          console.log('  已发起重启');
          clear('dead');
        } catch (e) { console.log('  重启失败: ' + e.message); }
      }
    }
    await new Promise(r => setTimeout(r, INTERVAL));
    continue;
  }
  deadStreak = 0;

  // 正在等用户登录：不做卡住判定，只提示
  if (p.loggingIn > 0) {
    alert('needlogin', '需要登录', '登录窗口已打开，请在窗口里完成统一身份认证。');
    await new Promise(r => setTimeout(r, INTERVAL));
    continue;
  }
  clear('needlogin');

  // 3) 连续失败
  if (s.streak >= FAIL_STREAK) {
    const head = s.allNoAccess
      ? '连续 no_access —— 机构会话很可能已失效，需要重新登录'
      : '连续失败，可能是网络或风控问题';
    alert('fail', `连续失败 ${s.streak} 篇`, `${head}。最近：${s.streakIds.slice(-6).join(', ')}`);
  } else {
    clear('fail');
  }

  // 3.5) 风控页 → 自动清理 + 重启
  if (BLOCK_RESTART) {
    // 判定窗口 = 最近 FAIL_WINDOW 分钟，但**不早于上次清理时刻**——
    // 否则清理完窗口里旧的风控记录还在，会立刻再触发一次，变成死循环。
    const since = Math.max(Date.now() - FAIL_WINDOW * 60000, lastBlockCleanAt || 0);
    const b = blockedRecent(since);
    // 实时读浏览器页面：这是有效的信号——实测它读到的确实是 Elsevier 的
    // "There was a problem providing the content you requested" 封禁页，
    // 而付费墙页文案完全不同（"does not subscribe"），不会误命中。
    const live = await pageBlockedNow();
    if (live) { b.total++; b.lastLine = b.lastLine || '（浏览器当前页面就是封禁页）'; b.hint = 1; }
    if (b.total > 0) blockEvents += 0;    // 计数只用于展示
    if (b.total >= BLOCK_TRIGGER && Date.now() - lastBlockCleanAt > BLOCK_COOLDOWN_MS) {
      lastBlockCleanAt = Date.now();
      blockEvents++;
      console.log(`\n风控处置 #${blockEvents}：检出 ${b.total} 次风控信号（日志=${b.fromJson} out=${b.fromOut} 页面=${b.hint || 0}）`);
      if (b.lastLine) console.log('  最后一条: ' + b.lastLine.slice(0, 120));
      const k = killAll(); k.forEach(x => console.log('  ' + x));
      await new Promise(r => setTimeout(r, 4000));      // 等文件句柄释放
      const c = clean(MODE); c.forEach(x => console.log('  ' + x));
      await new Promise(r => setTimeout(r, 2000));
      const ok = relaunch();                            // 遇风控：清理完立即重启
      // 每次风控处置都是独立事件，用 alertAlways：每次都记日志 + 弹通知，
      // 不走 fired 去重（否则第二、三次风控就静默了）。
      const title = `风控第 ${blockEvents} 次：已清理并重启`;
      const msg = `${b.total} 次风控信号（日志=${b.fromJson} out=${b.fromOut} 页面=${b.hint || 0}）。${k.concat(c).join('；')}。重启${ok ? '成功' : '失败'}。`;
      const line = `[${new Date().toLocaleString()}] ${title} :: ${msg}`;
      try { fs.appendFileSync(ALERTS, line + '\n'); } catch {}
      console.log('ALERT  ' + line);
      notify(title, msg);
      fired.delete('blocked');
      fired.delete('stall'); fired.delete('dead'); fired.delete('fail');
      lastChangeAt = Date.now();
      await new Promise(r => setTimeout(r, 60000));     // 给新进程一分钟启动
      continue;
    }
    if (b.total === 0) clear('blocked');
  }

  // 2) 卡住
  const idleMs = Date.now() - lastChangeAt;
  if (idleMs > STALL_MIN * 60000) {
    alert('stall', `下载卡住 ${Math.round(idleMs / 60000)} 分钟`, `剩余仍是 ${s.remaining} 篇，进程还在但没进展（最近日志 ${s.lastTs ? Math.round((Date.now() - s.lastTs) / 1000) + 's 前' : '无'}）。`);
  } else {
    clear('stall');
  }

  await new Promise(r => setTimeout(r, INTERVAL));
}

console.log(done ? 'watchdog 正常退出：任务完成' : 'watchdog 退出');
