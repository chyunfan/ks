/**
 * 「部署在任意子路径都能跑」的验收（v2.24 起因，v2.25 补充仓库更名 ks）。
 *
 * 起因（真实线上事故）：
 *   应用被网关代理到 https://www.chyunfan.cn/ks 后，整页没有任何样式 —— 裸 HTML。
 *   原因不是 CSS 写错了，而是**构建期写死的路径 ≠ 实际访问路径**：
 *     · 多文件产物里 index.html 引用 /credit-exam-cloud/assets/index-xxx.css
 *     · 而这次访问路径是 /ks，浏览器老实去取 /credit-exam-cloud/assets/... 
 *     · 那个路径命中的是另一个**已暂停**的部署 → 503 → CSS/JS 全没下来
 *     · 结果 .hide{display:none} 失效，登录卡和应用主体同时露在外面（就是截图那样）
 *   同一个根因还让登录接口打到 /credit-exam-cloud/api/login → 503 → 登录必然失败。
 *
 * 修法的两条硬约束，本脚本就测这两条：
 *   1) 产物「零外链」：index.html 自己带齐 CSS/JS，浏览器**一个资源请求都不发**，
 *      于是部署在哪个子路径都无所谓。
 *   2) 接口前缀「跟着页面走」：页面在 /ks，接口就调 /ks/api/xxx；
 *      页面在站点根，就调 /api/xxx。
 *
 * v2.25 追加：GitHub 仓库更名为 ks，构建期 base（vite.config.js 的 APP_BASE）
 * 与 vercel.json 的 rewrite 一并切到 /ks，彻底不留指向已暂停部署的老前缀。
 *
 * 测的是**构建产物 dist/index.html 本体**（不是 dev server），
 * 用一个迷你静态服务器把它挂到各种子路径下，看真实浏览器发出去的请求。
 *
 * 用法：node scripts/check_paths.mjs
 */
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';

const PW_CORE = process.env.PW_CORE
  || 'C:/Users/cyf/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';
const _pw = await import(pathToFileURL(PW_CORE).href);
const chromium = _pw.chromium || _pw.default?.chromium;
const EXE = 'C:/Users/cyf/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5231;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(ROOT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const DIST = path.join(ROOT, 'dist', 'index.html');
const BUILD_TAG_RE = /v2\.\d+ · \d{4}-\d{2}-\d{2}/;

const fails = [];
let n = 0;
const chk = (cond, name, extra) => { n++; if (!cond) fails.push(`T${n} ${name}${extra ? ' → ' + extra : ''}`); };

/* ============================================================
 * A. 静态核对：产物必须零外链
 * ============================================================ */
console.log('\n【A. 产物零外链（决定了「部署路径」是否还能影响资源加载）】');

chk(fs.existsSync(DIST), 'A1 dist/index.html 存在（先跑 npm run build）', DIST);
const html = fs.readFileSync(DIST, 'utf8');
const tag = (BUILD_TAG_RE.exec(html) || ['<未找到版本号>'])[0];
console.log(`      产物版本：${tag}（${(Buffer.byteLength(html) / 1024).toFixed(1)} KB）`);

const scriptSrc = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/gi)].map(m => m[1]);
const linkCss = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/gi)].map(m => m[1]);
const anyHref = [...html.matchAll(/<link[^>]*href="([^"]+)"/gi)].map(m => m[1]).filter(u => !/^data:/i.test(u));

chk(scriptSrc.length === 0, 'A2 没有任何 <script src>（JS 已内联）', JSON.stringify(scriptSrc));
chk(linkCss.length === 0, 'A3 没有任何外链样式表（CSS 已内联）', JSON.stringify(linkCss));
chk(anyHref.length === 0, 'A4 连 favicon 之类的外链都没有', JSON.stringify(anyHref));
chk(/<style>/.test(html), 'A5 样式确实以内联 <style> 形式存在', '');
chk(/<script type="module">/.test(html), 'A6 脚本确实以内联 module 形式存在', '');
// 内联进 HTML 的样式必须带上「隐藏」这条规则，否则截图里那种「两屏同显」会重演
chk(/\.hide\s*\{[^}]*display\s*:\s*none/.test(html) || /\/\*hide\*\//.test(html) || html.includes('.hide{display:none'),
  'A7 内联样式里含 .hide{display:none}（截图里两屏同显的直接元凶）', '');
// v2.25：仓库/部署路径更名为 ks，产物里不该再残留老前缀（它指向的部署已暂停 → 503）
chk(!html.includes('/credit-exam-cloud/'),
  'A8 产物里已没有 /credit-exam-cloud/ 这个老前缀（构建期 base 已对齐到 /ks/）',
  '出现次数=' + (html.split('/credit-exam-cloud/').length - 1));

/* ============================================================
 * B. 源码核对：接口前缀必须是运行时推导，不能只信构建期 base
 * ============================================================ */
console.log('\n【B. 接口前缀改为运行时推导】');

