// 上櫃三大法人買賣超(TPEX dailyTrade)。由 build-data.mjs 的 fetchTPEX 抽出,行為不變。
import { fetchJson } from '../http.mjs';
import { slash } from '../dates.mjs';
import { isCommonStock, toInt } from '../parse.mjs';

// 新站固定 24 欄:0 代號 1 名稱,之後 7 組(各 買/賣/超),最後 1 欄三大法人合計
//   g1 外資不含自營[2-4]  g2 外資自營商[5-7]  g3 外資合計[8-10]
//   g4 投信[11-13]  g5 自營自行[14-16]  g6 自營避險[17-19]  g7 自營合計[20-22]  total[23]
// 回應 → Map<code, {name, foreign, trust, dealer}>(單位:股);無資料(非交易日)回傳 null
export function parseTpexInst(j) {
  const table = j && Array.isArray(j.tables) ? j.tables[0] : null;
  if (!table || !Array.isArray(table.data) || table.data.length === 0) return null;

  const map = new Map();
  let validated = false;
  for (const row of table.data) {
    const code = String(row[0]).trim();
    if (!isCommonStock(code)) continue;

    const g1 = toInt(row[4]), g2 = toInt(row[7]), g3 = toInt(row[10]), g4 = toInt(row[13]);
    const g5 = toInt(row[16]), g6 = toInt(row[19]), g7 = toInt(row[22]), total = toInt(row[23]);

    // 自我驗證一次:外資合計 = 不含自營 + 外資自營商;自營合計 = 自行 + 避險;三大法人合計 = 外資 + 投信 + 自營
    if (!validated) {
      if (g1 + g2 !== g3 || g5 + g6 !== g7 || g3 + g4 + g7 !== total) {
        throw new Error(`TPEX 欄位結構與預期不符 (g1+g2=${g1 + g2} vs g3=${g3}, g5+g6=${g5 + g6} vs g7=${g7}, g3+g4+g7=${g3 + g4 + g7} vs total=${total})。端點可能改版。`);
      }
      validated = true;
    }
    map.set(code, { name: String(row[1]).trim(), foreign: g3, trust: g4, dealer: g7 });
  }
  return map;
}

export async function fetchTpexInst(date) {
  const url = `https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=${slash(date)}&response=json`;
  return parseTpexInst(await fetchJson(url));
}
