// 集保股權分散表。兩個來源:
//   1. 開放資料 CSV(getOD.ashx?id=1-5):只有最新一週,全部代號一次下載。ingest-weekly 使用。
//   2. 官網查詢頁(smWeb/qryStock):約一年歷史,但一次只能查一檔一週,回傳 HTML。回補歷史用。
// 分級定義見 specs/endpoints.md。第 16 級(差異數調整)兩個來源的正負號寫法不同,
// 一律存「真實帶號值」= 第 17 級 − Σ 第 1~15 級(與集保官網顯示一致,例如 2330 為 -7,900)。
import { fetchText, fetchPage } from '../http.mjs';
import { isCommonStock, toNum } from '../parse.mjs';

const CSV_URL = 'https://opendata.tdcc.com.tw/getOD.ashx?id=1-5';
const QRY_URL = 'https://www.tdcc.com.tw/portal/zh/smWeb/qryStock';

const isoOf = (yyyymmdd) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

// levels: 長度 17 的陣列,levels[i] = { level: i+1, people, shares, pct }
// 第 16 級改成帶號值後,驗證 Σshares(1..16) == shares(17)、Σpeople(1..15) == people(17)
export function normalizeLevels(levels) {
  if (levels.length !== 17 || levels.some((l, i) => l.level !== i + 1)) return { ok: false, reason: '分級不是 1~17' };
  const sum = (key, to) => levels.slice(0, to).reduce((a, l) => a + l[key], 0);
  const total = levels[16];
  const adj = total.shares - sum('shares', 15);
  const out = levels.map((l) => ({ ...l }));
  out[15].shares = adj;
  out[15].pct = Math.sign(adj) * Math.abs(levels[15].pct);
  if (Math.abs(levels[15].shares) !== Math.abs(adj)) return { ok: false, reason: `第 16 級 ${levels[15].shares} 與差額 ${adj} 不符`, levels: out };
  if (sum('people', 15) !== total.people) return { ok: false, reason: `人數合計 ${sum('people', 15)} ≠ 第 17 級 ${total.people}`, levels: out };
  return { ok: true, levels: out };
}

// CSV → { dataDate: 'YYYY-MM-DD', stocks: Map<code, levels>, invalid: [{code, reason}] };只收普通股
export function parseTdccCsv(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(',').map((s) => s.trim());
  const expected = ['資料日期', '證券代號', '持股分級', '人數', '股數', '占集保庫存數比例%'];
  if (header.join() !== expected.join()) throw new Error(`tdcc CSV 表頭不符: ${header.join(',')}`);

  const dates = new Set();
  const raw = new Map();
  for (const line of lines.slice(1)) {
    const [date, rawCode, level, people, shares, pct] = line.split(',');
    const code = rawCode.trim();
    if (!isCommonStock(code)) continue;
    dates.add(date.trim());
    if (!raw.has(code)) raw.set(code, []);
    raw.get(code).push({ level: Number(level), people: toNum(people), shares: toNum(shares), pct: toNum(pct) });
  }
  if (dates.size !== 1) throw new Error(`tdcc CSV 資料日期不只一個: ${[...dates].join(',')}`);

  const stocks = new Map();
  const invalid = [];
  for (const [code, levels] of raw) {
    levels.sort((a, b) => a.level - b.level);
    const r = normalizeLevels(levels);
    if (r.ok) stocks.set(code, r.levels);
    else invalid.push({ code, reason: r.reason });
  }
  return { dataDate: isoOf([...dates][0]), stocks, invalid };
}

export async function fetchTdccCsv() {
  return parseTdccCsv(await fetchText(CSV_URL));
}

// ---- 官網查詢頁(HTML)----

const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, '');

// 查詢頁 → { weeks: ['YYYYMMDD', ...](新到舊), token }
export function parseQryForm(html) {
  const token = html.match(/name="SYNCHRONIZER_TOKEN" value="([^"]+)"/)?.[1];
  const sel = html.match(/<select[^>]*id="scaDate"[^>]*>([\s\S]*?)<\/select>/)?.[1] ?? '';
  const weeks = [...sel.matchAll(/value="(\d{8})"/g)].map((m) => m[1]);
  if (!token || weeks.length === 0) throw new Error('tdcc 查詢頁找不到 token 或資料日期選單。網站可能改版。');
  return { weeks, token };
}

// 查詢結果 → { dataDate, levels } ;查無資料回傳 null
export function parseQryResult(html) {
  const roc = html.match(/資料日期：(\d+)年(\d+)月(\d+)日/);
  const table = [...html.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)]
    .map((m) => [...m[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) => [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => strip(c[1]))))
    .find((rows) => rows[0]?.[1] === '持股/單位數分級');
  if (!table || html.includes('查無此資料')) return null;
  if (!roc) throw new Error('tdcc 查詢結果找不到資料日期');
  const dataDate = `${Number(roc[1]) + 1911}-${roc[2]}-${roc[3]}`;
  // 差異數調整為 0 時,頁面整列省略、「合計」的序號變成 16,所以依名稱判斷級別,不信任序號
  const levels = table.slice(1).map((r) => ({
    level: r[1] === '合計' ? 17 : r[1].startsWith('差異數調整') ? 16 : Number(r[0]),
    people: toNum(r[2]) ?? 0, shares: toNum(r[3]), pct: toNum(r[4]),
  }));
  if (!levels.some((l) => l.level === 16)) levels.splice(15, 0, { level: 16, people: 0, shares: 0, pct: 0 });
  return { dataDate, levels };
}

// 查詢頁需要 session cookie 與每次更新的 SYNCHRONIZER_TOKEN
export async function openTdccSession() {
  let cookie = '';
  let state;
  const load = async () => {
    const r = await fetchPage(QRY_URL);
    cookie = r.cookies.join('; ');
    state = parseQryForm(r.text);
  };
  await load();

  // 查一檔一週。回傳 { levels } 或 null(查無資料);資料日期不符或驗證失敗會報錯
  async function query(code, week) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const body = new URLSearchParams({
        method: 'submit', firDate: state.weeks[0], scaDate: week, sqlMethod: 'StockNo', stockNo: code, stockName: '',
        SYNCHRONIZER_TOKEN: state.token, SYNCHRONIZER_URI: '/portal/zh/smWeb/qryStock',
      });
      const r = await fetchPage(QRY_URL, { method: 'POST', body, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' } });
      const next = r.text.match(/name="SYNCHRONIZER_TOKEN" value="([^"]+)"/)?.[1];
      if (!next) { await load(); continue; } // session 失效 → 重新取得後再試一次
      state.token = next;
      const res = parseQryResult(r.text);
      if (!res) return null;
      if (res.dataDate !== isoOf(week)) throw new Error(`tdcc ${code} 回應日期 ${res.dataDate} 與要求 ${isoOf(week)} 不符`);
      const n = normalizeLevels(res.levels);
      if (!n.ok) throw new Error(`tdcc ${code} ${week} 驗證失敗: ${n.reason}`);
      return { levels: n.levels };
    }
    throw new Error(`tdcc ${code} ${week} session 重建後仍失敗`);
  }
  return { weeks: () => state.weeks, query };
}
