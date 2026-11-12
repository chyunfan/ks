import { apiCandidates } from './auth.js';
import { getToken } from './supabase.js';

// ============================================================
// 当前登录者的身份资料 + 用户管理界面（仅管理员）
// ------------------------------------------------------------
// 身份资料来自 /api/me（服务端读 exam_accounts 返回）。
// 这里的 isAdmin 只用于「界面显示哪些按钮」，真正的权限判定在
// 数据库 RLS 与 /api/admin-users 里各自独立校验，前端改不了。
// ============================================================

let me = null;          // { id, username, isAdmin, dept, role }
let users = [];         // 用户列表缓存（同时作为「部门 / 角色」候选来源）
let onBack = null;
let onShow = null;
let onMeChange = null;
let _inited = false;

export function getMe() { return me; }
export function isAdmin() { return !!(me && me.isAdmin); }
export function getKnownUsers() { return users; }

/** 从缓存里取出出现过的部门 / 角色（去重、按出现次数排序） */
export function knownTags() {
  const tally = list => {
    const m = new Map();
    list.forEach(v => { const s = String(v || '').trim(); if (s) m.set(s, (m.get(s) || 0) + 1); });
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).map(x => x[0]);
  };
  return {
    depts: tally(users.map(u => u.dept)),
    roles: tally(users.map(u => u.role))
  };
}

/**
 * 带令牌的接口请求。沿用登录接口那套「多候选地址回退」：
 * 子路径代理下接口是 /credit-exam-cloud/api/xxx，直连 Vercel 时是 /api/xxx。
 */
export async function apiRequest(method, path, body, needAuth = true) {
  const urls = apiCandidates(path);
  let lastErr = null;

  for (const url of urls) {
    let resp;
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (needAuth && getToken()) headers.Authorization = 'Bearer ' + getToken();
      resp = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (e) { lastErr = new Error('网络不可达：' + url); continue; }

    const text = await resp.text();
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch (e) { data = null; }
    if (data === null) { lastErr = new Error('接口未就绪（HTTP ' + resp.status + '）：' + url); continue; }
    if (!resp.ok) throw new Error(data.error || ('请求失败（HTTP ' + resp.status + '）'));
    return data;
  }
  throw lastErr || new Error('接口不可用');
}

/** 拉取自己的资料；失败（未登录 / 接口未部署）时降级为「非管理员」，不影响练习 */
export async function loadMe() {
  if (!getToken()) { me = null; return null; }
  try { me = await apiRequest('GET', '/api/me'); }
  catch (e) { me = null; }
  return me;
}

/** 确保用户列表已加载（可见范围弹窗要用它给出「常用部门 / 角色」候选） */
export async function ensureUsers() {
  if (users.length || !isAdmin()) return users;
  try {
    const d = await apiRequest('GET', '/api/admin-users');
    users = d.users || [];
  } catch (e) { /* 拉不到就只支持手工输入 */ }
  return users;
}

/** 顶部栏「用户管理」入口的显隐 */
export function applyAdminEntry() {
  const btn = document.getElementById('toAdmin');
  if (btn) btn.classList.toggle('hide', !isAdmin());
}

export function initAdmin(cb) {
  onBack = cb.onBack;
  onShow = cb.onShow;
  onMeChange = cb.onMeChange;

  if (_inited) return;
  _inited = true;

  document.getElementById('toAdmin').addEventListener('click', () => showAdmin());
  document.getElementById('userReload').addEventListener('click', () => renderAdminUsers());
  document.getElementById('userSearch').addEventListener('input', renderUserRows);
  document.getElementById('userList').addEventListener('click', onUserListClick);

  // 做题情况弹层：✕ 与遮罩都能关
  document.getElementById('statsClose').addEventListener('click', closeStats);
  document.getElementById('statsMask').addEventListener('click', closeStats);

  // 分题库统计弹层（按题库横向看所有人）
  const bBtn = document.getElementById('bankStatsBtn');
  if (bBtn) bBtn.addEventListener('click', openBankStats);
  const bClose = document.getElementById('bstatsClose');
  if (bClose) bClose.addEventListener('click', closeBankStats);
  const bMask = document.getElementById('bstatsMask');
  if (bMask) bMask.addEventListener('click', closeBankStats);
  const bPick = document.getElementById('bstatsPick');
  if (bPick) bPick.addEventListener('change', e => loadBankStats(e.target.value));
}

export async function showAdmin() {
  if (!isAdmin()) return false;
  bstatBanks = null;        // 每次进后台重拉题库清单：别人刚导入的题库要能选到
  if (onShow) onShow();
  await renderAdminUsers();
  return true;
}

