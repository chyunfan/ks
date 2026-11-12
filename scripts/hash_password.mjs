// ============================================================
// 生成 bcrypt 哈希 —— 供「忘记密码」手工重置用
// ------------------------------------------------------------
// 不连数据库、不读任何密钥，纯本地计算，安全。
//
// 用法：
//   node scripts/hash_password.mjs 新密码
//
// 输出形如：
//   $2a$10$RVU/0n7d9HQlUslNXEKKQOcwgYUhu3.ZKWQCfYJDQrwnnO1sO/Agq
//
// 把这一整串（含 $ 符号）贴进 supabase/reset-password.sql 的 update 语句即可。
// 哈希参数 cost=10，与 api/register.js 注册时完全一致。
// ============================================================
import bcrypt from 'bcryptjs';

const pw = process.argv[2];

if (!pw) {
  console.error('用法：node scripts/hash_password.mjs 新密码');
  process.exit(1);
}
if (pw.length < 6) {
  console.error('密码至少 6 位（与注册规则一致）');
  process.exit(1);
}

const hash = bcrypt.hashSync(pw, 10);

// 自检：确保生成的哈希能反校验通过（防止手滑/环境问题产出坏哈希）
if (!bcrypt.compareSync(pw, hash)) {
  console.error('自检失败：生成的哈希无法通过校验，请检查 bcryptjs 是否正常');
  process.exit(1);
}

console.log(hash);
