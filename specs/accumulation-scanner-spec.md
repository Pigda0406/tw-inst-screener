# SPEC：主力吸籌掃描器（Accumulation Scanner）v1

> 專案：`tw-inst-screener`（weiyungwu/tw-inst-screener）
> 版本：v1.0 草案 · 2026-10-07
> 執行者：Claude Code
> 本文件是實作規格。請**依 Phase 順序**實作，每個 Phase 完成後停下來回報，等使用者確認再繼續。

---

## 0. 給 Claude Code 的執行規則（必讀）

1. **開新分支** `feat/accumulation-scanner`，不要直接改 `master`（push 到 master 會自動部署到 Cloudflare）。
2. **不可破壞現有功能**：
   - `scripts/build-data.mjs` → `docs/data.json` → 現有「法人同步買超」頁面，必須維持原本的行為。
   - `docs/index.html`、`docs/app.js` 只允許加一個連到新頁面的連結，不要修改篩選邏輯。
   - `worker/index.js` 的 `/data.json` 和 `scheduled()` 行為保持不變，只能**新增**路由。
3. **runtime 零 npm 依賴**，沿用現有專案風格：Node 內建 `fetch`、`node:sqlite`、`node:test`。`wrangler` 只作為部署工具。
4. **Node 版本 ≥ 22.13**，因為需要不帶 flag 的 `node:sqlite`。開工前先執行 `node -e "require('node:sqlite')"` 確認；不支援就停下回報，**不要自行改用 better-sqlite3**。
5. **資料正確性優先於完整性**（沿用現有原則）：
   - 抓不到的資料**不准用 0 填補**。缺漏就記錄缺漏，計算時把該特徵標為不可用。
   - 交易日判定和 TWSE 重複資料的指紋去重，沿用 `build-data.mjs` 現有邏輯（抽成共用模組）。
6. **所有日期以 Asia/Taipei 為準**。排程和腳本執行時都設定 `TZ=Asia/Taipei`。
7. **對官方網站要客氣**：TWSE 和 TPEx 的請求間隔 ≥ 3 秒，失敗以指數退避重試，最多 4 次。backfill 時尤其要遵守，否則 IP 會被封鎖。
8. **任何官方端點的實際欄位跟本文件不符時**，以實測結果為準，更新 `specs/endpoints.md`，並在回報中說明差異。
9. 不 commit 任何資料檔，包括 `*.sqlite` 和 `data/` 底下的檔案。
10. 每個 Phase 一個 commit，訊息格式：`feat(scanner): P<n> <摘要>`。

---

## 1. 背景與目標

### 1.1 現況
- 每次執行都從零重抓最近 10 個交易日的三大法人買賣超（TWSE T86 和 TPEx dailyTrade），在前端篩出「勾選的法人各自連續買超」的個股。
- **沒有任何歷史資料**：每次都從頭抓，不累積。
- 部署方式：GitHub Actions（由 Cloudflare Cron 準時觸發）→ `data.json` 上傳 R2 → Cloudflare Worker 提供靜態頁和 `/data.json`。

### 1.2 目標
新增一個「**主力默默吸籌**」掃描器。每個交易日收盤後自動產出候選清單，判斷依據是四類訊號同時成立：

| 層 | 問題 | 資料 |
|---|---|---|
| L1 法人流量 | 外資和投信是否持續、溫和地淨買？ | 三大法人買賣超、外資持股 |
| L2 籌碼集中 | 大戶持股比例上升、股東人數下降？ | 集保股權分散表（每週） |
| L3 價量行為 | 價格還沒噴、量能溫和、波動收斂？ | 每日收盤行情 |
| L4 信用 | 融資有沒有退場？ | 融資融券餘額 |

最後輸出分數和階段分類。結果放在網頁，也透過 API 提供給 Hermes Agent 使用。

### 1.3 非目標（v1 不做）
- 券商分點資料（需要 FinMind Sponsor 付費，留到 P7）。
- 洗盤、出貨的細分類（v1 只分四類，見 §7）。
- 自動下單或任何交易功能。
- 回測框架（v1 只保存特徵歷史，供日後回測使用）。

---

## 2. 架構

