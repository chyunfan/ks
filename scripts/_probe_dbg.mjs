import { pathToFileURL } from 'node:url';
const PW_CORE = 'C:/Users/cyf/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';
const _pw = await import(pathToFileURL(PW_CORE).href);
const chromium = _pw.chromium || _pw.default?.chromium;
const EXE = 'C:/Users/cyf/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe';

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
const page = await ctx.newPage();
console.log('page created:', !!page);

let n = 0;
page.on('request', r => { n++; console.log('REQ', r.method(), r.url()); });
page.on('response', r => { if (r.status() >= 400) console.log('BAD', r.status(), r.url()); });
page.on('console', m => console.log('CONSOLE', m.type(), m.text().slice(0, 300)));

const resp = await page.goto('https://www.chyunfan.cn/ks/', { waitUntil: 'domcontentloaded', timeout: 45000 });
console.log('status:', resp && resp.status(), 'reqCount:', n);
await page.waitForTimeout(4000);
console.log('reqCount after wait:', n);
console.log('title:', await page.title());
await browser.close();
