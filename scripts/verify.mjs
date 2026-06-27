import { readFile } from 'node:fs/promises';
const d = JSON.parse(await readFile(new URL('../docs/data.json', import.meta.url)));
console.log('trading_days:', d.trading_days.join(', '));
console.log('total stocks:', d.stocks.length);
const find = (c) => d.stocks.find((s) => s.code === c);
for (const c of ['3481', '2330']) { const s = find(c); console.log(c, '=>', s ? JSON.stringify(s) : '(未入預篩)'); }

const days = d.trading_days.length;
const last5 = (a) => a.slice(days - 5);
const streakOk = (a, k) => a.slice(days - k).every((v) => v > 0);
const sum = (a) => a.reduce((p, c) => p + c, 0);
const pass = d.stocks.filter((s) => {
  const f = last5(s.foreign_daily), de = last5(s.dealer_daily);
  return sum(f) > 0 && sum(de) > 0 && streakOk(s.foreign_daily, 3) && streakOk(s.dealer_daily, 3);
});
console.log('\n最終符合(外資+自營 各自 5日累計>0 且 最近連3日每日>0):', pass.length, '檔');
for (const s of pass.slice(0, 10)) {
  console.log(`${s.code} ${s.name} [${s.market}] 外資日:${s.foreign_daily.join(',')} 自營日:${s.dealer_daily.join(',')}`);
}
