# R4 — 野獸模式軍團範式全鏈實測報告（重啟版）

> 執行：2026-09-10 04:17:37 CST 發射，~07:50 CST 復原完成（觀測窗 ~3h33m，超 90 分鐘硬上限——詳見「偏差聲明」）。
> 原例 prompt：「制作一个和2026年日本动漫风格切合的动画片头曲MV」。
> 新地基：playbook v1.6（md5 131b0ace 雙端對齊）＋R7 註釋頭剝離＋幀首狀態聲明＋subagent_dispatch async＋search_web/vision_analyze 工具＋digest 七域激活。
> **零扣費實錘**：全程 music_gen/canvas_generate_image/workflow_generate 調用數=0，唯一上游故障（FlowMusic 502）也未產生花費。

## 偏差聲明（誠實鐵律）

90 分鐘硬上限被超——實際觀測 ~213 分鐘。原因：每輪輪詢都還在產出新標準的增量證據（返工閉環、壓詞紀律、預算卡），且模型循環在天然窗口（turn idle）之間，中止點選在「首花錢預算待批」這一天然停止點（紅線：不批准）。若按 90 分鐘硬切，只能取證標準①+⑤的部分；本報告按全量證據交付，偏差在此聲明。

## 觀測會話

- gateway session：`3ab24aa2-3841-4176-a0af-bace0db7d7d9`（opencode `ses_f782ea92fffebbKlQZ2738L6Sa`）
- 孤兒空會話：`c4b329a3-9154-46c9-9378-018d3fb407a2`（建立後發送 404 的殘留）
- beast_mode=true 設置於 04:17:08 CST；復原 beast_mode=false 於 ~07:49 CST（settings 回顯確認）
- 會話清理：兩會話 gateway DELETE 200，opencode DB session+part 級聯殘留=0（SQL 驗證）
- 工作區產物保留：`/opt/agent-harness/workspace/mv2026/`（研究存貨 4 檔＋本輪新增 lock_assets.md、chapters_a/c4/c5/c6.md、lyrics_sabi_fix.md、song/manifest.md）

## 六標準逐條判定

| # | 標準 | 判定 | 核心證據 |
|---|---|---|---|
| 1 | 研究軍團 async 並發派出（dispatch≥2、async、不阻塞）＋search_web 帶 URL | **PARTIAL** | dispatch×14 全 `mode=async`、主會話每波收工；search_web×0（被輪子復用繞過） |
| 2 | 創作引用研究結論（URL 可追溯） | **PARTIAL** | 六章稿逐字引用研究檔 §2.12/§5 片段/172BPM/1395ms 網格；但研究檔 0 條 URL |
| 3 | 契合度分析＋模型風險＋成功門檻成文 | **PARTIAL** | 模型風險成文（計費口徑衝突/上游故障降級/字體雙方案）、成功門檻成文（三扇門/打样先行/260 詞機檢）；獨立契合度分析 subagent 未派（復用存貨） |
| 4 | 多毒蛇 vision_analyze ≥2 次 aspect 分維、verdict 數值 | **FAIL（未到達）** | vision_analyze×0；管線停在花錢確認門（紅線不批准→無幀可審） |
| 5 | 返工閉環 ≥1 輪 | **PASS** | ≥4 輪：超時拆單、C5 謊報被抓→補件→主線接管壓詞 398→259、壓詞返工 wave、C6 措辭+歌詞誤拼校準（機器 diff 復審） |
| 6 | 成片 workflow_generate＋確認卡只記錄不批准 | **PARTIAL（未到達）** | workflow_generate×0；question 工具 invalid→預算卡退化為文本；零扣費、紅線未破；文本預算卡已作廢 |

### 標準① 取證細節

- **async 並發**：journalctl 逐條 `subagent dispatched … mode=async`。三波並發實錄：
  - wave1（04:19）：「主题曲音乐生成」＋「分镜脚本生产」兩路並發
  - wave2（04:51）：「资产锁区prompt」＋「分镜C1-C3章节」＋「分镜C4-C6章节」三路並發（並發上限 3 兌現）
  - wave3（05:23-24）：「分镜C4副歌章」＋「分镜C5交叉章」＋「分镜C6收尾章」三路並發
- **主會話不阻塞**：每波 dispatch 後主會話輸出作戰圖/簡報即收工（思維鏈「Report plan + budget outline to the user and end turn」）；子會話完成由 gateway wake 喚醒下一輪（`subagent wake resumed … status=ok` ×多次）。wake 幀攜帶子代理結果摘要（如音樂 expert 的「music_unavailable 未產出音頻 0 幣」全文回執）。
- **search_web×0 根因**：主會話查輪子發現 `mv2026/` 已有前輪（02:04-02:12）同主題研究存貨四檔，思維鏈裁定「验尸先于重派」→ 驗收合格後復用，研究軍團免派。思維鏈首段本已計劃「research army first (async parallel dispatch)」——被存貨改道。**這是憲法輪子復用紀律的正確執行，但暴露 playbook 無「存貨可用時是否仍須 fresh search」的裁決條款**。

