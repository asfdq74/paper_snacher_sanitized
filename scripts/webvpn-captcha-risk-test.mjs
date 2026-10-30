// Example University WebVPN 图片滑块样本采集器。
//
// 该入口只用于已授权测试，不参与主下载链路；主下载器复用 webvpn-auth.mjs。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, sleep, ts, parseArgs, opt,
  launchBrowser, connect, closeProfiles,
} from './lib.mjs';
import {
  WEBVPN_START_URL, MOTION_PROFILES, createMotionTrace as makeTrace, redact,
  ensureWorkspaceDir, readCasPageState, readCaptchaAssets, prepareGapImages,
  detectGapDistance, replayCaptchaTrace as replayTrace, waitForCaptchaResult,
  waitForBrowserAutofill, submitExistingLogin, fillAndSubmitCasLogin,
} from './webvpn-auth.mjs';

const OUT_DIR = path.join(ROOT, 'output', 'captcha-risk');
const PROFILES_DIR = path.join(OUT_DIR, 'profiles');
const LEGACY_PROFILES = [
  path.join(ROOT, '.browser_profile_captcha_probe'),
  path.join(ROOT, '.browser_profile_captcha_risk'),
];
const args = parseArgs();
const live = Boolean(args.run);
const login = Boolean(args.login);
const browserAutofill = Boolean(args['browser-autofill']);
const wantsLogin = login || browserAutofill;
const motionProfile = String(opt(args, 'profile', 'linear'));
const requestedDistance = args.distance === undefined ? null : Number(args.distance);
const autofillProfile = args['autofill-profile']
  ? path.resolve(ROOT, String(args['autofill-profile'])) : null;
const credentials = login ? {
  username: String(process.env.WEBVPN_CAPTCHA_TEST_USERNAME || ''),
  password: String(process.env.WEBVPN_CAPTCHA_TEST_PASSWORD || ''),
} : null;
delete process.env.WEBVPN_CAPTCHA_TEST_USERNAME;
delete process.env.WEBVPN_CAPTCHA_TEST_PASSWORD;

function usage() {
  console.log([
    '用法: node scripts/webvpn-captcha-risk-test.mjs [选项]',
    '  --dry-run                  生成轨迹样本，不访问网页',
    '  --run                      有头 Edge 执行一次验证码测试',
    '  --login                    验证码通过后填写测试账号并提交',
    '  --browser-autofill         使用复制后的浏览器 profile 自动填充',
    '  --profile <名称>           轨迹类型，默认 linear',
    '  --distance <像素>          手工位移；省略时自动检测',
    '  --seed <整数>              轨迹随机种子',
    '  --hold-ms <毫秒>           完成后保持窗口时间，默认 3000',
    '  --autofill-profile <目录>  自动填充源 profile',
    '',
    '运行 --run 需要 WEBVPN_CAPTCHA_TEST_AUTHORIZED=1；登录模式还需要',
    'WEBVPN_CAPTCHA_TEST_CONFIRM=1，并设置专用测试账号密码。',
  ].join('\n'));
}

function assertWorkspacePath(target) {
  const workspace = path.resolve(ROOT) + path.sep;
  const full = path.resolve(target);
  if (!full.toLowerCase().startsWith(workspace.toLowerCase())) {
    throw new Error(`拒绝操作工作区外路径: ${full}`);
  }
  return full;
}

function listTestProfiles() {
  const profiles = [];
  if (fs.existsSync(PROFILES_DIR)) {
    for (const entry of fs.readdirSync(PROFILES_DIR, { withFileTypes: true })) {
      if (entry.isDirectory()) profiles.push(path.join(PROFILES_DIR, entry.name));
    }
  }
  for (const legacy of LEGACY_PROFILES) if (fs.existsSync(legacy)) profiles.push(legacy);
  return profiles.map(assertWorkspacePath);
}

function prepareAutofillProfile(source, destination) {
  const sourceDir = assertWorkspacePath(source);
  const targetDir = assertWorkspacePath(destination);
  if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
    throw new Error(`自动填充源 profile 不存在: ${sourceDir}`);
  }
  ensureWorkspaceDir(targetDir);
  ensureWorkspaceDir(path.join(targetDir, 'Default'));
  const files = [
    'Local State', 'Default/Login Data', 'Default/Login Data For Account',
    'Default/Preferences', 'Default/Web Data',
  ];
  const copied = [];
  let bytes = 0;
  for (const relative of files) {
    const from = path.join(sourceDir, relative);
    if (!fs.existsSync(from)) continue;
    const to = path.join(targetDir, relative);
    ensureWorkspaceDir(path.dirname(to));
    fs.copyFileSync(from, to);
    bytes += fs.statSync(to).size;
    copied.push(relative);
  }
  if (!copied.includes('Local State') || !copied.includes('Default/Login Data')) {
    throw new Error('源 profile 缺少 Local State 或 Login Data');
  }
  return { source: path.basename(sourceDir), copiedFiles: copied, bytes };
}

