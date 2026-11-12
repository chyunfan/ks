/**
 * 本机持久缓存（IndexedDB）· v2.32
 *
 * 为什么需要：题目以前只缓存在内存里（bankcache.js），关页就没了。
 * 于是每次打开页面都要重新下一遍整库题目 —— 大题库几百 KB 到几 MB，
 * 在实测 20 KB/s 的链路上就是十几到几十秒。这是「题库越大、打开越慢」的直接原因。
 *
 * 现在把题目和题库列表一起落到 IndexedDB：
 *   · 打开页面 → 先从本机拿上一次的题库列表和题目，界面立刻就有内容；
 *   · 同时后台按 updated_at 校验，题库真的改了才重下（用户要求：「题库有更新需更新缓存」）。
 *
 * 为什么单独一个模块：banks.js 需要、main.js 需要、退出登录也要清，
 * 放在谁那里都会让另外两边反向 import（这个项目已经有过一次成环的教训）。
 *
 * 全部操作**失败即降级**：无 IndexedDB / 隐私模式 / 配额满 → 当作没有缓存，
 * 功能退回 v2.31 的行为（每次现下），绝不让缓存把页面搞崩。
 */

const DB_NAME = 'ce_cache';
const DB_VER = 1;
const STORE = 'kv';
const MAX_BANKS = 6;          // 最多留几份题库题目（一份可能几 MB，不能无限长）

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise(resolve => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch (e) {
      resolve(null);
    }
  });
  return dbPromise;
}

/** 在一个事务里跑一次操作；任何异常都吞掉并返回 fallback */
async function withStore(mode, fn, fallback) {
  const db = await openDB();
  if (!db) return fallback;
  return new Promise(resolve => {
    let result = fallback;
    try {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      const req = fn(store);
      if (req) req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => resolve(result === undefined ? fallback : result);
      tx.onerror = () => resolve(fallback);
      tx.onabort = () => resolve(fallback);
    } catch (e) {
      resolve(fallback);
    }
  });
}

export function kvGet(key) {
  return withStore('readonly', s => s.get(key), null).then(v => (v === undefined ? null : v));
}

export function kvSet(key, val) {
  return withStore('readwrite', s => s.put(val, key), false).then(() => true);
}

export function kvDel(key) {
  return withStore('readwrite', s => s.delete(key), false).then(() => true);
}

export function kvKeys() {
  return withStore('readonly', s => s.getAllKeys(), []).then(v => v || []);
}

/* ============================================================
   题库题目：{ id, updatedAt, count, qs, at }
   updatedAt 就是 exam_banks.updated_at（触发器维护），用它判断「题库有没有更新」
   ============================================================ */
const qKey = id => 'q:' + id;

export async function getCachedQuestions(id) {
  if (!id) return null;
  const hit = await kvGet(qKey(id));
  if (!hit || !Array.isArray(hit.qs)) return null;
  return hit;
}

export async function putCachedQuestions(id, entry) {
  if (!id || !entry || !Array.isArray(entry.qs)) return false;
  const ok = await kvSet(qKey(id), Object.assign({ id: String(id) }, entry, { at: Date.now() }));
  trimQuestions().catch(() => {});
  return ok;
}

export function delCachedQuestions(id) {
  if (!id) return Promise.resolve(false);
  return kvDel(qKey(id));
}

/** 只保留最近用过的 MAX_BANKS 份，其余删掉（防止占满配额） */
async function trimQuestions() {
  const keys = (await kvKeys()).filter(k => typeof k === 'string' && k.startsWith('q:'));
  if (keys.length <= MAX_BANKS) return;
  const rows = [];
  for (const k of keys) {
    const v = await kvGet(k);
    rows.push({ k, at: (v && v.at) || 0 });
  }
  rows.sort((a, b) => b.at - a.at);
  for (const r of rows.slice(MAX_BANKS)) await kvDel(r.k);
}

/* ============================================================
   题库列表快照：{ userId, at, rows }
   按账号分开存 —— 换人登录不能看到上一个人的「我上传的」
   ============================================================ */
const LIST_KEY = 'banklist';

export async function getListSnapshot(userId) {
  const hit = await kvGet(LIST_KEY);
  if (!hit || !Array.isArray(hit.rows)) return null;
  if (String(hit.userId || '') !== String(userId || '')) return null;   // 换了账号：当没缓存
  return hit;
}

export function putListSnapshot(userId, rows) {
  if (!Array.isArray(rows)) return Promise.resolve(false);
  return kvSet(LIST_KEY, { userId: String(userId || ''), at: Date.now(), rows });
}

/** 退出登录：把本机缓存全清（含题目、列表、以及被淘汰逻辑漏掉的零散键） */
export async function clearAllCache() {
  const db = await openDB();
  if (!db) return false;
  return new Promise(resolve => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    } catch (e) { resolve(false); }
  });
}
