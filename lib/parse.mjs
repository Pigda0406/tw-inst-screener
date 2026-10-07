// 各來源共用的解析小工具

// 只保留普通個股:4 位數字、首位非 0(排除 ETF/債/權證等 0050、00679B、6 位權證)
export const isCommonStock = (code) => /^[1-9]\d{3}$/.test(code);

// 字串轉整數:去除千分位逗號/空白,'--'、''、null 視為 0
// (inst 來源沿用的既有行為;價量等來源缺值必須是 null,不可沿用此函式)
export function toInt(v) {
  if (v == null) return 0;
  const s = String(v).replace(/[,\s]/g, '');
  if (s === '' || s === '--' || s === '---') return 0;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? 0 : n;
}

// 字串轉數字,缺值回傳 null(價量/融資/外資持股用;不可把缺值變 0)
// 去除千分位逗號、空白、%;'--'、'---'、'----'、'' 視為缺值;其他無法解析的字串直接報錯(端點改版要大聲失敗)
export function toNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const s = String(v).replace(/[,\s%]/g, '');
  if (s === '' || /^-{2,}$/.test(s)) return null;
  const n = Number(s);
  if (Number.isNaN(n)) throw new Error(`無法解析的數字「${v}」`);
  return n;
}

// 依位置確認欄位名稱(去除 <br> 與空白後比對),不符就報錯,避免欄位位移後默默存錯
export function checkFields(source, fields, expected) {
  const norm = (s) => String(s ?? '').replace(/<br\s*\/?>/gi, '').replace(/\s/g, '');
  for (const [i, name] of Object.entries(expected)) {
    if (norm(fields?.[i]) !== norm(name)) {
      throw new Error(`${source} 欄位 ${i} 應為「${name}」,實際為「${fields?.[i]}」。端點可能改版。`);
    }
  }
}

// 回應的資料日期必須是要求的日期(防止官方把別天的資料回傳)
export function checkDate(source, actual, expected) {
  if (String(actual) !== expected) throw new Error(`${source} 回應日期 ${actual} 與要求日期 ${expected} 不符`);
}
