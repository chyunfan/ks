import { supabase, getUserId } from './supabase.js';
import { parseWorkbook, buildTemplateWorkbook, buildBankWorkbook } from './import.js';
import { getUsername } from './auth.js';
import { isAdmin, knownTags, ensureUsers } from './admin.js';
import { openQEdit } from './qedit.js';
import { getQuestions, putQuestions, dropQuestions } from './bankcache.js';
import { ensureXLSX } from './assets.js';
import { getListSnapshot, putListSnapshot, getCachedQuestions, putCachedQuestions, delCachedQuestions } from './idbcache.js';
import { showBoot, hideBoot } from './bootmask.js';

let pendingImport = null;   // { questions, caseCount }
let onOpenBank = null;
let onRefreshQuestions = null;   // 后台校验发现题目变了 → 通知 main.js 重画首页
let onOpenTyping = null;    // 下拉里选中「打字练习」后跳去哪（由 main.js 注入）


// 正在设置「可见范围」的题库 + 当前勾选的部门/角色
let scopeBank = null;
let scopeDepts = [];
let scopeRoles = [];

export function initBanks(cb) {
  onOpenBank = cb.onOpenBank;
  onOpenTyping = cb.onOpenTyping;
  onRefreshQuestions = cb.onRefreshQuestions || null;

  document.getElementById('importBtn').addEventListener('click', () => document.getElementById('fileInput').click());
  // Excel 组件是**按需加载**的（v2.32）：第一次点模板/导入/导出时下 427 KB，之后走缓存。
  document.getElementById('tplBtn').addEventListener('click', async () => {
    try {
      const X = await ensureXLSX();
      X.writeFile(buildTemplateWorkbook(X), '题库模板.xlsx');
    } catch (e) { alert('模板下载失败：' + e.message); }
  });
  document.getElementById('fileInput').addEventListener('change', onFile);
  document.getElementById('importClose').addEventListener('click', closeImport);
  document.getElementById('importMask').addEventListener('click', closeImport);
  document.getElementById('saveBankBtn').addEventListener('click', saveImport);
  bindScopeModal();

  // 顶栏「练习内容」→ 弹出切换列表（点完直接进该内容的练习首页，不必先退回题库列表）
  const sw = document.getElementById('bankSwitch');
  if (sw) sw.addEventListener('click', openBankPicker);
  const bpClose = document.getElementById('bankPickClose');
  if (bpClose) bpClose.addEventListener('click', closeBankPicker);
  const bpMask = document.getElementById('bankPickMask');
  if (bpMask) bpMask.addEventListener('click', closeBankPicker);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeBankPicker(); });
}

async function onFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const buf = await file.arrayBuffer();
    const X = await ensureXLSX();          // 首次导入时才加载 Excel 组件
    const res = parseWorkbook(buf, X);
    if (!res.ok) {
      pendingImport = null;
      document.getElementById('importPreview').innerHTML =
        '<div class="feedback no show">解析失败，请修正后重试：<br>' +
        res.errors.map(x => '· ' + x).join('<br>') + '</div>';
      document.getElementById('saveBankBtn').disabled = true;
    } else {
      pendingImport = { questions: res.questions, caseCount: res.caseCount };
      let html = '<div class="feedback ok show">解析成功：共 <b>' + res.questions.length +
        '</b> 题，案例 <b>' + res.caseCount + '</b> 组。</div>';
      const ws = res.warnings || [];
      if (ws.length) {
        html += '<div class="feedback warn show">提醒（<b>不影响导入</b>，可保存后再核对）：<br>' +
          ws.slice(0, 20).map(x => '· ' + x).join('<br>') +
          (ws.length > 20 ? '<br>· …另有 ' + (ws.length - 20) + ' 条同类提醒' : '') +
          '</div>';
      }
      html += '<div class="muted" style="margin-top:8px">保存后该题库<b>默认全员可见</b>（题库后会标注上传者）。'
        + '如需限定部门或角色，请联系管理员调整「可见范围」。</div>';
      document.getElementById('importPreview').innerHTML = html;
      document.getElementById('saveBankBtn').disabled = false;
    }
    document.getElementById('bankName').value = file.name.replace(/\.xlsx?$/i, '');
    document.getElementById('importModal').classList.remove('hide');
  } catch (err) {
    alert('读取文件失败：' + err.message);
  } finally {
    e.target.value = '';
  }
}

function closeImport() {
  document.getElementById('importModal').classList.add('hide');
  pendingImport = null;
}

async function saveImport() {
  if (!pendingImport) return;
  const name = document.getElementById('bankName').value.trim();
  if (name.length < 1) { alert('请输入题库名称'); return; }
  const userId = getUserId();
  if (!userId) { alert('登录状态丢失，请重新登录'); return; }
  const { error } = await supabase.from('exam_banks').insert({
    user_id: userId,
    owner_name: getUsername() || null,   // 上传者：列表里显示「上传者：xxx」
    name,
    questions: pendingImport.questions,
    case_count: pendingImport.caseCount,
    visibility: 'public'                 // 人人可导入；导入后默认全员可见
  });
  if (error) { alert('保存失败：' + error.message); return; }
  closeImport();
  invalidateBankList();
  await renderBanks({ force: true });
}

