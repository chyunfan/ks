/**
 * 题目编辑器（题库列表 → 「编辑题目」）
 *
 * 设计目标：**让答案不可能写错**。
 *   用户只需要「勾选哪个选项是正确答案」，answerKeys / correctIdx 由程序按
 *   选项位置推导出来 —— 这正是手写 SQL 最容易出错的地方（改了选项文字忘了改下标，
 *   或者删了一个选项导致后面全体错位）。所以编辑器里根本没有地方让你手写字母。
 *
 * 另外三条硬约束，代码里处处守着：
 *   ① 题目 id 一律不变（错题集 / 收藏 / 练习进度 / 答题卡标记全按 id 关联）
 *   ② 未改动的题**原样写回**（用 st.raw 不经过规范化），绝不误伤历史数据
 *   ③ 保存前逐题校验（题干非空、选项非空、判断题有答案、多选答案 ≥2）
 *
 * 判断题：options 固定为 [A=正确, B=错误]，答案要同时写 answerKeys + answerText + correctIdx
 *        （engine 里「去除正确的判断题」靠 answerText 判断，少一个字段就会失灵）。
 */
import { supabase } from './supabase.js';

const LT = 'ABCDEF';                       // 选项字母上限，与导入模板一致
const $ = id => document.getElementById(id);

let st = null;      // 编辑会话；null = 未打开
let _inited = false;

const deep = x => JSON.parse(JSON.stringify(x));
const esc = s => String(s == null ? '' : s)
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ============================================================
// 打开 / 关闭
// ============================================================

/**
 * @param {{id:string,name:string}} bank
 * @param {() => boolean} guard  权限回调（调用方给 canManage 的结果），保存时再查一次
 */
export async function openQEdit(bank, guard) {
  if (!_inited) { bind(); _inited = true; }
  if (guard && !guard()) return false;                 // 第一道闸
  const { data, error } = await supabase
    .from('exam_banks').select('questions').eq('id', bank.id).single();
  if (error) { alert('打开编辑器失败：' + error.message); return false; }
  const qs = Array.isArray(data && data.questions) ? data.questions : [];
  if (!qs.length) { alert('这个题库里还没有题目，先导入一份再编辑吧。'); return false; }

  st = {
    bank,
    guard,
    raw: deep(qs),                 // 原始题目（未改动的题回写时用它，保留一切未知字段）
    orig: qs.map(normRead),        // 规范化后的基线，用来判断「是否改过」
    draft: null,
    dirty: {},                     // { [题目下标]: true }
    idx: 0,
    filter: 'all',                 // all | single | multiple | judge | case
    onlyMod: false
  };
  st.draft = deep(st.orig);

  $('qeBankName').textContent = bank.name;
  $('qeTotal').textContent = String(st.draft.length);
  $('qeOnlyMod').checked = false;
  $('qeTypeChips').querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.dataset.t === 'all'));
  setMsg('');
  render();
  $('qeModal').classList.remove('hide');
  return true;
}

function bind() {
  $('qeClose').addEventListener('click', tryClose);
  $('qeMask').addEventListener('click', tryClose);
  $('qePrev').addEventListener('click', () => go(-1));
  $('qeNext').addEventListener('click', () => go(1));
  $('qeJump').addEventListener('change', onJump);
  $('qeSave').addEventListener('click', save);
  $('qeRevert').addEventListener('click', revertOne);
  $('qeRevertAll').addEventListener('click', revertAll);
  $('qeOnlyMod').addEventListener('change', e => {
    if (!st) return;
    st.onlyMod = e.target.checked;
    if (st.onlyMod && !Object.keys(st.dirty).length) {
      st.onlyMod = false; e.target.checked = false;
      setMsg('还没有改动，暂时没有「改过的题」可看');
      return;
    }
    if (!pass(st.idx)) { const n = firstMod(); if (n >= 0) st.idx = n; }
    render();
  });
  $('qeTypeChips').addEventListener('click', onChip);
  $('qeBody').addEventListener('input', onInput);
  $('qeBody').addEventListener('change', onPick);
  $('qeBody').addEventListener('click', onBodyClick);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && st && !$('qeModal').classList.contains('hide')) tryClose();
  });
}

function tryClose() {
  if (!st) return;
  const n = Object.keys(st.dirty).length;
  if (n && !confirm('还有 ' + n + ' 道题的改动没有保存，确定关闭？\n\n关闭后这些改动会丢失（已经保存过的不受影响）。')) return;
  $('qeModal').classList.add('hide');
  st = null;
}

// ============================================================
// 数据规范化
// ============================================================

