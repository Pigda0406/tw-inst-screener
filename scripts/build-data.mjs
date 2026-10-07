// ===========================================================================
// build-data.mjs — 抓取 TWSE(上市)+ TPEX(上櫃)三大法人買賣超,
//                  預篩近期有法人買超的個股(外資/投信/自營商),輸出 docs/data.json
//
// 執行:  TZ=Asia/Taipei node scripts/build-data.mjs
// 需求:  Node 18+(內建 fetch),零 npm 依賴;抓取邏輯在 lib/
// ===========================================================================
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { iso, todayTaipei, isWeekend } from '../lib/dates.mjs';
import { fetchInstDay } from '../lib/calendar.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'docs');
const OUT_FILE = join(OUT_DIR, 'data.json');

const NEEDED_DAYS = 10;      // 取最近 10 個交易日(前端預設累計 10 日)
const MAX_LOOKBACK = 30;     // 最多往回看的日曆天數(含週末與連假)

// ---- 取得最近 N 個交易日的合併資料 ---------------------------------------
// 交易日判定、兩市場皆需到齊、指紋去重的規則見 lib/calendar.mjs 的 fetchInstDay。
// 這裡的指紋只在本次執行抓到的日期之間比對。
async function collectRecentDays() {
  const days = [];           // [{date, twse:Map, tpex:Map}, ...] 由舊到新
  const twseFps = new Set();
  const cursor = todayTaipei();

  for (let back = 0; back < MAX_LOOKBACK && days.length < NEEDED_DAYS; back++) {
    const d = new Date(cursor);
    d.setDate(d.getDate() - back);
    if (isWeekend(d)) continue; // 週末直接跳過

    const r = await fetchInstDay(d, { isDupFp: (fp) => twseFps.has(fp) });
    if (r.status !== 'ok') continue;
    twseFps.add(r.fp);

    process.stderr.write(`${iso(d)} ✓ 上市 ${r.twse.size} 檔 / 上櫃 ${r.tpex.size} 檔\n`);
    days.push({ date: iso(d), twse: r.twse, tpex: r.tpex });
  }
  days.reverse(); // 由舊到新
  return days;
}

// ---- 主流程 ---------------------------------------------------------------
async function main() {
  const days = await collectRecentDays();
  if (days.length === 0) throw new Error('完全抓不到任何交易日資料。');

  const tradingDays = days.map((x) => x.date);

  // 彙整每檔股票的每日淨買超(張)。以最後一天(最新)的名稱/市場為準。
  const stocks = new Map(); // code -> {code,name,market,foreign_daily[],trust_daily[],dealer_daily[]}
  const ensure = (code, name, market) => {
    if (!stocks.has(code)) {
      stocks.set(code, {
        code, name, market,
        foreign_daily: new Array(days.length).fill(0),
        trust_daily: new Array(days.length).fill(0),
        dealer_daily: new Array(days.length).fill(0),
      });
    }
    const s = stocks.get(code);
    if (name) s.name = name;       // 用較新的名稱覆寫
    if (market) s.market = market;
    return s;
  };

  days.forEach((day, di) => {
    for (const [code, v] of day.twse) {
      const s = ensure(code, v.name, 'TWSE');
      s.foreign_daily[di] = Math.round(v.foreign / 1000); // 股 → 張
      s.trust_daily[di] = Math.round(v.trust / 1000);
      s.dealer_daily[di] = Math.round(v.dealer / 1000);
    }
    for (const [code, v] of day.tpex) {
      const s = ensure(code, v.name, 'TPEX');
      s.foreign_daily[di] = Math.round(v.foreign / 1000);
      s.trust_daily[di] = Math.round(v.trust / 1000);
      s.dealer_daily[di] = Math.round(v.dealer / 1000);
    }
  });

  // 寬鬆預篩:外資/投信/自營商「任一」近期累計 > 0 即輸出(要哪些法人同步買超由前端勾選)
  const sum = (a) => a.reduce((p, c) => p + c, 0);
  const result = [];
  for (const s of stocks.values()) {
    if (sum(s.foreign_daily) > 0 || sum(s.trust_daily) > 0 || sum(s.dealer_daily) > 0) result.push(s);
  }
  result.sort((a, b) => sum(b.foreign_daily) - sum(a.foreign_daily));

  const out = {
    updated_at: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).replace(' ', 'T') + '+08:00',
    trading_days: tradingDays,
    note: '數值單位為「張」(股數÷1000);外資含陸資、自營商含自行+避險。資料僅供參考,非投資建議。',
    stocks: result,
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(out, null, 2), 'utf8');
  process.stderr.write(`\n完成:${tradingDays.length} 個交易日 (${tradingDays.join(', ')}),預篩後 ${result.length} 檔 → ${OUT_FILE}\n`);
}

main().catch((e) => {
  console.error('執行失敗:', e);
  process.exit(1);
});
