/**
 * 大件按需加载（v2.32）
 *
 * 为什么需要：首屏单文件里曾经内联着五笔码表（209 KB）和 Excel 组件（427 KB），
 * 它们只在「打字练习」「导入/导出题库」时才用得上，却让每一次开页都多下 270 KB（gzip）。
 * 现在它们被放到 /lib/ 下，用到时才插 <script>。
 *
 * 路径怎么定：本项目跑在网关子路径（/ks）下，构建期写死的前缀不可信
 * （auth.js 里为此踩过两次事故）。这里沿用同一套「运行时推导 + 候选回退」：
 *   /ks/lib/xlsx.min.js → 站点根 /lib/xlsx.min.js → 构建期前缀兜底
 * 逐个尝试，谁先 loaded 用谁。
 *
 * 单文件版（npm run build:single）：内容会被内联成 <script type="text/plain" id="lib-xlsx">，
 * 这里检测到就直接 eval，一个请求都不发 —— 内网离线分发仍然只要一个 HTML。
 */
import { runtimePrefix } from './auth.js';

const BASE = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');

// /lib 下的文件是**固定文件名**（不走打包器哈希），靠 vercel.json 的 7 天缓存省流量。
// 哪天升级了 xlsx 或重生成码表，把这个版本号 +1，用户端立刻换新（缓存键带查询串）。
const LIB_VER = '1';

/** 候选地址：页面实际所在子路径 → 站点根 → 构建期前缀 */
function libUrls(file) {
  const tail = '/lib/' + file + '?v=' + LIB_VER;
  const list = [];
  const rt = runtimePrefix();
  if (rt) list.push(rt + tail);
  if (!list.includes(tail)) list.push(tail);
  if (BASE && !list.includes(BASE + tail)) list.push(BASE + tail);
  return list;
}

/** 插一个普通 <script> 并等它执行完 */
function injectScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = url;
    s.async = false;                 // 保序执行，避免与后续脚本穿插
    s.charset = 'utf-8';
    s.onload = () => resolve();
    s.onerror = () => { s.remove(); reject(new Error('加载失败：' + url)); };
    document.head.appendChild(s);
  });
}

const pending = new Map();   // name → Promise（并发调用共用一次加载）

/**
 * 加载一个挂全局变量的库。
 * @param {string} name   短名（用于并发去重与单文件内联标签 id：lib-xlsx / lib-wubi）
 * @param {string} file   实际文件名（xlsx 的产物叫 xlsx.min.js，跟短名不同）
 * @param {string} marker 全局变量名，加载成功后应存在
 */
async function loadLib(name, file, marker) {
  if (window[marker]) return window[marker];
  if (pending.has(name)) return pending.get(name);

  const task = (async () => {
    // 单文件版：构建期内联的源码，直接执行（不发请求）
    const inline = document.getElementById('lib-' + name);
    if (inline) {
      try { (0, eval)(inline.textContent); } catch (e) { /* 走网络兜底 */ }
      if (window[marker]) return window[marker];
    }
    let lastErr = null;
    for (const url of libUrls(file)) {
      try {
        await injectScript(url);
        if (window[marker]) return window[marker];
        lastErr = new Error('脚本已加载但没有导出 ' + marker + '：' + url);
      } catch (e) { lastErr = e; }
    }
    throw new Error('组件加载失败，请检查网络后重试'
      + (lastErr ? '（' + lastErr.message + '）' : ''));
  })();

  pending.set(name, task);
  try { return await task; } catch (e) { pending.delete(name); throw e; }
}

/** Excel 组件（SheetJS）：导入题库 / 导出 / 下载模板 */
export function ensureXLSX() { return loadLib('xlsx', 'xlsx.min.js', 'XLSX'); }

/** 五笔86 码表：打字练习的编码提示 */
export function ensureWubi() { return loadLib('wubi', 'wubi.js', '__WUBI'); }

// 验收脚本用（生产构建剔除）：确认主包确实不再内联这两个大件
if (import.meta.env.DEV) {
  window.__lazylib = { libUrls, ensureXLSX, ensureWubi };
}
