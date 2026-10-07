import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTwsePrice } from '../lib/sources/twse-price.mjs';
import { parseTpexPrice } from '../lib/sources/tpex-price.mjs';
import { parseTwseMargin } from '../lib/sources/twse-margin.mjs';
import { parseTpexMargin } from '../lib/sources/tpex-margin.mjs';
import { parseTwseQfii } from '../lib/sources/twse-qfii.mjs';
import { parseTpexQfii } from '../lib/sources/tpex-qfii.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const D = '20261006';
const priceTable = (j) => j.tables.find((t) => String(t.title ?? '').includes('每日收盤行情'));
const row = (rows, code, at = 0) => rows.find((r) => String(r[at]).trim() === code);

// 預期值直接抄自 fixture 原始字串(2026-10-06 實際回應),不從解析器推導

test('twse-price: 千分位去除、單位為股與元(53,639,152,613 元 ≈ 20,801,802 股 × 2,585)', () => {
  const m = parseTwsePrice(fixture('twse-price.json'), D);
  assert.deepEqual(m.get('2330'), { open: 2575, high: 2590, low: 2565, close: 2585, volume: 20801802, value: 53639152613 });
  for (const code of ['0050', '00878', '00403A']) assert.equal(m.has(code), false, code);
});

test('twse-price: 無成交的 -- 必須是 null 不是 0(0 元收盤會讓報酬率與均線算錯)', () => {
  const j = fixture('twse-price.json');
  const r = row(priceTable(j).data, '1101');
  r[2] = '0'; r[4] = '0'; r[5] = r[6] = r[7] = r[8] = '--';
  assert.deepEqual(parseTwsePrice(j, D).get('1101'), { open: null, high: null, low: null, close: null, volume: 0, value: 0 });
});

test('twse-price: 表格順序變動時仍以標題找到個股表', () => {
  const j = fixture('twse-price.json');
  j.tables.reverse();
  assert.equal(parseTwsePrice(j, D).get('2330').close, 2585);
});

test('tpex-price: 欄位順序和上市不同(收盤在開盤前),不可錯位', () => {
  const m = parseTpexPrice(fixture('tpex-price.json'), D);
  assert.deepEqual(m.get('5347'), { open: 184.5, high: 195, low: 184.5, close: 191, volume: 33208000, value: 6341293500 });
  for (const code of ['006201', '00679B']) assert.equal(m.has(code), false, code);
});

test('tpex-price: 無成交的 ---- 必須是 null', () => {
  const j = fixture('tpex-price.json');
  const r = row(j.tables[0].data, '8299');
  r[2] = r[4] = r[5] = r[6] = '----'; r[7] = '0'; r[8] = '0';
  assert.deepEqual(parseTpexPrice(j, D).get('8299'), { open: null, high: null, low: null, close: null, volume: 0, value: 0 });
});

test('twse-margin: 依位置取「今日餘額」(融資/融券欄名重複),單位為張', () => {
  const m = parseTwseMargin(fixture('twse-margin.json'), D);
  assert.deepEqual(m.get('2330'), { margin_balance: 30500, short_balance: 49 });
  assert.deepEqual(m.get('2317'), { margin_balance: 62211, short_balance: 428 });
  assert.equal(m.has('0050'), false);
});

test('twse-margin: 欄位錯位時餘額勾稽失敗並報錯(拿到「前日餘額」當今日會讓融資變化全錯)', () => {
  const j = fixture('twse-margin.json');
  for (const r of j.tables[1].data) [r[5], r[6]] = [r[6], r[5]];
  assert.throws(() => parseTwseMargin(j, D), /勾稽不符/);
});

test('tpex-margin: 資餘額/券餘額,上櫃融券是券賣在券買前', () => {
  const m = parseTpexMargin(fixture('tpex-margin.json'), D);
  assert.deepEqual(m.get('5347'), { margin_balance: 11777, short_balance: 600 });
  assert.deepEqual(m.get('6488'), { margin_balance: 17671, short_balance: 670 });
});

test('tpex-margin: 券賣/券買對調時勾稽失敗並報錯', () => {
  const j = fixture('tpex-margin.json');
  j.tables[0].fields[11] = '券買'; j.tables[0].fields[12] = '券賣';
  assert.throws(() => parseTpexMargin(j, D), /欄位 11/);
});

test('twse-qfii: 發行股數與外資持股為股,持股比率為 number 型別的 %', () => {
  const m = parseTwseQfii(fixture('twse-qfii.json'), D);
  assert.deepEqual(m.get('2330'), { issued_shares: 25932370067, foreign_shares: 17945787521, foreign_ratio: 69.2 });
});

test('tpex-qfii: 代號在 index 1(index 0 是排行),比率去除 % 且小數位數不固定', () => {
  const m = parseTpexQfii(fixture('tpex-qfii.json'), D);
  assert.deepEqual(m.get('5347'), { issued_shares: 1878502192, foreign_shares: 626247532, foreign_ratio: 33.33 });
  assert.equal(m.get('5276').foreign_ratio, 77); // 原文 "77%"
  assert.equal(m.has('29'), false); // 排行不可被當成代號
});

test('回應日期與要求日期不同時必須報錯(官方偶爾回傳別天資料,存進去會汙染時間序列)', () => {
  assert.throws(() => parseTwsePrice(fixture('twse-price.json'), '20261007'), /不符/);
  assert.throws(() => parseTpexPrice(fixture('tpex-price.json'), '20261007'), /不符/);
  assert.throws(() => parseTwseMargin(fixture('twse-margin.json'), '20261007'), /不符/);
  assert.throws(() => parseTpexMargin(fixture('tpex-margin.json'), '20261007'), /不符/);
  assert.throws(() => parseTwseQfii(fixture('twse-qfii.json'), '20261007'), /不符/);
  assert.throws(() => parseTpexQfii(fixture('tpex-qfii.json'), '20261007'), /不符/);
});

test('尚無資料(非交易日或尚未公布)回傳 null,讓 ingest 記為 empty、下次再補', () => {
  // 形狀取自 2026-10-04(週日)與 2026-10-07 14:00 的實際回應
  assert.equal(parseTwsePrice({ stat: '很抱歉，沒有符合條件的資料!' }, D), null);
  assert.equal(parseTwseMargin({ stat: '很抱歉，沒有符合條件的資料' }, D), null);
  assert.equal(parseTwseQfii({ stat: '查詢日期大於可查詢最大日期，請重新查詢!' }, D), null);
  assert.equal(parseTwseQfii({ stat: 'OK', date: '20261004', data: [] }, D), null);
  const emptyTpex = { stat: 'ok', date: '20261004', tables: [{ title: 'x', data: [] }] };
  for (const parse of [parseTpexPrice, parseTpexMargin, parseTpexQfii]) assert.equal(parse(emptyTpex, D), null);
});

test('欄位改名或位移時報錯,不可默默存錯欄', () => {
  const j = fixture('twse-qfii.json');
  j.fields.splice(4, 1);
  assert.throws(() => parseTwseQfii(j, D), /欄位 5/);
  const p = fixture('tpex-price.json');
  p.tables[0].fields[2] = '開盤 ';
  assert.throws(() => parseTpexPrice(p, D), /欄位 2/);
});