// ============================================================
// 题库列表：只取元数据 + 内存缓存（v2.29）
// ------------------------------------------------------------
// 原来的查询把 questions 整列也拉了回来，唯一用途是在浏览器里数一下长度
// （列表上要显示「多少题」）。questions 是完整题目数组，一个百题题库就几十上百 KB，
// 十几个库加起来是 MB 级；而进列表页、改名、删库、改可见范围之后都会重拉一次。
//
// 现在题数存在 question_count 列里（supabase/perf.sql 用触发器维护，任何写入路径都同步），
// 列表只查元数据，请求体从「全部题目」降到「每库一行摘要」。
//
// 兼容退路：万一线上还没跑 perf.sql，question_count 列不存在（PostgREST 报 42703），
//          自动退回旧查询 —— 慢，但页面不会白屏。**只退一次**：把探测结果记下来，
//          否则每次进列表都先发一个注定失败的请求，反而更慢。
// ============================================================
const BANK_COLS = 'id,name,case_count,question_count,created_at,updated_at,user_id,owner_name,visibility,allow_depts,allow_roles';
const BANK_COLS_LEGACY = 'id,name,case_count,created_at,updated_at,questions,user_id,owner_name,visibility,allow_depts,allow_roles';

let bankListCache = null;     // 最近一次成功的列表
let bankListCacheAt = 0;
const BANK_TTL = 30 * 1000;   // 超过 30 秒就顺手在后台刷一次
let missingCountColumn = false;

/** PostgREST 的「列不存在」有多种包装形式，这里认全 */
function isMissingColumn(err) {
  if (!err) return false;
  const code = String(err.code || '');
  const msg = String(err.message || '') + ' ' + String(err.details || '');
  return code === '42703' || code === 'PGRST204' || /question_count|column\s+\S+\s+does not exist/i.test(msg);
}

async function queryBankRows() {
  if (!missingCountColumn) {
    const r = await supabase.from('exam_banks').select(BANK_COLS).order('created_at', { ascending: false });
    if (!r.error) return r;
    if (!isMissingColumn(r.error)) return r;
    missingCountColumn = true;
    console.warn('[banks] 线上还没有 question_count 列，已退回旧查询（较慢）。建议执行 supabase/perf.sql');
  }
  return supabase.from('exam_banks').select(BANK_COLS_LEGACY).order('created_at', { ascending: false });
}

function mapBankRow(b, me) {
  return {
    id: b.id,
    name: b.name,
    caseCount: b.case_count || 0,
    // 新路径读 question_count；旧路径只能数数组长度（此时 data 里确实带着 questions）
    count: typeof b.question_count === 'number'
      ? b.question_count
      : (Array.isArray(b.questions) ? b.questions.length : 0),
    createdAt: b.created_at,
    updatedAt: b.updated_at || '',        // 题库版本号：判断本机缓存是否过期（v2.32）
    userId: b.user_id,
    ownerName: b.owner_name || '',
    visibility: b.visibility || 'public',
    allowDepts: Array.isArray(b.allow_depts) ? b.allow_depts : [],
    allowRoles: Array.isArray(b.allow_roles) ? b.allow_roles : [],
    mine: b.user_id === me
  };
}

/**
 * @param {{cache?:boolean}} [opts] cache=true 时优先用 30 秒内的缓存（切练习内容的下拉用得上，
 *        弹层要立刻出来，没必要为了 30 秒内的变化再等一个往返）
 */
async function listBanks(opts) {
  const useCache = !!(opts && opts.cache);
  if (useCache && bankListCache && Date.now() - bankListCacheAt < BANK_TTL) return bankListCache;
  const me = getUserId();
  const { data, error } = await queryBankRows();
  if (error) { alert('加载题库失败：' + error.message); return bankListCache || []; }
  const rows = (data || []).map(b => mapBankRow(b, me));
  bankListCache = rows;
  bankListCacheAt = Date.now();
  // 落一份到本机（IndexedDB）：下次打开页面先有内容可画，不用等网络（v2.32）
  putListSnapshot(me, rows).catch(() => {});
  return rows;
}

/**
 * 启动时从本机捞上一次的题库列表（v2.32）。
 * 有就直接当缓存用 —— 页面立刻能画出题库标题；超过 30 秒的会被 renderBanks 顺手后台刷新。
 * @returns {Promise<boolean>} 是否拿到了本机快照
 */
export async function hydrateBankList() {
  if (bankListCache) return true;
  const snap = await getListSnapshot(getUserId());
  if (!snap || !snap.rows.length) return false;
  bankListCache = snap.rows;
  bankListCacheAt = snap.at || 0;
  return true;
}

/** 让列表缓存失效（改名 / 删库 / 改可见范围 / 导入之后必须调，否则会看到旧名字） */
export function invalidateBankList() {
  bankListCache = null;
  bankListCacheAt = 0;
}

