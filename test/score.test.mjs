import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreStock } from '../lib/score.mjs';

// 典型吸籌:法人緩買 0.8% 股本、13 天買超;大戶連增 3 週、股東人數減、大戶 4 週 +0.6;
// 20 日漲 3%、貼近季線、箱型 12%;量比 1.2;融資 20 日 −6.4%
const accumulation = {
  avg_value_20: 80_000_000,
  inst_net_20_pct: 0.8, inst_buy_days_20: 13, trust_net_20_pct: 0.3,
  big400_up_weeks: 3, holders_chg_4w_pct: -0.021, big400_chg_4w: 0.6, tdcc_weeks: 8,
  ret_20: 0.03, dist_ma60: 0.04, range_20: 0.12,
  vol_ratio: 1.2,
  margin_chg_20: -0.064,
};

test('典型吸籌 → ACCUMULATION,各群組依規格給分', () => {
  const r = scoreStock(accumulation);
  assert.deepEqual(r.breakdown, { inst: 14 + 10, concentration: 15 + 10 + 5, price: 20, volume: 10, margin: 10 });
  assert.equal(r.score, 94);
  assert.equal(r.stage, 'ACCUMULATION');
  for (const s of ['inst_steady_buy', 'trust_buying', 'big_holder_rising', 'holders_declining', 'price_quiet', 'box_compression', 'volume_mild', 'margin_exit']) {
    assert.ok(r.signals.includes(s), s);
  }
  assert.equal(r.signals.some((s) => s.startsWith('missing:') || s === 'tdcc_warming_up'), false);
});

test('法人大買但 20 日已漲 30% → OVERHEATED(不論分數多高,吸籌已經不是「默默」)', () => {
  const r = scoreStock({ ...accumulation, inst_net_20_pct: 3.0, ret_20: 0.30 });
  assert.equal(r.stage, 'OVERHEATED');
  assert.ok(r.signals.includes('overheated'));
  assert.equal(r.signals.includes('price_quiet'), false);
});

test('量比 > 2.5 也是 OVERHEATED', () => {
  assert.equal(scoreStock({ ...accumulation, vol_ratio: 2.6 }).stage, 'OVERHEATED');
});

test('成交值不足 2,000 萬 → EXCLUDED,即使分數很高(小型股籌碼數字容易被少量交易放大)', () => {
  const r = scoreStock({ ...accumulation, avg_value_20: 19_999_999 });
  assert.equal(r.stage, 'EXCLUDED');
  assert.equal(r.score, 94); // 分數照算,保留給回測
});

test('價格資料不足(ret_20 或量比為 null)→ EXCLUDED', () => {
  assert.equal(scoreStock({ ...accumulation, ret_20: null }).stage, 'EXCLUDED');
  assert.equal(scoreStock({ ...accumulation, vol_ratio: null }).stage, 'EXCLUDED');
});

test('集保只有 1 週 → tdcc_warming_up,籌碼集中只拿得到部分分數,缺的特徵標 missing', () => {
  const r = scoreStock({ ...accumulation, big400_up_weeks: null, holders_chg_4w_pct: null, big400_chg_4w: null, tdcc_weeks: 1 });
  assert.ok(r.signals.includes('tdcc_warming_up'));
  assert.ok(r.breakdown.concentration < 30);
  for (const k of ['big400_up_weeks', 'holders_chg_4w_pct', 'big400_chg_4w']) assert.ok(r.signals.includes(`missing:${k}`), k);
  assert.equal(r.score, 94 - 30);
  assert.equal(r.stage, 'ACCUMULATION'); // 其他四群組滿分 64 仍達門檻
});

test('級距邊界:法人 % 與買超天數、量比、融資都依規格的 ≥ / < 判斷', () => {
  const s = (f) => scoreStock({ ...accumulation, ...f }).breakdown;
  assert.equal(s({ inst_net_20_pct: 1.0, inst_buy_days_20: 12 }).inst, 30);
  assert.equal(s({ inst_net_20_pct: 0.19, inst_buy_days_20: 9 }).inst, 0);
  assert.equal(s({ inst_net_20_pct: 0.2, inst_buy_days_20: 10 }).inst, 12);
  assert.equal(s({ vol_ratio: 1.8 }).volume, 10);
  assert.equal(s({ vol_ratio: 0.8 }).volume, 5);
  assert.equal(s({ vol_ratio: 1.81 }).volume, 0);
  assert.equal(s({ margin_chg_20: -0.05 }).margin, 5); // 要 < −5% 才給 10
  assert.equal(s({ margin_chg_20: 0 }).margin, 0);
  assert.equal(s({ big400_up_weeks: 2 }).concentration, 8 + 10 + 5);
  assert.equal(s({ ret_20: -0.06 }).price, 10);
});

test('分數落在 45~59 → WATCH;低於 45 → NEUTRAL', () => {
  // 集保與融資都沒加分:法人 24 + 價格 20 + 量能 10 = 54
  const base = { ...accumulation, big400_up_weeks: 0, holders_chg_4w_pct: 0.01, big400_chg_4w: 0, margin_chg_20: 0.1 };
  const watch = scoreStock(base);
  assert.equal(watch.score, 54);
  assert.equal(watch.stage, 'WATCH');
  const neutral = scoreStock({ ...base, vol_ratio: 2.0 }); // 量能 0 → 44
  assert.equal(neutral.score, 44);
  assert.equal(neutral.stage, 'NEUTRAL');
});