const authSrc = fs.readFileSync(path.join(ROOT, 'src/auth.js'), 'utf8');
chk(/function runtimePrefix\s*\(/.test(authSrc), 'B1 auth.js 有 runtimePrefix()', '');
chk(/location\.pathname/.test(authSrc), 'B2 它读的是 location.pathname（页面实际位置）', '');
chk(/replace\(\/\\\/index\\\.html\?\/\$\/i/.test(authSrc) || /index\\\.html/.test(authSrc),
  'B3 处理了 /xxx/index.html 这种带文件名的地址', '');
const apiFn = /export function apiCandidates\(path\)\s*\{[\s\S]*?\n\}/.exec(authSrc);
chk(!!apiFn, 'B4 找得到 apiCandidates()', '');
if (apiFn) {
  const body = apiFn[0];
  chk(/const rt = runtimePrefix\(\);/.test(body), 'B5 候选列表里用上了运行时前缀', '');
  chk(/if \(rt\) list\.push\(rt \+ tail\)/.test(body), 'B6 运行时前缀排在候选第一位（优先命中）', '');
  chk(/list\.push\(tail\)/.test(body), 'B7 站点根 /api/xxx 仍是候选（直连 Vercel 可用）', '');
  chk(/BASE_PREFIX && !list\.includes\(BASE_PREFIX \+ tail\)/.test(body),
    'B8 构建期前缀降级为最后一个兜底候选，且不重复', '');
}

const vc = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
chk(vc.buildCommand === 'npm run build',
  'B9 vercel.json 的 buildCommand 是 npm run build（含内联），不是裸 vite build', vc.buildCommand);

const inlineSrc = fs.readFileSync(path.join(ROOT, 'scripts/inline.mjs'), 'utf8');
chk(/process\.exit\(1\)/.test(inlineSrc) && /残留外链资源/.test(inlineSrc),
  'B10 inline.mjs 加了「内联后仍有外链就让构建失败」的安全网', '');

// v2.25：仓库与部署路径统一更名为 ks，构建期前缀也要跟着走，不能还留在那个已暂停的老路径上
const viteCfg = fs.readFileSync(path.join(ROOT, 'vite.config.js'), 'utf8');
const baseM = /const APP_BASE = '([^']+)'/.exec(viteCfg);
chk(!!baseM, 'B11 vite.config.js 里能读到 APP_BASE', baseM ? baseM[1] : '(没找到)');
chk(!!baseM && baseM[1] === '/ks/',
  'B11 构建期前缀已对齐到当前部署路径 /ks/', baseM ? baseM[1] : '(没找到)');
chk(!!baseM && !baseM[1].includes('credit-exam-cloud'),
  'B11 构建期前缀不再是那个已暂停的 /credit-exam-cloud/', baseM ? baseM[1] : '(没找到)');

const vcRaw = fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8');
chk(/"source": "\/ks\/:path\*"/.test(vcRaw),
  'B12 vercel.json 也认 /ks 前缀（直连 Vercel 时带前缀也能打开）', '');

/* ============================================================
 * C. 真实浏览器：挂到各个子路径下，看请求发去哪
 * ============================================================ */
console.log('\n【C. 各子路径实测（真实浏览器 + 真实产物）】');

const hits = [];             // 本轮记录到的所有请求 path
const server = http.createServer((req, res) => {
  const u = new URL(req.url, ORIGIN);
  const p = u.pathname;
  hits.push(p);

  // 后端接口：任何 <前缀>/api/health 都返回 JSON（模拟网关把 /xxx/api/* 转发到 Vercel 函数）
  if (/\/api\/health$/.test(p)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, app: 'credit-exam-cloud', ts: Date.now() }));
    return;
  }
  // 应用页面：网关把 /xxx 和 /xxx/ 都指到同一份 index.html
  const isPage = p === '/' || p === '/index.html'
    || /^\/(ks|credit-exam-cloud)\/?$/.test(p)
    || /^\/(ks|credit-exam-cloud)\/index\.html$/.test(p);
  if (isPage) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  // 其它一律 404（真出事时就是这里：/credit-exam-cloud/assets/xxx 拿不到）
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 420, height: 900 }, deviceScaleFactor: 1 });
const jsErrors = [];
page.on('pageerror', e => jsErrors.push(e.message));
page.on('dialog', d => d.accept());
// 登录页会自检后端并打印版本号；清掉本机缓存，保证每次都是「第一次进来」
await page.addInitScript(() => { try { localStorage.clear(); } catch (e) { } });

/** 打开某个前缀下的页面，等它自己发第一发 /api/health */
async function probe(url) {
  hits.length = 0;
  await page.goto(url, { waitUntil: 'load' });
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) {
    if (hits.some(h => /\/api\/health$/.test(h))) break;
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(300);
  return await page.evaluate(() => {
    const app = document.getElementById('app');
    const auth = document.getElementById('auth');
    const cs = el => (el ? getComputedStyle(el).display : 'missing');
    return {
      appDisplay: cs(app),
      authDisplay: cs(auth),
      buildTag: (document.getElementById('buildTag') || {}).textContent || '',
      styleTags: document.querySelectorAll('style').length,
      inlineCssKB: Array.from(document.querySelectorAll('style')).reduce((s, e) => s + e.textContent.length, 0) / 1024
    };
  });
}