/** 可见范围徽标 */
function visTag(b) {
  if (b.visibility === 'private') return '<span class="vis-tag vis-private">仅自己可见</span>';
  if (b.visibility === 'scope') {
    const parts = [];
    if (b.allowDepts.length) parts.push('部门 ' + b.allowDepts.join('、'));
    if (b.allowRoles.length) parts.push('角色 ' + b.allowRoles.join('、'));
    return '<span class="vis-tag vis-scope">限定：' + (parts.length ? esc(parts.join(' · ')) : '指定范围') + '</span>';
  }
  return '<span class="vis-tag vis-public">全员可见</span>';
}

/**
 * 权限口径（唯一入口，界面与各操作都用它判断）：
 *   上传者本人 或 管理员 → 可改名 / 导出 / 删除（可见范围仅管理员）
 *   其他人               → **只能练习**，既不删除也不修改
 */
function canManage(b) {
  if (!b) return false;
  if (isAdmin()) return true;
  return !!b.mine;
}

/** 越权提示：正常情况按钮不会出现，这是纵深防御的第二道闸（DOM 被改写 / 代码被调用也拦得住） */
function denyManage(b) {
  alert('无权限：只有题库上传者本人或管理员才能修改 / 删除该题库。\n\n'
    + '「' + ((b && b.name) || '该题库') + '」是 ' + ((b && b.ownerName) || '其他用户')
    + ' 上传的，你只能练习。');
}

function bankRow(b) {
  const adm = isAdmin();
  const own = canManage(b);
  const acts = [];
  acts.push('<button class="btn btn-primary btn-sm act-open" type="button">练习</button>');
  // 他人的题库：非管理员只给「练习」——不出现编辑题目 / 重命名 / 导出 / 删除 / 可见范围
  if (own) acts.push('<button class="btn btn-ghost btn-sm act-edit" type="button">编辑题目</button>');
  if (own) acts.push('<button class="btn btn-ghost btn-sm act-rename" type="button">重命名</button>');
  if (own) acts.push('<button class="btn btn-ghost btn-sm act-export" type="button">导出</button>');
  if (adm) acts.push('<button class="btn btn-ghost btn-sm act-scope" type="button">可见范围</button>');
  if (own) acts.push('<button class="btn btn-ghost btn-sm act-del" type="button">删除</button>');

  const meta = [b.count + ' 题', '案例 ' + b.caseCount + ' 组',
    '上传者：' + esc(b.ownerName || '未知') + (b.mine ? '（我）' : '')].join(' · ');

  return `
    <div class="bank-row" data-id="${esc(b.id)}">
      <div class="bank-info">
        <div class="bank-name">${esc(b.name)} ${visTag(b)}</div>
        <div class="muted">${meta}</div>
      </div>
      <div class="bank-acts">${acts.join('')}</div>
    </div>`;
}

/** 把一组题库画到列表里（纯渲染，不发请求） */
function paintBanks(banks) {
  const box = document.getElementById('bankList');
  if (!box) return;
  if (!banks.length) {
    box.innerHTML = '<div class="muted" style="padding:20px 0;text-align:center">还没有题库，点击上方「导入题库」开始吧。</div>';
    return;
  }

  const mine = banks.filter(b => b.mine);
  const shared = banks.filter(b => !b.mine);
  // 管理员看到的「共享」里含别人的私有库（RLS 对管理员放开），标注出来便于管理
  let html = '';
  if (mine.length) html += '<div class="list-head">我上传的（' + mine.length + '）</div>' + mine.map(bankRow).join('');
  if (shared.length) {
    const tip = isAdmin() ? '' : '<span class="muted"> · 只能练习</span>';
    html += '<div class="list-head">其他人上传的（' + shared.length + '）' + tip + '</div>' + shared.map(bankRow).join('');
  }
  box.innerHTML = html;

  box.querySelectorAll('.bank-row').forEach(row => {
    const id = row.dataset.id;
    const b = banks.find(x => x.id === id);
    const on = (sel, fn) => { const el = row.querySelector(sel); if (el) el.addEventListener('click', fn); };
    on('.act-open', () => openBank(b));
    on('.act-edit', () => editQuestions(b));
    on('.act-rename', () => renameBank(b));
    on('.act-export', () => exportBank(b));
    on('.act-scope', () => openScope(b));
    on('.act-del', () => deleteBank(b));
  });

  // 列表一出来就开始后台预热（从前往后，用户点谁谁插队）—— 让「点进去」这件事变成立刻的
  prefetchBanks(banks);
}

/**
 * 渲染题库列表。
 * @param {{force?:boolean}} [opts]  force=true 时跳过缓存直接重拉（改名/删库后必须用）
 *
 * 默认走「先画缓存、再后台刷新」：切回列表页时内容是立刻出现的，
 * 不会先给一片空白再突然填上 —— 这个项目里列表页会被反复进出（管理页返回、
 * 打字练习返回、切换练习内容返回），每次都空等一下很难受。
 */
export async function renderBanks(opts) {
  const force = !!(opts && opts.force);
  if (bankListCache && !force) {
    paintBanks(bankListCache);
    if (Date.now() - bankListCacheAt > BANK_TTL) {
      // 后台刷新：失败就算了，屏幕上已经有东西了
      listBanks().then(rows => { if (Array.isArray(rows) && rows.length) paintBanks(rows); }).catch(() => {});
    }
    return;
  }
  const banks = await listBanks();
  paintBanks(banks);
}

