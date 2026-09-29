import { supabase, getUserId } from './supabase.js';
import { getUsername } from './auth.js';
import { isAdmin, knownTags, ensureUsers } from './admin.js';
import { getTypingPrefs } from './typing.js';

// ============================================================
// 字库管理（打字练习的题库）+ 练习记录
// ------------------------------------------------------------
// 权限口径（当前需求）：
//   打字：**所有人**（只要能看到这个字库，就能进去打）
//   重排：管理员 / 上传者本人 / 字库被设为 editable='all' 时的所有人
//         —— 重排只是打乱字序，不动字数与用字，属于「练习玩法」而非「改内容」
//   改名：**仅管理员或上传者本人**（本次收窄：别人上传的库不许改名字）
//   可见范围：仅管理员或上传者本人可改（数据库侧另有触发器锁住）
//   删除：仅上传者本人或管理员
// 一句话：非自己上传的字库，普通用户「只能打字、重排」。
// 上传者身份用 source 徽章标出：admin 管理员上传 / user 个人上传。
// ============================================================

const $ = id => document.getElementById(id);

let onStartTyping = null;
let hzkRows = [];
let note = '';
let scopeHz = null;
let scopeDepts = [];
let scopeRoles = [];
let inited = false;

const HZK_COLS = 'id,name,per_line,chars,source,owner_name,visibility,editable,allow_depts,allow_roles,shuffles,created_at,user_id';

/* ---------- 小工具 ---------- */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(d.getTime())) return '—';
  const p = n => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function fmtDur(sec) {
  sec = Math.max(0, parseInt(sec, 10) || 0);
  const m = Math.floor(sec / 60), s = sec % 60;
  return (m ? m + '分' : '') + s + '秒';
}
/** 把字库正文按每行字数切成行 —— 只用于「重排」在本地预览字数，与引擎同一口径 */
function countChars(text) { return Array.from(String(text || '').replace(/\s/g, '')).length; }

/** 随机重排：只打乱字符，不动字数和用字（空白不参与） */
function shuffleText(text) {
  const arr = Array.from(String(text || '')).filter(c => !/\s/.test(c));
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr.join('');
}

/* ---------- 权限口径（唯一入口） ---------- */
function mineOf(h) { return !!h && h.userId === getUserId(); }
/** 重排：所有人可重排（editable='all'），或本人 / 管理员 */
export function canEditHz(h) {
  if (!h) return false;
  if (isAdmin() || mineOf(h)) return true;
  return (h.editable || 'all') === 'all';
}
/** 改名：**仅管理员或上传者本人**（别人上传的库只能打字、重排） */
export function canRenameHz(h) { return !!h && (isAdmin() || mineOf(h)); }
/** 删除：本人或管理员 */
export function canDeleteHz(h) { return !!h && (isAdmin() || mineOf(h)); }
/** 可见范围：管理员或上传者本人 */
export function canScopeHz(h) { return !!h && (isAdmin() || mineOf(h)); }

/* ============================================================
   ｜ 列表
   ============================================================ */
async function listHzk() {
  const me = getUserId();
  const { data, error } = await supabase.from('exam_hzk').select(HZK_COLS).order('created_at', { ascending: false });
  if (error) { msg('加载字库失败：' + error.message, true); return []; }
  return (data || []).map(h => ({
    id: h.id,
    name: h.name,
    perLine: h.per_line || 35,
    chars: h.chars || 0,
    source: h.source || 'user',
    ownerName: h.owner_name || '',
    visibility: h.visibility || 'public',
    editable: h.editable || 'all',
    allowDepts: Array.isArray(h.allow_depts) ? h.allow_depts : [],
    allowRoles: Array.isArray(h.allow_roles) ? h.allow_roles : [],
    shuffles: h.shuffles || 0,
    createdAt: h.created_at,
    userId: h.user_id,
    mine: h.user_id === me
  }));
}

