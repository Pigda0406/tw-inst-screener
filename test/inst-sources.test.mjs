import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTwseInst } from '../lib/sources/twse-inst.mjs';
import { parseTpexInst } from '../lib/sources/tpex-inst.mjs';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

// 預期值直接抄自 fixture 原始字串(2026-10-06 實際回應),不從解析器推導

test('TWSE: 外資 = 外陸資(不含自營) + 外資自營商,單位為股、千分位已去除', () => {
  const m = parseTwseInst(fixture('twse-inst.json'));
  // 2330:外陸資 -1,672,231、外資自營商 0、投信 154,586、自營商合計 395,975
  assert.deepEqual(m.get('2330'), { name: '台積電', foreign: -1672231, trust: 154586, dealer: 395975 });
});

test('TWSE: 只收普通股,ETF/權證不得混入(否則法人買超排名會被 ETF 洗版)', () => {
  const m = parseTwseInst(fixture('twse-inst.json'));
  for (const code of ['0050', '00878', '00403A', '072756']) assert.equal(m.has(code), false, code);
  assert.ok([...m.keys()].every((c) => /^[1-9]\d{3}$/.test(c)));
});

test('TWSE: 欄位改名時必須報錯,不可默默產生錯誤數字', () => {
  const j = fixture('twse-inst.json');
  j.fields[10] = '投信買賣超';
  assert.throws(() => parseTwseInst(j), /投信買賣超股數/);
});

test('TPEX: 外資/投信/自營取合計欄,單位為股', () => {
  const m = parseTpexInst(fixture('tpex-inst.json'));
  // 5347:外資合計 12,070,915、投信 196,000、自營合計 607,134
  assert.deepEqual(m.get('5347'), { name: '世界', foreign: 12070915, trust: 196000, dealer: 607134 });
  for (const code of ['006201', '00679B', '020025']) assert.equal(m.has(code), false, code);
});

test('TPEX: 非交易日回傳 null(交易日判定以 TPEX 為準,不可回傳空 Map 讓呼叫端誤以為開盤)', () => {
  assert.equal(parseTpexInst(fixture('tpex-inst-holiday.json')), null);
});

test('TPEX: 欄位位移時自我驗證失敗並報錯(端點改版不可默默錯位)', () => {
  const j = fixture('tpex-inst.json');
  for (const row of j.tables[0].data) row.splice(2, 1); // 模擬少一欄
  assert.throws(() => parseTpexInst(j), /欄位結構與預期不符/);
});
