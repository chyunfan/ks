// 检查已部署页面：托管方、资源可用性、部署 JS 的内容特征、api 函数是否在线
// ⚠ v2.24 起线上产物零外链、且 assets/ 里的 hash 每次都变，本脚本里写死的
//   assets/index-B_SaLDxl.js 已失效；域名已随仓库更名切到 /ks。保留仅作历史参考。
const base = 'https://www.chyunfan.cn/ks';

function countOcc(s, n) {
  let c = 0, i = 0;
  while ((i = s.indexOf(n, i)) !== -1) { c++; i += n.length; }
  return c;
}

(async () => {
  const r = await fetch(base + '/index.html');
  console.log('=== index.html headers ===');
  for (const [k, v] of r.headers) console.log('  ' + k + ': ' + v);
  const html = await r.text();
  console.log('  html bytes:', Buffer.byteLength(html));

  const assetRefs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]);
  console.log('  资源引用:', assetRefs.join(' | '));

  console.log('\n=== 部署 JS 内容特征 ===');
  const jsr = await fetch(base + '/assets/index-B_SaLDxl.js');
  const buf = Buffer.from(await jsr.arrayBuffer());
  const s = buf.toString('utf8');
  console.log('  bytes =', buf.length);
  const marks = ['exam_banks', 'exam_bank_progress', 'exam_accounts',
    'supabase.co', '/api/login', '/api/register', 'sb_publishable_', 'YOUR-PROJECT',
    'undefined_VITE', 'VITE_SUPABASE'];
  for (const n of marks) console.log('  "' + n + '": ' + countOcc(s, n) + ' 次');
  const urls = s.match(/https:\/\/[A-Za-z0-9-]+\.supabase\.co/gi);
  console.log('  supabase URL:', urls ? [...new Set(urls)].join(', ') : '(无)');

  console.log('\n=== api 函数探测 ===');
  for (const p of ['/api/login', '/api/register']) {
    try {
      const ar = await fetch(base + p, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });
      const t = await ar.text();
      console.log('  POST ' + p + ' -> ' + ar.status + '  ' +
        (ar.headers.get('content-type') || '') + '  ' + t.slice(0, 200).replace(/\n/g, ' '));
    } catch (e) { console.log('  POST ' + p + ' -> ERR ' + e.message); }
  }
})();
