// 上櫃每日收盤行情(TPEX afterTrading/otc)。欄位順序和上市不同:收盤在開盤前面。
import { fetchJson } from '../http.mjs';
import { ymd, slash } from '../dates.mjs';
import { isCommonStock, toNum, checkFields, checkDate } from '../parse.mjs';

const FIELDS = { 0: '代號', 2: '收盤', 4: '開盤', 5: '最高', 6: '最低', 7: '成交股數', 8: '成交金額(元)' };

// 回應 → Map<code, {open, high, low, close, volume, value}>(股、元;無成交的價格為 null);無資料回傳 null
export function parseTpexPrice(j, expectDate) {
  const table = j && Array.isArray(j.tables) ? j.tables[0] : null;
  if (!table || !Array.isArray(table.data) || table.data.length === 0) return null;
  if (expectDate) checkDate('tpex-price', j.date, expectDate);
  checkFields('tpex-price', table.fields, FIELDS);

  const map = new Map();
  for (const row of table.data) {
    const code = String(row[0]).trim();
    if (!isCommonStock(code)) continue;
    map.set(code, {
      open: toNum(row[4]), high: toNum(row[5]), low: toNum(row[6]), close: toNum(row[2]),
      volume: toNum(row[7]), value: toNum(row[8]),
    });
  }
  return map;
}

export async function fetchTpexPrice(date) {
  const url = `https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=${slash(date)}&type=EW&response=json`;
  return parseTpexPrice(await fetchJson(url), ymd(date));
}
