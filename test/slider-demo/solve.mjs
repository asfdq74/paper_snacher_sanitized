// 本地滑块自动识别与拖动示例。
//
// 目标坐标不通过 DOM/URL 读取，而是从 Canvas 像素中识别；
// 识别完成后用 Playwright 的鼠标事件拖动页面滑块。
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { EDGE, ROOT, parseArgs, sleep } from '../../scripts/lib.mjs';
import { startServer } from './server.mjs';

const args = parseArgs();

function positiveInt(name, fallback) {
  const raw = args[name];
  if (raw === undefined) return fallback;
  if (raw === true) {
    console.error(`参数 --${name} 需要一个正整数，例如 --${name} ${fallback}`);
    process.exit(2);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`参数 --${name} 必须是正整数，收到: ${raw}`);
    process.exit(2);
  }
  return value;
}

function uint32(name, fallback) {
  const raw = args[name];
  if (raw === undefined) return fallback;
  if (raw === true) {
    console.error(`参数 --${name} 需要一个非负整数，例如 --${name} 12345`);
    process.exit(2);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    console.error(`参数 --${name} 必须是 0 到 4294967295 之间的整数，收到: ${raw}`);
    process.exit(2);
  }
  return value >>> 0;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

const ROUNDS = positiveInt('rounds', 5);
const HEADED = !!args.headed;
const TIMEOUT_MS = positiveInt('timeout', 10) * 1000;
const FAILURE_DIR = path.join(ROOT, 'output', 'playwright');
const MOTION = args.motion === undefined ? 'natural' : args.motion;
if (MOTION !== 'natural' && MOTION !== 'linear') {
  console.error(`参数 --motion 只支持 natural 或 linear，收到: ${MOTION}`);
  process.exit(2);
}
const SEED = uint32(
  'seed',
  (Date.now() ^ Math.imul(process.pid, 2654435761)) >>> 0,
);
const motionRandom = mulberry32(SEED);

function randomBetween(min, max) {
  return min + motionRandom() * (max - min);
}

function randomJitter(amount) {
  return randomBetween(-amount, amount);
}

function matchPuzzle(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('#scene');
    const pieceCanvas = document.querySelector('#pieceTexture');
    if (!canvas || !pieceCanvas) return null;

    const sceneWidth = canvas.width;
    const sceneHeight = canvas.height;
    const pieceWidth = pieceCanvas.width;
    const pieceHeight = pieceCanvas.height;
    const sceneData = canvas
      .getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, sceneWidth, sceneHeight).data;
    const pieceData = pieceCanvas
      .getContext('2d', { willReadFrequently: true })
      .getImageData(0, 0, pieceWidth, pieceHeight).data;

    const grayscale = (pixels, width, height) => {
      const output = new Float32Array(width * height);
      for (let index = 0; index < width * height; index++) {
        const offset = index * 4;
        output[index] = pixels[offset] * 0.299
          + pixels[offset + 1] * 0.587
          + pixels[offset + 2] * 0.114;
      }
      return output;
    };

    const blur3 = (source, width, height) => {
      const output = new Float32Array(width * height);
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          let sum = 0;
          for (let oy = -1; oy <= 1; oy++) {
            for (let ox = -1; ox <= 1; ox++) {
              sum += source[(y + oy) * width + x + ox];
            }
          }
          output[y * width + x] = sum / 9;
        }
      }
      return output;
    };

    const sobelEdges = (source, width, height, threshold) => {
      const mask = new Uint8Array(width * height);
      let count = 0;
      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const index = y * width + x;
          const topLeft = source[index - width - 1];
          const top = source[index - width];
          const topRight = source[index - width + 1];
          const left = source[index - 1];
          const right = source[index + 1];
          const bottomLeft = source[index + width - 1];
          const bottom = source[index + width];
          const bottomRight = source[index + width + 1];
          const gx = -topLeft - 2 * left - bottomLeft
            + topRight + 2 * right + bottomRight;
          const gy = topLeft + 2 * top + topRight
            - bottomLeft - 2 * bottom - bottomRight;
          if (gx * gx + gy * gy >= threshold * threshold) {
            mask[index] = 1;
            count++;
          }
        }
      }
      return { mask, count };
    };

    const sceneGray = blur3(
      grayscale(sceneData, sceneWidth, sceneHeight),
      sceneWidth,
      sceneHeight,
    );
    const pieceGray = blur3(
      grayscale(pieceData, pieceWidth, pieceHeight),
      pieceWidth,
      pieceHeight,
    );
    const sceneEdges = sobelEdges(sceneGray, sceneWidth, sceneHeight, 36);
    const pieceEdges = sobelEdges(pieceGray, pieceWidth, pieceHeight, 36);

    const allSamples = [];
    for (let y = 0; y < pieceHeight; y++) {
      for (let x = 0; x < pieceWidth; x++) {
        if (pieceEdges.mask[y * pieceWidth + x]) {
          allSamples.push(y * pieceWidth + x);
        }
      }
    }
    if (!allSamples.length) return null;

    const stride = Math.max(1, Math.ceil(allSamples.length / 650));
    const samples = allSamples.filter((_, index) => index % stride === 0);

    const integralWidth = sceneWidth + 1;
    const integral = new Uint32Array(
      (sceneWidth + 1) * (sceneHeight + 1),
    );
    for (let y = 1; y <= sceneHeight; y++) {
      let rowSum = 0;
      for (let x = 1; x <= sceneWidth; x++) {
        rowSum += sceneEdges.mask[(y - 1) * sceneWidth + x - 1];
        integral[y * integralWidth + x] = integral[(y - 1) * integralWidth + x] + rowSum;
      }
    }

    const rectangleEdges = (x, y, width, height) => {
      const right = x + width;
      const bottom = y + height;
      return integral[bottom * integralWidth + right]
        - integral[y * integralWidth + right]
        - integral[bottom * integralWidth + x]
        + integral[y * integralWidth + x];
    };

    const scoreAt = (x, y) => {
      let hits = 0;
      for (const sample of samples) {
        const tx = sample % pieceWidth;
        const ty = Math.floor(sample / pieceWidth);
        if (sceneEdges.mask[(y + ty) * sceneWidth + x + tx]) hits++;
      }
      const sceneCount = rectangleEdges(x, y, pieceWidth, pieceHeight);
      const union = samples.length + sceneCount - hits;
      return union > 0 ? hits / union : 0;
    };

    const maxX = sceneWidth - pieceWidth;
    const maxY = sceneHeight - pieceHeight;
    let best = { x: 0, y: 0, score: -1 };
    const coarseCandidates = [];

    for (let y = 0; y <= maxY; y += 2) {
      for (let x = 0; x <= maxX; x += 2) {
        const score = scoreAt(x, y);
        if (score >= 0.06) coarseCandidates.push({ x, y, score });
        if (score > best.score) best = { x, y, score };
      }
    }

    const coarseX = best.x;
    const coarseY = best.y;
    for (let y = Math.max(0, coarseY - 4); y <= Math.min(maxY, coarseY + 4); y++) {
      for (let x = Math.max(0, coarseX - 4); x <= Math.min(maxX, coarseX + 4); x++) {
        const score = scoreAt(x, y);
        if (score > best.score) best = { x, y, score };
      }
    }

    coarseCandidates.sort((left, right) => right.score - left.score);
    const alternate = coarseCandidates.find(candidate => (
      Math.hypot(candidate.x - best.x, candidate.y - best.y) > 24
    ));
    const secondScore = alternate?.score || 0;

    return {
      x: best.x,
      y: best.y,
      score: best.score,
      secondScore,
      margin: best.score - secondScore,
      templateEdges: allSamples.length,
      sampledEdges: samples.length,
      sceneEdges: rectangleEdges(best.x, best.y, pieceWidth, pieceHeight),
      pieceWidth,
      pieceHeight,
    };
  });
}

