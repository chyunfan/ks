// 期望表头（按中文名定位；大小写/空格不敏感）
const HEADERS = {
  type: ['题型'],
  material: ['案例材料'],
  stem: ['题干', '题目'],
  opt: ['A', 'B', 'C', 'D', 'E', 'F'],
  answer: ['答案'],
  analysis: ['解析']
};

function norm(s) { return (s == null ? '' : String(s)).trim(); }
function findCol(headers, names) {
  for (let i = 0; i < headers.length; i++) {
    const h = norm(headers[i]).replace(/\s/g, '');
    if (names.some(n => h === n || h.includes(n))) return i;
  }
  return -1;
}

function parseType(t) {
  const s = norm(t);
  if (/^单/.test(s) || s === 'single') return 'single';
  if (/^多/.test(s) || s === 'multiple') return 'multiple';
  if (/^判/.test(s) || s === 'judge') return 'judge';
  if (/案/.test(s) || s === 'case') return 'case';
  return null;
}

// 从答案单元格抽取 A-F 字母（忽略分隔符/大小写）
function answerLetters(raw) {
  const s = norm(raw).toUpperCase();
  const m = s.match(/[A-F]/g);
  return m ? [...new Set(m)] : [];
}

// 判断题答案归一化 -> {answerText, key}
function parseJudge(raw) {
  const s = norm(raw);
  if (/错|FALSE/i.test(s) || s === 'B' || s === 'F') return { answerText: '错误', key: 'B' };
  if (/对|正确|TRUE/i.test(s) || s === 'A' || s === 'T') return { answerText: '正确', key: 'A' };
  return null;
}

/**
 * 解析 xlsx 题库。
 * errors   —— 阻断性问题，必须修正后才能导入
 * warnings —— 提示性问题，不阻断导入（如多选全选）
 * @returns {{ok:boolean, questions:Array, caseCount:number, errors:Array, warnings:Array, rowCount:number}}
 */
export function parseWorkbook(arrayBuffer, X) {
  const errors = [];
  const warnings = [];
  const wb = X.read(arrayBuffer, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = X.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  if (!rows.length) return { ok: false, questions: [], caseCount: 0, errors: ['文件为空'], warnings: [], rowCount: 0 };

  const header = rows[0].map(c => norm(c));
  const col = {
    type: findCol(header, HEADERS.type),
    material: findCol(header, HEADERS.material),
    stem: findCol(header, HEADERS.stem),
    answer: findCol(header, HEADERS.answer),
    analysis: findCol(header, HEADERS.analysis)
  };
  const optCols = HEADERS.opt.map((_, i) => findCol(header, [HEADERS.opt[i]])).filter(i => i >= 0);

  if (col.type < 0 || col.stem < 0 || col.answer < 0) {
    return { ok: false, questions: [], caseCount: 0, errors: ['表头缺少必要列：题型 / 题干 / 答案'], warnings: [], rowCount: 0 };
  }

  const questions = [];
  let caseSeq = 0;
  const caseMap = new Map();
  let lastCase = null;
  let id = 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every(c => norm(c) === '')) continue; // 空行跳过
    const lineNo = r + 1; // 含表头
    const typeRaw = norm(row[col.type]);
    const materialRaw = col.material >= 0 ? norm(row[col.material]) : '';
    const stem = norm(row[col.stem]);
    const answerRaw = norm(row[col.answer]);
    const analysis = col.analysis >= 0 ? norm(row[col.analysis]) : '';

    const t = parseType(typeRaw);
    if (!t) { errors.push(`第 ${lineNo} 行：题型「${typeRaw}」非法，仅限 单选/多选/判断/案例`); continue; }

    // 收集选项 A-F
    const options = [];
    for (const ci of optCols) {
      const txt = norm(row[ci]);
      const key = HEADERS.opt[optCols.indexOf(ci)];
      if (txt !== '') options.push({ key, text: txt });
    }

    let isCase = false, caseId = null, caseBackground = '';
    if (t === 'case' || (materialRaw !== '' && (t === 'single' || t === 'multiple'))) {
      isCase = true;
      const mat = materialRaw || (lastCase ? lastCase.material : '');
      if (!mat) { errors.push(`第 ${lineNo} 行：案例题缺少「案例材料」`); continue; }
      if (caseMap.has(mat)) caseId = caseMap.get(mat);
      else { caseId = ++caseSeq; caseMap.set(mat, caseId); }
      caseBackground = mat;
      lastCase = { material: mat, cid: caseId };
    } else {
      lastCase = null;
    }

    // 案例子题的题型：显式给定 或 由答案字母数推断
    let qtype = t;
    if (isCase && t === 'case') qtype = answerLetters(answerRaw).length > 1 ? 'multiple' : 'single';

    // 答案解析与校验
    let answerKeys, correctIdx, answerText = null;
    if (qtype === 'judge') {
      const j = parseJudge(answerRaw);
      if (!j) { errors.push(`第 ${lineNo} 行：判断题答案必须是 对/错（或 正确/错误/A/B）`); continue; }
      options.length = 0;
      options.push({ key: 'A', text: '正确' }, { key: 'B', text: '错误' });
      answerKeys = [j.key];
      correctIdx = [j.key === 'A' ? 0 : 1];
      answerText = j.answerText;
    } else {
      const letters = answerLetters(answerRaw);
      if (!letters.length) { errors.push(`第 ${lineNo} 行：缺少答案（A-F）`); continue; }
      const optKeys = options.map(o => o.key);
      const bad = letters.filter(l => !optKeys.includes(l));
      if (bad.length) { errors.push(`第 ${lineNo} 行：答案包含未填写的选项 ${bad.join('')}`); continue; }
      if (qtype === 'single') {
        if (letters.length !== 1) { errors.push(`第 ${lineNo} 行：单选题答案应只有 1 个，当前 ${letters.length} 个`); continue; }
        if (options.length < 2) { errors.push(`第 ${lineNo} 行：单选题至少需要 2 个选项`); continue; }
        answerKeys = letters;
        correctIdx = [optKeys.indexOf(letters[0])];
      } else { // multiple
        if (letters.length < 2) { errors.push(`第 ${lineNo} 行：多选题答案至少 2 个，当前 ${letters.length} 个`); continue; }
        if (options.length < 2) { errors.push(`第 ${lineNo} 行：多选题至少需要 2 个选项`); continue; }
        // 多选「答案覆盖全部选项」在真实题库里是合法答案（如"以下哪些属于…"），
        // 只提醒、不阻断导入 —— 早期版本在此处直接报错，会误伤整批真题。
        if (letters.length === options.length) {
          warnings.push(`第 ${lineNo} 行：多选题答案为全选（${letters.join('')}），请确认是否符合预期`);
        }
        answerKeys = letters;
        correctIdx = letters.map(l => optKeys.indexOf(l)).sort((a, b) => a - b);
      }
    }

    if (!stem) { errors.push(`第 ${lineNo} 行：缺少题干`); continue; }

    id++;
    const q = {
      id,
      type: qtype,
      stem,
      options,
      answerKeys,
      answerText,
      correctIdx,
      analysis: analysis || null
    };
    if (isCase) { q.isCase = true; q.caseId = caseId; q.caseBackground = caseBackground; }
    questions.push(q);
  }

  if (questions.length === 0 && errors.length === 0) {
    errors.push('没有解析到任何题目，请检查模板格式');
  }

  return {
    ok: errors.length === 0,
    questions,
    caseCount: caseSeq,
    errors,
    warnings,
    rowCount: questions.length
  };
}

