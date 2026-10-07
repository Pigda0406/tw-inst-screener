import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, writeInstDay, hasTwseFp, completeDates } from '../lib/db.mjs';

const day = (twse, tpex, fp = 1) => ({ twse: new Map(Object.entries(twse)), tpex: new Map(Object.entries(tpex)), fp });
const v = (name, foreign, trust = 0, dealer = 0) => ({ name, foreign, trust, dealer });
const count = (db, t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;

test('同一天重跑不重複寫入,數值以最新抓到的為準(18:00 與 20:00 兩次排程都可能寫同一天)', () => {
  const db = openDb();
  writeInstDay(db, '2026-10-06', day({ 2330: v('台積電', -100) }, { 5347: v('世界', 200) }));
  writeInstDay(db, '2026-10-06', day({ 2330: v('台積電', -100) }, { 5347: v('世界', 200) }));
  assert.equal(count(db, 'inst_daily'), 2);
  assert.equal(count(db, 'stocks'), 2);
  assert.equal(count(db, 'trading_days'), 1);

  writeInstDay(db, '2026-10-06', day({ 2330: v('台積電', -999) }, { 5347: v('世界', 200) }));
  assert.equal(db.prepare("SELECT foreign_net FROM inst_daily WHERE code = '2330'").get().foreign_net, -999);
  assert.deepEqual([...completeDates(db)], ['2026-10-06']);
});

test('backfill 舊日期不可蓋掉較新的股票名稱(公司改名後應顯示新名)', () => {
  const db = openDb();
  writeInstDay(db, '2026-10-06', day({ 1234: v('新名', 1) }, {}));
  writeInstDay(db, '2026-09-01', day({ 1234: v('舊名', 1) }, {}, 2));
  assert.equal(db.prepare("SELECT name FROM stocks WHERE code = '1234'").get().name, '新名');
  writeInstDay(db, '2026-10-07', day({ 1234: v('更新名', 1) }, {}, 3));
  assert.equal(db.prepare("SELECT name FROM stocks WHERE code = '1234'").get().name, '更新名');
});

test('TWSE 指紋只跟「其他日期」比對:別天相同代表重複資料,同一天重跑不算', () => {
  const db = openDb();
  writeInstDay(db, '2026-10-05', day({ 2330: v('台積電', 1) }, {}, 777));
  assert.equal(hasTwseFp(db, 777, '2026-10-06'), true);
  assert.equal(hasTwseFp(db, 777, '2026-10-05'), false);
  assert.equal(hasTwseFp(db, 778, '2026-10-06'), false);
});

test('寫入中途失敗整批 rollback,該日不可被標成完整(否則之後永遠不會補抓)', () => {
  const db = openDb();
  const bad = day({ 2330: v('台積電', 1), 9999: v(null, 1) }, {}); // name NOT NULL → 第二筆失敗(整數 key 依數值排序)
  assert.throws(() => writeInstDay(db, '2026-10-06', bad));
  assert.equal(count(db, 'inst_daily'), 0);
  assert.equal(completeDates(db).size, 0);
});
