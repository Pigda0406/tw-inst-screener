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
