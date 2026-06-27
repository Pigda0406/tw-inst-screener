// ===========================================================================
// build-data.mjs — 抓取 TWSE(上市)+ TPEX(上櫃)三大法人買賣超,
//                  篩出「外資 + 自營商」近期同步買超的個股,輸出 docs/data.json
//
// 執行:  TZ=Asia/Taipei node scripts/build-data.mjs
// 需求:  Node 18+(內建 fetch),零 npm 依賴
// ===========================================================================
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'docs');
const OUT_FILE = join(OUT_DIR, 'data.json');

const NEEDED_DAYS = 6;       // 取最近 6 個交易日(多 1 天讓前端可調「連 N 日」)
const MAX_LOOKBACK = 18;     // 最多往回看的日曆天數
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) tw-inst-screener' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 只保留普通個股:4 位數字、首位非 0(排除 ETF/債/權證等 0050、00679B、6 位權證)
const isCommonStock = (code) => /^[1-9]\d{3}$/.test(code);

// 字串轉整數:去除千分位逗號/空白,'--'、''、null 視為 0
function toInt(v) {
  if (v == null) return 0;
  const s = String(v).replace(/[,\s]/g, '');
  if (s === '' || s === '--' || s === '---') return 0;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

async function fetchJson(url, { retries = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { headers: UA });
      const text = await r.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`非 JSON 回應 (HTTP ${r.status}): ${text.slice(0, 120)}`);
      }
    } catch (e) {
      lastErr = e;
      await sleep(1500 * (i + 1));
    }
  }
  throw lastErr;
}

// ---- 日期工具 -------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;       // TWSE: 20260626
const slash = (d) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;   // TPEX 新站: 2026/06/26
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;     // 顯示用: 2026-06-26

// ---- TWSE 上市 ------------------------------------------------------------
// 用較穩定的 fund/T86 路徑(rwd/zh 對部分日期會回矛盾錯誤)。
// 回傳 Map<code, {name, foreign, dealer}>;取不到(連假或持續失敗)回傳 null。
// 注意:TWSE 偶有「暫時性」失敗(stat 非 OK),故內建多次重試。
async function fetchTWSE(date, tries = 4) {
  const url = `https://www.twse.com.tw/fund/T86?response=json&date=${ymd(date)}&selectType=ALL`;
  let j = null;
  for (let i = 0; i < tries; i++) {
    j = await fetchJson(url);
    if (j && j.stat === 'OK' && Array.isArray(j.data) && j.data.length > 0) break;
    j = null;
    await sleep(2500 * (i + 1));   // 暫時性失敗 → 退避後重試
  }
  if (!j) return null;

  const f = j.fields;
  const idx = (name) => {
    const i = f.indexOf(name);
    if (i < 0) throw new Error(`TWSE 找不到欄位「${name}」`);
    return i;
  };
  const iCode = idx('證券代號');
  const iName = idx('證券名稱');
  const iForeign1 = idx('外陸資買賣超股數(不含外資自營商)');
  const iForeign2 = idx('外資自營商買賣超股數');
  const iDealer = idx('自營商買賣超股數');

  const map = new Map();
  for (const row of j.data) {
    const code = String(row[iCode]).trim();
    if (!isCommonStock(code)) continue;
    map.set(code, {
      name: String(row[iName]).trim(),
      foreign: toInt(row[iForeign1]) + toInt(row[iForeign2]),
      dealer: toInt(row[iDealer]),
    });
  }
  return map;
}

// ---- TPEX 上櫃 ------------------------------------------------------------
// 新站固定 24 欄:0 代號 1 名稱,之後 7 組(各 買/賣/超),最後 1 欄三大法人合計
//   g1 外資不含自營[2-4]  g2 外資自營商[5-7]  g3 外資合計[8-10]
//   g4 投信[11-13]  g5 自營自行[14-16]  g6 自營避險[17-19]  g7 自營合計[20-22]  total[23]
async function fetchTPEX(date) {
  const url = `https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=${slash(date)}&response=json`;
  const j = await fetchJson(url);
  const table = j && Array.isArray(j.tables) ? j.tables[0] : null;
  if (!table || !Array.isArray(table.data) || table.data.length === 0) return null;

  const map = new Map();
  let validated = false;
  for (const row of table.data) {
    const code = String(row[0]).trim();
    if (!isCommonStock(code)) continue;

    const g1 = toInt(row[4]), g2 = toInt(row[7]), g3 = toInt(row[10]);
    const g5 = toInt(row[16]), g6 = toInt(row[19]), g7 = toInt(row[22]);

    // 自我驗證一次:外資合計 = 不含自營 + 外資自營商;自營合計 = 自行 + 避險
    if (!validated) {
      if (g1 + g2 !== g3 || g5 + g6 !== g7) {
        throw new Error(`TPEX 欄位結構與預期不符 (g1+g2=${g1 + g2} vs g3=${g3}, g5+g6=${g5 + g6} vs g7=${g7})。端點可能改版。`);
      }
      validated = true;
    }
    map.set(code, { name: String(row[1]).trim(), foreign: g3, dealer: g7 });
  }
  return map;
}