async function nextChallenge(page) {
  const before = await page.evaluate(() => window.__sliderReady || 0);
  await page.locator('#newChallenge').click();
  await page.waitForFunction(
    previous => (window.__sliderReady || 0) > previous,
    before,
    { timeout: 3000 },
  );
}

async function linearDrag(page, startX, startY, distance) {
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + distance, startY, { steps: 30 });
  await sleep(80);
  await page.mouse.up();
  return { mode: 'linear', steps: 30, durationMs: 80, overshoot: 0 };
}

async function naturalDrag(page, startX, startY, distance) {
  const approachPause = randomBetween(70, 190);
  const pressPause = randomBetween(35, 115);
  const holdBeforeRelease = randomBetween(55, 145);
  const overshoot = randomBetween(2, 6);
  const yDrift = randomBetween(0.5, 1.6);
  const yCurve = randomJitter(yDrift);
  const mainPhase = randomBetween(0.78, 0.84);
  const correctionPhase = mainPhase + randomBetween(0.1, 0.14);
  const durationMs = clamp(400 + distance * 1.9 + randomBetween(0, 160), 520, 1050);

  await page.mouse.move(
    startX + randomJitter(3),
    startY + randomJitter(1.2),
  );
  await sleep(approachPause);
  await page.mouse.down();
  await sleep(pressPause);

  const startedAt = Date.now();
  let steps = 0;
  let nextFrameAt = randomBetween(14, 24);

  for (;;) {
    const elapsedMs = Date.now() - startedAt;
    const t = Math.min(1, elapsedMs / durationMs);

    let offset;
    if (t < mainPhase) {
      const phase = t / mainPhase;
      const eased = 1 - Math.pow(1 - phase, 3);
      offset = (distance + overshoot) * eased;
    } else if (t < correctionPhase) {
      const phase = (t - mainPhase) / (correctionPhase - mainPhase);
      const eased = 1 - Math.pow(1 - phase, 3);
      offset = distance + overshoot * (1 - eased);
    } else {
      offset = distance;
    }

    const vertical = startY
      + Math.sin(Math.PI * t) * yCurve
      + randomJitter(0.28);
    await page.mouse.move(
      startX + offset + randomJitter(0.32),
      vertical,
      { steps: 1 },
    );
    steps++;

    if (elapsedMs >= durationMs) break;
    const remaining = nextFrameAt - (Date.now() - startedAt);
    if (remaining > 0) await sleep(remaining);
    nextFrameAt += randomBetween(18, 32);
    if (nextFrameAt > durationMs + 250) break;
  }

  await page.mouse.move(startX + distance, startY, { steps: 1 });
  await sleep(holdBeforeRelease);
  await page.mouse.up();

  return {
    mode: 'natural',
    steps: steps + 1,
    durationMs: Date.now() - startedAt,
    overshoot,
    approachPause,
    pressPause,
  };
}

