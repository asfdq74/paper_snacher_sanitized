// Example University WebVPN/CAS 共用登录与验证码处理。
//
// 主下载器和独立登录入口都通过本模块处理滑块验证，避免各维护一套识别逻辑。
// 账号密码只保存在进程内，不写入日志或状态文件。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { ROOT, STATE, sleep, ts, logLine, WEBVPN_BASE_URL } from './lib.mjs';

export const WEBVPN_START_URL = WEBVPN_BASE_URL;
export const MOTION_PROFILES = [
  'linear', 'ease', 'jitter', 'stepped',
  'human', 'human_slow', 'human_fast',
];

const DETECTOR = path.join(ROOT, 'scripts', 'detect_captcha_gap.py');
const CAPTCHA_LOG = path.join(STATE, 'captcha_login.jsonl');
const MAX_CAPTCHA_ATTEMPTS = 2;

export function redact(value) {
  return String(value || '')
    .replace(/(ticket|token|code|password|passwd|pwd)=([^&\s]+)/gi, '$1=***')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '***@***');
}

export function ensureWorkspaceDir(target) {
  const workspace = path.resolve(ROOT);
  const full = path.resolve(target);
  if (full !== workspace && !full.toLowerCase().startsWith(workspace.toLowerCase() + path.sep)) {
    throw new Error(`拒绝操作工作区外路径: ${full}`);
  }
  fs.mkdirSync(full, { recursive: true });
  return full;
}

function askLine(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, answer => {
    rl.close();
    resolve(answer);
  }));
}

function askSecret(question) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return askLine(question);
  }
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    let value = '';
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
    };
    const onData = chunk => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u007f' || char === '\b') {
          if (value) {
            value = value.slice(0, -1);
            process.stdout.write('\b \b');
          }
          continue;
        }
        value += char;
        process.stdout.write('*');
      }
    };
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    stdin.once('error', err => {
      cleanup();
      reject(err);
    });
  });
}