/* ============================================================
   取题目：内存 → 本机 IndexedDB → 网络（v2.32）
   ------------------------------------------------------------
   v2.29 只加了内存缓存，关页就没了：于是每次打开页面都要重下一遍整库
   —— 大题库几百 KB 到几 MB，这条链路上实测 20 KB/s，就是十几到几十秒，
   这就是「题库越大、打开越慢」的根。
   v2.32 多一层 IndexedDB：第二次开页直接读本机（毫秒级），网络只用来
   **校验题库有没有更新**（比 updated_at），真改了才重下。

   版本号取自 exam_banks.updated_at（触发器维护，改题就会变），
   本机那份记着当时的 updatedAt，不一致即视为「题库有更新」。
   ============================================================ */

/** 取题目时顺手记下的题库名（localStorage 里那份可能是旧名字） */
const nameCache = new Map();

/**
 * 同一个题库「正在下载」的请求（v2.32）。
 * 场景：启动时后台已经在为上次那份题库下载，用户等不及直接点了它 ——
 * 没有这张表的话会再发一个一模一样的整库请求，在 20 KB/s 的链路上等于把时间翻倍。
 * 有它就把两个等待合并成一次下载。
 */
const inflight = new Map();

/** 本机那份缓存和列表给的版本对不对得上 */
function sameVersion(cached, updatedAt) {
  if (!cached) return false;
  if (!updatedAt) return true;                    // 列表没给版本：当作可用
  if (!cached.updatedAt) return false;
  return String(cached.updatedAt) === String(updatedAt);
}

/**
 * 从网络取整库题目，并写回两级缓存。
 * @param {object} [opts] prefetch=true 时走后台预取（可被用户操作中止）
 */
function fetchFromNet(id, updatedAt, opts) {
  const key = String(id);
  const running = inflight.get(key);
  if (running) return running;                 // 同一份正在下：共用这一次
  const task = doFetchFromNet(id, updatedAt, opts)
    .finally(() => { if (inflight.get(key) === task) inflight.delete(key); });
  inflight.set(key, task);
  return task;
}

async function doFetchFromNet(id, updatedAt, opts) {
  const prefetch = !!(opts && opts.prefetch);
  const ctrl = opts && opts.ctrl;
  let q = supabase.from('exam_banks').select('questions,updated_at,question_count,name').eq('id', id).single();
  if (prefetch && ctrl && typeof q.abortSignal === 'function') q = q.abortSignal(ctrl.signal);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const qs = Array.isArray(data && data.questions) ? data.questions : [];
  if (data && data.name) nameCache.set(String(id), data.name);   // 顺手记住权威名字（顶栏要用）
  putQuestions(id, qs);
  putCachedQuestions(id, {
    updatedAt: (data && data.updated_at) || updatedAt || '',
    count: typeof (data && data.question_count) === 'number' ? data.question_count : qs.length,
    qs
  }).catch(() => {});
  return qs;
}

/**
 * 取题目（带两级缓存）。
 * 「从列表点练习」和「刷新页面恢复上次题库」会拉到同一份数据，命中即复用；
 * 任何改动题目的地方（编辑/导入/删库）都会 dropQuestions 让两级缓存一起失效。
 */
async function fetchBankQuestions(id, updatedAt) {
  const mem = getQuestions(id);
  if (mem) return mem;
  const hit = await getCachedQuestions(id);
  if (hit && Array.isArray(hit.qs) && hit.qs.length && sameVersion(hit, updatedAt)) {
    putQuestions(id, hit.qs);
    return hit.qs;
  }
  const running = inflight.get(String(id));
  if (running) return running;   // 正在下（可能是后台预取）：直接等它，别再发一个
  abortPrefetch();               // 用户要的是别的库：先把后台预取停下，别抢带宽
  return fetchFromNet(id, updatedAt);
}

/**
 * 先用本机缓存进页面，再后台确认题库有没有更新（v2.32）。
 * 只比 updated_at / 题数，一个几百字节的请求；真的变了才重下并回调。
 * 这样「题库有更新需更新缓存」不会变成「每次开页都重下」。
 */
async function revalidateQuestions(id, cachedUpdatedAt) {
  try {
    const { data } = await supabase
      .from('exam_banks').select('updated_at,question_count').eq('id', id).maybeSingle();
    if (!data) return;
    const changed = String(data.updated_at || '') !== String(cachedUpdatedAt || '');
    const cur = getQuestions(id);
    const countChanged = typeof data.question_count === 'number'
      && Array.isArray(cur) && data.question_count !== cur.length;
    if (!changed && !countChanged) return;
    const qs = await fetchFromNet(id, data.updated_at);
    if (onRefreshQuestions) onRefreshQuestions(id, qs);
  } catch (e) { /* 后台校验失败没关系：本机这份照样能用 */ }
}

/* ---------- 后台预取（按列表顺序从前往后，用户点谁谁插队） ---------- */
const PREFETCH_MAX = 3;      // 最多预取几份：这条链路很慢，别把用户真正要那份的带宽挤掉
const PREFETCH_DELAY = 1500; // 首屏稳定后再开始：别和「进上次题库」的请求抢带宽
let prefetchQueue = [];
let prefetchRunning = false;
let prefetchCtrl = null;
let prefetchTimer = null;