function srcTag(h) {
  return h.source === 'admin'
    ? '<span class="src-tag src-admin">管理员上传</span>'
    : '<span class="src-tag src-user">个人上传</span>';
}
function visTag(h) {
  if (h.visibility === 'private') return '<span class="vis-tag vis-private">仅自己可见</span>';
  if (h.visibility === 'scope') {
    const parts = [];
    if (h.allowDepts.length) parts.push('部门 ' + h.allowDepts.join('、'));
    if (h.allowRoles.length) parts.push('角色 ' + h.allowRoles.join('、'));
    return '<span class="vis-tag vis-scope">限定：' + esc(parts.join(' · ') || '指定范围') + '</span>';
  }
  return '<span class="vis-tag vis-public">所有人可见</span>';
}
function editTag(h) {
  // 这个标签说的是「别人能不能动这份字库」：重排属于可放开的，改名/可见范围/删除不放。
  return (h.editable || 'all') === 'all'
    ? '<span class="vis-tag vis-edit">所有人可重排</span>'
    : '<span class="vis-tag vis-scope">仅上传者可改</span>';
}

function hzkRowHtml(h) {
  const acts = [];
  acts.push('<button class="btn btn-primary btn-sm act-type" type="button">打字</button>');
  if (canEditHz(h)) acts.push('<button class="btn btn-ghost btn-sm act-shuffle" type="button">重排</button>');
  // 改名只给管理员和上传者本人：别人上传的库，普通用户「只能打字、重排」
  if (canRenameHz(h)) acts.push('<button class="btn btn-ghost btn-sm act-rename" type="button">改名</button>');
  if (canScopeHz(h)) acts.push('<button class="btn btn-ghost btn-sm act-scope" type="button">可见范围</button>');
  if (canDeleteHz(h)) acts.push('<button class="btn btn-ghost btn-sm act-del" type="button">删除</button>');

  const meta = [
    h.chars + ' 字',
    h.perLine + ' 字/行',
    '上传者：' + esc(h.ownerName || '未知') + (h.mine ? '（我）' : ''),
    fmtTime(h.createdAt) + (h.shuffles ? ' · 已重排 ' + h.shuffles + ' 次' : '')
  ].join(' · ');

  return `
    <div class="bank-row" data-id="${esc(h.id)}">
      <div class="bank-info">
        <div class="bank-name">${esc(h.name)} ${srcTag(h)} ${visTag(h)} ${editTag(h)}</div>
        <div class="muted">${meta}</div>
      </div>
      <div class="bank-acts">${acts.join('')}</div>
    </div>`;
}

export async function renderHzk() {
  const box = $('hzkList');
  if (!box) return;
  box.innerHTML = '<div class="muted" style="padding:16px 0">加载中…</div>';
  hzkRows = await listHzk();
  if (!hzkRows.length) {
    box.innerHTML = '<div class="muted" style="padding:20px 0;text-align:center">还没有字库，点上方「导入字库」开始吧。</div>';
    return;
  }

  const admins = hzkRows.filter(h => h.source === 'admin');
  const persons = hzkRows.filter(h => h.source !== 'admin');
  let html = '';
  if (note) html += '<div class="feedback ok show">' + esc(note) + '</div>';
  if (admins.length) html += '<div class="list-head">管理员上传（' + admins.length + '）· 所有人可见 · 可打字/重排</div>' + admins.map(hzkRowHtml).join('');
  if (persons.length) html += '<div class="list-head">个人上传（' + persons.length + '）· 所有人可见 · 可打字/重排</div>' + persons.map(hzkRowHtml).join('');
  box.innerHTML = html;

  box.querySelectorAll('.bank-row').forEach(row => {
    const h = hzkRows.find(x => x.id === row.dataset.id);
    const on = (sel, fn) => { const el = row.querySelector(sel); if (el) el.addEventListener('click', fn); };
    on('.act-type', () => openForTyping(h));
    on('.act-shuffle', () => shuffleHz(h));
    on('.act-rename', () => renameHz(h));
    on('.act-scope', () => openScope(h));
    on('.act-del', () => deleteHz(h));
  });
}

function msg(t, bad) {
  const el = $('hzkMsg');
  if (!el) return;
  el.textContent = t || '';
  el.style.color = bad ? 'var(--bad)' : '';
}
function setNote(t) {
  note = t || '';
  clearTimeout(setNote._t);
  if (note) setNote._t = setTimeout(() => { note = ''; renderHzk(); }, 5000);
}

/* ============================================================
   ｜ 打字
   ============================================================ */
