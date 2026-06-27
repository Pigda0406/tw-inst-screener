'use strict';

const state = {
  data: null,
  sumDays: 5,
  streakDays: 3,
  markets: { TWSE: true, TPEX: true },
  sortKey: 'foreignSum',
  sortDir: -1, // -1 由大到小
};

const COLS = [
  { key: 'code', label: '代號', num: false },
  { key: 'name', label: '名稱', num: false },
  { key: 'market', label: '市場', num: false },
  { key: 'foreignSum', label: '外資累計', num: true },
  { key: 'dealerSum', label: '自營累計', num: true },
  { key: 'foreignStreak', label: '外資連買', num: true },
  { key: 'dealerStreak', label: '自營連買', num: true },
  { key: 'daily', label: '每日(外資/自營)', num: false, cls: 'daily' },
];

const sum = (a) => a.reduce((p, c) => p + c, 0);
const fmt = (n) => (n > 0 ? '+' : '') + n.toLocaleString('en-US');
function tailStreak(arr) { // 從最後一天往前數連續 > 0 的天數
  let c = 0;
  for (let i = arr.length - 1; i >= 0; i--) { if (arr[i] > 0) c++; else break; }
  return c;
}

async function load() {
  try {
    const r = await fetch('data.json?_=' + Date.now());
    state.data = await r.json();
  } catch (e) {
    document.getElementById('meta').textContent = '無法載入資料(data.json)。' + e;
    return;
  }
  setupControls();
  render();
}

function setupControls() {
  const d = state.data;
  const total = d.trading_days.length;
  const meta = document.getElementById('meta');
  meta.innerHTML =
    `更新時間:<strong>${d.updated_at}</strong>　|　交易日:${d.trading_days.join('、')}`;

  const sumSel = document.getElementById('sumDays');
  const stSel = document.getElementById('streakDays');
  for (let i = 1; i <= total; i++) {
    sumSel.add(new Option(i + ' 日', i, false, i === state.sumDays));
    stSel.add(new Option(i + ' 日', i, false, i === state.streakDays));
  }
  sumSel.onchange = () => { state.sumDays = +sumSel.value; render(); };
  stSel.onchange = () => { state.streakDays = +stSel.value; render(); };
  document.getElementById('mTWSE').onchange = (e) => { state.markets.TWSE = e.target.checked; render(); };
  document.getElementById('mTPEX').onchange = (e) => { state.markets.TPEX = e.target.checked; render(); };
}

function compute() {
  const total = state.data.trading_days.length;
  const sw = Math.min(state.sumDays, total);
  const kw = Math.min(state.streakDays, total);
  const rows = [];
  for (const s of state.data.stocks) {
    if (!state.markets[s.market]) continue;
    const fWin = s.foreign_daily.slice(total - sw);
    const dWin = s.dealer_daily.slice(total - sw);
    const foreignSum = sum(fWin), dealerSum = sum(dWin);
    if (foreignSum <= 0 || dealerSum <= 0) continue;

    const fStreak = tailStreak(s.foreign_daily);
    const dStreak = tailStreak(s.dealer_daily);
    if (fStreak < kw || dStreak < kw) continue; // 兩者都要連買達門檻

    rows.push({
      code: s.code, name: s.name, market: s.market,
      foreignSum, dealerSum, foreignStreak: fStreak, dealerStreak: dStreak,
      foreign_daily: s.foreign_daily, dealer_daily: s.dealer_daily,
    });
  }
  return rows;
}

function render() {
  const rows = compute();
  const { sortKey, sortDir } = state;
  rows.sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (typeof av === 'string') return av.localeCompare(bv) * sortDir;
    return (av - bv) * sortDir;
  });

  // 表頭
  const head = document.getElementById('headRow');
  head.innerHTML = COLS.map((c) => {
    const arrow = c.key === sortKey ? `<span class="arrow">${sortDir < 0 ? '▼' : '▲'}</span>` : '';
    return `<th data-key="${c.key}" class="${c.cls || ''}">${c.label} ${arrow}</th>`;
  }).join('');
  head.querySelectorAll('th').forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.key;
      if (state.sortKey === k) state.sortDir *= -1;
      else { state.sortKey = k; state.sortDir = COLS.find((c) => c.key === k).num ? -1 : 1; }
      render();
    };
  });

  // 內容
  const body = document.getElementById('body');
  body.innerHTML = rows.map((r) => {
    const daily = r.foreign_daily.map((f, i) =>
      `${f}/${r.dealer_daily[i]}`).join(' ');
    return `<tr data-code="${r.code}">
      <td class="code">${r.code}</td>
      <td>${r.name}</td>
      <td><span class="tag">${r.market === 'TWSE' ? '上市' : '上櫃'}</span></td>
      <td class="pos">${fmt(r.foreignSum)}</td>
      <td class="pos">${fmt(r.dealerSum)}</td>
      <td>${r.foreignStreak}</td>
      <td>${r.dealerStreak}</td>
      <td class="daily">${daily}</td>
    </tr>`;
  }).join('');
  body.querySelectorAll('tr').forEach((tr) => {
    tr.onclick = () => window.open(`https://tw.stock.yahoo.com/quote/${tr.dataset.code}`, '_blank');
  });

  document.getElementById('count').textContent = `符合 ${rows.length} 檔`;
  document.getElementById('empty').hidden = rows.length > 0;
}

load();