export async function readCredentials({ prompt = true, noPrompt = false } = {}) {
  let username = String(process.env.WEBVPN_USERNAME || '').trim();
  let password = String(process.env.WEBVPN_PASSWORD || '');
  if (prompt && process.stdin.isTTY && !noPrompt) {
    if (!username) {
      username = (await askLine('WEBVPN_ID（直接回车则稍后手动填写）: ')).trim();
    }
    if (!password) {
      password = await askSecret('密码（直接回车则稍后手动填写）: ');
    }
  }
  // 子进程不再继承凭据，运行日志也不会包含凭据值。
  delete process.env.WEBVPN_USERNAME;
  delete process.env.WEBVPN_PASSWORD;
  return { username, password };
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function between(random, range) {
  return range[0] + random() * (range[1] - range[0]);
}

function summarizeTrace(events) {
  const deltas = events.map(event => Math.abs(event.dx)).filter(Boolean);
  const finalX = events.at(-1)?.x || 0;
  const furthestX = Math.max(...events.map(event => event.x), 0);
  return {
    eventCount: events.length,
    durationMs: events.at(-1)?.t || 0,
    uniqueDeltaX: new Set(deltas).size,
    meanDeltaX: deltas.length
      ? Number((deltas.reduce((sum, value) => sum + value, 0) / deltas.length).toFixed(3))
      : 0,
    pauseEvents: events.filter(event => event.pauseMs > 0).length,
    overshootPx: Number((furthestX - finalX).toFixed(1)),
    integerCoordinates: events.every(event => Number.isInteger(event.x) && Number.isInteger(event.y)),
  };
}

function humanConfig(name) {
  return {
    human: {
      duration: [900, 1200], overshoot: [3, 6], pathHeight: [1.2, 2.6],
      hoverDelay: [140, 260], holdAfterDown: [80, 150], midPause: [35, 85],
      overshootHold: [80, 150], finalHold: [90, 150], sampleStep: [11, 18],
    },
    human_slow: {
      duration: [1350, 1800], overshoot: [2, 4], pathHeight: [0.8, 1.8],
      hoverDelay: [180, 340], holdAfterDown: [120, 220], midPause: [60, 130],
      overshootHold: [150, 260], finalHold: [130, 220], sampleStep: [14, 23],
    },
    human_fast: {
      duration: [620, 850], overshoot: [6, 10], pathHeight: [1.5, 3.2],
      hoverDelay: [90, 170], holdAfterDown: [55, 100], midPause: [20, 55],
      overshootHold: [55, 110], finalHold: [70, 120], sampleStep: [9, 15],
    },
  }[name];
}

function makeHumanTrace(name, distance, seed) {
  const config = humanConfig(name);
  if (!config) throw new Error(`未知人类化轨迹类型: ${name}`);
  const random = seededRandom(seed + name.length * 92821);
  const durationMs = Math.round(between(random, config.duration));
  const overshoot = Math.max(0, Math.min(
    between(random, config.overshoot),
    304 - distance,
  ));
  const pathHeight = between(random, config.pathHeight);
  const hoverBeforeDownMs = Math.round(between(random, config.hoverDelay));
  const holdAfterDownMs = Math.round(between(random, config.holdAfterDown));
  const midPauseMs = Math.round(between(random, config.midPause));
  const overshootHoldMs = Math.round(between(random, config.overshootHold));
  const finalHoldMs = Math.round(between(random, config.finalHold));
  const events = [];
  let elapsed = 0;
  let previousX = 0;
  let previousY = 0;
  const push = (x, y, pauseMs = 0) => {
    const rx = Number(x.toFixed(1));
    const ry = Number(y.toFixed(1));
    events.push({
      t: Math.round(elapsed), x: rx, y: ry,
      dx: Number((rx - previousX).toFixed(1)),
      dy: Number((ry - previousY).toFixed(1)), pauseMs,
    });
    previousX = rx;
    previousY = ry;
  };
  push(0, 0);
  const steps = Math.max(28, Math.round(durationMs / 14));
  const pauseAt = 0.38 + random() * 0.24;
  let paused = false;
  for (let index = 1; index <= steps; index++) {
    elapsed += between(random, config.sampleStep);
    const progress = index / steps;
    const eased = progress * progress * (3 - 2 * progress);
    const x = (distance + overshoot) * eased;
    const y = pathHeight * Math.sin(Math.PI * progress) * Math.sin(progress * Math.PI * 4.8);
    const shouldPause = !paused && progress >= pauseAt;
    push(x, y, shouldPause ? midPauseMs : 0);
    paused ||= shouldPause;
  }
  elapsed += overshootHoldMs;
  push(distance + overshoot, 0);
  const correctionSteps = 7;
  for (let index = 1; index <= correctionSteps; index++) {
    elapsed += 110 / correctionSteps;
    const progress = index / correctionSteps;
    const x = index === correctionSteps
      ? distance
      : distance + overshoot * (1 - progress) ** 2;
    push(x, 0);
  }
  elapsed += finalHoldMs;
  push(distance, 0);
  return {
    schema: 'webvpn-captcha-trace/v1', createdAt: new Date().toISOString(),
    profile: name, seed, distance: Number(distance.toFixed(1)),
    durationMs: events.at(-1).t, sampleHz: null,
    behavior: {
      hoverBeforeDownMs, holdAfterDownMs, midPauseMs,
      overshootPx: Number(overshoot.toFixed(1)), overshootHoldMs, finalHoldMs,
      pathHeight: Number(pathHeight.toFixed(2)), nonIntegerCoordinates: true,
    },
    events, features: summarizeTrace(events),
  };
}

export function createMotionTrace(name, distance, seed = 20261017) {
  if (!MOTION_PROFILES.includes(name)) throw new Error(`未知轨迹类型: ${name}`);
  if (!Number.isFinite(distance) || distance <= 0) throw new Error('轨迹位移必须大于 0');
  if (name.startsWith('human')) return makeHumanTrace(name, distance, seed);
  const random = seededRandom(seed + name.length * 1009);
  const durationMs = name === 'ease' ? 640 : name === 'jitter' ? 760 : 540;
  const sampleHz = 60;
  const count = Math.round(durationMs / (1000 / sampleHz));
  const events = [];
  let previousX = 0;
  let previousY = 0;
  for (let i = 0; i <= count; i++) {
    const ratio = i / count;
    let progress = ratio;
    let y = 0;
    let pauseMs = 0;
    if (name === 'ease') progress = ratio < 0.5 ? 4 * ratio ** 3 : 1 - ((-2 * ratio + 2) ** 3) / 2;
    if (name === 'jitter') y = Math.sin(ratio * Math.PI * 7) * 2.1 + (random() - 0.5) * 1.4;
    if (name === 'stepped') {
      progress = Math.floor(ratio * 8) / 8;
      pauseMs = i > 0 && i < count ? 24 : 0;
    }
    const x = Math.round(distance * progress);
    const ry = Math.round(y);
    events.push({ t: Math.round(i * (1000 / sampleHz)), x, y: ry, dx: x - previousX, dy: ry - previousY, pauseMs });
    previousX = x;
    previousY = ry;
  }
  return {
    schema: 'webvpn-captcha-trace/v1', createdAt: new Date().toISOString(),
    profile: name, seed, distance: Number(distance.toFixed(1)),
    durationMs: events.at(-1).t, sampleHz, events, features: summarizeTrace(events),
  };
}

export async function readCasPageState(page) {
  return page.evaluate(() => {
    const visible = element => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0
        && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const body = document.body ? document.body.innerText.slice(0, 800) : '';
    const captcha = document.querySelector('#captcha');
    const token = document.querySelector('input[name="NECaptchaValidate"]');
    const loginButton = [...document.querySelectorAll(
      '#index_login_btn .login_box_landing_btn, .login_box_landing_btn',
    )].find(visible);
    const error = document.querySelector('#errormsg');
    const tips = document.querySelector('.yidun_tips');
    return {
      host: location.hostname, href: location.href, url: location.href,
      title: document.title, body, bodyHint: body.slice(0, 600),
      hasAccount: Boolean(document.querySelector('#un')),
      hasPassword: Boolean(document.querySelector('#pd')),
      accountFilled: Boolean(document.querySelector('#un')?.value?.trim()),
      passwordFilled: Boolean(document.querySelector('#pd')?.value),
      captchaVisible: visible(captcha),
      captchaChildren: captcha ? captcha.querySelectorAll('*').length : 0,
      tokenReady: Boolean(token?.value), tokenLength: token?.value?.length || 0,
      tips: tips?.innerText?.trim() || '',
      loginButtonVisible: Boolean(loginButton), loginButton: Boolean(loginButton),
      error: error?.innerText?.trim().slice(0, 300) || '',
      gateway: /502 Bad Gateway|504 Gateway Time-out|WebVPN.*(错误|失败)/i.test(
        `${document.title}\n${body}`,
      ),
      wafBlocked: /网关错误|云防护|访问被拒绝|Web Application Firewall/i.test(
        `${document.title}\n${body}`,
      ),
    };
  }).catch(() => null);
}

export function isCasPageState(state) {
  return /^icas\.webvpn\.edu\.cn$/i.test(state?.host || '')
    || /\/cas\/login/i.test(state?.href || '')
    || /统一身份认证/.test((state?.body || '').slice(0, 200));
}

export function isWebVpnLoggedInState(state) {
  return /^webvpn\.webvpn\.edu\.cn$/i.test(state?.host || '')
    && !/\/cas\/login/i.test(state?.href || '')
    && !isCasPageState(state) && !state?.gateway;
}

export async function fillCasCredentials(page, credentials) {
  const filled = { username: false, password: false };
  if (!credentials) return filled;
  for (const [name, selector, value] of [
    ['username', '#un', credentials.username],
    ['password', '#pd', credentials.password],
  ]) {
    if (!value) continue;
    const input = page.locator(selector).first();
    if (!(await input.count())) continue;
    const current = await input.inputValue().catch(() => '');
    if (current) continue;
    await input.fill(value);
    filled[name] = true;
  }
  return filled;
}

export async function clickCasLogin(page) {
  const button = page.locator(
    '#index_login_btn .login_box_landing_btn:visible, .login_box_landing_btn:visible',
  ).last();
  if (await button.count()) {
    try {
      await button.click({ timeout: 10000 });
      return true;
    } catch {}
  }
  return false;
}

export async function submitExistingLogin(page) {
  const before = await readCasPageState(page);
  if (!before?.accountFilled || !before?.passwordFilled) {
    throw new Error('浏览器未自动填充账号和密码，拒绝点击登录');
  }
  if (!(await clickCasLogin(page))) throw new Error('找不到立即登录按钮');
  await sleep(12000);
  return readCasPageState(page);
}

export async function fillAndSubmitCasLogin(page, credentials) {
  if (!credentials?.username || !credentials?.password) {
    throw new Error('缺少 WEBVPN_USERNAME 或 WEBVPN_PASSWORD');
  }
  await fillCasCredentials(page, credentials);
  const state = await readCasPageState(page);
  if (!state?.accountFilled || !state?.passwordFilled) {
    throw new Error('验证码通过后仍未出现账号/密码输入框');
  }
  if (!(await clickCasLogin(page))) throw new Error('找不到立即登录按钮');
  await sleep(10000);
  return readCasPageState(page);
}

export async function waitForBrowserAutofill(page, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let state = await readCasPageState(page);
  let focusAttempted = false;
  while (Date.now() < deadline) {
    state = await readCasPageState(page);
    if (state?.accountFilled && state?.passwordFilled) {
      return { filled: true, state, focusAttempted };
    }
    if (!focusAttempted && Date.now() > deadline - timeoutMs + 1800) {
      focusAttempted = true;
      await page.locator('#un').first().click({ timeout: 3000 }).catch(() => {});
      await sleep(800);
      if (!(await readCasPageState(page))?.passwordFilled) {
        await page.locator('#pd').first().click({ timeout: 3000 }).catch(() => {});
      }
    }
    await sleep(250);
  }
  return { filled: false, state, focusAttempted };
}

export async function readCaptchaAssets(page) {
  await page.locator('.yidun_bg-img').first().waitFor({ state: 'visible', timeout: 30000 });
  await page.locator('.yidun_jigsaw').first().waitFor({ state: 'visible', timeout: 30000 });
  return page.evaluate(() => {
    const background = document.querySelector('.yidun_bg-img');
    const piece = document.querySelector('.yidun_jigsaw');
    const control = document.querySelector('.yidun_slider');
    const rect = element => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    };
    return {
      backgroundSrc: background?.currentSrc || background?.src || '',
      pieceSrc: piece?.currentSrc || piece?.src || '',
      backgroundRect: background ? rect(background) : null,
      pieceRect: piece ? rect(piece) : null,
      sliderRect: control ? rect(control) : null,
    };
  });
}

