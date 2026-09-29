// 构建后处理：把 dist/assets 里的 CSS/JS 内联进 dist/index.html，
// 产出一个自包含单文件，便于像原有项目那样"只上传一个 HTML"。
import fs from 'node:fs';
import path from 'node:path';

const dist = path.resolve('dist');
const indexPath = path.join(dist, 'index.html');

if (!fs.existsSync(indexPath)) {
  console.error('[inline] 找不到 dist/index.html，请先执行 vite build');
  process.exit(1);
}

let html = fs.readFileSync(indexPath, 'utf8');

// 资源地址 → 本地文件路径
// 兼容三种写法：
//   './assets/x.js'                     （base: './'）
//   '/assets/x.js'                      （base: '/'）
//   '/ks/assets/x.js'                   （base: '/ks/'，本项目的实际配置）
function toLocal(href) {
  const clean = String(href).replace(/^\.?\//, '');
  const direct = path.join(dist, clean);
  if (fs.existsSync(direct)) return direct;
  // base 带子路径时，去掉第一段再试
  const parts = clean.split('/');
  if (parts.length > 1) {
    const stripped = path.join(dist, parts.slice(1).join('/'));
    if (fs.existsSync(stripped)) return stripped;
  }
  return direct;
}

// 1) 内联 <link rel="stylesheet">
let cssCount = 0;
html = html.replace(/<link[^>]*rel="stylesheet"[^>]*>/gi, (tag) => {
  const m = tag.match(/href="([^"]+)"/i);
  if (!m) return tag;
  const p = toLocal(m[1]);
  if (!fs.existsSync(p)) return tag;
  cssCount++;
  const css = fs.readFileSync(p, 'utf8');
  return `<style>\n${css}\n</style>`;
});

// 2) 内联 <script src="...">（含 module）
let jsCount = 0;
html = html.replace(/<script[^>]*src="([^"]+)"[^>]*>\s*<\/script>/gi, (tag, src) => {
  const p = toLocal(src);
  if (!fs.existsSync(p)) return tag;
  jsCount++;
  // 防止脚本内容里的 </script> 提前闭合标签
  const js = fs.readFileSync(p, 'utf8').replace(/<\/script>/gi, '<\\/script>');
  return `<script type="module">\n${js}\n</script>`;
});

fs.writeFileSync(indexPath, html, 'utf8');
const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
console.log(`[inline] 内联 CSS ${cssCount} 个 / JS ${jsCount} 个 → dist/index.html (${kb} KB)`);

// 3) 安全网：内联后必须「零外链」。
// 这条断言是 v2.24 加的，起因是一次真实的线上事故：构建只跑了 vite build（没有内联），
// 产物里 index.html 引用 /credit-exam-cloud/assets/xxx；而应用被网关换到了 /ks 访问，
// 浏览器就去 /credit-exam-cloud/assets/xxx 取样式 → 命中另一个已暂停的部署 → 503 →
// 整页没有任何样式（裸 HTML）。
// 只要内联到位，资源路径就与「部署在哪个子路径」彻底解耦。
// 万一哪天内联没生效，这里直接让构建失败，而不是把裸页面发到线上。
const leftovers = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/gi)].map(m => m[1])
  .concat([...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/gi)].map(m => m[1]));
if (leftovers.length) {
  console.error('[inline] ✗ 失败：内联后仍残留外链资源，构建中止');
  leftovers.forEach(u => console.error('        → ' + u));
  process.exit(1);
}
console.log('[inline] ✓ 校验通过：dist/index.html 零外链（可部署在任意子路径）');

// 3) 尝试清理已内联的 assets 目录（沙箱可能拦截删除，失败则忽略）
try {
  fs.rmSync(path.join(dist, 'assets'), { recursive: true, force: true });
  console.log('[inline] 已清理 dist/assets');
} catch (e) {
  console.log('[inline] 跳过清理 dist/assets（不影响使用）');
}