const CASES = [
  { url: `${ORIGIN}/ks`, want: '/ks/api/health', label: 'C1 /ks（无尾斜杠，就是这次出事的那种地址）' },
  { url: `${ORIGIN}/ks/`, want: '/ks/api/health', label: 'C2 /ks/（带尾斜杠）' },
  { url: `${ORIGIN}/ks/index.html`, want: '/ks/api/health', label: 'C3 /ks/index.html' },
  { url: `${ORIGIN}/credit-exam-cloud`, want: '/credit-exam-cloud/api/health', label: 'C4 /credit-exam-cloud（老路径不能退化）' },
  { url: `${ORIGIN}/credit-exam-cloud/`, want: '/credit-exam-cloud/api/health', label: 'C5 /credit-exam-cloud/' },
  { url: `${ORIGIN}/`, want: '/api/health', label: 'C6 站点根（直连 Vercel 那种部署）' }
];

let firstShot = true;
for (const c of CASES) {
  const r = await probe(c.url);
  const apiHits = hits.filter(h => /\/api\/health$/.test(h));
  const firstApi = apiHits[0] || '(没发接口请求)';
  chk(firstApi === c.want, `${c.label}：接口打到 ${c.want}`, '实际=' + firstApi);

  const assetHits = hits.filter(h => /\/assets\//.test(h));
  chk(assetHits.length === 0, `${c.label}：没有任何 /assets/ 资源请求（零外链的直接证据）`,
    JSON.stringify(assetHits));

  chk(BUILD_TAG_RE.test(r.buildTag), `${c.label}：页面 JS 真的跑起来了（版本号已渲染）`, r.buildTag);
  chk(r.styleTags >= 1 && r.inlineCssKB > 5, `${c.label}：样式确实内联到位`,
    `style标签=${r.styleTags} CSS=${r.inlineCssKB.toFixed(1)}KB`);
  // 这一条就是截图里的病：没样式时 .hide 失效，登录卡和应用主体一起露出来
  chk(r.appDisplay === 'none', `${c.label}：#app 被 .hide 正确隐藏（样式生效，不再两屏同显）`, r.appDisplay);
  chk(r.authDisplay !== 'none', `${c.label}：#auth 登录卡正常可见`, r.authDisplay);

  if (firstShot && c.url.endsWith('/ks')) {
    await page.screenshot({ path: path.join(SHOTS, 'paths-ks-ok.png'), clip: { x: 0, y: 0, width: 420, height: 620 } });
    firstShot = false;
  }
}

/* ============================================================
 * D. 反证：老的多文件产物确实会因为路径不同而崩
 * ============================================================ */
console.log('\n【D. 反证：跑 vite build（不内联）会怎样】');
{
  // 现场跑一次 vite build，看看它产出的 index.html 是不是把资源路径写死成构建期前缀
  const child = spawn(process.execPath,
    [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', 'dist_nocheck'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  const code = await new Promise(res => child.on('exit', res));
  const raw = path.join(ROOT, 'dist_nocheck', 'index.html');
  chk(code === 0, 'D1 单独跑 vite build 也能成功（说明这条链路正常）', 'exit=' + code);
  if (fs.existsSync(raw)) {
    const h = fs.readFileSync(raw, 'utf8');
    const refs = [...h.matchAll(/<script[^>]*\ssrc="([^"]+)"/gi)].map(m => m[1])
      .concat([...h.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/gi)].map(m => m[1]));
    chk(refs.length > 0, 'D2 未内联的产物里确实存在写死的外链', JSON.stringify(refs));
    chk(refs.some(u => u.startsWith('/')), 'D3 而且它们是**绝对路径**（换个子路径就必然 404）', JSON.stringify(refs));
    // v2.25：即使有人误跑裸 vite build，资源路径也该落在当前部署路径下（/ks/assets/...）
    chk(refs.every(u => u.startsWith('/ks/')),
      'D4 误跑裸 vite build 时，资源路径也落在 /ks/ 下（不再是已暂停的老前缀）', JSON.stringify(refs));
    console.log('      未内联产物引用的资源：' + refs.join(', '));
  }
  try { fs.rmSync(path.join(ROOT, 'dist_nocheck'), { recursive: true, force: true }); } catch (e) { }
}

chk(jsErrors.length === 0, 'E1 全程无 JS 报错', jsErrors.join(' | '));

/* ---------- 收尾 ---------- */
await browser.close();
await new Promise(r => server.close(r));

console.log('');
if (fails.length) {
  console.log(`✗ ${fails.length} / ${n} 项失败：`);
  fails.forEach(f => console.log('   ' + f));
  process.exit(1);
}
console.log(`✓ 全部通过：${n} / ${n}`);