### 2.1 決策紀錄
**歷史資料庫採用「SQLite 檔案存在 R2」，不用 D1。** 理由如下：
- 評分在 GitHub Actions 裡跑，需要一次讀出約 60～120 天乘以約 1,800 檔的資料。如果用 D1，就得走 HTTP API 分頁拉資料，比較麻煩。
- `node:sqlite` 是內建模組，維持零依賴，而且本機開發和 CI 環境完全一致。
- 資料量小：120 天、約 1,800 檔、6 張表，估計小於 100 MB。
- 風險和對策：上傳失敗時當天資料會遺失。但 ingest 是冪等的，下次執行會自動補抓缺漏日；集保資料無法回補，所以另外做每週備份（§9.3）。

### 2.2 資料流
```
Cloudflare Cron（週一至五 台北 18:00 / 20:00）→ GitHub Actions workflow_dispatch
  └─ job: build
       1. 從 R2 下載 db/history.sqlite（不存在就建新檔）
       2. node scripts/ingest-daily.mjs     # 法人、收盤行情、融資、外資持股 → upsert
       3. node scripts/ingest-weekly.mjs    # 集保分散表（有新資料日期才寫入）
       4. node scripts/score.mjs            # 特徵 → 分數 → docs/scan.json、features/*.json
       5. node scripts/build-data.mjs       # 既有流程，保持不動
       6. 上傳到 R2：db/history.sqlite、scan.json、features/*.json、data.json
       7. 週六（或當週第一次抓到新集保資料時）額外備份 db
Cloudflare Worker
  ├─ /data.json              （既有）
  ├─ /scan.json              （新）R2 → 回傳
  ├─ /api/scan               （新）讀 scan.json，支援篩選參數
  └─ /api/stock/:code        （新）讀 features/<分片>.json，回傳單檔明細
docs/
  ├─ index.html、app.js      （既有，只加導覽連結）
  └─ scan.html、scan.js      （新）吸籌掃描頁
```

### 2.3 目錄結構（目標）
```
lib/
  http.mjs          # fetchJson、fetchText（含重試、退避、UA、節流）
  dates.mjs         # pad、ymd、slash、iso、民國日期、Asia/Taipei 今日
  calendar.mjs      # 交易日判定（以 TPEx 為準）、TWSE 指紋去重
  db.mjs            # 開檔、套 schema、upsert helper、交易
  sources/
    twse-inst.mjs   # 由 build-data.mjs 的 fetchTWSE 抽出（行為不變）
    tpex-inst.mjs   # 由 build-data.mjs 的 fetchTPEX 抽出（行為不變）
    twse-price.mjs  # 上市每日收盤行情
    tpex-price.mjs  # 上櫃每日收盤行情
    twse-margin.mjs # 上市融資融券
    tpex-margin.mjs # 上櫃融資融券
    twse-qfii.mjs   # 上市外資持股、發行股數
    tpex-qfii.mjs   # 上櫃外資持股、發行股數
    tdcc.mjs        # 集保股權分散表
  features.mjs      # 純函式：由時間序列算特徵
  score.mjs         # 純函式：特徵 → 分數、階段、訊號
scripts/
  build-data.mjs    # 改成 import lib/sources/*，輸出必須跟改之前完全一致
  probe.mjs         # P0：探測所有端點並印出欄位
  ingest-daily.mjs
  ingest-weekly.mjs
  backfill.mjs
  score.mjs
  verify-scan.mjs   # 印出今日候選清單與統計（自我檢查用）
db/schema.sql
specs/
  accumulation-scanner-spec.md   # 本文件
  endpoints.md                   # P0 產出：各端點實測欄位
test/
  fixtures/*.json                # 各端點的實際回應樣本（P0 存下）
  *.test.mjs                     # node --test
docs/scan.html、docs/scan.js
```

---

## 3. 資料來源

> **狀態說明**：✅ 已在現有程式碼或實測中驗證；🔍 需要 P0 實測確認 URL 和欄位。

