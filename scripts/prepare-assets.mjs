// ============================================================
// 构建前置：把两个「大件但很少用」的库放到 public/lib/ 下，改成按需加载（v2.32）
// ------------------------------------------------------------
// 起因：首屏单文件 gzip 411 KB，其中 272 KB 是这两个家伙 ——
//   · 五笔码表（27516 字）：只有「打字练习」用
//   · Excel 组件（SheetJS）：只有「导入题库 / 导出 / 下载模板」用
// 也就是说，99% 的开页动作都在为这两件偶尔才用的事付费。实测这条链路上
// 下载只有 20 KB/s 左右，多出来的 270 KB 就是十几秒白屏。
//
// 做法：构建时把它们拷成独立文件（public/lib/ → dist/lib/），前端用到时才
// 动态插入 <script> 加载。放 public/ 而不是让打包器处理，是为了拿到**固定文件名**：
// 打包器会给动态 chunk 加哈希并改写路径，而本项目要跑在网关子路径（/ks）下，
// 固定名字 + 运行时前缀推导最不容易出错。
//
// wubi.js 原本是 ES 模块，这里转成等价的 IIFE 挂到 window.__WUBI 上，
// 这样加载方式与 xlsx 一致（都是普通 <script>），不必关心 import/模块作用域。
//
// 幂等：可重复执行；源文件没变就跳过写入。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'public', 'lib');
fs.mkdirSync(OUT, { recursive: true });

const kb = n => (n / 1024).toFixed(1) + ' KB';

function writeIfChanged(file, content) {
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (old === content) return false;
  fs.writeFileSync(file, content, 'utf8');
  return true;
}

/* ---------- 1) SheetJS（浏览器构建，自带 window.XLSX） ---------- */
const xlsxSrc = path.join(ROOT, 'node_modules', 'xlsx', 'dist', 'xlsx.core.min.js');
if (!fs.existsSync(xlsxSrc)) {
  console.error('[assets] 找不到 node_modules/xlsx/dist/xlsx.core.min.js，请先 npm install');
  process.exit(1);
}
const xlsxOut = path.join(OUT, 'xlsx.min.js');
const xlsxCode = fs.readFileSync(xlsxSrc, 'utf8');
// 加个标记，验收脚本据此确认「加载的是按需件，不是主包内联」
const xlsxChanged = writeIfChanged(xlsxOut, '/* credit-exam-cloud · 按需加载件：Excel 解析/导出（v2.32） */\n' + xlsxCode);

/* ---------- 2) 五笔码表（ES 模块 → IIFE） ---------- */
const wubiSrc = path.join(ROOT, 'src', 'wubi.js');
const wubiCode = fs.readFileSync(wubiSrc, 'utf8');
if (!/export\s*\{\s*WUBI\s*\}/.test(wubiCode)) {
  console.error('[assets] src/wubi.js 的导出形式变了（找不到 export { WUBI }），请同步 scripts/prepare-assets.mjs');
  process.exit(1);
}
const wubiBody = wubiCode.replace(/export\s*\{\s*WUBI\s*\};?/, '');
const wubiOut = path.join(OUT, 'wubi.js');
const wubiOutCode = '/* credit-exam-cloud · 按需加载件：五笔86 码表（v2.32）*/\n(function(){\n'
  + wubiBody + '\nwindow.__WUBI = WUBI;\n})();\n';
const wubiChanged = writeIfChanged(wubiOut, wubiOutCode);

const size = f => kb(fs.statSync(f).size);
console.log('[assets] xlsx.min.js ' + size(xlsxOut) + (xlsxChanged ? '（已更新）' : '（未变）')
  + ' / wubi.js ' + size(wubiOut) + (wubiChanged ? '（已更新）' : '（未变）'));
console.log('[assets] 这两个文件会在用到时才加载（打字练习 / 导入导出），不再进首屏包');
