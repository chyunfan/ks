// 用真实模板跑一遍解析，验证导入不再被「多选全选」阻断
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { parseWorkbook } from '../src/import.js';
// v2.32：import.js 不再自带 xlsx（主包要瘦身），Excel 组件由调用方传进来。
// 浏览器里传的是按需加载的 window.XLSX，Node 这里直接用 node_modules 的。

const file = process.argv[2];
if (!file) { console.error('用法：node check_import.mjs <xlsx路径>'); process.exit(2); }

const buf = readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const t0 = Date.now();
const res = parseWorkbook(ab, XLSX);

console.log('解析耗时:', Date.now() - t0, 'ms');
console.log('ok        :', res.ok);
console.log('题目总数  :', res.questions.length);
console.log('案例组数  :', res.caseCount);
console.log('行数统计  :', res.rowCount);
const byType = {};
for (const q of res.questions) byType[q.type] = (byType[q.type] || 0) + 1;
console.log('题型分布  :', JSON.stringify(byType));
console.log('errors    :', res.errors.length);
res.errors.slice(0, 20).forEach(e => console.log('   ✗', e));
console.log('warnings  :', res.warnings.length);
res.warnings.slice(0, 20).forEach(w => console.log('   ! ', w));
console.log('是否还有「不能全选」类错误:', res.errors.some(e => e.includes('不能全选')));

// 抽样检查全选题是否完整入库
const full = res.questions.filter(q => q.type === 'multiple' && q.answerKeys.length === q.options.length);
console.log('\n全选型多选题已入库数:', full.length);
full.slice(0, 3).forEach(q => console.log('   ·', q.answerKeys.join(''), '|', q.stem.slice(0, 34) + '…', '| 选项数', q.options.length));
