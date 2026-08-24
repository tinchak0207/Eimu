# shuohao-skills 模式挖掘（2026-08-22）

來源：https://github.com/eternityspring/shuohao-skills（Apache 2.0，AI 短劇五段管線 skill 集合，83 檔）
結論：**可復用的是契約機制，不是內容**。（完整分析見當日會話輸出；本檔為跨 session 指針）

## image-app 缺口（單向對稱差）
1. 質量門體系：確定性代碼檢查（validate --stage skeleton/beats/full）+ .gates.jsonl 追加日誌 + stats 聚合 + 每門擊穿用例
2. SKILL.md frontmatter 契約標準（name/version/allowed-tools/triggers/metadata.requires+optional）
3. schema.md 單一真相（欄位表+枚舉+零冗餘推導：總秒數由子項求和）
4. ID 主鍵跨任務引用 + 校驗器驅動改動傳播（素材庫）
5. report.mjs 組裝器（scopeCss/scopeJs/scopeHtml/rebaseAssets/深鏈/needs 注入/逐面板容錯）
6. style-presets 五塊一組整套換 + negative 反義校驗
7. shot-recipes 卡庫（must_phrases 硬門 + 建議項只提示）
8. install.sh 軟鏈安裝（git pull 即生效）
9. selftest 紀律（零框架、不調模型、事故釘回歸、數量進 CHANGELOG）
10. render --lang 只翻 UI 不翻數據
11. CHANGELOG 紀律（設計主張+實測數字+自測 delta）

## 吞併優先級
P0 質量門+.gates.jsonl 掛 generation-core／schema.md 任務契約文檔（biz-api 延伸）
P1 組裝器（agent 批量願望報告頁）／ID 資產庫（canvas/history 延伸）
P2 SKILL.md 標準化 docs/skills/／style-presets 整塊校驗／selftest 擊穿紀律

## 戰略定調（2026-08-22 用戶拍板）
「拼深度徹底吊打，但不失 General 工具優雅」。吞法=**機制下沉為通用原語，管線只是配方**：
資產第一級對象（pin 即資產，ID 引用）→ 品質門前後雙挂（提交前+生成後）→ 管線模板=配方包（短劇是其一）→ 審查單頁組裝器。
殺手鐧：shuohao 止步於投產包（出圖可選），我們閉環到真量產（storyboard 段→批次任務+設定圖引用+門）。他們的 Apache 2.0 五 skill 可直接 vendor 成平台配方包，用他們的管線證明我們的深度。
優雅紅線：不加頂層模式、小白路徑零儀式不變、門可選「跳過≠失敗」。
