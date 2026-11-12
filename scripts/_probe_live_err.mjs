import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const PW_CORE = process.env.PW_CORE
  || 'C:/Users/cyf/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';
const _pw = await import(pathToFileURL(PW_CORE).href);
const chromium = _pw.chromium || _pw.default?.chromium;

const EXE = 'C:/Users/cyf/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe';
const URL_APP = process.env.URL_APP || 'https://www.chyunfan.cn/ks/';
const OUT = path.resolve(import.meta.dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
const page = await ctx.newPage();

const logs = [];
page.on('console', m => logs.push(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}\n${(e.stack || '').split('\n').slice(0, 4).join('\n')}`));
page.on('requestfailed', r => logs.push(`[reqfailed] ${r.method()} ${r.url()} :: ${r.failure()?.errorText}`));
page.on('response', async r => {
  const s = r.status();
  if (s >= 400) logs.push(`[http ${s}] ${r.request().method()} ${r.url()}`);
});

await page.goto(URL_APP, { waitUntil: 'networkidle', timeout: 45000 }).catch(e => logs.push('[goto] ' + e.message));
await page.waitForTimeout(2500);

const text = await page.evaluate(() => document.body.innerText.slice(0, 3000)).catch(() => '(no body)');
const html = await page.evaluate(() => {
  // 抓 toast / 错误条之类的浮层
  const out = [];
  document.querySelectorAll('body *').forEach(el => {
    const cs = getComputedStyle(el);
    if ((cs.position === 'fixed' || cs.position === 'absolute') && el.offsetHeight > 0 && el.innerText && el.innerText.trim().length < 200) {
      out.push(`<${el.tagName.toLowerCase()} class="${el.className}"> ${el.innerText.trim().replace(/\n+/g, ' | ')}`);
    }
  });
  return out.slice(0, 20);
}).catch(() => []);

await page.screenshot({ path: path.join(OUT, 'live_err.png'), fullPage: false });
fs.writeFileSync(path.join(OUT, 'live_err.log.txt'), logs.join('\n') + '\n\n=== BODY TEXT ===\n' + text + '\n\n=== FLOAT ===\n' + html.join('\n'), 'utf8');

console.log('=== CONSOLE / ERRORS ===');
console.log(logs.join('\n') || '(无)');
console.log('\n=== BODY TEXT (前 2000) ===');
console.log(text.slice(0, 2000));
console.log('\n=== 浮层 ===');
console.log(html.join('\n'));

await browser.close();