| 代碼 | 內容 | 頻率 | 端點（候選） | 狀態 |
|---|---|---|---|---|
| twse-inst | 上市三大法人買賣超 | 日 | `https://www.twse.com.tw/fund/T86?response=json&date=YYYYMMDD&selectType=ALL` | ✅ 現有程式碼 |
| tpex-inst | 上櫃三大法人買賣超 | 日 | `https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=YYYY/MM/DD&response=json` | ✅ 現有程式碼 |
| twse-price | 上市每日收盤行情（全部個股） | 日 | `https://www.twse.com.tw/exchangeReport/MI_INDEX?response=json&date=YYYYMMDD&type=ALLBUT0999` | 🔍 |
| tpex-price | 上櫃每日收盤行情 | 日 | 候選：`https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=YYYY/MM/DD&type=EW&response=json` | 🔍 |
| twse-margin | 上市融資融券餘額 | 日 | `https://www.twse.com.tw/exchangeReport/MI_MARGN?response=json&date=YYYYMMDD&selectType=ALL` | 🔍 |
| tpex-margin | 上櫃融資融券餘額 | 日 | 候選：`https://www.tpex.org.tw/www/zh-tw/margin/balance?date=YYYY/MM/DD&response=json` | 🔍 |
| twse-qfii | 上市外資持股與發行股數 | 日 | `https://www.twse.com.tw/rwd/zh/fund/MI_QFIIS?response=json&date=YYYYMMDD&selectType=ALLBUT0999` | 🔍（voidful/tw-institutional-stocker 用 csv 版有效） |
| tpex-qfii | 上櫃外資持股與發行股數 | 日 | 候選：`https://www.tpex.org.tw/www/zh-tw/insti/qfii?date=YYYY/MM/DD&response=json`；舊版 `.../web/stock/3insti/qfii/qfii_result.php?d=民國日期&l=zh-tw&o=data` | 🔍 |
| tdcc | 集保股權分散表 | 週 | `https://opendata.tdcc.com.tw/getOD.ashx?id=1-5`（CSV，**只有最新一週**） | ✅ 2026-10-07 實測 |

### 3.1 集保 CSV 格式（已實測）
```
資料日期,證券代號,持股分級,人數,股數,占集保庫存數比例%
20261002,000218,15,1,422278902,100.00
```
- `資料日期` 是 YYYYMMDD，為該週結算日（通常是週五）。
- 持股分級共 17 級。**P0 必須對照集保官網的定義表確認**，以下為預期的對應：

| 分級 | 股數區間 | 分級 | 股數區間 |
|---|---|---|---|
| 1 | 1–999 | 9 | 50,001–100,000 |
| 2 | 1,000–5,000 | 10 | 100,001–200,000 |
| 3 | 5,001–10,000 | 11 | 200,001–400,000 |
| 4 | 10,001–15,000 | 12 | 400,001–600,000 |
| 5 | 15,001–20,000 | 13 | 600,001–800,000 |
| 6 | 20,001–30,000 | 14 | 800,001–1,000,000 |
| 7 | 30,001–40,000 | 15 | 1,000,001 以上 |
| 8 | 40,001–50,000 | 16 | 差異數調整（**計算時排除**） |
|   |   | 17 | 合計 |

- 定義：**大戶 400 張以上** = 第 12～15 級；**千張大戶** = 第 15 級；**散戶 50 張以下** = 第 1～8 級；**總股東人數** = 第 17 級的 `人數`。
- **集保歷史無法免費回補**：系統上線後才開始累積，L2 訊號至少需要 4 週暖機。選配：使用者提供 `FINMIND_TOKEN`（Backer 方案）時，`backfill.mjs --tdcc-finmind` 可用 FinMind 的 `TaiwanStockHoldingSharesPer` 回補（見 P7）。

### 3.2 個股範圍
- 沿用 `isCommonStock`：`/^[1-9]\d{3}$/`，只收 4 位數、首位非 0 的普通股，排除 ETF、權證、債券。
- 流動性門檻（只在評分時套用，資料照常儲存）：20 日平均成交值 ≥ NT$20,000,000。

---

## 4. 資料庫 Schema（`db/schema.sql`）

單位約定：**股數一律存「股」**，顯示時再換算成張。價格存元，比例存百分比數值（例如 12.34 代表 12.34%）。

