// 上市融資融券餘額(TWSE MI_MARGN)。欄位名稱重複(融資/融券各一組),只能依位置解析。
import { fetchJson } from '../http.mjs';
import { ymd } from '../dates.mjs';
import { isCommonStock, toNum, checkFields, checkDate } from '../parse.mjs';

// 融資 2 買進 3 賣出 4 現金償還 5 前日餘額 6 今日餘額;融券 8 買進 9 賣出 10 現券償還 11 前日餘額 12 今日餘額
const FIELDS = { 0: '代號', 2: '買進', 3: '賣出', 4: '現金償還', 5: '前日餘額', 6: '今日餘額', 8: '買進', 9: '賣出', 10: '現券償還', 11: '前日餘額', 12: '今日餘額' };

// 回應 → Map<code, {margin_balance, short_balance}>(張);無資料回傳 null
export function parseTwseMargin(j, expectDate) {
  if (!j || j.stat !== 'OK') return null;
  if (expectDate) checkDate('twse-margin', j.date, expectDate);
  const table = (j.tables ?? []).find((t) => String(t.title ?? '').includes('融資融券彙總'));
  if (!table) throw new Error('twse-margin 找不到「融資融券彙總」表');
  if (!Array.isArray(table.data) || table.data.length === 0) return null;
  checkFields('twse-margin', table.fields, FIELDS);

  const map = new Map();
  let validated = false;
  for (const row of table.data) {
    const code = String(row[0]).trim();
    if (!isCommonStock(code)) continue;
    const n = (i) => toNum(row[i]);
    // 自我驗證一次:融資 前日+買進−賣出−現償=今日;融券 前日+賣出−買進−現券償還=今日
    if (!validated) {
      if (n(5) + n(2) - n(3) - n(4) !== n(6) || n(11) + n(9) - n(8) - n(10) !== n(12)) {
        throw new Error(`twse-margin ${code} 餘額勾稽不符,欄位可能錯位。端點可能改版。`);
      }
      validated = true;
    }
    map.set(code, { margin_balance: n(6), short_balance: n(12) });
  }
  return map;
}

export async function fetchTwseMargin(date) {
  const url = `https://www.twse.com.tw/exchangeReport/MI_MARGN?response=json&date=${ymd(date)}&selectType=ALL`;
  return parseTwseMargin(await fetchJson(url), ymd(date));
}
