/**
 * 大件按需加载的验收（v2.32）
 *
 * 起因：用户反馈「页面打开时加载很慢」。实测首屏 gzip 411 KB，其中 272 KB 是
 * 五笔码表（209 KB）和 Excel 组件（427 KB 原始）—— 只在打字练习 / 导入导出时才用，
 * 却让每一次开页都付费。这条链路上 20 KB/s，多出来的 270 KB 就是十几秒。
 *
 * 做法：两个大件移到 /lib/，用到时才插 <script>。这个脚本钉住：
 *   A. 主包（含构建产物）里**确实没有**这两个大件的代码
 *   B. 用到时能加载成功（ensureXLSX 拿到函数、ensureWubi 拿到码表）
 *   C. 路径走运行时前缀候选（部署在 /ks 子路径也能取到）
 *   D. 只下一次（并发/重复调用共用同一次加载）
 *   E. 产物里有按需件（部署时不能漏传 lib/ 目录）
 *
 * 用法：node scripts/check_lib.mjs      （需要先 npm run build）
 */
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const PW_CORE = process.env.PW_CORE
  || 'C:/Users/cyf/.workbuddy/binaries/node/workspace/node_modules/playwright-core/index.js';
const _pw = await import(pathToFileURL(PW_CORE).href);
const chromium = _pw.chromium || _pw.default?.chromium;
const EXE = 'C:/Users/cyf/AppData/Local/ms-playwright/chromium-1140/chrome-win/chrome.exe';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 5223;
const URL_APP = `http://localhost:${PORT}/ks/`;

const fails = [];
let n = 0;
const chk = (cond, name, extra) => {
  n++;
  if (cond) console.log(`  ✔ ${name}`);
  else { fails.push(name + (extra ? '｜实际：' + extra : '')); console.log(`  ✘ ${name}${extra ? '｜实际：' + extra : ''}`); }
};

/* ---------- A. 静态：主包里不该有这两个大件 ---------- */
console.log('\n【A】主包体积与内容');
const distPath = path.join(ROOT, 'dist/index.html');
const dist = fs.existsSync(distPath) ? fs.readFileSync(distPath, 'utf8') : '';
const distKB = (Buffer.byteLength(dist) / 1024).toFixed(1);
const gzKB = (await import('node:zlib')).gzipSync(Buffer.from(dist), { level: 9 }).length / 1024;

chk(!!dist, 'A1 dist/index.html 存在', String(dist.length));
chk(!/SheetJS/.test(dist), 'A2 主包不含 Excel 组件（SheetJS 版权头不在）', '');
chk(!/xlsx\.js \(C\) 2013-present/.test(dist), 'A2 主包不含 Excel 组件的特征串', '');
chk(!/PACKED\s*=\s*'工a /.test(dist), 'A3 主包不含五笔码表（PACKED 常量不在）', '');
chk(gzKB < 160, 'A4 首屏 gzip 已在 160 KB 以内（v2.31 是 396 KB）', gzKB.toFixed(1) + ' KB / 原始 ' + distKB + ' KB');

/* ---------- B. 按需件在位 ---------- */
console.log('\n【B】按需件与产物');
const libX = path.join(ROOT, 'dist/lib/xlsx.min.js');
const libW = path.join(ROOT, 'dist/lib/wubi.js');
chk(fs.existsSync(libX) && fs.statSync(libX).size > 300 * 1024, 'B1 dist/lib/xlsx.min.js 已生成', fs.existsSync(libX) ? fs.statSync(libX).size + ' B' : '缺失');
chk(fs.existsSync(libW) && fs.statSync(libW).size > 150 * 1024, 'B2 dist/lib/wubi.js 已生成', fs.existsSync(libW) ? fs.statSync(libW).size + ' B' : '缺失');
const wubiCode = fs.existsSync(libW) ? fs.readFileSync(libW, 'utf8') : '';
chk(/window\.__WUBI\s*=\s*WUBI/.test(wubiCode), 'B3 五笔码表被包成普通脚本（挂 window.__WUBI）', '');
chk(!/^\s*export\s/m.test(wubiCode), 'B3 码表产物里没有 ESM 导出（才能当普通 <script> 加载）', '');
chk(/id="bootMask"/.test(dist), 'B4 首屏骨架仍在（遮罩兜底）', '');

/* ---------- C. 运行时：真的能加载、只加载一次、路径可回退 ---------- */
const srv = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe']
});
await new Promise((res, rej) => {
  const t0 = Date.now();
  const timer = setInterval(async () => {
    if (Date.now() - t0 > 40000) { clearInterval(timer); rej(new Error('vite dev server 启动超时')); return; }
    try { const r = await fetch(URL_APP); if (r.ok) { clearInterval(timer); res(); } } catch (e) { }
  }, 400);
  srv.stderr.on('data', d => process.stderr.write(d));
});