async function solveRound(page, round) {
  await page.waitForSelector('#scene', { state: 'visible', timeout: TIMEOUT_MS });

  const match = await matchPuzzle(page);
  if (!match) throw new Error('边缘图或模板边缘为空，无法匹配');
  if (match.score < 0.12) {
    throw new Error(`模板匹配置信度过低: ${match.score.toFixed(3)}`);
  }
  if (match.margin < 0.008) {
    throw new Error(
      `模板匹配区分度不足: best=${match.score.toFixed(3)}, `
      + `second=${match.secondScore.toFixed(3)}`,
    );
  }

  const canvasBox = await page.locator('#scene').boundingBox();
  const pieceBox = await page.locator('#piece').boundingBox();
  const trackBox = await page.locator('#track').boundingBox();
  const handleBox = await page.locator('#handle').boundingBox();
  if (!canvasBox || !pieceBox || !trackBox || !handleBox) {
    throw new Error('页面元素尺寸不可用');
  }

  const scaleX = canvasBox.width / 480;
  const scaleY = canvasBox.height / 240;
  const targetPieceX = canvasBox.x + match.x * scaleX;
  const distance = targetPieceX - pieceBox.x;
  const maxDistance = trackBox.width - handleBox.width;
  if (distance > maxDistance + 1) {
    throw new Error(`目标距离 ${distance.toFixed(1)}px 超过轨道范围 ${maxDistance.toFixed(1)}px`);
  }
  const expectedPieceTop = (pieceBox.y - canvasBox.y) / scaleY;
  const yError = Math.abs(expectedPieceTop - match.y);
  const meta = await page.evaluate(() => window.__challengeMeta || null);

  if (args.screenshot && round === 1) {
    fs.mkdirSync(FAILURE_DIR, { recursive: true });
    const shot = path.join(FAILURE_DIR, 'slider-puzzle-before.png');
    await page.screenshot({ path: shot, fullPage: true });
    console.log(`首轮截图: ${shot}`);
  }

  const handleX = handleBox.x + handleBox.width / 2;
  const handleY = handleBox.y + handleBox.height / 2;
  const startedAt = Date.now();

  const motion = MOTION === 'linear'
    ? await linearDrag(page, handleX, handleY, distance)
    : await naturalDrag(page, handleX, handleY, distance);

  await page.waitForSelector('#result[data-state="success"]', { timeout: 4000 });
  const elapsed = Date.now() - startedAt;

  console.log(
    `第 ${round}/${ROUNDS} 轮通过`
    + `｜匹配 (${match.x}, ${match.y}) score=${match.score.toFixed(3)}`
    + `｜间隔=${match.margin.toFixed(3)}`
    + `｜y误差=${yError.toFixed(1)}px`
    + `｜边缘 ${match.sampledEdges}/${match.templateEdges}`
    + `｜拖动 ${distance.toFixed(1)}px`
    + `｜轨迹 ${motion.steps}步/${Math.round(motion.durationMs)}ms`
    + `｜过冲 ${motion.overshoot.toFixed(1)}px`
    + `｜缩放 ${(meta?.displayScale || scaleX).toFixed(3)}`
    + `｜噪声 ${(meta?.noiseRate * 100).toFixed(2)}%`
    + `｜遮挡 r=${meta?.occlusionRadius?.toFixed(1) || '?'}`
    + `｜${elapsed}ms`,
  );

  return { match, distance, elapsed };
}