// 生成可下载的空模板（含表头 + 2 行示例）
export function buildTemplateWorkbook(X) {
  const aoa = [
    ['题型', '案例材料', '题干', 'A', 'B', 'C', 'D', 'E', 'F', '答案', '解析'],
    ['单选', '', '中国人民银行的主要职责是？', '制定和执行货币政策', '发行人民币', '监管证券业', '审批商业银行设立', '', '', 'A', '货币政策职能'],
    ['案例', '某公司申请流动资金贷款用于日常经营周转。', '该贷款应归类为？', '流动资金贷款', '固定资产贷款', '项目贷款', '', '', '', 'A', ''],
    ['案例', '某公司申请流动资金贷款用于日常经营周转。', '贷款期限一般不超过？', '1年', '3年', '5年', '', '', '', 'B', '']
  ];
  const ws = X.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 8 }, { wch: 30 }, { wch: 40 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 20 }];
  const wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, ws, '题库模板');
  return wb;
}

// 将题库导出为 xlsx（便于备份）
export function buildBankWorkbook(questions, X) {
  const aoa = [['题型', '案例材料', '题干', 'A', 'B', 'C', 'D', 'E', 'F', '答案', '解析']];
  const typeName = { single: '单选', multiple: '多选', judge: '判断' };
  for (const q of questions) {
    const typeLabel = q.isCase ? '案例' : (typeName[q.type] || q.type);
    const material = q.isCase ? q.caseBackground : '';
    const opt = ['', '', '', '', '', ''];
    (q.options || []).forEach(o => { const i = 'ABCDEF'.indexOf(o.key); if (i >= 0) opt[i] = o.text; });
    const answer = (q.answerKeys || []).join('');
    aoa.push([typeLabel, material, q.stem, opt[0], opt[1], opt[2], opt[3], opt[4], opt[5], answer, q.analysis || '']);
  }
  const ws = X.utils.aoa_to_sheet(aoa);
  const wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, ws, '题库');
  return wb;
}
