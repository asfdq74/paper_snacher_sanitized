import path from 'node:path';
import {
  ROOT, sleep, parseArgs, num, launchBrowser, connect, closeProfiles,
} from './lib.mjs';

const args = parseArgs();
const profile = path.join(ROOT, '.browser_profile_captcha_probe');
const port = num(args, 'port', 9242);
const startUrl = 'https://webvpn.example.edu.cn/';

await closeProfiles([profile], { quiet: true });
await launchBrowser({
  profile,
  port,
  headless: false,
  offscreen: false,
  size: '1400,950',
  label: 'captcha-probe',
});

const { page } = await connect(port);
page.setDefaultTimeout(30000);

try {
  let gateway = true;
  for (let attempt = 1; attempt <= 4; attempt++) {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
    await sleep(5000);
    const status = await page.evaluate(() => ({
      title: document.title,
      text: document.body?.innerText?.slice(0, 200) || '',
      url: location.href,
    })).catch(() => null);
    gateway = !status || /502 Bad Gateway|504 Gateway Time-out/i.test(
      `${status.title}\n${status.text}`,
    );
    console.log(`探测尝试 ${attempt}/4: ${status?.title || '页面不可读'} ${status?.url || ''}`);
    if (!gateway) break;
    if (attempt < 4) await sleep(attempt * 5000);
  }

  await sleep(3000);
  const info = await page.evaluate(() => {
    const visible = el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0
        && s.display !== 'none' && s.visibility !== 'hidden';
    };
    const brief = el => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        cls: typeof el.className === 'string' ? el.className.slice(0, 200) : '',
        role: el.getAttribute('role') || '',
        src: el.currentSrc || el.src || '',
        visible: visible(el),
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      };
    };
    const selectors = [
      '#captcha', 'iframe', '[id*="captcha" i]', '[class*="captcha" i]',
      '[class*="yidun" i]', '[id*="yidun" i]', '[class*="slider" i]',
      '[class*="slide" i]', '[class*="jigsaw" i]', '[class*="bg" i]',
      '[role="slider"]', 'img', 'canvas',
    ];
    const nodes = [...new Set(selectors.flatMap(sel => [...document.querySelectorAll(sel)]))];
    return {
      url: location.href,
      title: document.title,
      body: document.body?.innerText?.slice(0, 1000) || '',
      webdriver: navigator.webdriver,
      frames: [...document.querySelectorAll('iframe')].map(brief),
      nodes: nodes.map(brief),
      inputs: [...document.querySelectorAll('input')].map(el => ({
        ...brief(el),
        name: el.name,
        type: el.type,
        valueLength: el.value?.length || 0,
      })),
    };
  });
  const out = path.join(ROOT, 'output', 'captcha-risk');
  await page.screenshot({ path: path.join(out, 'probe.png'), fullPage: true });
  if (args.capture) {
    for (const [name, selector] of [
      ['background', '.yidun_bg-img'],
      ['jigsaw', '.yidun_jigsaw'],
      ['panel', '.yidun_panel'],
      ['slider', '.yidun_slider'],
    ]) {
      const locator = page.locator(selector).first();
      if (await locator.count()) {
        await locator.screenshot({ path: path.join(out, `${name}.png`) });
        console.log(`${name}: ${path.join(out, `${name}.png`)}`);
      }
    }
  }
  if (args['drag-distance'] !== undefined) {
    const distance = Number(args['drag-distance']);
    const slider = page.locator('.yidun_slider').first();
    const box = await slider.boundingBox();
    if (!box || !Number.isFinite(distance)) throw new Error('Invalid drag distance or slider');
    const startX = box.x + box.width / 2;
    const startY = box.y + box.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    for (let i = 1; i <= 30; i++) {
      await page.mouse.move(startX + distance * i / 30, startY);
      await sleep(18);
    }
    await page.mouse.up();
    await sleep(5000);
    const after = await page.evaluate(() => ({
      tokenLength: document.querySelector('input[name="NECaptchaValidate"]')?.value?.length || 0,
      tips: document.querySelector('.yidun_tips')?.innerText?.trim() || '',
      body: document.body?.innerText?.slice(0, 800) || '',
      account: Boolean(document.querySelector('#un')),
      password: Boolean(document.querySelector('#pd')),
      loginButton: Boolean(document.querySelector('#index_login_btn .login_box_landing_btn')),
    }));
    await page.screenshot({ path: path.join(out, 'after-drag.png'), fullPage: true });
    console.log('DRAG_RESULT', JSON.stringify({ distance, after }, null, 2));
  }
  console.log(JSON.stringify(info, null, 2));
} finally {
  await closeProfiles([profile], { quiet: true });
}
