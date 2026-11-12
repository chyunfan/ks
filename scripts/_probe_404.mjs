import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

const PW_CORE = 'C:/Users/cyf/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';
const _pw = await import(pathToFileURL(PW_CORE).href);
const chromium = _pw.chromium || _pw.default?.chromium;
const EXE = 'C:/Users/cyf/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe';
const URL_APP = process.env.URL_APP || 'https://www.chyunfan.cn/ks/';

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await (await browser.newContext({ viewport: { width: 420, height: 900 } })).newPage();

const all = [];
page.on('request', r => all.push(['REQ ', r.method(), r.url(), r.resourceType()]));
page.on('response', r => all.push(['RESP', String(r.status()), r.url(), r.request().resourceType()]));
page.on('requestfailed', r => all.push(['FAIL', '', r.url(), r.failure()?.errorText || '']));

await page.goto(URL_APP, { waitUntil: 'networkidle', timeout: 45000 }).catch(e => console.log('goto:', e.message));
await page.waitForTimeout(2000);

console.log('=== 非 2xx / 失败 ===');
all.filter(x => (x[0] === 'RESP' && !/^[23]/.test(x[1])) || x[0] === 'FAIL')
  .forEach(x => console.log(x.join('  ')));

console.log('\n=== 全部请求（按顺序） ===');
all.filter(x => x[0] === 'REQ').forEach(x => console.log(`${x[3].padEnd(10)} ${x[2]}`));

await browser.close();