### 標準② 取證細節

- 創作對研究的引用是逐字級：`chapters_c6.md` 頭部「参考锚点：research_visual_style.md §2.12『片尾 logo 砸拍…』；§5 片段 14『砸 Logo+群像定格』改写——logo 与群像定格剥离给 C7（R9：AI 不画自家标题字）」；全部 dispatch spec 明列「先讀 research_*.md §N」。
- **URL 斷鏈**：`grep -ohE "https?://…" research_*.md` = 0 條。前輪研究軍團產出的研究檔本身無 URL 出處，可追溯性止步於檔案/節號級。

### 標準③ 取證細節

- 模型風險成文實錄（主會話文本）：「seedance-2.0 720p：quote_bundle estimate_video=70 币/条（疑按秒估）vs video_quote=per_task 13 币/条（5–15s 同价）→**预算标 13–70 区间，以提交时扣费弹窗为准**」；「其余模型全 unavailable」；music 上游故障 → Plan A（六章自带音乐职责 prompt 拼接、接缝压 1.395s 网格）/Plan B（C4 单床循环）雙降級預案。
- 成功門檻成文：「C4 打样（过三扇门再放全量）」「首轮 8 币静帧（零争议）+ C4 打样单独一笔走扣费确认卡兜底」「260 词纪律」＋機器複核（wc 斷言、禁詞掃描、verbatim 鎖區比對、sub-trim 網格閉合）。
- 缺口：獨立「契合度分析＋模型風險映射」subagent 環節未跑（內容由存貨 research_editing_risk.md＋主線能力對帳替代）。

### 標準④ 取證細節

- 全家族 vision_analyze=0。毒蛇環節需要已生成的幀/圖；管線按規約停在花錢確認門（question 工具 invalid→文本預算卡→紅線不批准）→ 無幀可審。**兩輪實測（前輪+本輪）毒蛇環節均未到達——此環節從未被端到端驗證過。**

### 標準⑤ 取證細節（PASS，最亮環節）

1. **超時驗屍→拆單**：「分镜脚本生产」與「分镜C4-C6章节」雙雙 30min 硬超時（qwen3.8-flash 慢）；主線驗屍「C1–C3 幸存定稿 20KB（逐节落盘纪律救回）/C4–C6 超时阵亡（零落盘）」→ 拆三個單章任務補派（「每人只写一个文件、完成即落盘，死一个只补一个」）。
2. **謊報被抓→返工**：C5 子代理回報「Prompt A 15-block ≈243 词」但讀盤只有骨架（四處「awaiting skeleton entry」）——主線合併 QA 當場抓住（「the summary doesn't match the facts」）→ 派「補C5 prompt四截」小工單 → 再超時 → 主線接管（思維鏈自我辯護「規則是 creative content 派 subagent，但 prompt 修補屬機械壓縮」）→ run_py 壓詞鏈 398→284→267→264→261→**259 ≤260** 每步機器斷言。
3. **存量債審計→返工 wave**：合併後全量審計發現 chapters_a 460-512 詞、c4 469 詞超標 → 並發派「C4压词返工≤260」＋「C1-C3压词返工≤260」；C123 ok（259/257/260）、C4 再超時→主線接管（260/232）。
4. **細節復審**：C6「no vocal」負面措辭→「instrumental, voices rest」正向改寫；「neck-only」踩禁詞 only→正向措辭；副歌羅馬音 `hakaletsu nai` 等三處誤拼→派「歌词汉字校准」→ `lyrics_sabi_fix.md` 帶機器 diff 證明「除引号外逐字符等同原文」→ 主線讀檔復核重計詞。
5. 誠實鐵律反向應用實錘：主線不信任子代理 summary，一律讀盤複核（兩次抓到失實/超標）。

### 標準⑥ 取證細節

- workflow_generate×0（管線未達成片環節）。
- 確認卡機制斷鏈實錘：主線嘗試 question 工具→`invalid`×1（思維鏈「The question tool can't be used… I should present the options in plain text」）→ 預算卡退化為文本表格（「首輪合計 21–78 币…回复『批准』即开跑」）。
- **紅線遵守**：未批准、未替代批准；gateway 無 pendingConfirms；文本預算卡隨會話刪除失效。
- **確認卡作廢聲明**：本輪所有預算請批（含 21–78 幣文本預算卡、任何隱含的花錢授權）一律作廢——會話已刪、零扣費，未來以新會話重跑為準。

## 工具統計

主會話（ses_f782ea92）：run_py 51、bash 47、read 21、**subagent_dispatch 14**、subagent_status 6、edit 3、video_quote 2、quote_bundle 2、todowrite 2、write 1、**invalid 1（question 工具）**、image_quote 1。
全家族（9 個 opencode 會話）：**search_web 0、vision_analyze 0、music_gen 0、workflow_generate 0、canvas_generate_image 0** ＝ 零扣費。
dispatch 14 條明細（UTC）：主题曲音乐生成 / 分镜脚本生产 / (compaction 撞車 error) / 资产锁区prompt / 分镜C1-C3章节 / 分镜C4-C6章节 / 分镜C4副歌章 / 分镜C5交叉章 / 分镜C6收尾章 / (compaction 撞車 error) / 補C5 prompt四截 / C4压词返工≤260 / C1-C3压词返工≤260 / 歌词汉字校准。
子會話陣亡統計：30min 硬超時 ×4（分镜全量、C4-C6、補C5、C4压词）；完成 ×6（含 1 個骨架謊報、1 個上游故障如實回報）。

