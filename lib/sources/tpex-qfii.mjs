// 上櫃外資持股與發行股數(TPEX insti/qfii)。代號在 index 1(index 0 是排行),比率是含 % 的字串。
import { fetchJson } from '../http.mjs';
import { ymd, slash } from '../dates.mjs';
import { isCommonStock, toNum, checkFields, checkDate } from '../parse.mjs';

const FIELDS = { 0: '排行', 1: '代號', 3: '發行股數(A)', 5: '僑外資及陸資持有股數(C)', 7: '僑外資及陸資持股比率(E=C/A)' };

// 回應 → Map<code, {issued_shares, foreign_shares, foreign_ratio}>(股、%);無資料回傳 null
export function parseTpexQfii(j, expectDate) {
  const table = j && Array.isArray(j.tables) ? j.tables[0] : null;
  if (!table || !Array.isArray(table.data) || table.data.length === 0) return null;
  if (expectDate) checkDate('tpex-qfii', j.date, expectDate);
  checkFields('tpex-qfii', table.fields, FIELDS);

  const map = new Map();
  for (const row of table.data) {
    const code = String(row[1]).trim();
    if (!isCommonStock(code)) continue;
    map.set(code, { issued_shares: toNum(row[3]), foreign_shares: toNum(row[5]), foreign_ratio: toNum(row[7]) });
  }
  return map;
}

export async function fetchTpexQfii(date) {
  const url = `https://www.tpex.org.tw/www/zh-tw/insti/qfii?date=${slash(date)}&response=json`;
  return parseTpexQfii(await fetchJson(url), ymd(date));
}