```sql
PRAGMA journal_mode = WAL;

-- 交易日曆（由 calendar.mjs 判定；兩市場都拿到才算完整）
CREATE TABLE IF NOT EXISTS trading_days (
  date        TEXT PRIMARY KEY,          -- 'YYYY-MM-DD'
  twse_ok     INTEGER NOT NULL DEFAULT 0,
  tpex_ok     INTEGER NOT NULL DEFAULT 0,
  twse_fp     INTEGER,                   -- T86 指紋（外資淨買超總和）
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS stocks (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  market      TEXT NOT NULL CHECK (market IN ('TWSE','TPEX')),
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inst_daily (
  date         TEXT NOT NULL,
  code         TEXT NOT NULL,
  foreign_net  INTEGER NOT NULL,          -- 外資含陸資＋外資自營商（股）
  trust_net    INTEGER NOT NULL,          -- 投信（股）
  dealer_net   INTEGER NOT NULL,          -- 自營商合計（股）
  PRIMARY KEY (date, code)
);

CREATE TABLE IF NOT EXISTS price_daily (
  date     TEXT NOT NULL,
  code     TEXT NOT NULL,
  open     REAL, high REAL, low REAL, close REAL,  -- 無成交時為 NULL，不填 0
  volume   INTEGER,                                -- 成交股數
  value    INTEGER,                                -- 成交金額（元）
  PRIMARY KEY (date, code)
);

CREATE TABLE IF NOT EXISTS margin_daily (
  date            TEXT NOT NULL,
  code            TEXT NOT NULL,
  margin_balance  INTEGER,               -- 融資餘額（張，官方單位）
  short_balance   INTEGER,               -- 融券餘額（張）
  PRIMARY KEY (date, code)
);

CREATE TABLE IF NOT EXISTS qfii_daily (
  date            TEXT NOT NULL,
  code            TEXT NOT NULL,
  issued_shares   INTEGER,               -- 發行股數（股）
  foreign_shares  INTEGER,
  foreign_ratio   REAL,                  -- %
  PRIMARY KEY (date, code)
);

CREATE TABLE IF NOT EXISTS tdcc_weekly (
  data_date  TEXT NOT NULL,              -- 集保資料日期 'YYYY-MM-DD'
  code       TEXT NOT NULL,
  level      INTEGER NOT NULL,           -- 1..17
  people     INTEGER NOT NULL,
  shares     INTEGER NOT NULL,
  pct        REAL NOT NULL,
  fetched_at TEXT NOT NULL,              -- 實際抓到的時間（回測時用來對齊公布時點）
  PRIMARY KEY (data_date, code, level)
);

-- 每日掃描結果（保存全部個股的特徵，供日後回測與調權重）
CREATE TABLE IF NOT EXISTS scan_daily (
  date       TEXT NOT NULL,
  code       TEXT NOT NULL,
  score      INTEGER NOT NULL,
  stage      TEXT NOT NULL,
  features   TEXT NOT NULL,              -- JSON
  signals    TEXT NOT NULL,              -- JSON array
  PRIMARY KEY (date, code)
);

CREATE TABLE IF NOT EXISTS ingest_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at    TEXT NOT NULL DEFAULT (datetime('now')),
  source    TEXT NOT NULL,
  date      TEXT,
  status    TEXT NOT NULL CHECK (status IN ('ok','empty','error','skipped')),
  rows      INTEGER,
  message   TEXT
);

CREATE INDEX IF NOT EXISTS idx_inst_code   ON inst_daily(code, date);
CREATE INDEX IF NOT EXISTS idx_price_code  ON price_daily(code, date);
CREATE INDEX IF NOT EXISTS idx_margin_code ON margin_daily(code, date);
CREATE INDEX IF NOT EXISTS idx_qfii_code   ON qfii_daily(code, date);
CREATE INDEX IF NOT EXISTS idx_tdcc_code   ON tdcc_weekly(code, data_date);
```

寫入規則：
- 一律使用 `INSERT ... ON CONFLICT DO UPDATE`（upsert），**同一天重跑結果必須相同**（冪等）。
- 每個來源、每一天整批包在一個 transaction 裡。解析失敗就整批 rollback，並寫一筆 `ingest_log`（status='error'）。

---

## 5. Ingest 流程

### 5.1 `ingest-daily.mjs`
1. 開啟 DB 並套用 schema。
2. 決定要抓的日期：今天（台北時間）往回 14 個日曆天之內，所有尚未在 `trading_days` 標記完整的平日，再加上各來源在近 14 天內缺漏的日期。這讓 18:00 的排程失敗時，20:00 的排程可以補上；第二次執行時沒有缺漏就幾乎不發請求。
3. 每個日期依序處理：
   1. `tpex-inst`：沒有資料就視為非交易日，跳過該日（沿用現有邏輯）。
   2. `twse-inst`：失敗或指紋重複就跳過該日（沿用現有邏輯）。
   3. 兩者都成功才寫入 `inst_daily`、`stocks`、`trading_days`。
   4. 接著抓 price、margin、qfii，四個來源**各自獨立**：任一失敗只記 log，不影響其他來源。
4. 請求之間至少間隔 3 秒。
5. 結束時印出摘要：各來源各日的筆數或錯誤。

