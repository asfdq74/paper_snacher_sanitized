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
export const DEFAULT_CAPTCHA_QUALITY = Object.freeze({
  minConfidence: 50,
  minScore: 0.50,
  minCorrelation: 0.55,
  minMargin: 0.02,
});
const USERNAME_SELECTORS = [
  '#un',
  'input[name="username"]',
  'input[name="user"]',
  'input[name="account"]',
  'input[autocomplete="username"]',
];
const PASSWORD_SELECTORS = [
  '#pd',
  'input[name="password"]',
  'input[type="password"]',
];
const LOGIN_BUTTON_SELECTORS = [
  '#index_login_btn .login_box_landing_btn',
  '.login_box_landing_btn',
  'form button[type="submit"]',
  'form input[type="submit"]',
];

export function redact(value) {
  return String(value || '')
    .replace(/(ticket|token|code|password|passwd|pwd)=([^&\s]+)/gi, '$1=***')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '***@***');
}

export function captchaOptionsFromArgs(args = {}) {
  const numberOption = (name, fallback) => {
    const raw = args[name];
    if (raw === undefined || raw === true) return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    captchaSliderOffset: numberOption('slider-offset', 12.2),
    captchaRetryMinMs: Math.max(200, numberOption('captcha-retry-min-ms', 900)),
    captchaRetryMaxMs: Math.max(400, numberOption('captcha-retry-max-ms', 3600)),
    captchaQuality: {
      minConfidence: numberOption(
        'captcha-min-confidence',
        DEFAULT_CAPTCHA_QUALITY.minConfidence,
      ),
      minScore: numberOption('captcha-min-score', DEFAULT_CAPTCHA_QUALITY.minScore),
      minCorrelation: numberOption(
        'captcha-min-correlation',
        DEFAULT_CAPTCHA_QUALITY.minCorrelation,
      ),
      minMargin: numberOption('captcha-min-margin', DEFAULT_CAPTCHA_QUALITY.minMargin),
    },
  };
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

function liveBetween(min, max) {
  return min + Math.random() * (max - min);
}

async function humanClick(page, locator, { hoverMs = 120, holdMs = 90 } = {}) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const box = await locator.boundingBox();
  if (!box) return false;
  const viewport = page.viewportSize()
    || await page.evaluate(() => ({ width: innerWidth, height: innerHeight })).catch(() => null);
  const width = viewport?.width || 1400;
  const height = viewport?.height || 950;
  const targetX = box.x + box.width * liveBetween(0.35, 0.65);
  const targetY = box.y + box.height * liveBetween(0.35, 0.65);
  const startX = Math.max(2, Math.min(width - 2, targetX + liveBetween(-55, 55)));
  const startY = Math.max(2, Math.min(height - 2, targetY + liveBetween(18, 48)));
  const steps = Math.round(liveBetween(7, 14));
  await page.mouse.move(startX, startY);
  for (let index = 1; index <= steps; index++) {
    const progress = index / steps;
    const eased = 1 - (1 - progress) ** 3;
    await page.mouse.move(
      startX + (targetX - startX) * eased + liveBetween(-0.35, 0.35),
      startY + (targetY - startY) * eased + liveBetween(-0.25, 0.25),
    );
    await sleep(liveBetween(9, 24));
  }
  await sleep(liveBetween(hoverMs * 0.7, hoverMs * 1.5));
  await page.mouse.down();
  await sleep(liveBetween(holdMs * 0.7, holdMs * 1.4));
  await page.mouse.up();
  await sleep(liveBetween(90, 260));
  return true;
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
      overshootChance: 0.58, endJitter: 0.8,
    },
    human_slow: {
      duration: [1350, 1800], overshoot: [2, 4], pathHeight: [0.8, 1.8],
      hoverDelay: [180, 340], holdAfterDown: [120, 220], midPause: [60, 130],
      overshootHold: [150, 260], finalHold: [130, 220], sampleStep: [14, 23],
      overshootChance: 0.38, endJitter: 1.0,
    },
    human_fast: {
      duration: [620, 850], overshoot: [6, 10], pathHeight: [1.5, 3.2],
      hoverDelay: [90, 170], holdAfterDown: [55, 100], midPause: [20, 55],
      overshootHold: [55, 110], finalHold: [70, 120], sampleStep: [9, 15],
      overshootChance: 0.72, endJitter: 0.65,
    },
  }[name];
}