/** 停掉当前预取并清空队列（用户开始要某份题库时调用） */
function abortPrefetch() {
  prefetchQueue = [];
  if (prefetchTimer) { clearTimeout(prefetchTimer); prefetchTimer = null; }
  if (prefetchCtrl) {
    try { prefetchCtrl.abort(); } catch (e) { /* 忽略 */ }
    prefetchCtrl = null;
  }
}

/**
 * 列表画完后在后台按顺序预热（v2.32）。
 * 只预热前 PREFETCH_MAX 份、且只预热本机没有或已过期的，
 * 每份之间让出 0.6 秒 —— 覆盖「最常点开的那几份」，又不至于把慢链路占满。
 */
export function prefetchBanks(list) {
  if (!Array.isArray(list) || !list.length) return;
  prefetchQueue = list.slice(0, PREFETCH_MAX)
    .map(b => ({ id: String(b.id), name: b.name, updatedAt: b.updatedAt || '' }));
  if (prefetchRunning) return;
  if (prefetchTimer) clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => { prefetchTimer = null; runPrefetch(); }, PREFETCH_DELAY);
}

async function runPrefetch() {
  if (prefetchRunning) return;
  prefetchRunning = true;
  try {
    while (prefetchQueue.length) {
      const job = prefetchQueue.shift();
      if (getQuestions(job.id)) continue;                       // 内存里已有
      const hit = await getCachedQuestions(job.id);
      if (hit && sameVersion(hit, job.updatedAt)) {             // 本机已是最新
        putQuestions(job.id, hit.qs);
        continue;
      }
      const ctrl = new AbortController();
      prefetchCtrl = ctrl;
      try {
        await fetchFromNet(job.id, job.updatedAt, { prefetch: true, ctrl });
      } catch (e) {
        if (ctrl.signal.aborted) return;                        // 被用户抢占：队列已清空
      } finally {
        if (prefetchCtrl === ctrl) prefetchCtrl = null;
      }
      await new Promise(r => setTimeout(r, 600));               // 让出带宽
    }
  } finally {
    prefetchRunning = false;
  }
}

async function openBank(b) {
  // 大题库要拉几百 KB，这期间界面没有任何反馈 → 用启动遮罩顶上（加载快就不会出现）
  showBoot('正在打开「' + b.name + '」…');
  let qs;
  try {
    qs = await fetchBankQuestions(b.id, b.updatedAt);
  } catch (e) {
    hideBoot();
    alert('打开失败：' + e.message);
    return;
  }
  if (!onOpenBank) { hideBoot(); return; }
  try {
    await onOpenBank({ id: b.id, name: b.name, questions: qs });
  } finally {
    hideBoot();
  }
}

/**
 * 启动时恢复上次的题库。
 * @param {string} id
 * @param {string} [knownName] 调用方已知的名字（localStorage 里就存着），省一个往返
 * @returns {Promise<boolean>} true=已经进了首页；false=本机没有题目，需要调用方走「列表先出 + 后台加载」
 */
export async function openBankById(id, knownName) {
  const mem = getQuestions(id);
  if (mem) {
    if (onOpenBank) await onOpenBank({ id, name: cachedNameOf(id) || nameCache.get(String(id)) || knownName || await bankNameOf(id), questions: mem });
    return true;
  }
  const hit = await getCachedQuestions(id);
  if (!hit || !Array.isArray(hit.qs) || !hit.qs.length) return false;   // 本机也没有
  putQuestions(id, hit.qs);
  const name = cachedNameOf(id) || nameCache.get(String(id)) || knownName || await bankNameOf(id) || '';
  if (onOpenBank) await onOpenBank({ id, name, questions: hit.qs });
  // 进页面之后才校验版本：慢一点无所谓，反正界面已经在了
  revalidateQuestions(id, hit.updatedAt);
  return true;
}

/**
 * 启动时本机没有这份题库的题目：**不要挡住页面**（v2.32）。
 * 调用方先把题库列表画出来（标题、题数都在列表元数据里），
 * 这份在后台优先加载；好了再回调 onReady，由调用方决定要不要自动进首页。
 */
export async function prepareBank(id, name, onReady) {
  abortPrefetch();
  const row = (bankListCache || []).find(b => String(b.id) === String(id));
  try {
    const qs = await fetchBankQuestions(id, (row && row.updatedAt) || '');
    // 名字以「取题目时服务端给的」为准，其次列表行，最后才是 localStorage 里那份
    const nm = nameCache.get(String(id)) || (row && row.name) || name || '';
    if (onReady) onReady({ id, name: nm, questions: qs });
    return qs;
  } catch (e) {
    return null;
  }
}

/** 列表缓存里的名字（不发请求；有就最省事） */
function cachedNameOf(id) {
  const row = (bankListCache || []).find(b => String(b.id) === String(id));
  return (row && row.name) || '';
}

/** 只取名字（缓存命中时补顶栏用；失败给空串，不影响进练习） */
async function bankNameOf(id) {
  const row = (bankListCache || []).find(b => String(b.id) === String(id));
  if (row && row.name) return row.name;
  const { data } = await supabase.from('exam_banks').select('name').eq('id', id).maybeSingle();
  return (data && data.name) || '';
}


