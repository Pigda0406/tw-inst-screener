// ===========================================================================
// verify-scan.mjs — 自我檢查用
//
// 執行:  node scripts/verify-scan.mjs --stats     各表的日期數、筆數、日期範圍,以及近期 ingest 錯誤
// (P4 會加入今日候選清單)
// ===========================================================================
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { openDb } from '../lib/db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? join(__dirname, '..', 'data', 'history.sqlite');

const { values: args } = parseArgs({ options: { stats: { type: 'boolean', default: false } } });

function printStats(db) {
  const tables = [
    ['trading_days', 'date'], ['inst_daily', 'date'], ['price_daily', 'date'],
    ['margin_daily', 'date'], ['qfii_daily', 'date'], ['tdcc_weekly', 'data_date'], ['scan_daily', 'date'],
  ];
  console.log('表              日期數    筆數  範圍');
  for (const [t, col] of tables) {
    const r = db.prepare(`SELECT COUNT(DISTINCT ${col}) AS days, COUNT(*) AS n, MIN(${col}) AS lo, MAX(${col}) AS hi FROM ${t}`).get();
    console.log(`${t.padEnd(14)} ${String(r.days).padStart(6)} ${String(r.n).padStart(7)}  ${r.lo ?? '-'} ~ ${r.hi ?? '-'}`);
  }

  // 交易日中,哪些來源/市場缺資料
  const gaps = db.prepare(`
    SELECT d.date, s.market, src.t AS tbl
    FROM trading_days d
    CROSS JOIN (SELECT 'TWSE' AS market UNION ALL SELECT 'TPEX') s
    CROSS JOIN (SELECT 'price_daily' AS t UNION ALL SELECT 'margin_daily' UNION ALL SELECT 'qfii_daily') src
    WHERE d.twse_ok = 1 AND d.tpex_ok = 1
      AND NOT EXISTS (
        SELECT 1 FROM price_daily p JOIN stocks k ON k.code = p.code WHERE src.t = 'price_daily' AND p.date = d.date AND k.market = s.market
        UNION ALL SELECT 1 FROM margin_daily m JOIN stocks k ON k.code = m.code WHERE src.t = 'margin_daily' AND m.date = d.date AND k.market = s.market
        UNION ALL SELECT 1 FROM qfii_daily q JOIN stocks k ON k.code = q.code WHERE src.t = 'qfii_daily' AND q.date = d.date AND k.market = s.market)
    ORDER BY d.date`).all();
  console.log(`\n交易日缺漏(來源/市場): ${gaps.length ? '' : '無'}`);
  for (const g of gaps) console.log(`  ${g.date} ${g.tbl} ${g.market}`);

  const errors = db.prepare(`SELECT run_at, source, date, message FROM ingest_log WHERE status = 'error' ORDER BY id DESC LIMIT 10`).all();
  console.log(`\n最近 ingest 錯誤: ${errors.length ? '' : '無'}`);
  for (const e of errors) console.log(`  ${e.run_at} ${e.source} ${e.date ?? ''} ${e.message ?? ''}`);
}

const db = openDb(DB_PATH);
if (args.stats) printStats(db);
else console.log('用法: node scripts/verify-scan.mjs --stats');
db.close();