async function openForTyping(h) {
  if (!h) return;
  const { data, error } = await supabase.from('exam_hzk').select('id,name,text,per_line,source').eq('id', h.id).single();
  if (error || !data) { alert('打开字库失败：' + (error ? error.message : '字库不存在')); return; }
  // 库里的字段是下划线风格，交给引擎前统一成驼峰，免得两边各记一套
  if (onStartTyping) onStartTyping({
    id: data.id,
    name: data.name,
    text: data.text,
    perLine: data.per_line,
    source: data.source
  });
}

/* ============================================================
   ｜ 重排 / 改名 / 删除
   ============================================================ */
async function shuffleHz(h) {
  if (!canEditHz(h)) { alert('该字库被设为「仅上传者可改」，你没有修改权限。'); return; }
  const { data, error } = await supabase.from('exam_hzk').select('text,shuffles,per_line').eq('id', h.id).single();
  if (error || !data) { alert('读取字库失败：' + (error ? error.message : '字库不存在')); return; }
  const text = shuffleText(data.text);
  const { error: e2 } = await supabase.from('exam_hzk').update({
    text,
    chars: countChars(text),
    shuffles: (data.shuffles || 0) + 1
  }).eq('id', h.id);
  if (e2) { alert('重排失败：' + e2.message); return; }
  setNote('已重排「' + h.name + '」：字序随机打乱，字数与用字不变。');
  await renderHzk();
}

async function renameHz(h) {
  if (!canRenameHz(h)) {
    alert('无权限：改名只有管理员或上传者本人可以操作。\n\n别人上传的字库，你可以「打字」和「重排」。');
    return;
  }
  const name = prompt('修改字库名称', h.name);
  if (!name || !name.trim() || name.trim() === h.name) return;
  const { error } = await supabase.from('exam_hzk').update({ name: name.trim() }).eq('id', h.id);
  if (error) {
    alert(/duplicate|唯一|unique/i.test(error.message) ? '改名失败：已存在同名字库，请换一个。' : '改名失败：' + error.message);
    return;
  }
  setNote('字库已改名为「' + name.trim() + '」。');
  await renderHzk();
}

async function deleteHz(h) {
  if (!canDeleteHz(h)) { alert('无权限：只有上传者本人或管理员能删除该字库。'); return; }
  const extra = h.mine ? '' : '\n注意：这是其他用户上传的字库。';
  if (!confirm('确定删除字库「' + h.name + '」？' + extra + '\n删除后不可恢复（已产生的练习记录会保留）。')) return;
  const { error } = await supabase.from('exam_hzk').delete().eq('id', h.id);
  if (error) { alert('删除失败：' + error.message); return; }
  setNote('已删除字库「' + h.name + '」。');
  await renderHzk();
}

/* ============================================================
   ｜ 导入字库
   ============================================================ */
