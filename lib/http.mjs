// HTTP 工具:統一 UA、全域節流(請求間隔 ≥ 3 秒)、指數退避重試(最多 4 次)
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) tw-inst-screener' };
const MIN_INTERVAL_MS = 3000;
const MAX_TRIES = 4;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 對官方網站要客氣:所有請求共用同一個節流閘,不論來源
let lastRequestAt = 0;
async function throttle() {
  const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

async function withRetry(url, parse, init = {}) {
  let lastErr;
  for (let i = 0; i < MAX_TRIES; i++) {
    try {
      await throttle();
      const r = await fetch(url, { ...init, headers: { ...UA, ...init.headers } });
      return parse(r, await r.text());
    } catch (e) {
      lastErr = e;
      if (i < MAX_TRIES - 1) await sleep(2000 * 2 ** i); // 2s, 4s, 8s
    }
  }
  throw lastErr;
}

export function fetchJson(url) {
  return withRetry(url, (r, text) => {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`非 JSON 回應 (HTTP ${r.status}): ${text.slice(0, 120)}`);
    }
  });
}

export function fetchText(url) {
  return withRetry(url, (r, text) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 120)}`);
    return text;
  });
}

// 需要 POST 或 cookie 的頁面(集保查詢頁):回傳 { text, cookies },cookies 為 set-cookie 的 name=value 陣列
export function fetchPage(url, init = {}) {
  return withRetry(url, (r, text) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 120)}`);
    return { text, cookies: r.headers.getSetCookie().map((c) => c.split(';')[0]) };
  }, init);
}