export async function renderAdminUsers() {
  const box = document.getElementById('userList');
  if (!box) return;
  if (!isAdmin()) { box.innerHTML = '<div class="muted" style="padding:16px 0">需要管理员权限。</div>'; return; }
  box.innerHTML = '<div class="muted" style="padding:16px 0">加载中…</div>';
  try {
    const d = await apiRequest('GET', '/api/admin-users');
    users = d.users || [];
    adminMsg('');
    renderUserRows();
  } catch (e) {
    box.innerHTML = '<div class="feedback no show">加载用户失败：' + esc(e.message) + '</div>';
  }
}

function renderUserRows() {
  const box = document.getElementById('userList');
  const kw = (document.getElementById('userSearch').value || '').trim().toLowerCase();
  const list = users.filter(u => {
    if (!kw) return true;
    return (u.username || '').toLowerCase().includes(kw)
      || (u.dept || '').toLowerCase().includes(kw)
      || (u.role || '').toLowerCase().includes(kw);
  });

  const admins = users.filter(u => u.isAdmin).length;
  const head = '<div class="muted list-head">共 ' + users.length + ' 个账号 · 管理员 ' + admins + ' 名' +
    (kw ? '（筛选后 ' + list.length + ' 个）' : '') + '</div>';

  if (!list.length) {
    box.innerHTML = head + '<div class="muted" style="padding:14px 0">没有匹配的账号。</div>';
    return;
  }

  box.innerHTML = head + list.map(u => `
    <div class="user-row${u.isAdmin ? ' is-adm' : ''}" data-id="${esc(u.id)}">
      <div class="u-main">
        <div class="u-name">${esc(u.username)}
          ${u.isAdmin ? '<span class="u-badge">管理员</span>' : ''}
          ${u.id === (me && me.id) ? '<span class="u-badge me">我</span>' : ''}
        </div>
        <div class="muted">注册 ${fmtDate(u.createdAt)} · 题库 ${u.bankCount} 个${u.sharedCount ? '（共享 ' + u.sharedCount + '）' : ''}</div>
      </div>
      <div class="u-fields">
        <label class="u-f"><span>部门</span><input class="field u-dept" value="${esc(u.dept)}" placeholder="如：信贷部"></label>
        <label class="u-f"><span>角色</span><input class="field u-role" value="${esc(u.role)}" placeholder="如：客户经理"></label>
        <label class="u-adm"><input type="checkbox" class="u-isadmin"${u.isAdmin ? ' checked' : ''}> 管理员</label>
        <button class="btn btn-primary btn-sm u-save" type="button">保存</button>
        <button class="btn btn-ghost btn-sm u-stats" type="button">做题情况</button>
        <button class="btn btn-ghost btn-sm u-reset" type="button">重置密码</button>
      </div>
    </div>`).join('');
}

async function onUserListClick(e) {
  // 复制临时密码（结果条上的按钮）
  const copyBtn = e.target.closest('.u-copy');
  if (copyBtn) return copyPwd(copyBtn);

  // 重置密码（管理员代客重置）
  const resetBtn = e.target.closest('.u-reset');
  if (resetBtn) return resetUserPwd(resetBtn);

  // 查看做题情况
  const statsBtn = e.target.closest('.u-stats');
  if (statsBtn) return openStats(statsBtn);

  const btn = e.target.closest('.u-save');
  if (!btn) return;
  const row = btn.closest('.user-row');
  if (!row) return;
  const id = row.dataset.id;
  const before = users.find(u => u.id === id);
  if (!before) return;

  const dept = row.querySelector('.u-dept').value.trim();
  const role = row.querySelector('.u-role').value.trim();
  const isAdm = row.querySelector('.u-isadmin').checked;

  btn.disabled = true;
  btn.textContent = '保存中…';
  adminMsg('');
  try {
    const d = await apiRequest('POST', '/api/admin-users', {
      action: 'updateUser', userId: id, dept, role, isAdmin: isAdm
    });
    users = d.users || users;
    adminMsg('已保存：' + (d.updated || before.username), true);
    // 管理员名单可能变了（含把自己降级）→ 重新取一次自己的资料
    await loadMe();
    applyAdminEntry();
    if (onMeChange) onMeChange();
    renderUserRows();
    if (!isAdmin()) {
      document.getElementById('userList').innerHTML =
        '<div class="feedback warn show">你已不再拥有管理员权限，管理入口已隐藏。</div>';
      return;
    }
  } catch (err) {
    adminMsg(err.message, false, true);
    renderUserRows();
  } finally {
    btn.disabled = false;
    btn.textContent = '保存';
  }
}