/** 读入一道题 → 内部统一结构（保留未知字段，只覆盖自己管理的字段） */
function normRead(q) {
  const src = q && typeof q === 'object' ? q : {};
  const out = Object.assign({}, src);
  out.id = src.id;
  out.type = src.type || 'single';
  out.stem = src.stem == null ? '' : String(src.stem);
  out.options = Array.isArray(src.options)
    ? src.options.map((o, i) => ({ key: LT[i] || String(i + 1), text: o && o.text != null ? String(o.text) : '' }))
    : [];
  out.analysis = src.analysis == null ? null : String(src.analysis);
  if (out.type === 'judge') {
    // 判断题答案在三处冗余存放，任一可信即可（导入产物三者一致，历史数据可能缺项）
    let p = 0;
    if (Array.isArray(src.correctIdx) && src.correctIdx.length) p = Number(src.correctIdx[0]) === 1 ? 1 : 0;
    else if (src.answerText === '错误') p = 1;
    else if (Array.isArray(src.answerKeys) && src.answerKeys[0] === 'B') p = 1;
    out.correctIdx = [p];
  } else {
    out.correctIdx = Array.isArray(src.correctIdx)
      ? src.correctIdx.map(Number).filter(n => Number.isFinite(n)).sort((a, b) => a - b)
      : [];
  }
  if (src.isCase) {
    out.isCase = true;
    out.caseId = src.caseId;
    out.caseBackground = src.caseBackground == null ? '' : String(src.caseBackground);
  } else {
    delete out.isCase; delete out.caseId; delete out.caseBackground;
  }
  rebuild(out);
  return out;
}

/** 由 correctIdx 反推 answerKeys / answerText，并把选项字母按位置重排 */
function rebuild(q) {
  if (q.type === 'judge') {
    q.options = [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }];
    const p = (q.correctIdx || []).map(Number).indexOf(1) >= 0 ? 1 : 0;
    q.correctIdx = [p];
    q.answerKeys = [LT[p]];
    q.answerText = p === 0 ? '正确' : '错误';
  } else {
    q.options = (q.options || []).slice(0, LT.length)
      .map((o, i) => ({ key: LT[i], text: o && o.text != null ? String(o.text) : '' }));
    q.correctIdx = (q.correctIdx || []).map(Number)
      .filter(n => n >= 0 && n < q.options.length)
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort((a, b) => a - b);
    q.answerKeys = q.correctIdx.map(i => LT[i]);
    q.answerText = null;
  }
}

// ============================================================
// 筛选 / 导航
// ============================================================

function pass(i) {
  const q = st.draft[i];
  if (!q) return false;
  if (st.filter === 'case') { if (!q.isCase) return false; }
  else if (st.filter !== 'all') {
    if (q.isCase || q.type !== st.filter) return false;   // 案例子题只在「案例」里出现，免得混在一起
  }
  if (st.onlyMod && !st.dirty[i]) return false;
  return true;
}
const nextIdx = from => { for (let i = from + 1; i < st.draft.length; i++) if (pass(i)) return i; return -1; };
const prevIdx = from => { for (let i = from - 1; i >= 0; i--) if (pass(i)) return i; return -1; };
const firstMod = () => { for (let i = 0; i < st.draft.length; i++) if (st.dirty[i] && pass(i)) return i; return -1; };

function onChip(e) {
  const c = e.target.closest('.chip');
  if (!c || !st) return;
  st.filter = c.dataset.t;
  $('qeTypeChips').querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === c));
  if (!pass(st.idx)) {
    st.idx = nextIdx(-1) >= 0 ? nextIdx(-1) : 0;
  }
  render();
}

function go(dir) {
  if (!st) return;
  const n = dir > 0 ? nextIdx(st.idx) : prevIdx(st.idx);
  if (n < 0) return;
  st.idx = n;
  render();
}

function jumpTo(i) {
  if (!st || i < 0 || i >= st.draft.length) return;
  if (!pass(i) && (st.filter !== 'all' || st.onlyMod)) {
    // 目标题被筛掉了，先放宽筛选，避免用户点了却看不到变化
    st.filter = 'all';
    st.onlyMod = false;
    $('qeOnlyMod').checked = false;
    $('qeTypeChips').querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x.dataset.t === 'all'));
  }
  st.idx = i;
  render();
}

function onJump() {
  if (!st) return;
  const v = parseInt($('qeJump').value, 10);
  if (!Number.isFinite(v)) { $('qeJump').value = String(st.idx + 1); return; }
  const i = Math.min(Math.max(v, 1), st.draft.length) - 1;
  jumpTo(i);
}

