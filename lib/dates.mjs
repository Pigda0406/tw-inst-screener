// 日期工具。所有日期以 Asia/Taipei 為準。
export const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;       // TWSE: 20260626
export const slash = (d) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;   // TPEX 新站: 2026/06/26
export const roc = (d) => `${d.getFullYear() - 1911}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`; // TPEX 舊站: 115/06/26
export const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;     // 顯示/DB: 2026-06-26

// 台北時間的「今天」,回傳本地時區 00:00 的 Date(之後一律用本地 getter 取年月日)
export function todayTaipei() {
  const [y, m, d] = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' }).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export const isWeekend = (d) => d.getDay() === 0 || d.getDay() === 6;

// 台北時間的現在,'YYYY-MM-DD HH:MM:SS'(集保 fetched_at 用,回測時對齊公布時點)
export const nowTaipei = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' });