/**
 * 做题情况：管理员查看某个账号在每个题库上的「已做 / 总数 + 正确率」。
 * 统计口径在服务端算（api/admin-stats.js），前端只渲染数字。
 */
async function openStats(btn) {
  const row = btn.closest('.user-row');
  if (!row) return;
  const id = row.dataset.id;
  const u = users.find(x => x.id === id);
  if (!u) return;

  const modal = document.getElementById('statsModal');
  document.getElementById('statsUserName').textContent = u.username;
  document.getElementById('statsSummary').innerHTML = '';
  document.getElementById('statsList').innerHTML =
    '<div class="muted" style="padding:20px 0;text-align:center">加载中…</div>';
  modal.classList.remove('hide');

  try {
    const d = await apiRequest('GET', '/api/admin-stats?userId=' + encodeURIComponent(id));
    if (modal.classList.contains('hide')) return;   // 加载期间被关掉了，别再往里写
    renderStats(d);
  } catch (err) {
    document.getElementById('statsList').innerHTML =
      '<div class="feedback no show">加载失败：' + esc(err.message) + '</div>';
  }
}

function closeStats() {
  const m = document.getElementById('statsModal');
  if (m) m.classList.add('hide');
}

function renderStats(d) {
  const s = d.summary || {};
  const ans = s.answered || 0;
  const rate = s.rate || 0;

  document.getElementById('statsSummary').innerHTML =
    '<div class="stat"><b>' + ans + '</b><span>累计做题</span></div>' +
    '<div class="stat"><b class="' + rateCls(rate, ans) + '">' + (ans ? rate + '%' : '—') + '</b><span>总正确率</span></div>' +
    '<div class="stat"><b>' + (s.bankCount || 0) + '</b><span>练过题库</span></div>' +
    '<div class="stat"><b class="stat-date">' + (s.lastAt ? fmtDate(s.lastAt) : '—') + '</b><span>最近练习</span></div>';

  const items = d.items || [];
  document.getElementById('statsList').innerHTML = items.length
    ? items.map(it => {
      const cov = Math.max(0, Math.min(100, it.coverage || 0));
      const rc = rateCls(it.rate, it.answered);
      // 模拟考试：有记录的列最近几场（逐场成绩），没有就不占地方
      const el = it.examList || [];
      const examHtml = el.length
        ? '<div class="sr-exams">' +
            '<span class="sr-exams-h">模拟考试 ' + it.examCount + ' 次' +
              ' · 均 <b class="' + rateCls(it.examAvg, 1) + '">' + it.examAvg + '</b>' +
              ' · 最高 <b class="' + rateCls(it.examBest, 1) + '">' + it.examBest + '</b></span>' +
            el.slice(0, 5).map(e => {
              const pct = (Number(e.full) || 100) > 0 ? Math.round((Number(e.score) || 0) / (Number(e.full) || 100) * 100) : 0;
              return '<span class="sr-exam">' + fmtMD(e.at) +
                ' <b class="' + rateCls(pct, 1) + '">' + e.score + '</b>/' + (e.full || 100) +
                '<span class="muted"> 对' + e.right + '/' + e.total + '</span>' +
                (e.auto ? '<i class="sr-auto">自动</i>' : '') + '</span>';
            }).join('') +
            (el.length > 5 ? '<span class="muted sr-more">…共 ' + it.examCount + ' 场</span>' : '') +
          '</div>'
        : '<div class="sr-exams"><span class="muted">未参加模拟考试</span></div>';
      return '<div class="stat-row">' +
        '<div class="sr-top">' +
          '<span class="sr-name">' + esc(it.bankName) + '</span>' +
          '<span class="sr-prog">已做 <b>' + it.answered + '</b> / ' + it.total + '</span>' +
        '</div>' +
        '<div class="sr-bar"><i style="width:' + cov + '%"></i></div>' +
        '<div class="sr-meta">' +
          '<span>正确率 <b class="' + rc + '">' + (it.answered ? it.rate + '%' : '—') + '</b>' +
          ' <span class="muted">（对 ' + it.correct + ' 题）</span></span>' +
          '<span class="muted">' + (it.lastAt ? fmtDate(it.lastAt) : '—') + '</span>' +
        '</div>' +
        examHtml +
      '</div>';
    }).join('')
    : '<div class="muted" style="padding:22px 0;text-align:center">该账号还没有做题记录。</div>';
}