// 計算一份 Map 的「指紋」(外資淨買超總和),用來偵測 TWSE 偶發的重複/錯誤資料
function fingerprint(map) {
  let fp = 0;
  for (const v of map.values()) fp += v.foreign;
  return fp;
}

// ---- 取得最近 N 個交易日的合併資料 ---------------------------------------
// 策略:以 TPEX(最穩)判定交易日 → TPEX 有資料才算開盤;該日再抓 TWSE(重試)。
//       必須「兩市場都拿到」才採用此日,任一缺就整天跳過(絕不以 0 填補造成假訊號)。
//       並用指紋去重,擋掉 TWSE 偶爾把別天資料重複回傳的情況。
async function collectRecentDays() {
  const days = [];           // [{date, twse:Map, tpex:Map}, ...] 由舊到新
  const twseFps = new Set();
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);

  for (let back = 0; back < MAX_LOOKBACK && days.length < NEEDED_DAYS; back++) {
    const d = new Date(cursor);
    d.setDate(d.getDate() - back);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue; // 週末直接跳過

    // 1) 先問 TPEX:它是交易日的權威判定
    let tpex = null;
    try { tpex = await fetchTPEX(d); } catch (e) { process.stderr.write(`${iso(d)} TPEX 失敗: ${e.message}\n`); }
    await sleep(1500);
    if (!tpex || tpex.size === 0) {
      process.stderr.write(`${iso(d)} 非交易日或無上櫃資料,略過\n`);
      continue;
    }

    // 2) 是交易日 → 抓 TWSE(內建重試)
    let twse = null;
    try { twse = await fetchTWSE(d); } catch (e) { process.stderr.write(`${iso(d)} TWSE 失敗: ${e.message}\n`); }
    await sleep(1500);
    if (!twse || twse.size === 0) {
      process.stderr.write(`${iso(d)} ⚠ 取不到上市資料,整日跳過(不以 0 填補)\n`);
      continue;
    }

    // 3) 指紋去重:擋掉 TWSE 偶發回傳的重複/錯誤資料
    const fp = fingerprint(twse);
    if (twseFps.has(fp)) {
      process.stderr.write(`${iso(d)} ⚠ 上市資料與其他日重複(指紋 ${fp}),跳過\n`);
      continue;
    }
    twseFps.add(fp);

    process.stderr.write(`${iso(d)} ✓ 上市 ${twse.size} 檔 / 上櫃 ${tpex.size} 檔\n`);
    days.push({ date: iso(d), twse, tpex });
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
  const stocks = new Map(); // code -> {code,name,market,foreign_daily[],dealer_daily[]}
  const ensure = (code, name, market) => {
    if (!stocks.has(code)) {
      stocks.set(code, {
        code, name, market,
        foreign_daily: new Array(days.length).fill(0),
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
      s.dealer_daily[di] = Math.round(v.dealer / 1000);
    }
    for (const [code, v] of day.tpex) {
      const s = ensure(code, v.name, 'TPEX');
      s.foreign_daily[di] = Math.round(v.foreign / 1000);
      s.dealer_daily[di] = Math.round(v.dealer / 1000);
    }
  });

  // 寬鬆預篩:外資與自營商「近期累計皆 > 0」即輸出(最終嚴格條件交給前端)
  const sum = (a) => a.reduce((p, c) => p + c, 0);
  const result = [];
  for (const s of stocks.values()) {
    if (sum(s.foreign_daily) > 0 && sum(s.dealer_daily) > 0) result.push(s);
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