async function renameBank(b) {
  if (!canManage(b)) { denyManage(b); return; }        // 第二道闸
  const name = prompt('修改题库名称', b.name);
  if (!name || !name.trim()) return;
  const { error } = await supabase.from('exam_banks').update({ name: name.trim() }).eq('id', b.id);
  if (error) { alert('重命名失败：' + error.message); return; }
  invalidateBankList();                                // 名字变了，缓存必须作废
  await renderBanks({ force: true });
}

async function deleteBank(b) {
  if (!canManage(b)) { denyManage(b); return; }        // 第二道闸
  const extra = b.mine ? '' : '\n注意：这是其他用户上传的题库。';
  if (!confirm(`确定删除题库「${b.name}」？${extra}\n该题库下的错题/收藏/进度也会一并删除，且不可恢复。`)) return;
  const { error } = await supabase.from('exam_banks').delete().eq('id', b.id);
  if (error) { alert('删除失败：' + error.message); return; }
  dropQuestions(b.id);                                 // 题目缓存也要清，别留着一份已删除的库
  invalidateBankList();
  await renderBanks({ force: true });
}

async function exportBank(b) {
  if (!canManage(b)) { denyManage(b); return; }        // 第二道闸
  let qs;
  try {
    qs = await fetchBankQuestions(b.id, b.updatedAt); // 有缓存就用缓存，省一次整库下载
  } catch (e) {
    alert('导出失败：' + e.message);
    return;
  }
  let X;
  try {
    X = await ensureXLSX();                            // 按需加载 Excel 组件
  } catch (e) {
    alert('导出失败：' + e.message);
    return;
  }
  const wb = buildBankWorkbook(qs, X);
  X.writeFile(wb, (b.name || '题库') + '.xlsx');
}

/**
 * 打开题目编辑器。
 * 只改题目内容，不碰 name/可见范围等元信息，所以权限口径与重命名/导出一致（canManage）：
 * 上传者本人或管理员可用，其他人只能练习（数据库侧的 update 策略是第三道闸）。
 */
async function editQuestions(b) {
  if (!canManage(b)) { denyManage(b); return; }
  await openQEdit(b, () => canManage(b));
}

// ============================================================
// 可见范围（管理员）
// ============================================================
function bindScopeModal() {
  document.getElementById('scopeClose').addEventListener('click', closeScope);
  document.getElementById('scopeMask').addEventListener('click', closeScope);
  document.getElementById('scopeCancel').addEventListener('click', closeScope);
  document.getElementById('scopeSave').addEventListener('click', saveScope);
  document.getElementById('scopeOpts').addEventListener('change', syncScopeUI);
  document.getElementById('deptChips').addEventListener('click', e => onChipClick(e, 'dept'));
  document.getElementById('roleChips').addEventListener('click', e => onChipClick(e, 'role'));
  addTagInput('deptInput', 'dept');
  addTagInput('roleInput', 'role');
}

function addTagInput(id, kind) {
  const inp = document.getElementById(id);
  inp.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = inp.value.trim();
    if (!v) return;
    const list = kind === 'dept' ? scopeDepts : scopeRoles;
    if (list.indexOf(v) < 0) list.push(v);
    inp.value = '';
    renderScopeChips();
  });
}

function onChipClick(e, kind) {
  const tag = e.target.closest('.tag');
  if (!tag) return;
  const v = tag.dataset.v;
  const list = kind === 'dept' ? scopeDepts : scopeRoles;
  const i = list.indexOf(v);
  if (i < 0) list.push(v); else list.splice(i, 1);
  renderScopeChips();
}

function openScope(b) {
  if (!isAdmin()) { alert('无权限：「可见范围」只有管理员可以调整。'); return; }   // 第二道闸
  scopeBank = b;
  scopeDepts = b.allowDepts.slice();
  scopeRoles = b.allowRoles.slice();
  document.getElementById('scopeBankName').textContent = b.name;
  const vis = ['public', 'scope', 'private'].indexOf(b.visibility) >= 0 ? b.visibility : 'public';
  const radio = document.querySelector('input[name="scopeVis"][value="' + vis + '"]');
  if (radio) radio.checked = true;
  scopeMsg('');
  syncScopeUI();
  document.getElementById('scopeModal').classList.remove('hide');
  // 首次打开时把用户列表拉回来，好给出「常用部门 / 角色」候选（拉不到也能手工输入）
  ensureUsers().then(() => {
    if (scopeBank && !document.getElementById('scopeDetail').classList.contains('hide')) renderScopeChips();
  });
}

function closeScope() {
  document.getElementById('scopeModal').classList.add('hide');
  scopeBank = null;
}

function currentVis() {
  const r = document.querySelector('input[name="scopeVis"]:checked');
  return r ? r.value : 'public';
}