/** 正确率配色：≥80 绿 / ≥60 橙 / 其余红；没做过题返回 muted */
function rateCls(rate, n) {
  if (!n) return 'muted';
  if (rate >= 80) return 'rate-good';
  if (rate >= 60) return 'rate-mid';
  return 'rate-bad';
}

// ============================================================
// 分题库统计（管理员）
// ------------------------------------------------------------
// 「按用户看」是做题情况弹层：一个账号 → 各题库。
// 这里是反方向：一个题库 → 所有人，用来横向比同一份卷子谁练得多、谁考得好。
// 数据来自 /api/admin-stats?bankId=（服务端 service_role 聚合，前端拿不到别人的进度）。
// ============================================================
let bstatBanks = null;        // 题库清单缓存（同一个管理员会话里不必反复拉）
let bstatSeq = 0;             // 请求序号：快速切库时别让旧响应盖回来

function closeBankStats() {
  const m = document.getElementById('bstatsModal');
  if (m && !m.classList.contains('hide')) m.classList.add('hide');
  bstatSeq++;                 // 在途响应作废
}

async function openBankStats() {
  const pick = document.getElementById('bstatsPick');
  const sum = document.getElementById('bstatsSum');
  const list = document.getElementById('bstatsList');
  document.getElementById('bstatsModal').classList.remove('hide');
  const seq = ++bstatSeq;
  sum.innerHTML = '';
  list.innerHTML = '<div class="muted bstats-msg">正在加载题库…</div>';

  try {
    if (!bstatBanks) {
      const d = await apiRequest('GET', '/api/admin-stats?list=1');
      bstatBanks = d.banks || [];
    }
    if (seq !== bstatSeq) return;

    if (!bstatBanks.length) {
      pick.innerHTML = '<option value="">还没有题库</option>';
      list.innerHTML = '<div class="muted bstats-msg">还没有任何题库。先导入一份题库再来统计。</div>';
      return;
    }

    pick.innerHTML = bstatBanks.map(b =>
      '<option value="' + esc(b.id) + '">' + esc(b.name) +
      (b.total == null ? '' : '（' + b.total + ' 题）') + '</option>'
    ).join('');

    await loadBankStats(bstatBanks[0].id, seq);
  } catch (e) {
    if (seq !== bstatSeq) return;
    list.innerHTML = '<div class="muted bstats-msg">读取失败：' + esc(e && e.message || '未知错误') + '</div>';
  }
}

async function loadBankStats(bankId, seq0) {
  const sum = document.getElementById('bstatsSum');
  const list = document.getElementById('bstatsList');
  const seq = seq0 || ++bstatSeq;
  if (!bankId) {
    sum.innerHTML = '';
    list.innerHTML = '<div class="muted bstats-msg">请选择题库。</div>';
    return;
  }
  sum.innerHTML = '';
  list.innerHTML = '<div class="muted bstats-msg">正在统计…</div>';
  try {
    const d = await apiRequest('GET', '/api/admin-stats?bankId=' + encodeURIComponent(bankId));
    if (seq !== bstatSeq) return;
    renderBankStats(d);
  } catch (e) {
    if (seq !== bstatSeq) return;
    list.innerHTML = '<div class="muted bstats-msg">读取失败：' + esc(e && e.message || '未知错误') + '</div>';
  }
}

