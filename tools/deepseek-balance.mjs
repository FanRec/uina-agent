#!/usr/bin/env node
// 查 DeepSeek 账户余额。用法：
//   node tools/deepseek-balance.mjs
//   node tools/deepseek-balance.mjs --json
// key 取自环境变量 DEEPSEEK_API_KEY（或 --key=sk-xxx）。
// 官方接口：GET https://api.deepseek.com/user/balance

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const keyArg = args.find((a) => a.startsWith('--key='));
const key = (keyArg ? keyArg.slice('--key='.length) : process.env.DEEPSEEK_API_KEY || '').trim();

if (!key) {
  console.error('缺少 API key：设 DEEPSEEK_API_KEY，或传 --key=sk-xxx');
  process.exit(2);
}

const res = await fetch('https://api.deepseek.com/user/balance', {
  headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
});

const text = await res.text();
let body = null;
try {
  body = JSON.parse(text);
} catch {
  body = null;
}

if (!res.ok || !body) {
  console.error(`请求失败 HTTP ${res.status}`);
  console.error(text.slice(0, 500));
  process.exit(1);
}

if (asJson) {
  console.log(JSON.stringify({ status: res.status, body }, null, 2));
  process.exit(0);
}

console.log(`账户状态：${body.is_available ? '可用' : '不可用（余额不足或被限制）'}`);
const infos = Array.isArray(body.balance_infos) ? body.balance_infos : [];
if (!infos.length) console.log('没有返回余额条目。');
for (const b of infos) {
  const cur = b.currency || '?';
  const sym = cur === 'CNY' ? '¥' : cur === 'USD' ? '$' : `${cur} `;
  console.log(`可用余额：${sym}${b.total_balance}`);
  console.log(`  赠送：${sym}${b.granted_balance}   充值：${sym}${b.topped_up_balance}`);
}
