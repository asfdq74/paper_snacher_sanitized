// Example University WebVPN 登录辅助。
//
// 默认自动完成滑块、填写账号密码并点击登录；失败后保留可见窗口供人工接手。
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, SCRATCH, sleep, ts, parseArgs, opt, num,
  launchBrowser, connect, closeProfiles, WEBVPN_COOKIE_RE,
} from './lib.mjs';
import {
  WEBVPN_START_URL, MOTION_PROFILES, createCasLoginController,
  readCredentials, readCasPageState, isCasPageState, isWebVpnLoggedInState,
  captchaOptionsFromArgs,
} from './webvpn-auth.mjs';

const args = parseArgs();
const PROFILE = path.join(ROOT, opt(args, 'profile', '.browser_profile_webvpn_login'));
const PORT = num(args, 'port', 9240);
const TIMEOUT_MIN = num(args, 'timeout-min', 20);
const CHECK = !!args.check;
const KEEP_OPEN = !!args['keep-open'];
const COOKIE_FILE = path.resolve(ROOT, opt(args, 'cookie-file', path.join(SCRATCH, 'webvpn_cookies.json')));
const captchaMode = String(opt(args, 'captcha', 'auto')).toLowerCase();
const captchaProfile = String(opt(args, 'captcha-profile', 'human'));
const captchaMaxAttempts = Math.max(1, Math.min(2, num(args, 'captcha-max', 2) || 2));

function usage() {
  console.log([
    '用法: node scripts/webvpn-login.mjs [--check] [--keep-open]',
    '  --check                    只检查登录页是否可访问',
    '  --headed                   配合 --check 使用可见窗口',
    '  --keep-open                登录成功后保留浏览器',
    '  --timeout-min <分钟>       默认 20',
    '  --profile/--port           浏览器 profile 和调试端口',
    '  --cookie-file <路径>       会话 cookie 输出位置',
    '  --captcha auto|manual      默认 auto，失败后转人工',
    '  --captcha-profile <名称>   默认 human',
    '  --captcha-max <次数>       自动尝试上限，硬上限 2',
    '  --slider-offset <像素>     默认 12.2',
    '  --captcha-min-confidence   默认 50',
    '  --captcha-min-score        默认 0.50',
    '  --captcha-min-correlation  默认 0.55',
    '  --captcha-min-margin       默认 0.02',
    '  --captcha-retry-min-ms     失败后最小等待，默认 900',
    '  --captcha-retry-max-ms     失败后最大等待，默认 3600',
    '  --no-browser-autofill      禁止触发现有浏览器自动填充',
    '  --no-prompt                只使用 WEBVPN_USERNAME/WEBVPN_PASSWORD',
  ].join('\n'));
}

async function saveCookies(ctx) {
  const cookies = await ctx.cookies();
  fs.mkdirSync(path.dirname(COOKIE_FILE), { recursive: true });
  fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
  const webvpn = cookies.filter(cookie => WEBVPN_COOKIE_RE.test(cookie.domain || ''));
  console.log(`会话已保存：cookie ${cookies.length} 个（Example University相关 ${webvpn.length}）`);
  console.log(`输出：${COOKIE_FILE}`);
}

async function loadWithGatewayRetry(page, attempts) {
  let state = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await page.goto(WEBVPN_START_URL, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
    await sleep(1500);
    state = await readCasPageState(page);
    if (!state?.gateway) return state;
    console.log(ts(), `认证网关 502/504（${attempt}/${attempts}），稍后重试…`);
    if (attempt < attempts) await sleep(5000 * attempt);
  }
  return state;
}

