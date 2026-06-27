# 台股：外資 + 自營商 同步買超選股器

自動找出**最近數個交易日,外資與自營商「都」買超**的台股(上市 + 上櫃),做成一個
**公開網頁**,手機/任何電腦用網址即可查看,每個交易日收盤後**自動更新**,你的電腦不用開機。

## 篩選條件
每一檔股票,**外資(含陸資)**與**自營商(自行+避險)各自**都要滿足:
1. 在「累計天數」(預設 5 個交易日)內,**淨買超合計 > 0**
2. 在「連續買超天數」(預設 3 天)內,**每天都淨買超**

> 上述兩個參數可在網頁上即時調整;數值單位為「**張**」(股數 ÷ 1000)。

## 運作方式
```
GitHub Actions(每交易日傍晚排程)
   └─ scripts/build-data.mjs  抓 TWSE + TPEX 三大法人買賣超 → 篩選 → docs/data.json
GitHub Pages(/docs)
   └─ index.html / app.js     讀 data.json,前端套用條件、排序、顯示
```
- 資料來源:臺灣證券交易所(TWSE T86)、證券櫃檯買賣中心(TPEX)。
- 純前端讀取同源 `data.json`,沒有 CORS 問題;**零 npm 依賴**,只需 Node 18+。

## 本機開發
```bash
node scripts/build-data.mjs     # 重新抓資料,產生 docs/data.json(建議 TZ=Asia/Taipei)
node scripts/serve.mjs          # http://localhost:8080 預覽網頁
node scripts/verify.mjs         # 列印目前符合條件的股票(自我檢查用)
```

## 部署到 GitHub Pages
1. 建一個 GitHub repo,把本資料夾 push 上去。
2. **Settings → Pages**:Source 選 `Deploy from a branch`,分支 `main`、資料夾 `/docs`。
3. **Settings → Actions → General → Workflow permissions**:設為 *Read and write permissions*。
4. 到 **Actions** 頁手動跑一次「更新法人買賣超資料」(Run workflow),完成後開
   `https://<你的帳號>.github.io/<repo>/` 即可查看。之後每個交易日會自動更新。

## 免責
本專案僅供研究參考,**非投資建議**。資料以官方公告為準,程式可能因官方端點調整而需維護。
