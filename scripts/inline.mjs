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

function toLocal(href) {
  const clean = href.replace(/^\.?\//, '');
  return path.join(dist, clean);
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

// 3) 尝试清理已内联的 assets 目录（沙箱可能拦截删除，失败则忽略）
try {
  fs.rmSync(path.join(dist, 'assets'), { recursive: true, force: true });
  console.log('[inline] 已清理 dist/assets');
} catch (e) {
  console.log('[inline] 跳过清理 dist/assets（不影响使用）');
}
