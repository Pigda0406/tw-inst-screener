// 上市每日收盤行情(TWSE MI_INDEX, type=ALLBUT0999)。欄位見 specs/endpoints.md。
import { fetchJson } from '../http.mjs';
import { ymd } from '../dates.mjs';
import { isCommonStock, toNum, checkFields, checkDate } from '../parse.mjs';

const FIELDS = { 0: '證券代號', 2: '成交股數', 4: '成交金額', 5: '開盤價', 6: '最高價', 7: '最低價', 8: '收盤價' };

// 回應 → Map<code, {open, high, low, close, volume, value}>(股、元;無成交的價格為 null);無資料回傳 null
export function parseTwsePrice(j, expectDate) {
  if (!j || j.stat !== 'OK') return null;
  if (expectDate) checkDate('twse-price', j.date, expectDate);
  // 表格順序會變,以標題定位
  const table = (j.tables ?? []).find((t) => String(t.title ?? '').includes('每日收盤行情'));
  if (!table) throw new Error('twse-price 找不到「每日收盤行情」表');
  if (!Array.isArray(table.data) || table.data.length === 0) return null;
  checkFields('twse-price', table.fields, FIELDS);

  const map = new Map();
  for (const row of table.data) {
    const code = String(row[0]).trim();
    if (!isCommonStock(code)) continue;
    map.set(code, {
      open: toNum(row[5]), high: toNum(row[6]), low: toNum(row[7]), close: toNum(row[8]),
      volume: toNum(row[2]), value: toNum(row[4]),
    });
  }
  return map;
}

export async function fetchTwsePrice(date) {
  const url = `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=${ymd(date)}&type=ALLBUT0999`;
  return parseTwsePrice(await fetchJson(url), ymd(date));
}
