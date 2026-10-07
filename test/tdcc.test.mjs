import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTdccCsv, parseQryForm, parseQryResult, normalizeLevels } from '../lib/sources/tdcc.mjs';
import { openDb, writeTdcc, tdccCodes } from '../lib/db.mjs';

const read = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

// 預期值抄自 fixture 原始內容(2026-10-02 CSV、2026-09-24 查詢頁),並與集保官網查詢結果對照過

test('CSV: 代號去除補位空白、只收普通股,每檔 17 級', () => {
  const { dataDate, stocks, invalid } = parseTdccCsv(read('tdcc.csv'));
  assert.equal(dataDate, '2026-10-02');
  // fixture 是裁剪版,其他代號可能只留下部分分級(會被列為 invalid);2330 的 17 級完整
  assert.ok(stocks.has('2330'));
  assert.equal(invalid.some((x) => x.code === '2330'), false);
  for (const code of ['0050', '00878', '006201']) assert.equal(stocks.has(code), false, code);
  assert.equal(stocks.get('2330').length, 17);
  assert.deepEqual(stocks.get('2330')[14], { level: 15, people: 1485, shares: 21984287365, pct: 84.77 }); // 千張大戶
  assert.deepEqual(stocks.get('2330')[16], { level: 17, people: 3010913, shares: 25932370067, pct: 100 });
});

test('CSV: 第 16 級差異數調整存帶號值(CSV 寫 7900,官網顯示 -7,900),否則大戶比例加總會偏', () => {
  const lv16 = parseTdccCsv(read('tdcc.csv')).stocks.get('2330')[15];
  assert.equal(lv16.shares, -7900);
  assert.equal(lv16.people, 2);
});

test('CSV: 分級加總對不上的個股列入 invalid,不寫入(由 ingest-weekly 決定是否整批放棄)', () => {
  const text = read('tdcc.csv').replace('20261002,2330  ,3,52583,376217285,1.45', '20261002,2330  ,3,52583,376217286,1.45');
  const { stocks, invalid } = parseTdccCsv(text);
  assert.equal(stocks.has('2330'), false);
  assert.equal(invalid[0].code, '2330');
});

test('CSV: 表頭改變時報錯', () => {
  assert.throws(() => parseTdccCsv(read('tdcc.csv').replace('持股分級', '分級')), /表頭不符/);
});

test('查詢頁:取得 token 與可查詢週別(新到舊;9/25 中秋休市所以是 9/24)', () => {
  const { weeks, token } = parseQryForm(read('tdcc-qry-form.html'));
  assert.equal(token, '1fd03d2d-85c6-4d11-9548-df1ac4eea045');
  assert.deepEqual(weeks.slice(0, 3), ['20261002', '20260924', '20260918']);
});

test('查詢結果:民國資料日期轉西元,第 16 級本來就帶負號,驗證通過', () => {
  const r = parseQryResult(read('tdcc-qry-2330.html'));
  assert.equal(r.dataDate, '2026-09-24');
  const n = normalizeLevels(r.levels);
  assert.equal(n.ok, true);
  assert.deepEqual(n.levels[14], { level: 15, people: 1487, shares: 21984569643, pct: 84.77 });
  assert.equal(n.levels[15].shares, -1000);
  assert.equal(n.levels[15].people, 0); // 查詢頁第 16 級人數是空白
});

test('查詢結果:「查無此資料」回傳 null,不是錯誤(例如已下市的代號)', () => {
  const html = read('tdcc-qry-2330.html')
    .replace(/資料日期：[^<]*/, '資料日期：')
    .replace(/<\/thead>[\s\S]*<\/table>/, '</thead><tr><td align="center" colspan="5"><span class="font">查無此資料</span></td></tr></table>');
  assert.equal(parseQryResult(html), null);
});

test('寫入冪等:同一週重寫筆數不變', () => {
  const db = openDb();
  const { dataDate, stocks } = parseTdccCsv(read('tdcc.csv'));
  writeTdcc(db, dataDate, stocks, '2026-10-07 18:00:00');
  writeTdcc(db, dataDate, stocks, '2026-10-07 20:00:00');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tdcc_weekly').get().n, stocks.size * 17);
  assert.deepEqual([...tdccCodes(db, dataDate)].sort(), [...stocks.keys()].sort());
});

test('查詢結果:差異數調整為 0 時頁面省略該列、合計序號變 16,仍須正確對應到第 17 級', () => {
  // 2026-09-24 1101 實測即為此形狀;以 2330 fixture 去掉第 16 列、合計序號改 16 模擬
  const html = read('tdcc-qry-2330.html')
    .replace(/<tr>\s*<td[^>]*>16<\/td>[\s\S]*?<\/tr>/, '')
    .replace(/<td([^>]*)>17<\/td>/, '<td$1>16</td>')
    .replace('21,984,569,643', '21,984,568,643'); // 補回差額,讓加總等於合計
  const r = parseQryResult(html);
  assert.equal(r.levels.length, 17);
  const n = normalizeLevels(r.levels);
  assert.equal(n.ok, true, n.reason);
  assert.equal(n.levels[16].shares, 25932370067);
  assert.equal(n.levels[15].shares, 0);
});
