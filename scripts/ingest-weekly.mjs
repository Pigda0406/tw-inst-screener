// ===========================================================================
// ingest-weekly.mjs — 下載集保股權分散表(開放資料 CSV,只有最新一週)寫進 history.sqlite
//
// 執行:  TZ=Asia/Taipei node scripts/ingest-weekly.mjs
// 該週已寫入就記 skipped 後結束,所以每天執行都可以。
// 在 GitHub Actions 中寫入新的一週時,會輸出 new_tdcc=<資料日期>(workflow 用來決定是否備份 DB)。
// 驗證:Σ股數(1..15) + 差異數調整 = 合計、Σ人數(1..15) = 合計人數;不符超過 1% 整批放棄。
// ===========================================================================
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { appendFileSync } from 'node:fs';
import { nowTaipei } from '../lib/dates.mjs';
import { openDb, writeTdcc, tdccCodes, logIngest } from '../lib/db.mjs';
import { fetchTdccCsv } from '../lib/sources/tdcc.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? join(__dirname, '..', 'data', 'history.sqlite');
const MAX_INVALID_RATIO = 0.01;

async function main() {
  const db = openDb(DB_PATH);
  try {
    let csv;
    try {
      csv = await fetchTdccCsv();
    } catch (e) {
      logIngest(db, { source: 'tdcc', status: 'error', message: e.message });
      throw e;
    }
    const { dataDate, stocks, invalid } = csv;

    if (tdccCodes(db, dataDate).size > 0) {
      logIngest(db, { source: 'tdcc', date: dataDate, status: 'skipped', message: '該週已寫入' });
      process.stderr.write(`集保 ${dataDate} 已寫入,略過\n`);
      return;
    }

    const total = stocks.size + invalid.length;
    if (invalid.length > total * MAX_INVALID_RATIO) {
      const message = `驗證不符 ${invalid.length}/${total} 檔,超過 1%,整批放棄。例: ${invalid.slice(0, 3).map((x) => `${x.code} ${x.reason}`).join('; ')}`;
      logIngest(db, { source: 'tdcc', date: dataDate, status: 'error', message });
      throw new Error(message);
    }

    const n = writeTdcc(db, dataDate, stocks, nowTaipei());
    const message = invalid.length ? `驗證不符略過 ${invalid.length} 檔: ${invalid.map((x) => x.code).join(',')}` : null;
    logIngest(db, { source: 'tdcc', date: dataDate, status: 'ok', rows: n, message });
    process.stderr.write(`集保 ${dataDate} ✓ ${n} 檔${message ? `(${message})` : ''}\n`);
    // GitHub Actions:告訴 workflow 這次寫入了新的一週,要額外備份 DB(§9.3)
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `new_tdcc=${dataDate}\n`);
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error('執行失敗:', e.message);
  process.exit(1);
});
