// 上市三大法人買賣超(TWSE T86)。由 build-data.mjs 的 fetchTWSE 抽出,行為不變。
import { fetchJson, sleep } from '../http.mjs';
import { ymd } from '../dates.mjs';
import { isCommonStock, toInt } from '../parse.mjs';

// 回應 → Map<code, {name, foreign, trust, dealer}>(單位:股)
export function parseTwseInst(j) {
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
  const iTrust = idx('投信買賣超股數');
  const iDealer = idx('自營商買賣超股數');

  const map = new Map();
  for (const row of j.data) {
    const code = String(row[iCode]).trim();
    if (!isCommonStock(code)) continue;
    map.set(code, {
      name: String(row[iName]).trim(),
      foreign: toInt(row[iForeign1]) + toInt(row[iForeign2]),
      trust: toInt(row[iTrust]),
      dealer: toInt(row[iDealer]),
    });
  }
  return map;
}

// 用較穩定的 fund/T86 路徑(rwd/zh 對部分日期會回矛盾錯誤)。
// 取不到(連假或持續失敗)回傳 null。
// 注意:TWSE 偶有「暫時性」失敗(stat 非 OK),故內建多次重試。
export async function fetchTwseInst(date, tries = 4) {
  const url = `https://www.twse.com.tw/fund/T86?response=json&date=${ymd(date)}&selectType=ALL`;
  let j = null;
  for (let i = 0; i < tries; i++) {
    j = await fetchJson(url);
    if (j && j.stat === 'OK' && Array.isArray(j.data) && j.data.length > 0) break;
    j = null;
    await sleep(2500 * (i + 1));   // 暫時性失敗 → 退避後重試
  }
  if (!j) return null;
  return parseTwseInst(j);
}