const browser = await chromium.launch({ executablePath: EXE });
const page = await browser.newPage();
const reqs = [];
page.on('request', r => { if (/\/lib\//.test(r.url())) reqs.push({ url: r.url(), t: Date.now() }); });
const jsErrors = [];
page.on('pageerror', e => jsErrors.push(e.message));

await page.goto(URL_APP);
await page.waitForTimeout(800);

const before = reqs.length;
chk(before === 0, 'C1 首屏**不**加载这两个大件（一个请求都没有）', before + ' 个请求');

// 并发调三次：应共用一次加载
const r = await page.evaluate(async () => {
  const [a, b, c] = await Promise.all([
    window.__lazylib.ensureXLSX(), window.__lazylib.ensureXLSX(), window.__lazylib.ensureXLSX()
  ]);
  return {
    same: a === b && b === c,
    hasUtils: !!(a && a.utils && typeof a.utils.aoa_to_sheet === 'function'),
    hasWrite: !!(a && typeof a.writeFile === 'function'),
    hasRead: !!(a && typeof a.read === 'function'),
    globalSame: a === window.XLSX
  };
});
chk(r.same && r.globalSame, 'C2 并发三次只加载一份，且就是 window.XLSX', JSON.stringify(r));
chk(r.hasUtils && r.hasWrite && r.hasRead, 'C3 拿到的组件能读、能写、能生成表格', JSON.stringify(r));
const afterX = reqs.length;
chk(afterX === 1, 'C4 只发了一个 lib 请求（没有重复下载）', afterX + ' 个');

// 再调一次：不应再发请求
await page.evaluate(() => window.__lazylib.ensureXLSX());
await page.waitForTimeout(200);
chk(reqs.length === afterX, 'C5 再调不再下载（留在内存里）', reqs.length + ' 个');

// 五笔码表
const w = await page.evaluate(async () => {
  const t = await window.__lazylib.ensureWubi();
  return { gong: t && t['工'], de: t && t['地'], size: t ? Object.keys(t).length : 0 };
});
chk(w.gong === 'a' && w.de === 'f' && w.size > 20000, 'C6 五笔码表可用（工=a / 地=f，两万余字）', JSON.stringify(w));

// 路径候选：/ks/lib/... 取得到（本项目就是 /ks 子路径）
const libReqs = reqs.map(x => x.url);
chk(libReqs.some(u => /\/ks\/lib\/xlsx\.min\.js/.test(u)), 'C7 按需件按运行时前缀取到（/ks/lib/...）', JSON.stringify(libReqs));
chk(jsErrors.length === 0, 'C8 全程无 JS 报错', jsErrors.join(' | '));

/* ---------- D. 源码守卫 ---------- */
console.log('\n【D】源码守卫');
const assetsSrc = fs.readFileSync(path.join(ROOT, 'src/assets.js'), 'utf8');
const prepSrc = fs.readFileSync(path.join(ROOT, 'scripts/prepare-assets.mjs'), 'utf8');
chk(/apiCandidates|runtimePrefix/.test(assetsSrc), 'D1 路径走运行时前缀（不写死 /ks）', '');
chk(/LIB_VER/.test(assetsSrc), 'D2 有缓存版本号，升级组件可换 URL', '');
chk(/--inline-lib/.test(fs.readFileSync(path.join(ROOT, 'scripts/inline.mjs'), 'utf8')),
  'D3 保留单文件构建（build:single，内网离线分发仍只要一个 HTML）', '');
chk(/window\.__WUBI/.test(prepSrc), 'D4 构建前置把码表转成普通脚本', '');

await browser.close();
srv.kill('SIGTERM');

console.log('\n' + '='.repeat(56));
console.log(`  通过 ${n - fails.length} / ${n}`);
if (fails.length) {
  console.log('  未通过：');
  fails.forEach(f => console.log('   · ' + f));
}
console.log('='.repeat(56));
process.exit(fails.length ? 1 : 0);
