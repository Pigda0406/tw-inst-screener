// 上市外資持股與發行股數(TWSE MI_QFIIS)。持股比率是 number 不是字串。
import { fetchJson } from '../http.mjs';
import { ymd } from '../dates.mjs';
import { isCommonStock, toNum, checkFields, checkDate } from '../parse.mjs';

const FIELDS = { 0: '證券代號', 3: '發行股數', 5: '全體外資及陸資持有股數', 7: '全體外資及陸資持股比率' };

// 回應 → Map<code, {issued_shares, foreign_shares, foreign_ratio}>(股、%);無資料回傳 null
export function parseTwseQfii(j, expectDate) {
  if (!j || j.stat !== 'OK' || !Array.isArray(j.data) || j.data.length === 0) return null;
  if (expectDate) checkDate('twse-qfii', j.date, expectDate);
  checkFields('twse-qfii', j.fields, FIELDS);

  const map = new Map();
  for (const row of j.data) {
    const code = String(row[0]).trim();
    if (!isCommonStock(code)) continue;
    map.set(code, { issued_shares: toNum(row[3]), foreign_shares: toNum(row[5]), foreign_ratio: toNum(row[7]) });
  }
  return map;
}

export async function fetchTwseQfii(date) {
  const url = `https://www.twse.com.tw/rwd/zh/fund/MI_QFIIS?response=json&date=${ymd(date)}&selectType=ALLBUT0999`;
  return parseTwseQfii(await fetchJson(url), ymd(date));
}