async function downloadAsset(url, file) {
  const response = await fetch(url, {
    redirect: 'follow', signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`图片下载失败 HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(file, bytes);
  return bytes.length;
}

export async function prepareGapImages(page, runDir, assets) {
  ensureWorkspaceDir(runDir);
  const backgroundFile = path.join(runDir, 'background');
  const pieceFile = path.join(runDir, 'piece');
  try {
    if (!assets.backgroundSrc || !assets.pieceSrc) throw new Error('缺少图片 URL');
    await downloadAsset(assets.backgroundSrc, `${backgroundFile}.jpg`);
    await downloadAsset(assets.pieceSrc, `${pieceFile}.png`);
    return {
      mode: 'source-assets', background: `${backgroundFile}.jpg`,
      piece: `${pieceFile}.png`,
    };
  } catch (error) {
    console.log(ts(), `原图下载失败，改用页面截图: ${redact(error.message)}`);
    await page.locator('.yidun_bg-img').first().screenshot({ path: `${backgroundFile}.png` });
    await page.locator('.yidun_jigsaw').first().screenshot({ path: `${pieceFile}.png` });
    return {
      mode: 'page-screenshots', background: `${backgroundFile}.png`,
      piece: `${pieceFile}.png`,
    };
  }
}

export function detectGapDistance(images, displayWidth, runDir) {
  const annotated = path.join(runDir, 'gap-detected.png');
  const child = spawnSync(process.env.PAPER_SNACHER_PYTHON || 'python', [
    DETECTOR, '--background', images.background, '--piece', images.piece,
    '--display-width', String(displayWidth), '--annotated', annotated,
  ], { encoding: 'utf8', timeout: 45000, windowsHide: true });
  if (child.status !== 0) {
    throw new Error(`缺口检测失败: ${redact(child.stderr || child.stdout)}`);
  }
  const lines = String(child.stdout || '').trim().split(/\r?\n/);
  return { ...JSON.parse(lines.at(-1)), annotated };
}

export async function replayCaptchaTrace(page, trace, runDir) {
  const slider = page.locator('.yidun_slider').first();
  const box = await slider.boundingBox();
  if (!box) throw new Error('找不到可见的滑块手柄');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  const actual = [];
  const hoverBeforeDownMs = trace.behavior?.hoverBeforeDownMs ?? 120;
  const holdAfterDownMs = trace.behavior?.holdAfterDownMs ?? 0;
  const preReleaseSettleMs = trace.behavior?.finalHoldMs
    ? Math.max(150, Math.round(trace.behavior.finalHoldMs * 0.65)) : 180;
  await page.mouse.move(startX, startY);
  await sleep(hoverBeforeDownMs);
  await page.mouse.down();
  if (holdAfterDownMs) await sleep(holdAfterDownMs);
  const startedAt = Date.now();
  for (const event of trace.events) {
    const wait = startedAt + event.t - Date.now();
    if (wait > 0) await sleep(wait);
    const x = startX + event.x;
    const y = startY + event.y;
    await page.mouse.move(x, y);
    actual.push({
      t: Date.now() - startedAt, x: Number(x.toFixed(2)), y: Number(y.toFixed(2)),
      requestedX: event.x, requestedY: event.y,
    });
    if (event.pauseMs) await sleep(event.pauseMs);
  }
  await sleep(preReleaseSettleMs);
  const dragState = await page.evaluate(() => {
    const rect = element => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    };
    return {
      pieceRect: rect(document.querySelector('.yidun_jigsaw')),
      sliderRect: rect(document.querySelector('.yidun_slider')),
      tips: document.querySelector('.yidun_tips')?.innerText?.trim() || '',
      backgroundSrc: document.querySelector('.yidun_bg-img')?.currentSrc || '',
    };
  });
  if (runDir) await page.screenshot({ path: path.join(runDir, 'captcha-dragged.png'), fullPage: true });
  await page.mouse.up();
  return {
    start: { x: Number(startX.toFixed(2)), y: Number(startY.toFixed(2)) },
    elapsedMs: Date.now() - startedAt, hoverBeforeDownMs, holdAfterDownMs,
    preReleaseSettleMs, beforeRelease: dragState, actualEvents: actual,
  };
}

export async function waitForCaptchaResult(page, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readCasPageState(page);
    if (last?.tokenLength > 0) return { accepted: true, state: last };
    if (/失败|错误|重试|再试/.test(last?.tips || '')) {
      return { accepted: false, reason: 'captcha_rejected', state: last };
    }
    await sleep(250);
  }
  return { accepted: false, reason: 'token_not_ready', state: last };
}

function newEvidenceDir(label) {
  const safeLabel = String(label || 'login').replace(/[^a-z0-9_-]+/gi, '-').slice(0, 48);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return ensureWorkspaceDir(path.join(STATE, 'captcha', `${safeLabel}-${stamp}`));
}

function logCaptchaEvent(event) {
  logLine(CAPTCHA_LOG, { ts: new Date().toISOString(), ...event });
}

async function refreshCaptcha(page, previousSrc) {
  const refresh = page.locator(
    '.yidun_refresh:visible, .yidun-refresh:visible',
  ).first();
  if (await refresh.count().catch(() => 0)) {
    await refresh.click({ timeout: 3000 }).catch(() => {});
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await sleep(500);
    const assets = await readCaptchaAssets(page).catch(() => null);
    if (assets?.backgroundSrc && assets.backgroundSrc !== previousSrc) return true;
  }
  return false;
}

async function solveCaptchaOnce(page, {
  label, profile, sliderOffset, requestedDistance, seed, attempt,
}) {
  const runDir = newEvidenceDir(`${label}-attempt-${attempt}`);
  await page.screenshot({ path: path.join(runDir, 'captcha-before.png'), fullPage: true });
  const assets = await readCaptchaAssets(page);
  if (!assets.backgroundRect || !assets.sliderRect) throw new Error('验证码图像尺寸不可读');
  const images = await prepareGapImages(page, runDir, assets);
  const detected = requestedDistance === null
    ? detectGapDistance(images, assets.backgroundRect.width, runDir)
    : { distance_css: Number(requestedDistance.toFixed(1)), source: 'manual', confidence: null };
  const pieceDistance = detected.distance_css;
  const maxDrag = Math.max(1, assets.backgroundRect.width - assets.sliderRect.width);
  const dragDistance = Math.min(maxDrag, Math.max(1, pieceDistance + sliderOffset));
  const traceSeed = seed === null ? crypto.randomInt(0, 0xffffffff) : seed;
  const trace = createMotionTrace(profile, dragDistance, traceSeed);
  fs.writeFileSync(path.join(runDir, 'trace.json'), `${JSON.stringify(trace, null, 2)}\n`);
  const replay = await replayCaptchaTrace(page, trace, runDir);
  const outcome = await waitForCaptchaResult(page);
  await page.screenshot({
    path: path.join(runDir, outcome.accepted ? 'captcha-accepted.png' : 'captcha-rejected.png'),
    fullPage: true,
  }).catch(() => {});
  return {
    accepted: Boolean(outcome.accepted), reason: outcome.reason || '',
    confidence: detected.confidence ?? null, pieceDistance, dragDistance, sliderOffset,
    runDir, previousBackgroundSrc: assets.backgroundSrc, replay, finalState: outcome.state,
  };
}

export async function solveWebVpnCaptcha(page, {
  label = 'login', profile = 'human', sliderOffset = 12.2,
  requestedDistance = null, seed = null, maxAttempts = MAX_CAPTCHA_ATTEMPTS,
} = {}) {
  if (!MOTION_PROFILES.includes(profile)) throw new Error(`未知轨迹类型: ${profile}`);
  if (!Number.isFinite(sliderOffset)) throw new Error('sliderOffset 必须是数字');
  if (seed !== null && (!Number.isInteger(seed) || seed < 0)) {
    throw new Error('seed 必须是非负整数');
  }
  const attempts = Math.max(1, Math.min(MAX_CAPTCHA_ATTEMPTS, Number(maxAttempts) || 1));
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const startedAt = Date.now();
    try {
      last = await solveCaptchaOnce(page, {
        label, profile, sliderOffset, requestedDistance, seed, attempt,
      });
      logCaptchaEvent({
        label, profile, attempt, accepted: last.accepted, reason: last.reason,
        confidence: last.confidence, pieceDistance: last.pieceDistance,
        dragDistance: Number(last.dragDistance.toFixed(2)),
        secs: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
      });
      if (last.accepted) return last;
      if (attempt < attempts && !(await refreshCaptcha(page, last.previousBackgroundSrc))) break;
    } catch (error) {
      last = { accepted: false, reason: redact(error?.message || error), confidence: null, runDir: null };
      logCaptchaEvent({ label, profile, attempt, accepted: false, reason: last.reason });
      if (attempt >= attempts) break;
    }
  }
  return last || { accepted: false, reason: 'captcha_not_found' };
}

export function createCasLoginController(page, {
  credentials = null, captchaMode = 'auto', captchaProfile = 'human',
  browserAutofill = false,
  captchaMaxAttempts = MAX_CAPTCHA_ATTEMPTS, label = 'login', logger = console.log,
} = {}) {
  const mode = captchaMode === 'manual' ? 'manual' : 'auto';
  let captchaRoundStarted = false;
  let submitted = false;
  let submittedAt = 0;
  let manualFallbackLogged = false;
  let lastCaptchaLogAt = 0;

  return {
    async poll() {
      const state = await readCasPageState(page);
      if (!state || !isCasPageState(state)) return { handled: false, state };
      if (state.gateway || state.wafBlocked) return { handled: true, state };
      if (submitted && Date.now() - submittedAt > 15000 && !state.tokenReady) submitted = false;

      if (state.tokenReady) {
        const filled = await fillCasCredentials(page, credentials);
        if (filled.username || filled.password) {
          logger(ts(), '验证码已通过，已自动填写账号密码。');
        }
        if (browserAutofill && (!credentials?.username || !credentials?.password)) {
          const autofill = await waitForBrowserAutofill(page, 10000);
          logger(ts(), autofill.filled
            ? '已触发浏览器自动填充账号密码。'
            : '浏览器未自动填充账号密码，请手动填写。');
        }
        const refreshed = await readCasPageState(page);
        if (!submitted && refreshed?.accountFilled && refreshed?.passwordFilled
            && refreshed?.loginButtonVisible) {
          submitted = await clickCasLogin(page);
          submittedAt = Date.now();
          if (submitted) logger(ts(), '验证码已通过，正在提交登录…');
        }
        return { handled: true, state: refreshed || state, submitted };
      }

      if (state.captchaVisible && mode === 'auto' && !captchaRoundStarted) {
        captchaRoundStarted = true;
        logger(ts(), `检测到滑块验证，自动识别中（最多 ${captchaMaxAttempts} 次）…`);
        const result = await solveWebVpnCaptcha(page, {
          label, profile: captchaProfile, maxAttempts: captchaMaxAttempts,
        });
        if (result.accepted) logger(ts(), '滑块验证通过，等待登录表单就绪…');
        else logger(ts(), `自动验证码未通过（${result.reason || 'unknown'}），请手动完成滑块。`);
        return { handled: true, state: await readCasPageState(page), captcha: result };
      }

      if (state.captchaVisible && mode === 'manual' && !manualFallbackLogged) {
        manualFallbackLogged = true;
        logger(ts(), '验证码模式为 manual，等待你手动完成滑块。');
      }
      if (state.captchaVisible && mode === 'auto' && captchaRoundStarted
          && Date.now() - lastCaptchaLogAt > 30000) {
        lastCaptchaLogAt = Date.now();
        logger(ts(), '自动验证码未完成，请在浏览器中手动完成滑块。');
      }
      return { handled: true, state };
    },
  };
}