// ============================================================
// 渲染
// ============================================================

function render() {
  renderNav();
  renderForm();
  updateStatus();
}

function renderNav() {
  $('qeJump').value = String(st.idx + 1);
  $('qePrev').disabled = prevIdx(st.idx) < 0;
  $('qeNext').disabled = nextIdx(st.idx) < 0;
}

function typeTag(q) {
  if (q.isCase) return '<span class="qe-tag case">案例子题</span>' + '<span class="qe-tag">' + typeName(q.type) + '</span>';
  return '<span class="qe-tag">' + typeName(q.type) + '</span>';
}
const typeName = t => ({ single: '单选题', multiple: '多选题', judge: '判断题' }[t] || t || '未知题型');

function renderForm() {
  const i = st.idx, q = st.draft[i];
  if (!q) {
    $('qeBody').innerHTML = '<div class="qe-empty">当前筛选下没有题目。把「题型」或「只看改过的」放宽一点试试。</div>';
    return;
  }
  const isJudge = q.type === 'judge';
  const isMulti = q.type === 'multiple';
  let h = '<div class="qe-meta">' + typeTag(q) +
    '<span class="muted">题目编号 id=' + esc(q.id) + '（保存后不变）</span>' +
    (st.dirty[i] ? '<span class="qe-modtag">已改动</span>' : '') + '</div>';

  if (q.isCase) {
    h += field('案例材料', '改动会同步到本案例组的全部小题', 'casebg', q.caseBackground, 3);
  }
  h += field('题干', '', 'stem', q.stem, 2);

  h += '<div class="qe-field"><div class="qe-lbl">选项' +
    '<span class="muted">' + (isJudge
      ? '判断题固定为「正确 / 错误」，不能增删'
      : (isMulti ? '勾选正确答案（可多个）' : '点选正确答案') + '，字母与答案由位置自动推导，不用手写') +
    '</span></div><div class="qe-opts">';
  q.options.forEach((o, k) => {
    const on = q.correctIdx.indexOf(k) >= 0;
    h += '<div class="qe-opt' + (on ? ' on' : '') + '">' +
      '<label class="qe-pick" title="设为正确答案">' +
      '<input type="' + (isMulti ? 'checkbox' : 'radio') + '" name="qeAns" data-i="' + k + '"' + (on ? ' checked' : '') + '>' +
      '<span class="qe-k">' + esc(o.key || LT[k]) + '</span></label>' +
      (isJudge
        ? '<div class="qe-otext-ro">' + esc(o.text) + '</div>'
        : '<textarea class="qe-ota" data-f="otext" data-i="' + k + '" rows="1">' + esc(o.text) + '</textarea>' +
        '<button type="button" class="qe-del" data-del="' + k + '" title="删除该选项">✕</button>') +
      '</div>';
  });
  h += '</div>';
  if (!isJudge) {
    h += '<button type="button" class="btn btn-ghost btn-sm qe-add" id="qeAddOpt"' +
      (q.options.length >= LT.length ? ' disabled' : '') + '>+ 添加选项</button>' +
      '<span class="muted">' + (q.options.length >= LT.length ? '已到上限 ' + LT.length + ' 个（A–F）' : '最多 ' + LT.length + ' 个') + '</span>';
  }
  h += '</div>';

  h += field('解析', '留空表示这道题没有解析', 'ana', q.analysis == null ? '' : q.analysis, 3);
  h += '<div class="qe-cur" id="qeCur">' + curHtml(q) + '</div>';

  $('qeBody').innerHTML = h;
}

function field(lbl, hint, f, val, rows) {
  return '<div class="qe-field"><div class="qe-lbl">' + lbl +
    (hint ? '<span class="muted">' + hint + '</span>' : '') + '</div>' +
    '<textarea class="qe-ta" data-f="' + f + '" rows="' + (rows || 2) + '">' + esc(val) + '</textarea></div>';
}

function curHtml(q) {
  if (!q.correctIdx.length) return '正确答案：<b class="bad">尚未设置</b>';
  if (q.type === 'judge') {
    const t = q.correctIdx[0] === 0 ? '正确' : '错误';
    return '正确答案：<b>' + t + '</b>';
  }
  return '正确答案：<b>' + esc(q.correctIdx.map(i => LT[i] + '. ' + (q.options[i] ? q.options[i].text : '')).join('　')) + '</b>';
}