function syncScopeUI() {
  const vis = currentVis();
  const detail = document.getElementById('scopeDetail');
  detail.classList.toggle('hide', vis !== 'scope');
  document.querySelectorAll('#scopeOpts .scope-opt').forEach(el => {
    el.classList.toggle('on', el.querySelector('input').checked);
  });
  if (vis === 'scope') renderScopeChips();

  const tips = {
    public: '所有登录用户在「管理题库」里都能看到这个题库。',
    scope: '只有部门或角色命中的人能看到；其他人（除管理员外）看不到。',
    private: '除管理员外，只有上传者本人能看到并练习。'
  };
  document.getElementById('scopeHint').textContent = tips[vis];
}

function renderScopeChips() {
  const known = knownTags();
  [['dept', scopeDepts, known.depts], ['role', scopeRoles, known.roles]].forEach(([kind, list, cands]) => {
    const box = document.getElementById(kind + 'Chips');
    if (!box) return;
    const picked = list.map(v =>
      '<span class="tag on" data-kind="' + kind + '" data-v="' + esc(v) + '">' + esc(v) + '<i>✕</i></span>').join('');
    const rest = cands.filter(v => list.indexOf(v) < 0);
    const candHtml = rest.length
      ? '<span class="tag-sep">常用：</span>' + rest.slice(0, 12).map(v =>
        '<span class="tag" data-kind="' + kind + '" data-v="' + esc(v) + '">+ ' + esc(v) + '</span>').join('')
      : '';
    const empty = (!list.length && !rest.length)
      ? '<span class="muted" style="font-size:12px">还没有可选值，直接在下面输入后回车添加（部门 / 角色在「用户管理」里维护）</span>'
      : '';
    box.innerHTML = picked + candHtml + empty;
  });
}

