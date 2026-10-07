// ===========================================================================
// backfill.mjs — 在本機回補歷史資料(手動執行一次;請求間隔 ≥ 3 秒,約 25~30 分鐘)
//
// 執行:  TZ=Asia/Taipei node scripts/backfill.mjs [--days 60] [--sources inst,price,margin,qfii]
//                                                  [--from YYYY-MM-DD] [--to YYYY-MM-DD]
//   --days    由 --to(預設今天)往回回補的交易日數,預設 60;有 --from 時改以 --from 為下限
//   --sources 只處理指定的來源群組;非 inst 來源只會補「法人已完整」的日期
// 已存在的日期與來源直接跳過,可以中斷後續跑。
// ===========================================================================
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { iso, todayTaipei, isWeekend } from '../lib/dates.mjs';
import { openDb } from '../lib/db.mjs';
import { ingestDate, GROUPS } from '../lib/ingest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? join(__dirname, '..', 'data', 'history.sqlite');

const { values: args } = parseArgs({
  options: {
    days: { type: 'string', default: '60' },
    sources: { type: 'string', default: GROUPS.join(',') },
    from: { type: 'string' },
    to: { type: 'string' },
  },
});

const parseDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`日期格式錯誤: ${s}(應為 YYYY-MM-DD)`);
  return new Date(`${s}T00:00:00`);
};

async function main() {
  const groups = args.sources.split(',').map((s) => s.trim());
  const bad = groups.filter((g) => !GROUPS.includes(g));
  if (bad.length) throw new Error(`未知的來源: ${bad.join(', ')}(可用: ${GROUPS.join(', ')})`);
  const days = Number(args.days);
  if (!args.from && !(days > 0)) throw new Error(`--days 必須是正整數: ${args.days}`);

  const to = args.to ? parseDate(args.to) : todayTaipei();
  const from = args.from ? parseDate(args.from) : null;
  // 沒有 --from 時,往回最多走 days×2+30 個日曆天(足以涵蓋連假),避免無限往回
  const floor = from ?? new Date(to.getFullYear(), to.getMonth(), to.getDate() - (days * 2 + 30));

  const db = openDb(DB_PATH);
  process.stderr.write(`回補 ${from ? `${iso(from)} ~ ${iso(to)}` : `${iso(to)} 往回 ${days} 個交易日`},來源 ${groups.join(',')}\n`);

  let tradingDays = 0;
  for (const d = new Date(to); d >= floor; d.setDate(d.getDate() - 1)) {
    if (!from && tradingDays >= days) break;
    if (isWeekend(d)) continue;
    const { trading, lines } = await ingestDate(db, d, groups);
    if (trading !== false) tradingDays++;
    process.stderr.write(`${iso(d)} ${lines.join(' ') || '已完整,跳過'}\n`);
  }

  db.close();
  process.stderr.write(`\n完成:處理 ${tradingDays} 個交易日。查看統計:node scripts/verify-scan.mjs --stats\n`);
  process.stderr.write('上傳到 R2:\n  npx wrangler r2 object put tw-stocks-data/db/history.sqlite --file data/history.sqlite --remote\n');
}

main().catch((e) => {
  console.error('執行失敗:', e);
  process.exit(1);
});