function makeHumanTrace(name, distance, seed) {
  const config = humanConfig(name);
  if (!config) throw new Error(`未知人类化轨迹类型: ${name}`);
  const random = seededRandom(seed + name.length * 92821);
  // Fitts-law-like duration scaling: farther targets take longer, but with
  // diminishing growth rather than a linear delay.
  const fitts = Math.log2(1 + Math.max(1, distance) / 40);
  const distanceScale = Math.max(0.78, Math.min(1.45, fitts / Math.log2(5)));
  const durationMs = Math.round(between(random, config.duration) * distanceScale);
  const hasOvershoot = random() < config.overshootChance;
  const overshoot = hasOvershoot ? Math.max(0, Math.min(
    between(random, config.overshoot),
    304 - distance,
  )) : 0;
  const pathHeight = between(random, config.pathHeight);
  const hoverBeforeDownMs = Math.round(between(random, config.hoverDelay));
  const holdAfterDownMs = Math.round(between(random, config.holdAfterDown));
  const pauseRoll = random();
  const pauseCount = pauseRoll < 0.18 ? 0 : pauseRoll < 0.82 ? 1 : 2;
  const pausePoints = Array.from({ length: pauseCount }, () => 0.28 + random() * 0.46)
    .sort((a, b) => a - b);
  const pauseDurations = pausePoints.map(() => Math.round(between(random, config.midPause)));
  const overshootHoldMs = Math.round(between(random, config.overshootHold));
  const finalHoldMs = Math.round(between(random, config.finalHold));
  const correctionSteps = overshoot > 0
    ? 3 + Math.floor(random() * 7)
    : (random() < 0.35 ? 1 + Math.floor(random() * 2) : 0);
  const endX = Math.max(1, distance + between(random, [-config.endJitter, config.endJitter]));
  const endY = between(random, [-0.45, 0.45]);
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
  let pauseIndex = 0;
  for (let index = 1; index <= steps; index++) {
    elapsed += between(random, config.sampleStep);
    const progress = index / steps;
    const eased = progress * progress * (3 - 2 * progress);
    const x = (distance + overshoot) * eased;
    const y = pathHeight * Math.sin(Math.PI * progress) * Math.sin(progress * Math.PI * 4.8);
    const shouldPause = pauseIndex < pausePoints.length && progress >= pausePoints[pauseIndex];
    const pauseMs = shouldPause ? pauseDurations[pauseIndex] : 0;
    if (shouldPause) pauseIndex++;
    push(x, y, pauseMs);
  }
  elapsed += overshootHoldMs;
  push(distance + overshoot, 0);
  for (let index = 1; index <= correctionSteps; index++) {
    elapsed += between(random, [90, 145]) / correctionSteps;
    const progress = index / correctionSteps;
    const x = index === correctionSteps
      ? endX
      : distance + overshoot * (1 - progress) ** 2;
    push(x, 0);
  }
  elapsed += finalHoldMs;
  push(endX, endY);
  return {
    schema: 'webvpn-captcha-trace/v1', createdAt: new Date().toISOString(),
    profile: name, seed, distance: Number(distance.toFixed(1)),
    finalDistance: Number(endX.toFixed(1)),
    durationMs: events.at(-1).t, sampleHz: null,
    behavior: {
      hoverBeforeDownMs, holdAfterDownMs,
      pauseCount, pauseDurations, distanceScale: Number(distanceScale.toFixed(2)),
      overshootPx: Number(overshoot.toFixed(1)), overshootHoldMs, finalHoldMs,
      correctionSteps, endJitter: { x: Number((endX - distance).toFixed(2)), y: Number(endY.toFixed(2)) },
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
    const firstVisible = selectors => {
      for (const selector of selectors) {
        for (const element of document.querySelectorAll(selector)) {
          if (visible(element)) return element;
        }
      }
      return null;
    };
    const passwordInput = firstVisible([
      '#pd',
      'input[name="password"]',
      'input[type="password"]',
    ]);
    const loginForm = passwordInput?.closest('form')
      || document.querySelector('#un')?.closest('form')
      || null;
    const usernameInput = firstVisible([
      '#un',
      'input[name="username"]',
      'input[name="user"]',
      'input[name="account"]',
      'input[autocomplete="username"]',
    ]) || loginForm?.querySelector(
      'input[type="text"], input[type="email"], input:not([type])',
    );
    const captcha = firstVisible(['#captcha', '.yidun_panel', '.yidun_control']);
    const token = document.querySelector('input[name="NECaptchaValidate"]');
    const explicitButton = firstVisible([
      '#index_login_btn .login_box_landing_btn',
      '.login_box_landing_btn',
      'form button[type="submit"]',
      'form input[type="submit"]',
    ]);
    const textButton = [...document.querySelectorAll(
      'button, input[type="submit"], a[role="button"]',
    )].find(element => (
      visible(element) && /立即登录|登录|sign in/i.test(
        `${element.innerText || ''} ${element.value || ''}`,
      )
    ));
    const loginButton = explicitButton || textButton;
    const error = document.querySelector(
      '#errormsg, [role="alert"], .error-message, .login-error',
    );
    const tips = document.querySelector('.yidun_tips, [class*="yidun"][class*="tip"]');
    return {
      host: location.hostname, href: location.href, url: location.href,
      title: document.title, body, bodyHint: body.slice(0, 600),
      hasAccount: Boolean(usernameInput),
      hasPassword: Boolean(passwordInput),
      accountField: Boolean(usernameInput),
      passwordField: Boolean(passwordInput),
      accountFilled: Boolean(usernameInput?.value?.trim()),
      passwordFilled: Boolean(passwordInput?.value),
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
  const host = String(state?.host || '').toLowerCase();
  const href = String(state?.href || '');
  const body = String(state?.body || '').slice(0, 800);
  const loginControls = Boolean(
    state?.hasAccount || state?.hasPassword || state?.captchaVisible || state?.tokenReady,
  );
  return /\/cas(?:\/|_)|auth4|icas|sso|login/i.test(href)
    || /统一身份认证|统一身份|账号登录|sign in|log in/i.test(body)
    || (loginControls && host !== new URL(WEBVPN_START_URL).hostname.toLowerCase());
}

export function isWebVpnLoggedInState(state) {
  return String(state?.host || '').toLowerCase() === new URL(WEBVPN_START_URL).hostname.toLowerCase()
    && !/\/cas\/login/i.test(state?.href || '')
    && !isCasPageState(state) && !state?.gateway;
}

export async function fillCasCredentials(page, credentials) {
  const filled = { username: false, password: false };
  if (!credentials) return filled;
  for (const [name, selectors, value] of [
    ['username', USERNAME_SELECTORS, credentials.username],
    ['password', PASSWORD_SELECTORS, credentials.password],
  ]) {
    if (!value) continue;
    for (const selector of selectors) {
      const input = page.locator(`${selector}:visible`).first();
      if (!(await input.count())) continue;
      const current = await input.inputValue().catch(() => '');
      if (!current) {
        await humanClick(page, input, { hoverMs: 100, holdMs: 70 });
        await input.fill(value);
        filled[name] = true;
      }
      break;
    }
  }
  return filled;
}

export async function waitForCasLoginForm(page, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readCasPageState(page);
    if (last?.hasAccount && last?.hasPassword) return last;
    await sleep(250);
  }
  return last;
}

export async function clickCasLogin(page) {
  for (const selector of LOGIN_BUTTON_SELECTORS) {
    const button = page.locator(`${selector}:visible`).last();
    if (!(await button.count())) continue;
    try {
      if (await humanClick(page, button, { hoverMs: 170, holdMs: 105 })) return true;
    } catch {}
  }
  const textButton = page.getByRole('button', { name: /立即登录|登录|sign in/i }).last();
  if (await textButton.count().catch(() => 0)) {
    try {
      if (await humanClick(page, textButton, { hoverMs: 170, holdMs: 105 })) return true;
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
      const username = page.locator('#un:visible, input[name="username"]:visible').first();
      await humanClick(page, username).catch(() => {});
      await sleep(800);
      if (!(await readCasPageState(page))?.passwordFilled) {
        const password = page.locator('#pd:visible, input[type="password"]:visible').first();
        await humanClick(page, password).catch(() => {});
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

export function evaluateCaptchaQuality(detected, thresholds = DEFAULT_CAPTCHA_QUALITY) {
  const quality = {
    confidence: Number(detected?.confidence ?? 0),
    score: Number(detected?.score ?? 0),
    correlation: Number(detected?.correlation ?? 0),
    margin: Number(detected?.score ?? 0) - Number(detected?.runner_up_score ?? 0),
  };
  const issues = [];
  if (quality.confidence < thresholds.minConfidence) issues.push('minConfidence');
  if (quality.score < thresholds.minScore) issues.push('minScore');
  if (quality.correlation < thresholds.minCorrelation) issues.push('minCorrelation');
  if (quality.margin < thresholds.minMargin) issues.push('minMargin');
  return { ok: issues.length === 0, issues, quality };
}

export async function replayCaptchaTrace(page, trace, runDir) {
  const slider = page.locator('.yidun_slider').first();
  const box = await slider.boundingBox();
  if (!box) throw new Error('找不到可见的滑块手柄');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  const pointerStartX = startX + liveBetween(
    -Math.min(4, box.width * 0.15),
    Math.min(4, box.width * 0.15),
  );
  const pointerStartY = startY + liveBetween(
    -Math.min(3, box.height * 0.12),
    Math.min(3, box.height * 0.12),
  );
  const actual = [];
  const hoverBeforeDownMs = trace.behavior?.hoverBeforeDownMs ?? 120;
  const holdAfterDownMs = trace.behavior?.holdAfterDownMs ?? 0;
  const preReleaseSettleMs = trace.behavior?.finalHoldMs
    ? Math.max(150, Math.round(trace.behavior.finalHoldMs * 0.65)) : 180;

  // Approach from a nearby point instead of teleporting directly onto the handle.
  const approachX = pointerStartX - liveBetween(28, 62);
  const approachY = pointerStartY + liveBetween(-12, 18);
  const approachSteps = Math.round(liveBetween(6, 11));
  await page.mouse.move(approachX, approachY);
  for (let index = 1; index <= approachSteps; index++) {
    const progress = index / approachSteps;
    await page.mouse.move(
      approachX + (pointerStartX - approachX) * progress + liveBetween(-0.4, 0.4),
      approachY + (pointerStartY - approachY) * progress + liveBetween(-0.3, 0.3),
    );
    await sleep(liveBetween(10, 24));
  }
  await sleep(hoverBeforeDownMs);
  await page.mouse.down();
  if (holdAfterDownMs) await sleep(holdAfterDownMs);
  const startedAt = Date.now();
  for (const event of trace.events) {
    const wait = startedAt + event.t - Date.now();
    if (wait > 0) await sleep(wait);
    const x = pointerStartX + event.x;
    const y = pointerStartY + event.y;
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
  await sleep(liveBetween(180, 420));
  const endX = pointerStartX + (trace.finalDistance ?? trace.distance);
  const exitX = endX + liveBetween(12, 38);
  const exitY = pointerStartY + liveBetween(9, 25);
  const exitSteps = Math.round(liveBetween(5, 10));
  for (let index = 1; index <= exitSteps; index++) {
    const progress = index / exitSteps;
    await page.mouse.move(
      endX + (exitX - endX) * progress,
      pointerStartY + (exitY - pointerStartY) * progress,
    );
    await sleep(liveBetween(10, 22));
  }
  return {
    start: { x: Number(pointerStartX.toFixed(2)), y: Number(pointerStartY.toFixed(2)) },
    elapsedMs: Date.now() - startedAt, hoverBeforeDownMs, holdAfterDownMs,
    preReleaseSettleMs, beforeRelease: dragState, actualEvents: actual,
  };
}

export async function waitForCaptchaResult(page, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await readCasPageState(page);
    const formReady = !last?.captchaVisible && last?.hasAccount && last?.hasPassword;
    if (last?.tokenLength > 0 || formReady) {
      return { accepted: true, reason: formReady ? 'form_ready' : 'token_ready', state: last };
    }
    if (/失败|错误|重试|再试|拖动.*(?:正确|完成)/.test(`${last?.tips || ''} ${last?.error || ''}`)) {
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

async function refreshCaptcha(page, previousAssetKey) {
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
    const key = assets?.backgroundSrc || assets?.pieceSrc
      ? `${assets.backgroundSrc}|${assets.pieceSrc}`
      : '';
    if (key && key !== previousAssetKey) return true;
  }
  return false;
}

async function solveCaptchaOnce(page, {
  label, profile, sliderOffset, requestedDistance, seed, attempt,
  qualityThresholds = DEFAULT_CAPTCHA_QUALITY,
}) {
  const runDir = newEvidenceDir(`${label}-attempt-${attempt}`);
  await page.screenshot({ path: path.join(runDir, 'captcha-before.png'), fullPage: true });
  const assets = await readCaptchaAssets(page);
  if (!assets.backgroundRect || !assets.sliderRect) throw new Error('验证码图像尺寸不可读');
  const images = await prepareGapImages(page, runDir, assets);
  const detected = requestedDistance === null
    ? detectGapDistance(images, assets.backgroundRect.width, runDir)
    : { distance_css: Number(requestedDistance.toFixed(1)), source: 'manual', confidence: null };
  const quality = requestedDistance === null
    ? evaluateCaptchaQuality(detected, qualityThresholds)
    : { ok: true, issues: [], quality: null };
  fs.writeFileSync(
    path.join(runDir, 'detector.json'),
    `${JSON.stringify({ detected, quality }, null, 2)}\n`,
  );
  const assetKey = `${assets.backgroundSrc}|${assets.pieceSrc}`;
  if (!quality.ok) {
    await page.screenshot({
      path: path.join(runDir, 'captcha-low-confidence.png'),
      fullPage: true,
    }).catch(() => {});
    return {
      accepted: false,
      reason: `low_confidence:${quality.issues.join(',')}`,
      detector: detected,
      quality,
      confidence: detected.confidence ?? null,
      pieceDistance: detected.distance_css,
      dragDistance: 0,
      sliderOffset,
      runDir,
      previousBackgroundSrc: assets.backgroundSrc,
      previousAssetKey: assetKey,
      replay: null,
      finalState: await readCasPageState(page),
    };
  }
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
    detector: detected, quality,
    confidence: detected.confidence ?? null, pieceDistance, dragDistance, sliderOffset,
    runDir, previousBackgroundSrc: assets.backgroundSrc,
    previousAssetKey: assetKey, replay, finalState: outcome.state,
  };
}

export async function solveWebVpnCaptcha(page, {
  label = 'login', profile = 'human', sliderOffset = 12.2,
  requestedDistance = null, seed = null, maxAttempts = MAX_CAPTCHA_ATTEMPTS,
  qualityThresholds = DEFAULT_CAPTCHA_QUALITY,
  retryMinMs = 900, retryMaxMs = 3600,
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
        qualityThresholds,
      });
      logCaptchaEvent({
        label, profile, attempt, accepted: last.accepted, reason: last.reason,
        confidence: last.confidence, pieceDistance: last.pieceDistance,
        dragDistance: Number(last.dragDistance.toFixed(2)),
        score: last.detector?.score ?? null,
        correlation: last.detector?.correlation ?? null,
        qualityIssues: last.quality?.issues || [],
        runDir: last.runDir || null,
        secs: Number(((Date.now() - startedAt) / 1000).toFixed(1)),
      });
      if (last.accepted) return last;
      if (attempt < attempts) {
        const minDelay = Math.max(200, Math.min(retryMinMs, retryMaxMs));
        const maxDelay = Math.max(minDelay, retryMaxMs);
        const rejectedPenalty = String(last.reason || '').startsWith('low_confidence') ? 0 : 700;
        const delayMs = Math.round(liveBetween(minDelay + rejectedPenalty, maxDelay + rejectedPenalty));
        console.log(ts(), `验证码失败后等待 ${delayMs}ms 再刷新…`);
        await sleep(delayMs);
        if (!(await refreshCaptcha(page, last.previousAssetKey))) break;
      }
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
  captchaSliderOffset = 12.2,
  captchaQuality = DEFAULT_CAPTCHA_QUALITY,
  captchaRetryMinMs = 900,
  captchaRetryMaxMs = 3600,
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

      const formReadyWithoutToken = !state.captchaVisible
        && state.hasAccount && state.hasPassword;
      if (state.tokenReady || formReadyWithoutToken) {
        await waitForCasLoginForm(page, 6000);
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
        const refreshed = await waitForCasLoginForm(page, 2500);
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
          sliderOffset: captchaSliderOffset, qualityThresholds: captchaQuality,
          retryMinMs: captchaRetryMinMs, retryMaxMs: captchaRetryMaxMs,
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