async function cleanupCredentials() {
  const profiles = listTestProfiles();
  if (profiles.length) await closeProfiles(profiles, { quiet: true });
  for (const profile of profiles) fs.rmSync(profile, { recursive: true, force: true });
  return { profilesRemoved: profiles.length };
}

function saveJson(name, value) {
  ensureWorkspaceDir(OUT_DIR);
  const file = path.join(OUT_DIR, name);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function runDryRun() {
  if (!MOTION_PROFILES.includes(motionProfile)) {
    throw new Error(`未知轨迹类型: ${motionProfile}`);
  }
  const names = String(opt(args, 'profiles', motionProfile))
    .split(',').map(value => value.trim()).filter(Boolean);
  const distance = Number.isFinite(requestedDistance) && requestedDistance > 0 ? requestedDistance : 160;
  const seed = Number(opt(args, 'seed', 20261017));
  const files = names.map(name => saveJson(`trace-${name}-${Date.now()}.json`, makeTrace(name, distance, seed)));
  console.log('已生成自动化轨迹样本：');
  for (const file of files) console.log(`  ${file}`);
}

async function loadLoginPage(page) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    await page.goto(WEBVPN_START_URL, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
    await sleep(4000);
    const state = await readCasPageState(page);
    const gateway = !state || /502 Bad Gateway|504 Gateway Time-out/i.test(`${state.title}\n${state.body}`);
    console.log(ts(), `页面尝试 ${attempt}/4: ${state?.title || '不可读'}`);
    if (!gateway) return state;
    if (attempt < 4) await sleep(attempt * 4000);
  }
  throw new Error('认证网关连续返回 502/504');
}

function validateLiveRun() {
  if (process.env.WEBVPN_CAPTCHA_TEST_AUTHORIZED !== '1') {
    throw new Error('缺少 WEBVPN_CAPTCHA_TEST_AUTHORIZED=1，拒绝执行线上测试');
  }
  if (!MOTION_PROFILES.includes(motionProfile)) throw new Error(`未知轨迹类型: ${motionProfile}`);
  if (requestedDistance !== null && (!Number.isFinite(requestedDistance) || requestedDistance <= 0)) {
    throw new Error('--distance 必须是正数');
  }
  if (login && browserAutofill) throw new Error('--login 与 --browser-autofill 不能同时使用');
  if (browserAutofill) {
    if (!autofillProfile) throw new Error('浏览器自动填充模式需要 --autofill-profile');
    if (!fs.existsSync(autofillProfile) || !fs.statSync(autofillProfile).isDirectory()) {
      throw new Error(`自动填充源 profile 不存在: ${autofillProfile}`);
    }
  }
  if (wantsLogin && process.env.WEBVPN_CAPTCHA_TEST_CONFIRM !== '1') {
    throw new Error('登录样本需设置 WEBVPN_CAPTCHA_TEST_CONFIRM=1');
  }
  if (login && (!credentials?.username || !credentials?.password)) {
    throw new Error('登录样本必须提供专用测试账号和密码环境变量');
  }
}