function renderBankStats(d) {
  const total = (d.bank && d.bank.total) || 0;
  const rows = d.rows || [];

  // 汇总按**人**加权：整体正确率 = 全部答对 ÷ 全部已做，而不是各人正确率求平均
  let aSum = 0, cSum = 0, exSum = 0;
  rows.forEach(r => { aSum += r.answered || 0; cSum += r.correct || 0; exSum += r.examCount || 0; });
  const allRate = aSum ? Math.round(cSum / aSum * 100) : 0;

  document.getElementById('bstatsSum').innerHTML =
    '<div class="rs"><b>' + rows.length + '</b><span>参与人数</span></div>' +
    '<div class="rs"><b class="' + rateCls(allRate, aSum) + '">' + (aSum ? allRate + '%' : '—') + '</b><span>整体正确率</span></div>' +
    '<div class="rs"><b>' + exSum + '</b><span>考试场次</span></div>';

  if (!rows.length) {
    document.getElementById('bstatsList').innerHTML =
      '<div class="muted bstats-msg">这个题库还没有人练过或考过。</div>';
    return;
  }

  document.getElementById('bstatsList').innerHTML = rows.map(r => {
    const cov = total ? Math.max(0, Math.min(100, Math.round((r.answered || 0) / total * 100))) : 0;
    const tc = rateCls(r.rate, r.answered);
    const examTxt = r.examCount
      ? '考试 <b>' + r.examCount + '</b> 次 · 均 <b class="' + rateCls(r.examAvg, 1) + '">' + r.examAvg + '</b> · 最高 ' + r.examBest
      : '<span class="muted">未参加模拟考试</span>';
    return '<div class="stat-row">' +
      '<div class="sr-top">' +
        '<span class="sr-name">' + esc(r.username) +
          (r.dept ? ' <span class="muted" style="font-weight:400">· ' + esc(r.dept) + '</span>' : '') + '</span>' +
        '<span class="sr-prog">已做 <b>' + (r.answered || 0) + '</b> / ' + total + '</span>' +
      '</div>' +
      '<div class="sr-bar"><i style="width:' + cov + '%"></i></div>' +
      '<div class="sr-meta">' +
        '<span>正确率 <b class="' + tc + '">' + (r.answered ? r.rate + '%' : '—') + '</b>' +
          ' <span class="muted">（对 ' + (r.correct || 0) + ' 题）</span></span>' +
        '<span>' + examTxt + '</span>' +
      '</div>' +
    '</div>';
  }).join('');
}

// 本地开发调试钩子（生产构建会被剔除），供 scripts/check_report.mjs 验收
if (import.meta.env.DEV) {
  window.__bankstats = { open: openBankStats, close: closeBankStats, render: renderBankStats, reset: () => { bstatBanks = null; } };
}

/**
 * 重置某账号的密码（管理员代客重置）。
 * 服务端生成临时密码，明文只在这次响应里返回 → 在该行下方展开结果条。
 */
async function resetUserPwd(btn) {
  const row = btn.closest('.user-row');
  if (!row) return;
  const id = row.dataset.id;
  const u = users.find(x => x.id === id);
  if (!u) return;

  const yes = window.confirm(
    '确定重置「' + u.username + '」的密码？\n\n' +
    '· 系统生成 8 位临时密码，旧密码立即失效\n' +
    '· 临时密码只显示这一次，请当场转告本人\n' +
    '· 当前版本尚无「自助改密码」，请提醒本人妥善保管'
  );
  if (!yes) return;

  // 同一行重复点击时先清掉上一次的结果条，避免堆叠
  const prev = row.nextElementSibling;
  if (prev && prev.classList.contains('u-reset-out')) prev.remove();

  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '重置中…';
  adminMsg('');
  try {
    const d = await apiRequest('POST', '/api/admin-users', { action: 'resetPassword', userId: id });
    row.insertAdjacentHTML('afterend', resetOutHtml(u.username, d.tempPassword));
    adminMsg('已重置：' + (d.username || u.username), true);
  } catch (err) {
    adminMsg(err.message, false, true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function resetOutHtml(username, pwd) {
  return '<div class="u-reset-out">' +
    '<span class="u-reset-label">「' + esc(username) + '」的临时密码</span>' +
    '<code class="u-pwd">' + esc(pwd) + '</code>' +
    '<button class="btn btn-ghost btn-sm u-copy" type="button">复制</button>' +
    '<span class="muted u-reset-tip">只显示这一次，请立即转告本人</span>' +
    '</div>';
}

async function copyPwd(btn) {
  const box = btn.closest('.u-reset-out');
  if (!box) return;
  const pwd = ((box.querySelector('.u-pwd') || {}).textContent || '').trim();
  const ok = await copyText(pwd);
  const label = btn.textContent;
  btn.textContent = ok ? '已复制' : '请手动选中';
  setTimeout(() => { btn.textContent = label; }, 1600);
}

/** 复制到剪贴板：优先 Clipboard API（需 https / localhost），否则退回 execCommand */
async function copyText(t) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(t);
      return true;
    }
  } catch (e) { /* 落到下面的降级方案 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) { return false; }
}

function adminMsg(t, ok, bad) {
  const el = document.getElementById('adminMsg');
  if (!el) return;
  el.textContent = t || '';
  el.style.color = bad ? 'var(--bad)' : (ok ? 'var(--ok)' : '');
}

function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '—';
  const p = n => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 考试场次的短日期：11-12（本年度不必年年份，列表里一眼扫得动） */
function fmtMD(at) {
  const d = new Date(Number(at) || 0);
  if (!(d.getTime() > 0)) return '—';
  const p = n => (n < 10 ? '0' + n : '' + n);
  return p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
