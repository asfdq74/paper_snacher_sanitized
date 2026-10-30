// Recheck sampled DOI access with the existing WebVPN browser session.
import fs from 'node:fs';
import path from 'node:path';
import {
  MANIFESTS, STATE, wvUrl, launchBrowser, connect, closeProfiles,
  injectCookies, loadCookieFile, parseArgs, opt, sleep,
} from './lib.mjs';

const args = parseArgs();
const LIST = path.resolve(opt(args, 'list', path.join(MANIFESTS, 'list2_update_papers.json')));
const OUT = path.resolve(opt(args, 'out', path.join(STATE, 'wiley_access_samples.json')));
const PROFILE = opt(args, 'profile', '.browser_profile_wiley_lieyinrong_download');
const PORT = Number(opt(args, 'port', '9231'));
const COOKIE_FILE = path.join(STATE, 'wiley_cookies.json');
const REUSE = !!args.reuse;
const KEEP_OPEN = !!args['keep-open'];
const SAVE_HTML = !!args['save-html'];
const VISIBLE = !!args.visible;
const NEW_WINDOW = !!args['new-window'];
const HTML_DIR = path.join(STATE, 'wiley_access_html');
const HOST = 'onlinelibrary.wiley.com';
const ids = String(opt(args, 'ids', ''))
  .split(',').map(value => value.trim()).filter(Boolean);

const PAYWALL = /Get access to the full version|View access options|Purchase Instant Access|48-Hour online access|Add to Cart|access this content through your institution/i;
const LOGIN = /auth4\.webvpn\.edu\.cn|icas\.webvpn\.edu\.cn|cas_auth|统一身份认证|Sign in to continue/i;
const INSTITUTION = /Example University|Example University/i;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0';

const items = JSON.parse(fs.readFileSync(LIST, 'utf8'));
const selected = ids.length ? items.filter(item => ids.includes(String(item.id))) : [];
if (selected.length !== ids.length) {
  console.log('Some requested ids were not found in the manifest');
  process.exit(2);
}

function doiOf(item) {
  return (String(item.url || '').match(/10\.\d{4,9}\/\S+/) || [])[0] || '';
}

function compact(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

if (!REUSE) {
  await closeProfiles([PROFILE], { quiet: true });
  await launchBrowser({
    profile: PROFILE,
    port: PORT,
    offscreen: !VISIBLE,
    newWindow: NEW_WINDOW || VISIBLE,
    label: 'access-probe',
  });
}
const { ctx, page } = await connect(PORT);
ctx.setDefaultTimeout(60000);
const cookies = loadCookieFile(COOKIE_FILE);
if (cookies.length) await injectCookies(ctx, cookies);
if (SAVE_HTML) fs.mkdirSync(HTML_DIR, { recursive: true });

const results = [];
try {
  for (const item of selected) {
    const doi = doiOf(item);
    const record = { id: String(item.id), doi, title: item.title };
    record.pdfRoutes = {};
    for (const route of ['pdfdirect', 'pdf', 'epdf']) {
      const suffix = route === 'pdfdirect' ? `?download=true` : '';
      const routeUrl = wvUrl(HOST, `/doi/${route}/${doi}${suffix}`);
      const routeResponse = await ctx.request.get(routeUrl, {
        headers: { 'User-Agent': UA, Accept: 'application/pdf,text/html;q=0.9,*/*;q=0.8' },
        timeout: 180000,
        maxRedirects: 8,
      });
      const routeBody = Buffer.from(await routeResponse.body());
      record.pdfRoutes[route] = {
        status: routeResponse.status(),
        finalUrl: routeResponse.url(),
        contentType: routeResponse.headers()['content-type'] || '',
        length: routeBody.length,
        isPdf: routeBody.subarray(0, 5).toString('latin1') === '%PDF-',
        login: LOGIN.test(routeBody.toString('utf8').slice(0, 500000)),
        paywall: PAYWALL.test(routeBody.toString('utf8').slice(0, 500000)),
      };
    }

    const pdfUrl = wvUrl(HOST, `/doi/pdfdirect/${doi}?download=true`);
    const pdfResponse = await ctx.request.get(pdfUrl, {
      headers: { 'User-Agent': UA, Accept: 'application/pdf,text/html;q=0.9,*/*;q=0.8' },
      timeout: 180000,
      maxRedirects: 8,
    });
    const pdfBody = Buffer.from(await pdfResponse.body());
    const contentType = pdfResponse.headers()['content-type'] || '';
    record.pdf = {
      status: pdfResponse.status(),
      contentType,
      length: pdfBody.length,
      isPdf: pdfBody.subarray(0, 5).toString('latin1') === '%PDF-',
    };
    if (SAVE_HTML && !record.pdf.isPdf) {
      fs.writeFileSync(path.join(HTML_DIR, `${record.id}.html`), pdfBody);
    }

    const articleUrl = wvUrl(HOST, `/doi/${doi}`);
    const articleResponse = await page.goto(articleUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    }).catch(() => null);
    await sleep(2000);
    const finalUrl = page.url();
    const text = await page.locator('body').innerText({ timeout: 30000 }).catch(() => '');
    const rawHtml = pdfBody.subarray(0, 500000).toString('utf8');

    let pdfPageResult = null;
    if (!record.pdf.isPdf) {
      const pdfPage = await ctx.newPage();
      const response = await pdfPage.goto(pdfUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 90000,
      }).catch(() => null);
      await sleep(1500);
      const pdfText = await pdfPage.locator('body').innerText({ timeout: 30000 }).catch(() => '');
      pdfPageResult = {
        status: response ? response.status() : null,
        finalUrl: pdfPage.url(),
        title: await pdfPage.title().catch(() => ''),
        textSnippet: compact(pdfText).slice(0, 1600),
      };
      await pdfPage.close();
    }

    const loginRequired = LOGIN.test(finalUrl) || LOGIN.test(text.slice(0, 2000));
    const institutionShown = INSTITUTION.test(text);
    const paywallShown = PAYWALL.test(text)
      || PAYWALL.test(rawHtml)
      || PAYWALL.test(pdfPageResult?.textSnippet || '');

    record.article = {
      status: articleResponse ? articleResponse.status() : null,
      finalUrl,
      loginRequired,
      institutionShown,
      paywallShown,
      textSnippet: compact(text).slice(0, 1200),
    };
    record.pdfPage = pdfPageResult;
    record.verdict = record.pdf.isPdf
      ? 'accessible'
      : loginRequired
        ? 'login_required'
        : paywallShown && institutionShown
          ? 'no_subscription'
          : 'unknown';
    results.push(record);
    console.log(`${record.id} ${record.verdict} pdf=${record.pdf.status}/${record.pdf.length} institution=${institutionShown} login=${loginRequired} paywall=${paywallShown}`);
  }
} finally {
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  if (!KEEP_OPEN) await closeProfiles([PROFILE], { quiet: true });
  console.log(`wrote ${OUT}`);
}