async function runLive() {
  validateLiveRun();
  ensureWorkspaceDir(OUT_DIR);
  ensureWorkspaceDir(PROFILES_DIR);
  const cleanup = await cleanupCredentials();
  console.log(ts(), `清理完成: profile ${cleanup.profilesRemoved} 个`);

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(OUT_DIR, `run-${runId}`);
  const testProfile = path.join(PROFILES_DIR, `profile-${runId}-${process.pid}`);
  ensureWorkspaceDir(runDir);
  const port = 9242;
  const result = {
    schema: 'webvpn-captcha-risk-result/v2',
    startedAt: new Date().toISOString(),
    target: WEBVPN_START_URL,
    browser: { engine: 'Microsoft Edge', headed: true, freshProfilePerRun: true },
    motionProfile,
    loginMode: login ? 'environment-credentials' : browserAutofill ? 'browser-autofill' : false,
    cleanup,
    captcha: {},
    trace: null,
    outcome: null,
    login: null,
  };

  let browserStarted = false;
  try {
    if (browserAutofill) {
      result.autofillProfile = prepareAutofillProfile(autofillProfile, testProfile);
      console.log(ts(), `自动填充源 profile: ${result.autofillProfile.source}`);
    }
    await launchBrowser({
      profile: testProfile, port, headless: false, offscreen: false,
      size: '1400,950', label: 'captcha-risk',
    });
    browserStarted = true;
    const { page } = await connect(port);
    page.setDefaultTimeout(30000);

    await loadLoginPage(page);
    const assets = await readCaptchaAssets(page);
    result.captcha.assets = {
      backgroundRect: assets.backgroundRect,
      pieceRect: assets.pieceRect,
      sliderRect: assets.sliderRect,
    };
    await page.screenshot({ path: path.join(runDir, 'captcha-before.png'), fullPage: true });
    const images = await prepareGapImages(page, runDir, assets);
    const detected = requestedDistance === null
      ? detectGapDistance(images, assets.backgroundRect.width, runDir)
      : { distance_css: Number(requestedDistance.toFixed(1)), source: 'manual', confidence: null };
    const pieceDistance = detected.distance_css;
    const sliderOffset = args['slider-offset'] === undefined ? 12.2 : Number(args['slider-offset']);
    if (!Number.isFinite(sliderOffset)) throw new Error('--slider-offset 必须是数字');
    const maxDrag = Math.max(1, assets.backgroundRect.width - assets.sliderRect.width);
    const dragDistance = Math.min(maxDrag, Math.max(1, pieceDistance + sliderOffset));
    result.captcha.detector = { images, ...detected };
    result.captcha.mapping = { pieceDistance, sliderOffset, dragDistance };
    console.log(ts(), `拼图目标 ${pieceDistance}px；拖动 ${dragDistance.toFixed(1)}px`);

    const seed = args.seed === undefined ? crypto.randomInt(0, 0xffffffff) : Number(args.seed);
    if (!Number.isInteger(seed) || seed < 0) throw new Error('--seed 必须是非负整数');
    const trace = makeTrace(motionProfile, dragDistance, seed);
    result.trace = { requested: trace };
    result.trace.replay = await replayTrace(page, trace, runDir);
    result.outcome = await waitForCaptchaResult(page);
    result.outcome.finalState = await readCasPageState(page);
    await page.screenshot({ path: path.join(runDir, 'captcha-after.png'), fullPage: true });

    if (result.outcome.accepted && wantsLogin) {
      await page.locator('#un').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      result.login = { mode: browserAutofill ? 'browser-autofill' : 'environment-credentials', submitted: false };
      let state;
      if (browserAutofill) {
        const autofill = await waitForBrowserAutofill(page);
        result.login.autofill = {
          filled: autofill.filled, focusAttempted: autofill.focusAttempted,
          accountFilled: autofill.state?.accountFilled,
          passwordFilled: autofill.state?.passwordFilled,
        };
        if (!autofill.filled) throw new Error('浏览器未自动填充账号和密码');
        state = await submitExistingLogin(page);
      } else {
        result.login.usernameHash = crypto.createHash('sha256').update(credentials.username).digest('hex').slice(0, 12);
        result.login.usernameLength = credentials.username.length;
        result.login.passwordProvided = Boolean(credentials.password);
        state = await fillAndSubmitCasLogin(page, credentials);
      }
      result.login.finalState = state;
      result.login.submitted = true;
      result.login.loggedIn = Boolean(state && /^webvpn\.webvpn\.edu\.cn$/i.test(state.host || '') && !/\/cas\//i.test(state.url || ''));
    }

    const holdMs = Math.max(0, Math.min(15000, Number(opt(args, 'hold-ms', 3000)) || 0));
    if (holdMs) await sleep(holdMs);
    result.finishedAt = new Date().toISOString();
    const resultFile = path.join(runDir, 'result.json');
    fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify({
      resultFile, motionProfile, pieceDistance, dragDistance,
      captchaAccepted: Boolean(result.outcome?.accepted),
      tokenLength: result.outcome?.finalState?.tokenLength || 0,
      captchaTips: result.outcome?.finalState?.tips || '',
      loginMode: result.loginMode,
      loginSubmitted: Boolean(result.login?.submitted),
      loginFinalHost: result.login?.finalState?.host || '',
    }, null, 2));
    return result.outcome?.accepted ? 0 : 3;
  } catch (error) {
    result.error = redact(error?.stack || error?.message || error);
    result.finishedAt = new Date().toISOString();
    const resultFile = path.join(runDir, 'result.json');
    fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
    throw new Error(`${redact(error?.message || error)}；结果: ${resultFile}`);
  } finally {
    if (browserStarted) await closeProfiles([testProfile], { quiet: true }).catch(() => {});
    for (const profile of listTestProfiles()) fs.rmSync(profile, { recursive: true, force: true });
  }
}

let exitCode = 1;
try {
  if (args.help) { usage(); exitCode = 0; }
  else if (args['dry-run']) { runDryRun(); exitCode = 0; }
  else if (live) exitCode = await runLive();
  else { usage(); exitCode = 2; }
} catch (error) {
  console.error('测试脚本失败:', redact(error?.message || error));
} finally {
  process.exit(exitCode);
}