function nextHzkName(rows) {
  let max = 0;
  (rows || hzkRows).forEach(h => {
    const m = /^hzk(\d+)$/i.exec(h.name || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return 'hzk' + String(max + 1).padStart(3, '0');
}

function openImport() {
  $('hzkImportText').value = '';
  $('hzkImportName').value = nextHzkName();
  $('hzkImportShuffle').checked = false;
  const per = $('hzkImportPerLine');
  if (!per.options.length) {
    per.innerHTML = [16, 20, 24, 28, 35, 40].map(n => '<option value="' + n + '">' + n + '</option>').join('');
  }
  per.value = String(getTypingPrefs().perLine || 35);
  const r = document.querySelector('#hzkVisOpts input[value="public"]');
  if (r) r.checked = true;
  $('hzkImportMsg').textContent = '';
  $('hzkImportModal').classList.remove('hide');
  setTimeout(() => $('hzkImportText').focus(), 30);
}

async function saveImport() {
  let text = $('hzkImportText').value.trim();
  const perLine = parseInt($('hzkImportPerLine').value, 10) || 35;
  if (!text) { importMsg('请先粘贴文字或选择 .txt 文件。', true); return; }
  if ($('hzkImportShuffle').checked) text = shuffleText(text);
  const visEl = document.querySelector('#hzkVisOpts input:checked');
  const visibility = visEl ? visEl.value : 'public';

  const btn = $('hzkImportSave');
  btn.disabled = true;
  importMsg('保存中…', false);
  try {
    let name = $('hzkImportName').value.trim() || nextHzkName();
    let ins = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      ins = await supabase.from('exam_hzk').insert({
        user_id: getUserId(),
        name,
        text,
        per_line: perLine,
        chars: countChars(text),
        visibility,
        editable: 'all'          // 默认：所有人可修改
      });
      if (!ins.error) break;
      // 名字全局唯一，撞名（23505）就顺延到下一个编号重试
      if (/duplicate|unique|23505/i.test(ins.error.message || ins.error.code || '')) {
        name = nextHzkName();
        continue;
      }
      break;
    }
    if (ins && ins.error) throw new Error(ins.error.message);
    $('hzkImportModal').classList.add('hide');
    setNote('已导入字库「' + name + '」（' + countChars(text) + ' 字）· 所有人可见 · 可打字/重排。');
    await renderHzk();
  } catch (e) {
    importMsg('保存失败：' + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

function importMsg(t, bad) {
  const el = $('hzkImportMsg');
  if (!el) return;
  el.textContent = t || '';
  el.style.color = bad ? 'var(--bad)' : '';
}

/* ============================================================
   ｜ 可见范围（管理员 / 上传者）
   ============================================================ */
function openScope(h) {
  if (!canScopeHz(h)) { alert('无权限：「可见范围」只有管理员或上传者本人可以调整。'); return; }
  scopeHz = h;
  scopeDepts = h.allowDepts.slice();
  scopeRoles = h.allowRoles.slice();
  $('hzkScopeName').textContent = h.name;
  const vis = ['public', 'scope', 'private'].indexOf(h.visibility) >= 0 ? h.visibility : 'public';
  const radio = document.querySelector('#hzkScopeOpts input[value="' + vis + '"]');
  if (radio) radio.checked = true;
  $('hzkScopeMsg').textContent = '';
  syncScopeUI();
  $('hzkScopeModal').classList.remove('hide');
  ensureUsers().then(() => {
    if (scopeHz && !$('hzkScopeDetail').classList.contains('hide')) renderScopeChips();
  });
}
function closeScope() { $('hzkScopeModal').classList.add('hide'); scopeHz = null; }
function currentVis() {
  const r = document.querySelector('#hzkScopeOpts input:checked');
  return r ? r.value : 'public';
}
function syncScopeUI() {
  const vis = currentVis();
  $('hzkScopeDetail').classList.toggle('hide', vis !== 'scope');
  document.querySelectorAll('#hzkScopeOpts .scope-opt').forEach(el => el.classList.toggle('on', el.querySelector('input').checked));
  const tips = {
    public: '所有登录用户在「字库」里都能看到并练习（默认）。',
    scope: '只有部门或角色命中的人能看到（管理员始终可见）。',
    private: '除管理员外，只有上传者本人能看到。'
  };
  $('hzkScopeHint').textContent = tips[vis];
  if (vis === 'scope') renderScopeChips();
}
function renderScopeChips() {
  const known = knownTags();
  [['dept', scopeDepts, known.depts], ['role', scopeRoles, known.roles]].forEach(([kind, list, cands]) => {
    const box = $(kind === 'dept' ? 'hzkDeptChips' : 'hzkRoleChips');
    if (!box) return;
    const picked = list.map(v => '<span class="tag on" data-v="' + esc(v) + '">' + esc(v) + '<i>✕</i></span>').join('');
    const rest = cands.filter(v => list.indexOf(v) < 0);
    const candHtml = rest.length
      ? '<span class="tag-sep">常用：</span>' + rest.slice(0, 12).map(v => '<span class="tag" data-v="' + esc(v) + '">+ ' + esc(v) + '</span>').join('')
      : '';
    box.innerHTML = picked + candHtml;
  });
}
function onScopeChipClick(e) {
  const tag = e.target.closest('.tag');
  if (!tag) return;
  const box = tag.parentElement;
  const kind = box.id === 'hzkDeptChips' ? 'dept' : 'role';
  const list = kind === 'dept' ? scopeDepts : scopeRoles;
  const i = list.indexOf(tag.dataset.v);
  if (i < 0) list.push(tag.dataset.v); else list.splice(i, 1);
  renderScopeChips();
}
async function saveScope() {
  if (!scopeHz) return;
  if (!canScopeHz(scopeHz)) { closeScope(); alert('无权限调整可见范围。'); return; }
  const vis = currentVis();
  if (vis === 'scope' && !scopeDepts.length && !scopeRoles.length) {
    $('hzkScopeMsg').textContent = '请至少选择一个部门或角色，否则除管理员外没人能看到。';
    $('hzkScopeMsg').style.color = 'var(--bad)';
    return;
  }
  const btn = $('hzkScopeSave');
  btn.disabled = true;
  try {
    const { error } = await supabase.from('exam_hzk').update({
      visibility: vis,
      allow_depts: vis === 'scope' ? scopeDepts : [],
      allow_roles: vis === 'scope' ? scopeRoles : []
    }).eq('id', scopeHz.id);
    if (error) throw new Error(error.message);
    const nm = scopeHz.name;
    closeScope();
    setNote('已更新「' + nm + '」的可见范围。');
    await renderHzk();
  } catch (e) {
    $('hzkScopeMsg').textContent = '保存失败：' + e.message;
    $('hzkScopeMsg').style.color = 'var(--bad)';
  } finally {
    btn.disabled = false;
  }
}

/* ============================================================
   ｜ 练习记录
   ============================================================ */
let recRows = [];

export async function renderRecords() {
  const box = $('tprecList');
  if (!box) return;
  box.innerHTML = '<div class="muted" style="padding:16px 0">加载中…</div>';
  const adm = isAdmin();
  // 管理员：RLS 放开全表 → 能拿到所有人的记录；普通用户只拿到自己的
  const { data, error } = await supabase
    .from('exam_typing_records')
    .select('id,user_id,owner_name,hzk_name,per_line,total,ok,wrong,seconds,speed,acc,timed_out,created_at')
    .order('created_at', { ascending: false })
    .limit(300);
  if (error) {
    box.innerHTML = '<div class="feedback no show">加载练习记录失败：' + esc(error.message) + '</div>';
    return;
  }
  recRows = (data || []).map(r => ({
    id: r.id,
    userId: r.user_id,
    owner: r.owner_name || '未知账号',
    hzkName: r.hzk_name || '（字库已删除）',
    perLine: r.per_line || 35,
    total: r.total || 0,
    ok: r.ok || 0,
    wrong: r.wrong || 0,
    seconds: r.seconds || 0,
    speed: r.speed || 0,
    acc: r.acc || 0,
    timeout: !!r.timed_out,
    at: r.created_at,
    mine: r.user_id === getUserId()
  }));
  $('tprecScope').textContent = adm ? '管理员视图：可查看所有人的练习记录' : '我的练习记录';
  $('tprecSearch').classList.toggle('hide', !adm);
  $('tprecSearch').placeholder = '筛选账号 / 字库名';
  renderRecRows();
}

function renderRecRows() {
  const box = $('tprecList');
  const adm = isAdmin();
  const kw = adm ? ($('tprecSearch').value || '').trim().toLowerCase() : '';
  const list = recRows.filter(r => !kw
    || r.owner.toLowerCase().includes(kw)
    || r.hzkName.toLowerCase().includes(kw));

  if (!recRows.length) {
    box.innerHTML = '<div class="muted" style="padding:20px 0;text-align:center">还没有练习记录，去打一段字就会自动记录。</div>';
    return;
  }

  const persons = new Set(list.map(r => r.owner)).size;
  const avgSpeed = list.length ? Math.round(list.reduce((s, r) => s + r.speed, 0) / list.length) : 0;
  const avgAcc = list.length ? Math.round(list.reduce((s, r) => s + r.acc, 0) / list.length) : 0;
  const best = list.reduce((m, r) => Math.max(m, r.speed), 0);

  const head = '<div class="muted list-head">共 ' + list.length + ' 条记录'
    + (adm ? ' · ' + persons + ' 个账号' : '')
    + ' · 平均速度 ' + avgSpeed + ' 字/分'
    + ' · 平均正确率 ' + avgAcc + '%'
    + ' · 最快 ' + best + ' 字/分'
    + (kw ? '（筛选后 ' + list.length + ' 条）' : '') + '</div>';

  if (!list.length) { box.innerHTML = head + '<div class="muted" style="padding:14px 0">没有匹配的记录。</div>'; return; }

  // 管理员视图按账号分组，便于「查看其他用户的练习记录」
  const groups = new Map();
  list.forEach(r => {
    const k = adm ? r.owner : '我';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  });

  let html = head;
  groups.forEach((rows, owner) => {
    if (adm) {
      const u = rows.length;
      const sp = Math.round(rows.reduce((s, r) => s + r.speed, 0) / u);
      const ac = Math.round(rows.reduce((s, r) => s + r.acc, 0) / u);
      html += '<div class="list-head">' + esc(owner) + ' · ' + u + ' 次 · 平均 ' + sp + ' 字/分 · ' + ac + '%'
        + (owner === (getUsername() || '') ? '（我）' : '') + '</div>';
    }
    html += rows.map(r => `
      <div class="rec-row">
        <div class="rec-main">
          <div class="rec-name">${esc(r.hzkName)}${r.timeout ? ' <span class="vis-tag vis-scope">限时结束</span>' : ''}</div>
          <div class="muted">${fmtTime(r.at)} · ${r.ok}/${r.total} 字 · 错 ${r.wrong} · 用时 ${fmtDur(r.seconds)}${adm ? '' : ''}</div>
        </div>
        <div class="rec-nums">
          <span class="rec-n"><b>${r.speed}</b><i>字/分</i></span>
          <span class="rec-n"><b>${r.acc}%</b><i>正确率</i></span>
        </div>
      </div>`).join('');
  });
  box.innerHTML = html;
}

/* ============================================================
   ｜ 初始化
   ============================================================ */
export function initHzk(cb) {
  onStartTyping = (cb && cb.onStartTyping) || onStartTyping;
  if (inited) return;
  inited = true;

  $('hzkImportBtn').addEventListener('click', openImport);
  $('hzkImportClose').addEventListener('click', () => $('hzkImportModal').classList.add('hide'));
  $('hzkImportMask').addEventListener('click', () => $('hzkImportModal').classList.add('hide'));
  $('hzkImportCancel').addEventListener('click', () => $('hzkImportModal').classList.add('hide'));
  $('hzkImportSave').addEventListener('click', saveImport);
  $('hzkImportFile').addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { $('hzkImportText').value = String(r.result || ''); };
    r.readAsText(f, 'utf-8');
    e.target.value = '';
  });
  $('hzkVisOpts').addEventListener('change', () => {
    document.querySelectorAll('#hzkVisOpts .scope-opt').forEach(el => el.classList.toggle('on', el.querySelector('input').checked));
  });

  $('hzkScopeClose').addEventListener('click', closeScope);
  $('hzkScopeMask').addEventListener('click', closeScope);
  $('hzkScopeCancel').addEventListener('click', closeScope);
  $('hzkScopeSave').addEventListener('click', saveScope);
  $('hzkScopeOpts').addEventListener('change', syncScopeUI);
  $('hzkDeptChips').addEventListener('click', onScopeChipClick);
  $('hzkRoleChips').addEventListener('click', onScopeChipClick);
  ['hzkDeptInput', 'hzkRoleInput'].forEach(id => {
    $(id).addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = $(id).value.trim();
      if (!v) return;
      const list = id === 'hzkDeptInput' ? scopeDepts : scopeRoles;
      if (list.indexOf(v) < 0) list.push(v);
      $(id).value = '';
      renderScopeChips();
    });
  });

  $('tprecReload').addEventListener('click', () => renderRecords());
  $('tprecSearch').addEventListener('input', renderRecRows);
}

// 验收脚本用的调试出口（vite build 时整块剔除）
if (import.meta.env.DEV) {
  window.__hzk = {
    renderHzk, renderRecords, canEditHz, canRenameHz, canDeleteHz, canScopeHz,
    list: async () => (await listHzk()),
    find: async id => (await listHzk()).find(x => x.id === id),
    // 内部入口直调：验收要绕开按钮，验证「第二道闸」本身拦不拦得住
    rename: renameHz, shuffle: shuffleHz, del: deleteHz,
    shuffleText,
    nextHzkName
  };
}