function updateStatus() {
  const n = Object.keys(st.dirty).length;
  const total = st.draft.length;
  $('qeRevert').disabled = !st.dirty[st.idx];
  $('qeRevertAll').disabled = !n;
  $('qeSave').disabled = !n;
  if (!n) $('qeStatus').textContent = '共 ' + total + ' 题 · 还没有改动';
  else $('qeStatus').textContent = '共 ' + total + ' 题 · 已改动 ' + n + ' 题';
}
function setMsg(t, bad) {
  const el = $('qeMsg');
  if (!el) return;
  el.textContent = t || '';
  el.style.color = bad ? 'var(--bad)' : '';
}

// ============================================================
// 编辑交互
// ============================================================

function onInput(e) {
  const t = e.target, f = t.dataset && t.dataset.f;
  if (!st || !f) return;
  const q = st.draft[st.idx];
  if (!q) return;
  if (f === 'stem') q.stem = t.value;
  else if (f === 'ana') q.analysis = t.value;
  else if (f === 'otext') { const k = +t.dataset.i; if (q.options[k]) q.options[k].text = t.value; }
  else if (f === 'casebg') {
    q.caseBackground = t.value;
    // 案例材料在每道子题上各存一份 —— 改一处就同步全组，否则会留下不一致
    st.draft.forEach(x => { if (x.isCase && x.caseId === q.caseId) x.caseBackground = t.value; });
  } else return;
  judgeDirty();
  const cur = $('qeCur');
  if (cur) cur.innerHTML = curHtml(q);
  // 「已改动」角标随输入实时增减（改回原样要能自己消失）
  const meta = $('qeBody').querySelector('.qe-meta');
  if (meta) {
    const mt = meta.querySelector('.qe-modtag');
    if (st.dirty[st.idx] && !mt) meta.insertAdjacentHTML('beforeend', '<span class="qe-modtag">已改动</span>');
    else if (!st.dirty[st.idx] && mt) mt.remove();
  }
  updateStatus();
}

/** 重判「是否改过」：当前题 + （若为案例题）同组其他小题 */
function judgeDirty() {
  const q = st.draft[st.idx];
  judgeAt(st.idx);
  if (q && q.isCase) {
    st.draft.forEach((x, i) => { if (i !== st.idx && x.isCase && x.caseId === q.caseId) judgeAt(i); });
  }
}
function judgeAt(i) {
  if (JSON.stringify(st.draft[i]) !== JSON.stringify(st.orig[i])) st.dirty[i] = true;
  else delete st.dirty[i];
}

function onPick(e) {
  const t = e.target;
  if (!st || t.name !== 'qeAns') return;
  const q = st.draft[st.idx];
  if (!q) return;
  const k = +t.dataset.i;
  if (q.type === 'judge') {
    q.correctIdx = [k === 1 ? 1 : 0];                  // 判断题：A=正确 / B=错误，单选语义
  } else if (q.type === 'multiple') {
    const set = q.correctIdx.slice();
    const at = set.indexOf(k);
    if (t.checked) { if (at < 0) set.push(k); } else if (at >= 0) set.splice(at, 1);
    q.correctIdx = set;
  } else {
    q.correctIdx = [k];
  }
  rebuild(q);
  judgeDirty();
  renderForm();          // 重画选项高亮与「正确答案」行
  updateStatus();
}

function onBodyClick(e) {
  if (!st) return;
  const q = st.draft[st.idx];
  if (!q) return;

  const del = e.target.closest('[data-del]');
  if (del) {
    const k = +del.dataset.del;
    if (q.options.length <= 2) { setMsg('至少保留 2 个选项，不能再删了'); return; }
    q.options.splice(k, 1);
    // 删除后：被删的答案去掉，后面的答案下标整体前移 —— 这正是手写 SQL 最容易漏的一步
    q.correctIdx = q.correctIdx.filter(x => x !== k).map(x => (x > k ? x - 1 : x));
    rebuild(q);
    judgeDirty(); renderForm(); updateStatus();
    setMsg('');
    return;
  }

  if (e.target.closest('#qeAddOpt')) {
    if (q.options.length >= LT.length) return;
    q.options.push({ key: '', text: '' });
    rebuild(q);
    judgeDirty(); renderForm(); updateStatus();
    const tas = $('qeBody').querySelectorAll('textarea[data-f="otext"]');
    const last = tas[tas.length - 1];
    if (last) last.focus();
    setMsg('新增了一个空选项，填写内容后再保存');
  }
}

function revertOne() {
  if (!st) return;
  st.draft[st.idx] = deep(st.orig[st.idx]);
  const q = st.draft[st.idx];
  if (q.isCase) {
    // 材料是共享的：只回滚当前题会和同组不一致，所以整组一起回滚
    st.draft.forEach((x, i) => { if (x.isCase && x.caseId === q.caseId) st.draft[i] = deep(st.orig[i]); });
  }
  Object.keys(st.dirty).forEach(k => judgeAt(+k));
  render();
  setMsg('已撤销当前题的改动');
}

