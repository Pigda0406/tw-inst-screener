// 交易日判定與 TWSE 指紋去重。由 build-data.mjs 的 collectRecentDays 抽出。
import { iso } from './dates.mjs';
import { fetchTwseInst } from './sources/twse-inst.mjs';
import { fetchTpexInst } from './sources/tpex-inst.mjs';

// 計算一份 Map 的「指紋」(外資淨買超總和),用來偵測 TWSE 偶發的重複/錯誤資料
export function fingerprint(map) {
  let fp = 0;
  for (const v of map.values()) fp += v.foreign;
  return fp;
}

// 抓一天的兩市場法人資料。
// 策略:以 TPEX(最穩)判定交易日 → TPEX 有資料才算開盤;該日再抓 TWSE(重試)。
//       必須「兩市場都拿到」才採用此日,任一缺就整天跳過(絕不以 0 填補造成假訊號)。
//       並用指紋去重,擋掉 TWSE 偶爾把別天資料重複回傳的情況(isDupFp 由呼叫端決定比對範圍)。
// 回傳 { status: 'ok' | 'holiday' | 'twse_missing' | 'twse_dup', twse?, tpex?, fp?, error? }
export async function fetchInstDay(d, { isDupFp }) {
  let tpex = null;
  let tpexError = null;
  try { tpex = await fetchTpexInst(d); } catch (e) { tpexError = e; process.stderr.write(`${iso(d)} TPEX 失敗: ${e.message}\n`); }
  if (!tpex || tpex.size === 0) {
    process.stderr.write(`${iso(d)} 非交易日或無上櫃資料,略過\n`);
    return { status: 'holiday', error: tpexError };
  }

  let twse = null;
  let twseError = null;
  try { twse = await fetchTwseInst(d); } catch (e) { twseError = e; process.stderr.write(`${iso(d)} TWSE 失敗: ${e.message}\n`); }
  if (!twse || twse.size === 0) {
    process.stderr.write(`${iso(d)} ⚠ 取不到上市資料,整日跳過(不以 0 填補)\n`);
    return { status: 'twse_missing', tpex, error: twseError };
  }

  const fp = fingerprint(twse);
  if (isDupFp(fp)) {
    process.stderr.write(`${iso(d)} ⚠ 上市資料與其他日重複(指紋 ${fp}),跳過\n`);
    return { status: 'twse_dup', tpex, fp };
  }
  return { status: 'ok', twse, tpex, fp };
}