### 5.2 `ingest-weekly.mjs`
1. 下載 TDCC CSV。
2. 讀出 `資料日期`。如果 `tdcc_weekly` 已經有這個日期，就記 `skipped` 後結束。
3. 只保留 `isCommonStock` 的代號，寫入 17 個分級，`fetched_at` 填當下時間。
4. 驗證：每檔第 17 級的 `pct` 應接近 100；第 1～15 級的 `shares` 加總應等於第 17 級（容許差異來自第 16 級）。不符的比例超過 1% 就整批放棄，並記錄錯誤。
5. 每天執行都可以，大多數日子會直接 `skipped`。

### 5.3 `backfill.mjs`
- 參數：`--days 60`（預設 60 個交易日）、`--sources inst,price,margin,qfii`、`--from YYYY-MM-DD --to YYYY-MM-DD`。
- **在本機手動執行一次**，間隔 3 秒。預估請求數約為 60 天 × 8 個來源 ≈ 480 次，耗時約 25～30 分鐘。
- 已經存在的日期和來源直接跳過，可以中斷後續跑。
- 跑完後提示使用者執行：
  `npx wrangler r2 object put tw-stocks-data/db/history.sqlite --file data/history.sqlite --remote`

---

## 6. 特徵計算（`lib/features.mjs`）

**以交易日序列為軸**（取 `trading_days` 中兩市場都完整的日期，依日期排序），不要用日曆天。
某檔股票在序列中缺值（例如停牌），該日就視為缺值，**不補 0**。窗口內有效值少於 80% 時，該特徵設為 `null`。

設 `t` 為掃描日，`D20` 為截至 `t`（含）最近 20 個交易日，`D60` 同理。

| 特徵 | 定義 |
|---|---|
| `inst_net_20` | Σ D20 的 (foreign_net + trust_net)，單位股 |
| `inst_net_20_pct` | inst_net_20 ÷ issued_shares(t) × 100 |
| `trust_net_20_pct` | Σ D20 的 trust_net ÷ issued_shares × 100 |
| `inst_buy_days_20` | D20 中 (foreign_net + trust_net) > 0 的天數 |
| `foreign_ratio_chg_20` | foreign_ratio(t) − foreign_ratio(t−20) |
| `dealer_net_20_pct` | 只作參考顯示，**不計分**（自營商的買賣多為權證避險） |
| `ret_20` | close(t) ÷ close(t−20) − 1 |
| `dist_ma60` | close(t) ÷ MA60(t) − 1 |
| `range_20` | (max high D20 − min low D20) ÷ close(t)，用來判斷箱型收斂 |
| `vol_ratio` | 20 日均量 ÷ 60 日均量 |
| `avg_value_20` | 20 日平均成交金額（流動性過濾用） |
| `margin_chg_20` | (margin(t) − margin(t−20)) ÷ margin(t−20)；margin(t−20) 為 0 或 NULL 時設為 null |
| `big400_pct` | 最新一週（data_date ≤ t）第 12～15 級 pct 加總 |
| `big1000_pct` | 第 15 級 pct |
| `retail_pct` | 第 1～8 級 pct 加總 |
| `holders` | 第 17 級 people |
| `big400_up_weeks` | 從最新一週往回數，big400_pct 連續週增的週數 |
| `big400_chg_4w` | big400_pct(最新) − big400_pct(4 週前) |
| `holders_chg_4w_pct` | holders(最新) ÷ holders(4 週前) − 1 |
| `retail_chg_4w` | retail_pct(最新) − retail_pct(4 週前) |
| `tdcc_weeks` | 可用的集保週數（品質旗標） |

**時點對齊（point-in-time）**：掃描日 `t` 只能使用 `data_date ≤ t` 且 `fetched_at ≤ t 當日 23:59` 的集保資料。這是為了日後回測時不會偷看到未來的資料。

---

## 7. 評分與分類（`lib/score.mjs`）

所有門檻集中放在 `lib/score.mjs` 最上方的 `CONFIG` 物件，方便日後調整。分數範圍是 0～100。

### 7.1 評分

| 群組 | 上限 | 規則 |
|---|---|---|
| **法人緩買** | 30 | `inst_net_20_pct` ≥ 1.0 → 20；≥ 0.5 → 14；≥ 0.2 → 7。`inst_buy_days_20` ≥ 12 → +10；≥ 10 → +5 |
| **籌碼集中** | 30 | `big400_up_weeks` ≥ 3 → 15；= 2 → 8。`holders_chg_4w_pct` < 0 → +10。`big400_chg_4w` ≥ 0.5 → +5 |
| **價格未動** | 20 | −5% ≤ `ret_20` ≤ 10% → 10。\|`dist_ma60`\| ≤ 10% → 5。`range_20` ≤ 15% → 5 |
| **量能溫和** | 10 | 1.0 ≤ `vol_ratio` ≤ 1.8 → 10；0.8 ≤ `vol_ratio` < 1.0 → 5 |
| **融資退場** | 10 | `margin_chg_20` < −5% → 10；< 0 → 5 |

