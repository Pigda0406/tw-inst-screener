# 台股：法人同步買超選股器

自動找出**最近數個交易日,勾選的法人(外資/投信/自營商)「都」買超**的台股(上市 + 上櫃),做成一個
**公開網頁**,手機/任何電腦用網址即可查看,每個交易日收盤後**自動更新**,你的電腦不用開機。

## 篩選條件
每一檔股票,網頁上**勾選的法人**(預設外資+自營商,可加勾投信)**各自**都要滿足:
- 外資含陸資;自營商含自行+避險
1. 在「累計天數」(預設 10 個交易日)內,**淨買超合計 > 0**
2. 在「連續買超天數」(預設 5 天)內,**每天都淨買超**

> 上述兩個參數可在網頁上即時調整;數值單位為「**張**」(股數 ÷ 1000)。

## 運作方式
```
GitHub Actions(每交易日傍晚排程)
   └─ scripts/build-data.mjs  抓 TWSE + TPEX 三大法人買賣超 → 篩選 → data.json → 上傳 R2
Cloudflare Workers
   ├─ docs/                   靜態頁面(index.html / app.js),push 到 master 時自動部署
   └─ worker/index.js         /data.json 從 R2(bucket tw-stocks-data)讀出回傳
```
- 資料來源:臺灣證券交易所(TWSE T86)、證券櫃檯買賣中心(TPEX)。
- 前端讀取同源 `/data.json`,沒有 CORS 問題;資料更新只寫 R2,不 commit 回 repo、也不需重新部署。
- 抓資料腳本**零 npm 依賴**,只需 Node 18+;部署與上傳用 `wrangler`(需 Node 22+)。

## 本機開發
```bash
node scripts/build-data.mjs     # 重新抓資料,產生 docs/data.json(建議 TZ=Asia/Taipei)
node scripts/serve.mjs          # http://localhost:8080 預覽網頁
node scripts/verify.mjs         # 列印目前符合條件的股票(自我檢查用)
```
> `docs/data.json` 只存在本機(已列入 `.gitignore`、`docs/.assetsignore`),不會被 commit 或部署。
> 若要連同 Worker + R2 一起在本機測試:
> ```bash
> npx wrangler r2 object put tw-stocks-data/data.json --file docs/data.json --local
> npx wrangler dev                # 用本機模擬的 R2
> ```

## 部署到 Cloudflare
1. **Cloudflare → R2**:建立 bucket `tw-stocks-data`(名稱需與 `wrangler.jsonc` 一致)。
2. **Cloudflare → My Profile → API Tokens**:建立 Custom token,權限 `Account / Workers R2 Storage / Edit`。
3. **GitHub repo → Settings → Secrets and variables → Actions**:新增
   - `CLOUDFLARE_API_TOKEN`:上一步的 Token
   - `CLOUDFLARE_ACCOUNT_ID`:Cloudflare Dashboard 網址 `dash.cloudflare.com/<這段>/` 即是
4. **Cloudflare → Workers & Pages → Create application → Import a repository**:選本 repo,
   名稱填 `tw-inst-screener`(需與 `wrangler.jsonc` 的 `name` 一致),Build command 留空,
   Deploy command 用預設 `npx wrangler deploy`。之後 push 到 `master` 會自動部署。
5. 到 GitHub **Actions** 頁手動跑一次「更新法人買賣超資料」(Run workflow),把資料寫進 R2,
   完成後開 `https://tw-inst-screener.<你的子網域>.workers.dev/` 即可查看。之後每個交易日會自動更新。

## 免責
本專案僅供研究參考,**非投資建議**。資料以官方公告為準,程式可能因官方端點調整而需維護。
