// SQLite 存取:開檔、套 schema、upsert helper、交易。使用內建 node:sqlite(Node ≥ 22.13)。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');

export function openDb(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  return db;
}

// fn 內任何例外 → 整批 rollback 並往上拋
export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// 產生 INSERT ... ON CONFLICT(keys) DO UPDATE 的 statement;run(obj) 以欄位名稱綁定
export function upsertStmt(db, table, cols, keys) {
  const sets = cols.filter((c) => !keys.includes(c)).map((c) => `${c} = excluded.${c}`);
  const stmt = db.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')})
     ON CONFLICT (${keys.join(', ')}) DO UPDATE SET ${sets.join(', ')}`,
  );
  return { run: (row) => stmt.run(row) };
}

export function logIngest(db, { source, date = null, status, rows = null, message = null }) {
  db.prepare('INSERT INTO ingest_log (source, date, status, rows, message) VALUES (?, ?, ?, ?, ?)')
    .run(source, date, status, rows, message);
}

// 兩市場都已寫入的日期
export function completeDates(db) {
  return new Set(db.prepare('SELECT date FROM trading_days WHERE twse_ok = 1 AND tpex_ok = 1').all().map((r) => r.date));
}

// 其他日期是否已有相同的 TWSE 指紋(代表 TWSE 把別天的資料重複回傳)
export function hasTwseFp(db, fp, exceptDate) {
  return !!db.prepare('SELECT 1 FROM trading_days WHERE twse_fp = ? AND date <> ?').get(fp, exceptDate);
}

// 寫入一天的法人資料(兩市場已到齊)。同一天重跑結果相同。
// stocks 的名稱/市場只會被「同一天或更新」的資料覆寫,避免 backfill 舊日期蓋掉新名稱。
export function writeInstDay(db, date, { twse, tpex, fp }) {
  const stock = db.prepare(
    `INSERT INTO stocks (code, name, market, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (code) DO UPDATE SET name = excluded.name, market = excluded.market, updated_at = excluded.updated_at
     WHERE excluded.updated_at >= stocks.updated_at`,
  );
  const inst = upsertStmt(db, 'inst_daily', ['date', 'code', 'foreign_net', 'trust_net', 'dealer_net'], ['date', 'code']);
  const day = upsertStmt(db, 'trading_days', ['date', 'twse_ok', 'tpex_ok', 'twse_fp'], ['date']);

  return tx(db, () => {
    for (const [market, map] of [['TWSE', twse], ['TPEX', tpex]]) {
      for (const [code, v] of map) {
        stock.run(code, v.name, market, date);
        inst.run({ date, code, foreign_net: v.foreign, trust_net: v.trust, dealer_net: v.dealer });
      }
    }
    day.run({ date, twse_ok: 1, tpex_ok: 1, twse_fp: fp });
    return { twse: twse.size, tpex: tpex.size };
  });
}