特徵為 `null` 時，該項給 0 分，並在 `signals` 中加上 `missing:<特徵名>`。

### 7.2 階段分類（依序判斷，先符合者為準）

| stage | 條件 |
|---|---|
| `EXCLUDED` | `avg_value_20` < 2,000 萬，或價格資料不足 |
| `OVERHEATED` | `ret_20` > 25% 或 `vol_ratio` > 2.5（**不論分數高低**） |
| `ACCUMULATION` | score ≥ 60 |
| `WATCH` | 45 ≤ score < 60 |
| `NEUTRAL` | 其他 |

### 7.3 訊號標籤（`signals`）
`inst_steady_buy`、`trust_buying`、`big_holder_rising`、`holders_declining`、`price_quiet`、`box_compression`、`volume_mild`、`margin_exit`、`overheated`、`tdcc_warming_up`（`tdcc_weeks` < 4）。

### 7.4 品質旗標
- `tdcc_weeks` < 4：在 scan.json 加上 `quality: "tdcc_warming_up"`。前端顯示提示：「集保資料累積不足，籌碼集中分數僅供參考」。

---

## 8. 輸出

### 8.1 `scan.json`（上傳到 R2 的 `scan.json`）
只包含 `ACCUMULATION`、`WATCH`、`OVERHEATED` 三類，每類依分數由高到低排序。
```json
{
  "updated_at": "2026-10-07T18:12:03+08:00",
  "scan_date": "2026-10-07",
  "trading_days_available": 60,
  "tdcc_latest": "2026-10-02",
  "tdcc_weeks": 1,
  "quality": "tdcc_warming_up",
  "config_version": "v1",
  "counts": { "ACCUMULATION": 18, "WATCH": 42, "OVERHEATED": 25 },
  "stocks": [
    {
      "code": "1234", "name": "範例", "market": "TPEX",
      "score": 78, "stage": "ACCUMULATION",
      "breakdown": { "inst": 24, "concentration": 15, "price": 20, "volume": 10, "margin": 5 },
      "signals": ["inst_steady_buy", "big_holder_rising", "price_quiet", "box_compression"],
      "features": { "inst_net_20_pct": 0.82, "inst_buy_days_20": 13, "ret_20": 0.034, "vol_ratio": 1.21, "big400_pct": 61.2, "big400_up_weeks": 3, "holders_chg_4w_pct": -0.021, "margin_chg_20": -0.064 },
      "close": 45.6
    }
  ],
  "note": "僅供研究參考，非投資建議。"
}
```

### 8.2 `features/<n>.json`（依股票代號首位數分成 1～9 共 9 個分片）
內容為全部個股（含 NEUTRAL、EXCLUDED）的完整特徵、分數，以及最近 20 日的每日序列（法人淨買、收盤、成交量），供 `/api/stock/:code` 使用。分片的目的是讓 Worker 每次只解析一小份 JSON，避免超過免費方案的 CPU 限制。

### 8.3 `scan_daily` 表
全部個股每天寫入一次，作為日後回測的原始資料。

---

## 9. Worker 與 Workflow

### 9.1 `worker/index.js`（只新增，不改既有路由）
| 路由 | 行為 |
|---|---|
| `GET /scan.json` | R2 `scan.json` 原樣回傳，`cache-control: no-cache` |
| `GET /api/scan` | 參數：`stage`（預設 ACCUMULATION，可用逗號指定多個）、`min_score`、`market`（TWSE/TPEX）、`limit`（預設 50，上限 200）。回傳 `{ scan_date, quality, stocks: [...] }` |
| `GET /api/stock/:code` | 讀 `features/<首位數>.json` 取出該檔。找不到回 404 `{ error: "not_found" }` |

- `/api/*` 回應要加上 `access-control-allow-origin: *`。
- 選配：設定 Worker secret `API_TOKEN` 後，`/api/*` 要求 `Authorization: Bearer <token>`；沒設定就公開。

