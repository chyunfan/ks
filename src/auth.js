import { setToken, getToken } from './supabase.js';

// ============================================================
// 构建标识：页面会显示出来，用于确认「浏览器跑的是不是最新版」
// （改代码后务必同步更新这里，便于一眼看出缓存问题）
// ============================================================
export const BUILD_TAG = 'v2.26 · 2026-09-29';

// ============================================================
// 后端接口地址（候选列表，自动回退）
// ------------------------------------------------------------
// 本应用有三种访问形态：
//   A. 被网关 rewrites 代理到子路径：https://www.chyunfan.cn/ks（现在就用这条）
//      → 接口必须是 /ks/api/xxx（网关按前缀转发到 Vercel）
//   B. 直接访问 Vercel：https://credit-exam-cloud.vercel.app
//      → /api/xxx 可用；带前缀的 /xxx/api/xxx 由项目内 rewrite 兜住，也可用
//   C. 老路径 https://www.chyunfan.cn/credit-exam-cloud
//      → 网关那条规则指向的部署已暂停（503），v2.25 起不再把它当作兜底前缀
//
// 历史上踩过的两个坑（同一个根因：**构建期写死的前缀 ≠ 实际访问路径**）：
//   1) base 配成 './' 时，页面在无尾斜杠的 /credit-exam-cloud 下会把 ./api/login
//      解析成站点根 /api/login → 命中网关 404 页 → 前端 JSON.parse 报
//      "Unexpected token 'T', "The page c"... is not valid JSON"。
//   2) v2.24：应用被挪到 /ks 访问后，页面仍按构建期的 /credit-exam-cloud 调接口，
//      打到另一个已暂停的部署上（503 HTML）→ 登录直接失败。
//
// 结论：前缀不能再信构建期常量。**以「页面自己实际所在的路径」为准**永远正确 ——
// 页面在 /ks，接口就是 /ks/api/xxx；页面在站点根，接口就是 /api/xxx。
// 仍然保留候选列表逐个尝试（命中 JSON 即成功），这样任何部署方式都不会全盘卡死。
// ============================================================
const BASE_PREFIX = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '');

/**
 * 运行时推导当前页面所在的部署前缀。
 *   /ks                → '/ks'
 *   /ks/               → '/ks'
 *   /ks/index.html     → '/ks'
 *   /credit-exam-cloud → '/credit-exam-cloud'
 *   /                  → ''（部署在站点根）
 */
function runtimePrefix() {
  try {
    let p = String(location.pathname || '/');
    p = p.replace(/\/index\.html?$/i, '');
    p = p.replace(/\/+$/, '');
    return p === '/' ? '' : p;
  } catch (e) {
    return '';
  }
}

export function apiCandidates(path) {
  const p = String(path || '');
  const tail = p.startsWith('/') ? p : '/' + p;
  const list = [];
  const rt = runtimePrefix();
  if (rt) list.push(rt + tail);               // ① 页面实际所在的子路径（最可靠）
  if (!list.includes(tail)) list.push(tail);  // ② 站点根（直连 Vercel / 部署在根时）
  if (BASE_PREFIX && !list.includes(BASE_PREFIX + tail)) list.push(BASE_PREFIX + tail);  // ③ 构建期前缀（兜底）
  return list;
}

/**
 * 逐个候选地址 POST。
 * 只有「请求没打到后端」（网络错误 / 拿到 HTML 404 页）才换下一个候选；
 * 后端明确返回的 JSON 错误（409、400…）直接抛出，不重试，避免重复注册。
 */
