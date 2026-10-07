// 上櫃融資融券餘額(TPEX margin/balance)。注意融券是「券賣」在「券買」前面,和上市相反。
import { fetchJson } from '../http.mjs';
import { ymd, slash } from '../dates.mjs';
import { isCommonStock, toNum, checkFields, checkDate } from '../parse.mjs';

const FIELDS = { 0: '代號', 2: '前資餘額(張)', 3: '資買', 4: '資賣', 5: '現償', 6: '資餘額', 10: '前券餘額(張)', 11: '券賣', 12: '券買', 13: '券償', 14: '券餘額' };

// 回應 → Map<code, {margin_balance, short_balance}>(張);無資料回傳 null
export function parseTpexMargin(j, expectDate) {
  const table = j && Array.isArray(j.tables) ? j.tables[0] : null;
  if (!table || !Array.isArray(table.data) || table.data.length === 0) return null;
  if (expectDate) checkDate('tpex-margin', j.date, expectDate);
  checkFields('tpex-margin', table.fields, FIELDS);

  const map = new Map();
  let validated = false;
  for (const row of table.data) {
    const code = String(row[0]).trim();
    if (!isCommonStock(code)) continue;
    const n = (i) => toNum(row[i]);
    // 自我驗證一次:融資 前資+資買−資賣−現償=資餘額;融券 前券+券賣−券買−券償=券餘額
    if (!validated) {
      if (n(2) + n(3) - n(4) - n(5) !== n(6) || n(10) + n(11) - n(12) - n(13) !== n(14)) {
        throw new Error(`tpex-margin ${code} 餘額勾稽不符,欄位可能錯位。端點可能改版。`);
      }
      validated = true;
    }
    map.set(code, { margin_balance: n(6), short_balance: n(14) });
  }
  return map;
}

export async function fetchTpexMargin(date) {
  const url = `https://www.tpex.org.tw/www/zh-tw/margin/balance?date=${slash(date)}&response=json`;
  return parseTpexMargin(await fetchJson(url), ymd(date));
}