### 9.2 `.github/workflows/update.yml`（修改 build job）
在現有步驟前後加入以下步驟：
```yaml
      - name: 下載歷史資料庫
        run: |
          mkdir -p data
          npx -y wrangler@4 r2 object get tw-stocks-data/db/history.sqlite --file data/history.sqlite --remote \
            || echo "首次執行：尚無 history.sqlite，將建立新檔"
        env: { CLOUDFLARE_API_TOKEN: ..., CLOUDFLARE_ACCOUNT_ID: ... }

      - name: Ingest 每日資料
        run: node scripts/ingest-daily.mjs
        env: { TZ: Asia/Taipei }

      - name: Ingest 集保（有新資料才寫入）
        run: node scripts/ingest-weekly.mjs
        env: { TZ: Asia/Taipei }
        continue-on-error: true   # 集保失敗不影響每日流程

      - name: 計算吸籌分數
        run: node scripts/score.mjs
        env: { TZ: Asia/Taipei }

      # （既有）抓取並產生 data.json、上傳 data.json 到 R2

      - name: 上傳 scan 結果與資料庫
        run: |
          npx -y wrangler@4 r2 object put tw-stocks-data/scan.json --file docs/scan.json --content-type application/json --remote
          for f in data/features/*.json; do
            npx -y wrangler@4 r2 object put "tw-stocks-data/features/$(basename $f)" --file "$f" --content-type application/json --remote
          done
          npx -y wrangler@4 r2 object put tw-stocks-data/db/history.sqlite --file data/history.sqlite --remote
```
- `docs/scan.json` 要加進 `.gitignore` 和 `docs/.assetsignore`（比照 `data.json`）。`data/` 整個目錄加進 `.gitignore`。
- 既有的 `concurrency: update-data` 已經會序列化 18:00 和 20:00 兩次執行，避免同時上傳 DB。

### 9.3 DB 備份
`score.mjs` 執行後，如果本次 `ingest-weekly` 寫入了新的集保日期，workflow 就額外上傳一份
`tw-stocks-data/backups/history-<tdcc日期>.sqlite`。保留最近 8 份，清理舊檔可以先列為 TODO。

---

## 10. 前端（`docs/scan.html`、`docs/scan.js`）

- 視覺風格沿用 `style.css`，**不引入框架**。
- 頁首顯示 `scan_date`、`updated_at`、`tdcc_latest`；`quality` 為 warming_up 時顯示黃色提示條。
- 分頁切換：吸籌（ACCUMULATION）、觀察（WATCH）、過熱（OVERHEATED）。
- 表格欄位：代號、名稱、市場、分數、法人 20 日 % 股本、法人買超天數、大戶 400 張 % 與連增週數、股東人數 4 週變化、20 日漲幅、量比、融資 20 日變化、訊號標籤。
- 篩選：市場、最低分數。可依任一欄排序。
- 點擊列時展開 breakdown（各群組得分）；點代號開啟 Yahoo 股市（同現有頁面）。
- 手機寬度可以使用（表格水平捲動）。
- `index.html` 頁首加上連結「吸籌掃描 →」；`scan.html` 加上連結「← 法人同步買超」。
- 頁尾加上免責聲明。

---

## 11. 測試

- `node --test`，不引入測試框架。
- **解析器測試**：每個 `lib/sources/*` 用 P0 存下的 `test/fixtures` 實際回應測試，驗證欄位對應、單位、千分位、`--`、負數括號。
- **features 測試**：用手工構造的 25 天和 65 天序列，驗證每個特徵的數值，以及缺值時正確回傳 `null`。
- **score 測試**：至少四個情境：
  1. 典型吸籌（法人緩買、大戶連增、漲幅 3%、量比 1.2、融資減）→ ACCUMULATION
  2. 法人大買但 20 日漲 30% → OVERHEATED
  3. 成交值不足 → EXCLUDED
  4. 集保只有 1 週 → `tdcc_warming_up` 旗標存在，籌碼集中只得部分分數
- **回歸測試**：在 P1 重構 `build-data.mjs` 前後，各產生一次 `data.json`，比對時排除 `updated_at`，內容必須完全相同。

---

## 12. 實作階段與驗收標準

> 每個 Phase 完成後：執行測試 → commit → **停下來，用條列方式回報結果、差異和待決事項**。

