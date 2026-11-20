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
//
// v2.40 把 1 → 2：2026-11-20 的第二次事故不是「文件没上传」，而是**上传之前那个 404
// 被 CDN 缓存了**（X-Vercel-Cache: HIT，Age 1970s）。URL 一直是 ?v=1，缓存键不变，
// 于是文件明明已经 200（437108 字节）用户还是点不出来。换版本号 = 换缓存键，立刻好。
const LIB_VER = '2';

/**
 * 候选地址：页面实际所在子路径 → 站点根 → 构建期前缀
 * @param {boolean} bust 带一次性参数，用来穿透「404 被 CDN / 浏览器缓存住」的情况
 */
function libUrls(file, bust) {
  const tail = '/lib/' + file + '?v=' + LIB_VER + (bust ? '&_=' + Date.now().toString(36) : '');
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
const LABEL = { xlsx: 'Excel 组件', wubi: '五笔码表' };   // 出错提示里说人话

/**
 * 失败诊断：这个地址到底返回了什么（只在出错时调用，正常路径零开销）
 *
 * 为什么需要：灾难现场是「脚本加载成功（onload 触发了）但没有 window.XLSX」——
 * 因为服务器把 404 换成了 **200 的 HTML 页面**（Vercel 的 SPA 兜底、网关首页都是这德行），
 * 浏览器照单当脚本执行，报一句 "Unexpected token '<'" 就没了。
 * 光看那句话，谁也猜不到「部署里缺 dist/lib」。这里把响应类型摸清楚，给一句人话。
 */
export async function libProbe(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    const head = r.ok ? (await r.text()).slice(0, 200) : '';
    if (!r.ok) return { kind: 'http', status: r.status, ct };
    if (ct.includes('html') || /^\s*</.test(head)) return { kind: 'html', status: r.status, ct };
    return { kind: 'js', status: r.status, ct };
  } catch (e) {
    return { kind: 'net', status: 0, ct: '' };
  }
}

/** 把诊断结果翻译成一句用户/管理员都能用的话（路径用真的那个，别写死 /lib/） */
function libErrText(url, probe) {
  const path = String(url || '').replace(/^https?:\/\/[^/]+/i, '') || '/lib/';
  if (probe.kind === 'html') return path + ' 取不到（返回的是网页，不是脚本）：部署产物里没有 lib 目录';
  if (probe.status === 404) return path + ' 404（已换地址重试过）：部署产物里没有 lib 目录';
  if (probe.kind === 'http') return path + ' 打不开（HTTP ' + probe.status + '）';
  return '连不上服务器，取不到 ' + path;
}


/**
 * 依次尝试一组候选地址，任一成功即返回（失败不抛，交给调用方决定重试还是报错）
 * @returns {Promise<{ok:boolean, val?:any, lastUrl:string, urls:string[]}>}
 */
async function tryUrls(file, marker, bust) {
  const urls = libUrls(file, bust);
  let lastUrl = '';
  for (const url of urls) {
    lastUrl = url;
    try {
      await injectScript(url);
      if (window[marker]) return { ok: true, val: window[marker], lastUrl, urls };
    } catch (e) { /* 换下一个候选 */ }
  }
  return { ok: false, lastUrl, urls };
}

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
    // 第 1 轮：常规地址（能吃到 7 天缓存，省流量）
    let r = await tryUrls(file, marker, false);
    if (r.ok) return r.val;
    // 第 2 轮：每个地址加一个一次性参数，把「缓存住的 404 / 缓存住的老脚本」错开。
    // 这一步是 v2.40 补的：文件其实在服务器上，但 CDN 把上传之前那次 404 缓存了半个多小时，
    // 固定 URL 一直命中旧缓存 → 用户永远点不出来（而服务器上早就 200 了）。
    r = await tryUrls(file, marker, true);
    if (r.ok) return r.val;

    // 两轮都失败 → 问一次服务器到底返回什么，拼一句能用来排查的话
    let probedUrl = r.lastUrl || libUrls(file, true)[0];
    let probe = await libProbe(probedUrl);
    if (probe.kind === 'net' && r.urls.length > 1) {
      probedUrl = r.urls[r.urls.length - 1];
      probe = await libProbe(probedUrl);
    }
    throw new Error((LABEL[name] || '组件') + '加载失败：' + libErrText(probedUrl, probe)
      + '。若刚部署过，请确认仓库里有 public/lib/ 下那两个文件。');
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
  window.__lazylib = { libUrls, libProbe, ensureXLSX, ensureWubi };
}
