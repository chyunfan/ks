// 检查线上 bundle 是否包含最新改动标记
// ⚠ v2.24 起线上产物是**零外链单文件**（CSS/JS 全部内联），本脚本仍按「HTML 里找 .js 外链」
//   的老结构写的，已不适用，保留仅作历史参考。域名已随仓库更名切到 /ks。
const base = 'https://www.chyunfan.cn/ks';
const markers = ['flushNow', 'cancelPending', 'loadBankState', 'exam_bank_progress',
  'exam_banks', 'openBankById', 'applyTemplateInline', 'inline', '__diag__'];

const count = (s, n) => s.split(n).length - 1;

(async () => {
  const html = await (await fetch(base + '/index.html')).text();
  const jsPath = (html.match(/src="([^"]*\.js)"/) || [])[1];
  console.log('线上 JS:', jsPath);
  const jsUrl = new URL(jsPath, base + '/').toString();
  const js = await (await fetch(jsUrl)).text();
  console.log('bytes:', Buffer.byteLength(js));
  for (const m of markers) console.log('  ' + m.padEnd(20) + count(js, m));
})();