### P0　端點探測（不寫業務邏輯）
- 寫 `scripts/probe.mjs`：以最近一個交易日，對 §3 每個端點各發一次請求，印出 HTTP 狀態、欄位或表頭、前 3 筆資料，並把原始回應存到 `test/fixtures/<source>.json`（或 `.csv`）。
- 根據結果產出 `specs/endpoints.md`：每個來源最終採用的 URL、欄位名稱對應、單位、已知坑。
- 🔍 標記的端點不可用時，找出替代端點（優先順序：TWSE 和 TPEx 官網 → `openapi.twse.com.tw` 和 `www.tpex.org.tw/openapi`）。**找不到替代端點就停下回報。**
- 驗收：8 個來源都有可用的端點和 fixture，或已經明確回報不可用的來源。

### P1　共用模組與資料庫骨架
- 從 `build-data.mjs` 抽出 `lib/http.mjs`、`lib/dates.mjs`、`lib/calendar.mjs`、`lib/sources/twse-inst.mjs`、`lib/sources/tpex-inst.mjs`；`build-data.mjs` 改成 import 這些模組。
- 建立 `db/schema.sql`、`lib/db.mjs`。
- 寫 `ingest-daily.mjs`，這一階段只處理 inst 來源。
- 驗收：
  - `data.json` 回歸比對完全相同（§11）。
  - 連續執行 `ingest-daily.mjs` 兩次，第二次不重複寫入，筆數不變。

### P2　價量、融資、外資持股
- 實作 price、margin、qfii 共 6 個 source 模組，接進 `ingest-daily.mjs`。
- 寫 `backfill.mjs`。
- 驗收：在本機 backfill 60 個交易日完成；`verify-scan.mjs --stats` 印出各表的日期數與筆數；抽查 2330、3481 各一天的收盤價和融資餘額，與官網數字一致。

### P3　集保
- `lib/sources/tdcc.mjs`、`ingest-weekly.mjs`，包含 §5.2 的驗證。
- 驗收：寫入目前這一週（約 1,800 檔 × 17 級）；重複執行時為 `skipped`；抽查一檔的千張大戶比例，與集保官網一致。

### P4　特徵與評分
- `lib/features.mjs`、`lib/score.mjs`、`scripts/score.mjs`、`verify-scan.mjs`。
- 輸出 `docs/scan.json`、`data/features/*.json`、`scan_daily`。
- 驗收：§11 全部測試通過；`verify-scan.mjs` 印出今日 ACCUMULATION 前 20 檔及其 breakdown；各階段檔數合理（ACCUMULATION 不應超過可評分檔數的 5%，超過就回報並建議調整門檻）。

### P5　部署整合
- 修改 Worker 路由、workflow、`.gitignore`、`.assetsignore`、`scan.html`、`scan.js`，以及 README 新增一節說明。
- 驗收：`wrangler dev` 搭配本機 R2（`--local`）時，`/`、`/data.json`、`/scan.json`、`/api/scan`、`/api/stock/2330` 都正常；README 寫明首次部署步驟（上傳 backfill 後的 DB）。
- **不要 merge 到 master**。由使用者 review 後自行 merge。

### P6　Hermes 與通知（選做，使用者確認後再做）
- 提供 Hermes tool 定義範例（`specs/hermes-tool.md`），說明呼叫 `/api/scan` 和 `/api/stock/:code` 的方式。
- 選做：每日 ACCUMULATION 新進榜（前一天不在榜上的）推播到 LINE（需要 LINE Messaging API token，以 Worker secret 設定）。

### P7　付費資料擴充（選做，需要 FinMind token）
- `FINMIND_TOKEN` 存在時：
  - Backer：`backfill.mjs --tdcc-finmind --weeks 26`，回補集保歷史。
  - Sponsor：新增 `broker_daily` 表與 `lib/sources/finmind-broker.mjs`（`TaiwanStockTradingDailyReport`，一次請求只回傳一天一檔的資料，要先依分點彙總再存），新增特徵 `top_broker_streak`（單一分點 20 日內淨買天數），並維護隔日沖分點黑名單 `config/daytrade-brokers.json`。

---

## 13. 待使用者決定或提供

| 項目 | 何時需要 | 預設 |
|---|---|---|
| 確認本機 Node 版本 ≥ 22.13 | P1 前 | 已確認：本機 v22.22.3（nvm），CI 用 22 |
| backfill 天數 | P2 | 60 個交易日 |
| 評分門檻（§7） | P4 驗收後 | 照本文件 |
| `/api/*` 是否需要 API_TOKEN | P5 | 公開 |
| 是否做 P6、P7 | P5 後 | 不做 |

---

## 14. 免責
本系統只是籌碼與價量的統計篩選工具，**不構成投資建議**。分數權重是 v1 的主觀設定，需要累積資料、回測後再調整。