async function saveScope() {
  if (!scopeBank) return;
  if (!isAdmin()) { closeScope(); alert('无权限：「可见范围」只有管理员可以调整。'); return; }
  const vis = currentVis();
  if (vis === 'scope' && !scopeDepts.length && !scopeRoles.length) {
    scopeMsg('请至少选择一个部门或角色，否则没有人能看到这个题库。', true);
    return;
  }
  const btn = document.getElementById('scopeSave');
  btn.disabled = true;
  try {
    const { error } = await supabase.from('exam_banks').update({
      visibility: vis,
      allow_depts: vis === 'scope' ? scopeDepts : [],
      allow_roles: vis === 'scope' ? scopeRoles : []
    }).eq('id', scopeBank.id);
    if (error) throw new Error(error.message);
    closeScope();
    invalidateBankList();                              // 可见范围徽标变了
    await renderBanks({ force: true });
  } catch (e) {
    scopeMsg('保存失败：' + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

function scopeMsg(t, bad) {
  const el = document.getElementById('scopeMsg');
  el.textContent = t || '';
  el.style.color = bad ? 'var(--bad)' : '';
}

// ============================================================
// 切换练习内容（点顶栏「练习内容」）
// ============================================================
/** 当前正在练的那一份（与 boot() 启动时读的是同一个键） */
function currentBankId() {
  try {
    const v = JSON.parse(localStorage.getItem('ce_current_bank') || 'null');
    return v && v.id ? String(v.id) : '';
  } catch (e) { return ''; }
}

function closeBankPicker() {
  const m = document.getElementById('bankPick');
  if (m) m.classList.add('hide');
}

/** 现在是不是待在「打字练习」那几屏（字库列表 / 练习记录 / 打字屏） */
function isOnTypingScreen() {
  return ['hzk', 'tprec', 'typing'].some(id => {
    const el = document.getElementById(id);
    return el && !el.classList.contains('hide');
  });
}

/**
 * 是否正卡在「练习中」——做题的练习页 / 结果页，或打字练习屏。
 * 这时候换内容会出事：
 *   · 做题那边，继续练习是按 id 从**当前**题库里筛题，而不同题库的题号会重复（都是 1、2、3…），
 *     拿新库的题去对旧库的快照，题就全错位了；
 *   · 打字那边，中途换内容，这一轮跟打就断了。
 * 所以这一刻只拦、不给换（顶栏按钮同时变灰）。做题进度本来就已经落盘，退出后照旧能「继续练习」。
 */
function busyPracticing() {
  return ['practice', 'result', 'typing'].some(id => {
    const el = document.getElementById(id);
    return el && !el.classList.contains('hide');
  });
}

function pickRow(b, hideCur) {
  // 正在打字练习里时，题库行不标「当前」——这一刻的当前内容是打字练习，两边都标会打架
  const cur = !hideCur && currentBankId() === String(b.id);
  const meta = [b.count + ' 题', '案例 ' + b.caseCount + ' 组',
    '上传者：' + esc(b.ownerName || '未知') + (b.mine ? '（我）' : '')].join(' · ');
  return '<button type="button" class="pick-row' + (cur ? ' on' : '') + '"'
    + ' data-id="' + esc(b.id) + '" data-cur="' + (cur ? '1' : '0') + '">'
    + '<span class="pick-main">'
    + '<span class="pick-name">' + esc(b.name) + visTag(b) + '</span>'
    + '<span class="pick-meta">' + meta + '</span>'
    + '</span>'
    + (cur ? '<span class="pick-flag">当前</span>' : '')
    + '</button>';
}

/**
 * 下拉最上面的「打字练习」入口。
 * 它不是题库（字库是另一套数据、另一套流程），所以不跟题库混排，单独一组摆最前，
 * 免得让人以为它也是一份题库。选中后交给 main.js 跳到打字练习那几屏。
 */
function pickTypingRow() {
  const cur = isOnTypingScreen();
  return '<button type="button" class="pick-row pick-typing' + (cur ? ' on' : '') + '"'
    + ' data-typing="1" data-cur="' + (cur ? '1' : '0') + '">'
    + '<span class="pick-ic" aria-hidden="true">⌨</span>'
    + '<span class="pick-main">'
    + '<span class="pick-name">打字练习</span>'
    + '<span class="pick-meta">按字库逐字跟打 · 五笔编码提示 · 成绩存云端</span>'
    + '</span>'
    + (cur ? '<span class="pick-flag">当前</span>' : '')
    + '</button>';
}

/**
 * 打开「选择练习内容」弹层。
 * 题库部分的口径与「管理题库」完全一致（同一个 listBanks，可见范围由 RLS 决定）——
 * 看不到的题库本来就不该出现在切换列表里。
 */
export async function openBankPicker() {
  const modal = document.getElementById('bankPick');
  const box = document.getElementById('bankPickList');
  const hint = document.getElementById('bankPickHint');
  if (!modal || !box) return;
  // 第二道闸：顶栏按钮已经变灰，这里再拦一次（DOM 被改写也换不了库）
  if (busyPracticing()) {
    alert('正在练习中，先点「← 退出」回到首页再切换练习内容。\n\n'
      + '（为什么不让直接换：不同题库的题号会重复，中途换库会让这次的作答记录对不上题；'
      + '打字练习打了一半换内容，这一轮也就断了。）\n'
      + '做题进度已经保存，退出后点「继续练习」就能接着做。');
    return;
  }
  box.innerHTML = '<div class="muted" style="padding:12px 0;text-align:center">正在加载…</div>';
  hint.textContent = '';
  modal.classList.remove('hide');
  let banks = [];
  // 优先用 30 秒内的缓存：下拉要的是"立刻出现"，不是"绝对最新"
  try { banks = await listBanks({ cache: true }); } catch (e) { banks = []; }

  const onTyping = isOnTypingScreen();
  const mine = banks.filter(b => b.mine);
  const shared = banks.filter(b => !b.mine);
  // 打字练习固定排最前，单独一组：它是「另一类练习」，混进题库分组会让人以为它也是一份题库
  let html = '<div class="list-head">其他练习</div>' + pickTypingRow();
  if (mine.length) html += '<div class="list-head">我上传的（' + mine.length + '）</div>' + mine.map(b => pickRow(b, onTyping)).join('');
  if (shared.length) html += '<div class="list-head">其他人上传的（' + shared.length + '）</div>' + shared.map(b => pickRow(b, onTyping)).join('');
  // 一个题库都没有时，打字练习也必须还在（它不走题库表，不该被一起藏掉）
  if (!banks.length) {
    html += '<div class="muted" style="padding:12px 0 0;font-size:12px">'
      + '还没有可练的题库。点右上角「管理题库」导入一份吧。</div>';
  }
  hint.textContent = banks.length
    ? '共 ' + banks.length + ' 份题库 + 打字练习；点一下即可切换。'
      + '错题集、收藏、进度、组卷设置都按题库各自保存，互不影响。'
    : '还没有可练的题库，先试试打字练习吧。';
  box.innerHTML = html;
  box.querySelectorAll('.pick-row').forEach(row => {
    row.addEventListener('click', async () => {
      if (row.dataset.typing === '1') {
        if (row.dataset.cur === '1') { closeBankPicker(); return; }   // 已经在打字练习里：只关掉
        closeBankPicker();                                            // 先收起弹层，再切屏
        if (onOpenTyping) onOpenTyping();
        return;
      }
      const b = banks.find(x => String(x.id) === row.dataset.id);
      if (!b) return;
      if (row.dataset.cur === '1') { closeBankPicker(); return; }   // 点的就是当前那份：只关掉，不重载
      closeBankPicker();                                            // 先收起弹层，再去取题（弹层别压在页面上）
      await openBank(b);                                            // 内部查 questions 并回调 onOpenBank
    });
  });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 验收脚本用：把权限口径暴露出来，Playwright 可直接断言（与 window.__exam 同一套做法）
// import.meta.env.DEV 在 vite build 时被替换为 false，整块会被剔除，不会进生产包。
if (import.meta.env.DEV) {
  // find / editQuestions 用于验收「第二道闸」：绕开按钮直接调内部入口，看守卫拦不拦得住
  window.__banks = {
    renderBanks, canManage, editQuestions,
    find: async id => (await listBanks()).find(x => x.id === id),
    // 顶栏切换练习内容：openBankPicker 是内部入口、listBanks 是数据源、currentBankId 读当前选中
    openBankPicker, listBanks, currentBankId,
    closeBankPicker,
    // 打字练习入口：当前是否在打字那几屏 / 是否卡在练习中
    isOnTypingScreen, busyPracticing,
    // v2.32：本机缓存 / 后台预取 / 版本校验的入口（check_speed 用来断言缓存机制）
    hydrateBankList, prefetchBanks, openBankById, prepareBank,
    fetchBankQuestions, revalidateQuestions
  };
}