async function main() {
  if (args.help) { usage(); return 0; }
  if (!['auto', 'manual'].includes(captchaMode)) {
    console.log('--captcha 只能是 auto 或 manual');
    return 2;
  }
  if (!MOTION_PROFILES.includes(captchaProfile)) {
    console.log(`未知 --captcha-profile: ${captchaProfile}`);
    return 2;
  }
  if (args.headless && !CHECK) {
    console.log('普通登录模式需要可见浏览器窗口。');
    return 2;
  }

  const credentials = CHECK ? { username: '', password: '' } : await readCredentials({
    prompt: !args['no-prompt'],
    noPrompt: !!args['no-prompt'],
  });
  console.log('============================================================');
  console.log(' Example University WebVPN 登录辅助');
  console.log(` 验证码 ${captchaMode}｜轨迹 ${captchaProfile}｜最多 ${captchaMaxAttempts} 次`);
  console.log(' 自动验证失败时会保留窗口，可继续手动完成滑块。');
  if (!CHECK && (!credentials.username || !credentials.password)) {
    console.log(' 未完整提供账号密码；缺失项需在浏览器中手动填写');
  }
  console.log('============================================================');

  await closeProfiles([PROFILE], { quiet: true });
  await launchBrowser({
    profile: PROFILE, port: PORT, headless: CHECK && !args.headed,
    offscreen: false, size: '1400,950', label: CHECK ? 'webvpn-check' : 'webvpn-login',
  });
  const { ctx, page } = await connect(PORT);
  ctx.setDefaultTimeout(30000);
  const initialState = await loadWithGatewayRetry(page, 3);

  if (CHECK) {
    await sleep(3000);
    const state = await readCasPageState(page) || initialState;
    console.log(JSON.stringify({
      url: state?.href, title: state?.title,
      casLoginPage: Boolean(state && isCasPageState(state)),
      gatewayError: Boolean(state?.gateway), wafBlocked: Boolean(state?.wafBlocked),
      captchaVisible: state?.captchaVisible, captchaChildren: state?.captchaChildren,
      loginButtonVisible: state?.loginButtonVisible,
    }, null, 2));
    await closeProfiles([PROFILE], { quiet: true });
    return state && isCasPageState(state) ? 0 : 3;
  }

  const auth = createCasLoginController(page, {
    credentials, captchaMode, captchaProfile, captchaMaxAttempts,
    ...captchaOptionsFromArgs(args),
    browserAutofill: !args['no-browser-autofill'],
    label: 'standalone-webvpn-login', logger: console.log,
  });
  const deadline = Date.now() + TIMEOUT_MIN * 60 * 1000;
  let loggedInStreak = 0;
  let lastLogAt = 0;
  let lastUrl = '';
  let lastError = '';
  let gatewayRetries = 0;
  let lastGatewayRetryAt = 0;

  while (Date.now() < deadline) {
    const authResult = await auth.poll();
    const state = authResult.state || await readCasPageState(page);
    if (!state) { await sleep(750); continue; }
    if (state.href !== lastUrl) {
      lastUrl = state.href;
      console.log(ts(), '当前页面:', state.host, state.title || '');
    }

    loggedInStreak = isWebVpnLoggedInState(state) ? loggedInStreak + 1 : 0;
    if (loggedInStreak >= 3) {
      await saveCookies(ctx);
      if (KEEP_OPEN) console.log('登录窗口保持打开。');
      else { await closeProfiles([PROFILE], { quiet: true }); console.log('登录窗口已关闭。'); }
      return 0;
    }

    if (state.gateway) {
      if (Date.now() - lastGatewayRetryAt > 15000 && gatewayRetries < 6) {
        gatewayRetries++;
        lastGatewayRetryAt = Date.now();
        console.log(ts(), `认证网关 502/504，正在重试（${gatewayRetries}/6）…`);
        await page.goto(WEBVPN_START_URL, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
      } else if (Date.now() - lastLogAt > 30000) {
        lastLogAt = Date.now();
        console.log(ts(), '认证网关持续异常，请检查网络。');
      }
      await sleep(1000);
      continue;
    }

    if (state.wafBlocked) {
      if (Date.now() - lastLogAt > 30000) {
        lastLogAt = Date.now();
        console.log(ts(), '页面被云防护拦截或认证网关异常，请手动处理。');
      }
      await sleep(1000);
      continue;
    }

    if (state.error && state.error !== lastError) {
      lastError = state.error;
      console.log(ts(), '登录页提示:', state.error);
    }
    if (Date.now() - lastLogAt > 30000) {
      lastLogAt = Date.now();
      if (state.captchaVisible) {
        console.log(ts(), captchaMode === 'auto' ? '自动验证码未完成，等待人工接手…' : '等待你完成滑块验证…');
      } else if (state.hasAccount && !state.accountFilled && !credentials.username) {
        console.log(ts(), '请在浏览器中填写 WEBVPN_ID。');
      } else if (state.hasAccount && !state.passwordFilled && !credentials.password) {
        console.log(ts(), '请在浏览器中填写密码。');
      } else {
        console.log(ts(), '等待登录完成…');
      }
    }
    await sleep(750);
  }

  console.log(ts(), `登录等待超时（${TIMEOUT_MIN} 分钟），浏览器保持打开。`);
  return 4;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (err) {
  console.error('登录辅助脚本失败:', err?.message || err);
} finally {
  process.exit(exitCode);
}