let browser;
let server;
let exitCode = 1;

try {
  const started = await startServer({ port: 0 });
  server = started.server;
  console.log(`本地页面: ${started.url}`);
  console.log('识别方式: 灰度化 + 模糊 + Sobel 边缘 + 模板匹配');
  console.log(`动作模式: ${MOTION}｜随机种子: ${SEED}`);

  browser = await chromium.launch({
    headless: !HEADED,
    executablePath: EDGE,
  });
  const context = await browser.newContext({ viewport: { width: 900, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);
  page.setDefaultNavigationTimeout(TIMEOUT_MS);

  await page.goto(started.url, { waitUntil: 'load' });
  await page.waitForFunction(() => (window.__sliderReady || 0) > 0);

  for (let round = 1; round <= ROUNDS; round++) {
    if (round > 1) await nextChallenge(page);
    await solveRound(page, round);
  }

  console.log(`全部通过：${ROUNDS}/${ROUNDS}`);
  exitCode = 0;
} catch (error) {
  console.error('测试失败:', error?.message || error);
  try {
    fs.mkdirSync(FAILURE_DIR, { recursive: true });
    const pages = browser?.contexts().flatMap(context => context.pages()) || [];
    if (pages[0]) {
      const shot = path.join(FAILURE_DIR, 'slider-demo-failure.png');
      await pages[0].screenshot({ path: shot, fullPage: true });
      console.error(`失败截图: ${shot}`);
    }
  } catch {}
} finally {
  try { await browser?.close(); } catch {}
  await new Promise(resolve => server?.close(resolve) ?? resolve());
  process.exit(exitCode);
}
