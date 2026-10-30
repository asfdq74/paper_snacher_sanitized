// Collect WebVPN/CAS captcha images and detector metrics without submitting a login.
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, STATE, sleep, ts, parseArgs, num, opt,
  launchBrowser, connect, closeProfiles,
} from './lib.mjs';
import {
  WEBVPN_START_URL, ensureWorkspaceDir, readCasPageState, readCaptchaAssets,
  prepareGapImages, detectGapDistance, evaluateCaptchaQuality, DEFAULT_CAPTCHA_QUALITY,
} from './webvpn-auth.mjs';

const args = parseArgs();
const MAX = Math.max(1, Math.min(10, num(args, 'max', 5)));
const PORT = num(args, 'port', 9243);
const PROFILE = path.join(
  ROOT,
  opt(args, 'profile', '.browser_profile_webvpn_captcha_samples'),
);
const KEEP_OPEN = !!args['keep-open'];
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = ensureWorkspaceDir(
  path.join(STATE, 'captcha_samples', `run-${runId}`),
);

function saveJson(name, value) {
  const target = path.join(RUN_DIR, name);
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
  return target;
}

async function loadLoginPage(page) {
  let last = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto(WEBVPN_START_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    }).catch(() => {});
    await sleep(3000);
    last = await readCasPageState(page);
    if (last && !last.gateway && !last.wafBlocked) return last;
    console.log(ts(), `登录页暂不可用，重试 ${attempt}/3`);
    await sleep(3000 * attempt);
  }
  return last;
}

async function refreshCaptcha(page, previousKey) {
  const selectors = [
    '.yidun_refresh:visible',
    '.yidun-refresh:visible',
    '[class*="refresh"]:visible',
  ];
  for (const selector of selectors) {
    const refresh = page.locator(selector).first();
    if (!(await refresh.count().catch(() => 0))) continue;
    await refresh.click({ timeout: 3000 }).catch(() => {});
    break;
  }
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await sleep(500);
    const assets = await readCaptchaAssets(page).catch(() => null);
    const key = assets
      ? `${assets.backgroundSrc}|${assets.pieceSrc}`
      : '';
    if (key && key !== previousKey) return true;
  }
  return false;
}

await closeProfiles([PROFILE], { quiet: true });
await launchBrowser({
  profile: PROFILE,
  port: PORT,
  offscreen: false,
  newWindow: true,
  label: 'captcha-sample-collector',
});

const collection = {
  schema: 'webvpn-captcha-samples/v1',
  startedAt: new Date().toISOString(),
  target: new URL(WEBVPN_START_URL).host,
  thresholds: DEFAULT_CAPTCHA_QUALITY,
  samples: [],
};

try {
  const { page } = await connect(PORT);
  page.setDefaultTimeout(30000);
  const initial = await loadLoginPage(page);
  if (!initial) throw new Error('无法读取登录页');
  console.log(ts(), '登录页:', initial.title || initial.host);

  for (let index = 1; index <= MAX; index++) {
    const sampleDir = ensureWorkspaceDir(path.join(RUN_DIR, `sample-${index}`));
    try {
      const state = await readCasPageState(page);
      const assets = await readCaptchaAssets(page);
      const key = `${assets.backgroundSrc}|${assets.pieceSrc}`;
      await page.screenshot({
        path: path.join(sampleDir, 'captcha-page.png'),
        fullPage: true,
      });
      const images = await prepareGapImages(page, sampleDir, assets);
      const detected = detectGapDistance(images, assets.backgroundRect.width, sampleDir);
      const quality = evaluateCaptchaQuality(detected);
      const record = {
        index,
        collectedAt: new Date().toISOString(),
        page: {
          host: state?.host || '',
          title: state?.title || '',
          captchaVisible: Boolean(state?.captchaVisible),
          accountVisible: Boolean(state?.hasAccount),
          passwordVisible: Boolean(state?.hasPassword),
        },
        assets: {
          backgroundRect: assets.backgroundRect,
          pieceRect: assets.pieceRect,
          sliderRect: assets.sliderRect,
          mode: images.mode,
        },
        detected,
        quality,
      };
      saveJson(path.join(`sample-${index}`, 'metadata.json'), record);
      collection.samples.push(record);
      console.log(
        `${ts()} sample ${index}/${MAX} confidence=${detected.confidence} `
        + `score=${detected.score} distance=${detected.distance_css}px `
        + `quality=${quality.ok ? 'ok' : quality.issues.join(',')}`,
      );

      if (index < MAX) {
        const changed = await refreshCaptcha(page, key);
        if (!changed) {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
          await sleep(3000);
        }
        await sleep(1000 + Math.floor(Math.random() * 1200));
      }
    } catch (error) {
      const failure = {
        index,
        failedAt: new Date().toISOString(),
        error: String(error?.message || error),
      };
      collection.samples.push(failure);
      saveJson(path.join(`sample-${index}`, 'error.json'), failure);
      console.log(`${ts()} sample ${index}/${MAX} failed: ${failure.error}`);
    }
  }
} finally {
  collection.finishedAt = new Date().toISOString();
  saveJson('manifest.json', collection);
  if (!KEEP_OPEN) await closeProfiles([PROFILE], { quiet: true });
  console.log(`samples: ${RUN_DIR}`);
  console.log(`collected: ${collection.samples.filter(item => !item.error).length}/${MAX}`);
}