function revertAll() {
  if (!st) return;
  if (!confirm('把全部 ' + Object.keys(st.dirty).length + ' 处改动还原成题库里的原样？')) return;
  st.draft = deep(st.orig);
  st.dirty = {};
  if (st.onlyMod) { st.onlyMod = false; $('qeOnlyMod').checked = false; }
  render();
  setMsg('已还原全部改动');
}

// ============================================================
// 校验与保存
// ============================================================

/** 只校验**改过的**题：历史数据里可能本来就有点小毛病，不该因此卡住保存 */
function checkQ(q) {
  if (!String(q.stem == null ? '' : q.stem).trim()) return '题干不能为空';
  if (q.isCase && !String(q.caseBackground || '').trim()) return '案例题缺少案例材料';
  if (q.type !== 'judge') {
    if (q.options.length < 2) return '至少需要 2 个选项';
    const e = q.options.findIndex(o => !String(o.text == null ? '' : o.text).trim());
    if (e >= 0) return '第 ' + (e + 1) + ' 个选项内容为空';
  }
  if (!q.correctIdx.length) return '还没有设置正确答案';
  if (q.type === 'multiple' && q.correctIdx.length < 2) return '多选题的正确答案至少要 2 个';
  return '';
}

async function save() {
  if (!st) return;
  if (st.guard && !st.guard()) {                        // 第二道闸（数据库 RLS 是第三道）
    alert('无权限：只有题库上传者本人或管理员才能编辑该题库的题目。');
    return;
  }
  const idxs = Object.keys(st.dirty).map(Number).sort((a, b) => a - b);
  if (!idxs.length) { setMsg('没有改动，无需保存'); return; }

  const bad = [];
  idxs.forEach(i => { const m = checkQ(st.draft[i]); if (m) bad.push({ i, m }); });
  if (bad.length) {
    setMsg('有 ' + bad.length + ' 道改动还不能保存，已跳到第一处', true);
    alert('有 ' + bad.length + ' 道改动还不能保存：\n\n' +
      bad.slice(0, 8).map(b => '· 第 ' + (b.i + 1) + ' 题：' + b.m).join('\n') +
      (bad.length > 8 ? '\n· …另有 ' + (bad.length - 8) + ' 道' : '') +
      '\n\n请补全后再保存。');
    jumpTo(bad[0].i);
    return;
  }

  if (!confirm('将把 ' + idxs.length + ' 道题的修改保存到「' + st.bank.name + '」。\n\n' +
    '· 题目编号不会变，其他人的错题集、收藏、练习进度都不受影响\n' +
    '· 保存后所有使用者重新进入题库即看到新内容\n\n确定保存？')) return;

  // 未改动的题用 st.raw 原样写回：保留所有未知字段，绝不误伤历史数据
  const out = st.raw.map((raw, i) => (st.dirty[i] ? deep(st.draft[i]) : raw));

  const btn = $('qeSave');
  btn.disabled = true;
  setMsg('正在保存…');
  try {
    const { error } = await supabase.from('exam_banks').update({ questions: out }).eq('id', st.bank.id);
    if (error) throw new Error(error.message);
    st.raw = deep(out);
    st.orig = out.map(normRead);
    st.draft = deep(st.orig);
    st.dirty = {};
    if (st.onlyMod) { st.onlyMod = false; $('qeOnlyMod').checked = false; }
    render();
    setMsg('已保存 ' + idxs.length + ' 道题的修改 ✓ 题目编号未变，大家的错题集与练习进度不受影响');
  } catch (e) {
    setMsg('保存失败：' + e.message, true);
    alert('保存失败：' + e.message);
  } finally {
    btn.disabled = false;
    updateStatus();
  }
}

// ============================================================
// 验收钩子（生产构建会被整块剔除）
// ============================================================
if (import.meta.env.DEV) {
  window.__qedit = {
    openQEdit, save, close: tryClose,
    state: () => (st ? {
      bank: st.bank, idx: st.idx, filter: st.filter, onlyMod: st.onlyMod,
      total: st.draft.length,
      dirty: Object.keys(st.dirty).map(Number).sort((a, b) => a - b),
      draft: st.draft, raw: st.raw, orig: st.orig
    } : null),
    payload: () => (st ? st.raw.map((raw, i) => (st.dirty[i] ? deep(st.draft[i]) : raw)) : null),
    rebuild, normRead, checkQ,
    jump: i => jumpTo(i)
  };
}