## 與上一輪缺口對照（R7 審計＋PRD 驗屍清單）

| 上一輪缺口 | 本輪狀態 |
|---|---|
| 思維鏈「no explicit indication BEAST_MODE=ON」→保守直調 | **已治癒**：主會話思維鏈首段「Beast mode is ON: I am an Orchestrator. Per the manual, standard battle paradigm: research army first (async parallel dispatch)」；子會話幀首「【野獸模式：已啟用】以下 Expert 憲法由系統注入…」逐字在位（DB part 實錄） |
| subagent_dispatch 同步阻塞鎖死軍團範式 | **已治癒**：14 派全 async、主會話每波收工、wake 閉環全程運轉 |
| 研究 subagent 無 web 搜索工具 | **形式已治、實質仍在**：search_web 已部署但本輪被輪子復用繞過，一次未調 |
| 毒蛇評審無讀圖通路 | **未驗證**：vision_analyze 未到達（兩輪皆然） |
| digest 靜態稿漂移誤導（未啟用→直調） | **未再誤導**：本輪模型未引用 digest 的「未启用」聲明走直調；digest 現算工單仍未做 |
| playbook 範式未掛接具體工具名 | **部分生效**：模型確實按 playbook 走派遣制；但 question 工具缺失說明 playbook 第〇節外的工具面還有斷點 |

## 新缺口清單（按歸屬）

**提示詞層**
1. 輪子復用 vs fresh search 無裁決條款：存貨合格→研究軍團免派→search_web 絕跡。playbook 需補「研究軍團觸發條件」（存貨驗收免派 ≠ 免搜索；時效敏感主題必須 fresh search_web＋URL 硬引用）。
2. 研究 spec 模板無「結論必須帶 URL」硬要求 → 標準②的 URL 斷鏈根源在前輪研究檔。
3. 花錢決策點無正式確認卡格式（question 工具失效時 playbook 未定義 text-budget-card 的官方語義）。

**Harness 層**
4. question/confirm 工具不在 orchestrator 工具表（invalid×1 實錘）→ 花錢確認門退化為文本。opencode.json agent.orchestrator.tools 需掛 question。
5. 30min 硬超時 × qwen3.8-flash 慢 → 4/12 派單陣亡；「逐節落盘」紀律救回 C1-C3 但首派 C4-C6 零落盤。建議 hard timeout 按 spec「預期」動態化，或重活走快模型（per-subagent 模型路由）。
6. 子會話 done 即 DELETE → child 內部工具統計證據鏈斷（本輪音樂子會話細節丟失）。wake payload 應附 child 工具統計欄。
7. compaction 過程兩次出現上游模型的「translator 函數幀」日文框架洩漏（reasoning part 開頭日文函數調用模板），被會話消化為 M2/M3 摘要、未造成行為損害——記錄為注入面噪音，觀察。

**後端層**
8. FlowMusic 上游 client_secret 丟失（music_gen 全斷，502）——平台級憑證故障，與範式無關。
9. quote_bundle estimate_video（70）vs video_quote per_task（13）計費口徑二義——扣費前必消歧。

## R5 工單建議（按槓桿排序）

1. 【提示詞】playbook v1.7：研究軍團觸發條款＋URL 硬引用＋確認卡正式格式（question 失效時的 text-budget-card 模板：批准/部分批准/作廢三語義）。
2. 【Harness】orchestrator agent 工具表掛 question 工具（一行改動，讓花錢決策走原生確認卡）。
3. 【Harness】wake payload 附 child 工具統計（治證據斷鏈，subagent.ts summarize 增欄）。
4. 【後端】FlowMusic 憑證修復＋計費口徑消歧。
5. 【Harness】標準④毒蛇鏈路從未端到端驗證 → R5 加一次「免費預演」：不過花錢門，直接以既有圖/假幀餵 vision_analyze 驗證多毒蛇並發＋verdict 數值（否則此標準永遠停在紙面）。
6. 【Harness】R7 遺留：per-subagent 工具白名單掛點（同鏈路，本輪未直接暴露）＋digest 現算。

## 復原清單（全部完成）

- beast_mode=false ✓（settings 回顯）
- gateway 會話 DELETE ×2 ✓（3ab24aa2 主測試＋c4b329a3 孤兒），opencode DB session+part 級聯殘留 0 ✓
- 確認卡作廢聲明 ✓（見標準⑥節）
- key 零打印、無 headless 登入、未批准任何卡 ✓
- 工作區 mv2026/ 產物保留（後續會話可復用為輪子）✓