async function postJSON(path, body) {
  const urls = apiCandidates(path);
  let lastErr = null;

  for (const url of urls) {
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      });
    } catch (e) {
      lastErr = new Error(`网络不可达：${url}`);
      continue;
    }

    const text = await resp.text();
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch (e) { data = null; }

    if (data === null) {
      // 返回的不是 JSON（通常是网关/Vercel 的 404 页面）→ 说明该地址没落到后端函数
      const snippet = text.trim().slice(0, 40).replace(/\s+/g, ' ');
      lastErr = new Error(`接口未就绪（HTTP ${resp.status}）：${url}｜返回：${snippet}`);
      continue;
    }
    if (!resp.ok) throw new Error(data.error || `请求失败（HTTP ${resp.status}）`);
    return data;
  }

  throw lastErr || new Error('接口不可用');
}

/** 后端连通性自检：登录页会用结果显示「后端正常 / 不可用」 */
export async function checkBackend() {
  for (const url of apiCandidates('/api/health')) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      const t = await r.text();
      const d = JSON.parse(t);
      if (d && d.ok) return { ok: true, url };
    } catch (e) { /* 试下一个候选 */ }
  }
  return { ok: false };
}

let mode = 'login';
let onLogin = null;

export function initAuth(cb) {
  onLogin = cb.onLogin;

  document.getElementById('tabLogin').addEventListener('click', () => setMode('login'));
  document.getElementById('tabReg').addEventListener('click', () => setMode('reg'));
  document.getElementById('authSubmit').addEventListener('click', submit);
  document.getElementById('authPass').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  document.getElementById('authUser').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });

  // 版本号 + 后端自检：一眼区分「浏览器跑的是新版还是缓存的旧版」
  const tag = document.getElementById('buildTag');
  if (tag) {
    tag.textContent = `${BUILD_TAG} · 正在检测后端…`;
    tag.style.color = '';
    checkBackend().then(r => {
      tag.textContent = r.ok
        ? `${BUILD_TAG} · 后端正常`
        : `${BUILD_TAG} · 后端不可用（请按 Ctrl+Shift+R 强制刷新重试）`;
      tag.style.color = r.ok ? 'var(--ok)' : 'var(--bad)';
    });
  }
}

export function getSession() {
  return getToken() ? { token: getToken() } : null;
}

export function getUsername() {
  try { return localStorage.getItem('ce_user') || ''; } catch { return ''; }
}

function setMode(m) {
  mode = m;
  document.getElementById('tabLogin').classList.toggle('active', m === 'login');
  document.getElementById('tabReg').classList.toggle('active', m === 'reg');
  document.getElementById('authSubmit').textContent = m === 'login' ? '登录' : '注册';
  document.getElementById('authMsg').textContent = '';
}

function msg(t, bad) {
  const el = document.getElementById('authMsg');
  el.textContent = t;
  el.style.color = bad ? 'var(--bad)' : 'var(--ok)';
}

async function submit() {
  const username = document.getElementById('authUser').value.trim();
  const password = document.getElementById('authPass').value;
  if (!username || !password) { msg('请填写账号和密码', true); return; }

  // 注册模式先做本地校验，避免无谓请求（规则与后端 api/register.js 保持一致）
  if (mode === 'reg') {
    if (Array.from(username).length < 5) { msg('账号至少 5 位（中文按字符计）', true); return; }
    if (Array.from(password).length < 6) { msg('密码至少 6 位（中文按字符计）', true); return; }
  }

  const btn = document.getElementById('authSubmit');
  btn.disabled = true;
  try {
    if (mode === 'reg') {
      await postJSON('/api/register', { username, password });
      // 注册成功后自动登录
      const d2 = await postJSON('/api/login', { username, password });
      setToken(d2.token);
    } else {
      const data = await postJSON('/api/login', { username, password });
      setToken(data.token);
    }
    try { localStorage.setItem('ce_user', username); } catch (e) {}
    document.getElementById('authPass').value = '';
    msg('', false);
    if (onLogin) onLogin(username);
  } catch (e) {
    const t = String(e && e.message || '操作失败');
    msg(t.length > 160 ? t.slice(0, 160) + '…' : t, true);
  } finally {
    btn.disabled = false;
  }
}

export function logout() {
  setToken(null);
  try { localStorage.removeItem('ce_user'); } catch (e) {}
}
