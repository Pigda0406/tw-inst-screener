// ===========================================================================
// ingest-daily.mjs — 把近 14 個日曆天內尚未完整的交易日寫進 history.sqlite
//
// 執行:  TZ=Asia/Taipei node scripts/ingest-daily.mjs
// 需求:  Node ≥ 22.13(node:sqlite);DB 路徑可用 DB_PATH 覆寫,預設 data/history.sqlite
// 目前只處理 inst 來源(上市 T86 + 上櫃 dailyTrade);price/margin/qfii 於 P2 加入。
// ===========================================================================
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { iso, todayTaipei, isWeekend } from '../lib/dates.mjs';
import { fetchInstDay } from '../lib/calendar.mjs';
import { openDb, completeDates, hasTwseFp, writeInstDay, logIngest } from '../lib/db.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? join(__dirname, '..', 'data', 'history.sqlite');
const LOOKBACK_DAYS = 14;

// 近 LOOKBACK_DAYS 個日曆天內、尚未在 trading_days 標記完整的平日,由舊到新
function pendingDates(db) {
  const done = completeDates(db);
  const today = todayTaipei();
  const out = [];
  for (let back = LOOKBACK_DAYS - 1; back >= 0; back--) {
    const d = new Date(today);
    d.setDate(d.getDate() - back);
    if (!isWeekend(d) && !done.has(iso(d))) out.push(d);
  }
  return out;
}

async function main() {
  const db = openDb(DB_PATH);
  const dates = pendingDates(db);
  process.stderr.write(`待處理 ${dates.length} 天: ${dates.map(iso).join(', ') || '(無)'}\n`);

  const summary = [];
  for (const d of dates) {
    const date = iso(d);
    const r = await fetchInstDay(d, { isDupFp: (fp) => hasTwseFp(db, fp, date) });

    if (r.status === 'holiday') {
      logIngest(db, { source: 'tpex-inst', date, status: r.error ? 'error' : 'empty', message: r.error?.message });
      summary.push(`${date} 非交易日或上櫃無資料`);
      continue;
    }
    if (r.status === 'twse_missing' || r.status === 'twse_dup') {
      const message = r.status === 'twse_dup' ? `指紋 ${r.fp} 與其他日重複` : r.error?.message ?? '取不到資料';
      logIngest(db, { source: 'twse-inst', date, status: r.status === 'twse_dup' ? 'skipped' : 'error', message });
      summary.push(`${date} ⚠ 上市 ${message},整日跳過`);
      continue;
    }

    try {
      const n = writeInstDay(db, date, r);
      logIngest(db, { source: 'twse-inst', date, status: 'ok', rows: n.twse });
      logIngest(db, { source: 'tpex-inst', date, status: 'ok', rows: n.tpex });
      summary.push(`${date} ✓ 上市 ${n.twse} 檔 / 上櫃 ${n.tpex} 檔`);
    } catch (e) {
      logIngest(db, { source: 'inst', date, status: 'error', message: e.message });
      summary.push(`${date} ✗ 寫入失敗: ${e.message}`);
    }
  }

  const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  const totals = ['trading_days', 'stocks', 'inst_daily'].map((t) => `${t} ${count(t)}`).join(' / ');
  db.close();
  process.stderr.write(`\n摘要:\n${summary.map((s) => `  ${s}`).join('\n') || '  (沒有需要處理的日期)'}\n`);
  process.stderr.write(`DB ${DB_PATH}: ${totals}\n`);
}

main().catch((e) => {
  console.error('執行失敗:', e);
  process.exit(1);
});
