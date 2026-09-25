# MCode（MiniMax Code）取代 opencode-server 遷移評估

日期：2026-09-19　結論：**現在搬不了，凍結等待；重試條件明確（見末節）**

## 一句話結論

我們的 agent-gateway 深度綁死 opencode 的 HTTP/SSE server API（約 63 個 fetch 呼叫點），而 MCode **公開版本根本沒有 server API**——唯一官方預告的 `mcode app-server` 仍在內部測試、未隨任何版本發佈（官方維護者在 issue #139 親口確認）。在此現狀下遷移＝丟掉 gateway 的串流、question、abort、subagent 全部控制面，或在無官方背書的 ACP 表面上自造橋接層，成本以週計且踩在不穩定地基上。

## 證據鏈

### 1. MCode 無公開 server API（致命斷點）

- `docs/architecture.md`（源碼倉內）：`local-runtime-v2` 的 application 層「does not instantiate … an HTTP front door, or cloud handoff services」；全 repo grep `createServer`/`Hono` 僅命中 miniapp 開發腳手架與 OAuth lease 本地 socket，零對外 HTTP 服務。
- **Issue #139（open）**：官方文檔頁 `agent.minimax.io/docs/cli/integrations` 曾記載 `mcode app-server`（`--stdio` JSON-RPC / `--listen unix://` / `proxy` / `daemon`），但 0.2.0–0.3.4 全部已發佈版本 grep 零命中。官方回覆原文：**"The app-server feature is still in internal testing and is not available in the current public release. We have corrected the documentation to remove the premature references. We will notify you when a future release makes this feature publicly available."**——即：路存在、無時間表、文檔已撤回。
- **Issue #176（open，零回覆）**：第三方桌面客戶端（Monocode Linux 維護者）問「ACP 是不是嵌入 mcode 的正確表面」，官方未答。ACP 嵌入路徑無官方背書、無生態先例。

### 2. 我方依賴面 vs MCode 可用表面

gateway 對 opencode 的依賴（另一探查報告實錘）：

| 依賴 | opencode 現狀 | MCode 對應物 |
|---|---|---|
| `POST /session/:id/prompt_async` ＋ `GET /event` SSE | 異步發送＋事件流是全架構前提 | 無。只剩 `mcode exec` 每輪起子進程（丟串流粒度）或 `mcode acp`（stdio JSON-RPC，事件語義全重映射，無背書） |
| `session.idle` SSE 事件 | 承載收盤、看門狗、抖動重試、question 凍結 | 無同構事件；`session.idle` 僅在 `packages/local-runtime/src/cron/api.ts` 出現，語義不同 |
| question 雙路徑 6 組端點（/question、/reply、/reject） | 中途人機交互 | ACP 有 approval 概念但語義不同，需全部重寫 |
| `POST /session` 帶 `agent` 欄掛 8 Expert subagent | subagent 派遣 | MCode 自有 mavis 子代理體系（`subagent-roles.ts`），概念不同構 |
| `@opencode-ai/plugin` 工具生態（25 檔 vendor-bridges＋`.opencode/tools/` 落位＋registry） | 工具真源 | MCode 走 MCP＋自家 plugin system，25 檔全重寫 |
| `agent-models.json` → `gen-opencode.ts` → `opencode.json` provider 配置鏈 | provider 層 | `mcode provider add` BYOK 可行，但配置鏈要重做 |

### 3. 遷移成本量級（若現在硬搬）

- 最低路徑（ACP 橋接）：新造 ACP→前端幀翻譯 daemon＋63 呼叫點適配＋question/abort/subagent 重寫＋25 工具檔重寫，粗估 2–4 週聚焦開發才到主鏈路可用，且地基（ACP 表面）官方未承諾穩定。
- `mcode exec` 每輪子進程路徑更便宜但功能殘缺，不符產品要求。

### 4. 「性能更好」的前提本身有疑

截圖（FrontierHarness Eval，30 任務全量通過率）顯示 MCode 76.7%/4m33s、Codex 66.7%、Claude Code 63.3%、OpenCode 50%。但：

- 外部搜尋（GitHub/Reddit/DDG）對「FrontierHarness」零獨立命中；源碼倉（21 commits、docs/）無該評測數據。**來源＝MiniMax 自家發佈、無獨立複現、無公開 harness 代碼。**
- n=30 的小樣本上 76.7% vs 50% 的差距，疊加廠商自測，按本倉「不宣稱未驗證的成功」標準只能記為「廠商宣稱」，不能記為事實。
- 圖中「MiniMax Code: Kimi China API」註記＝它跑的是 Kimi 模型，非 MiniMax 自家模型；即它的優勢主張是 harness 本身，這正是我們想買的東西，但唯一驗證渠道就是這份自測報告。

### 5. 附帶紅旗（生態成熟度）

- Issue #102（open）：「No Linux support is simply unreasonable」——Linux 支援狀態有公開 bug 報告；我們的 harness 跑在 Linux VPS 上。
- Issue #87（open）：MCode 使用 opencode 的資料庫路徑造成衝突——與 opencode 有部分共源痕跡，但共生態位會互踩。
- Issue #103：首次調用 SyntaxError；#76：MCP stdio cwd 落 homedir 丟 workspace 上下文。
- 模型側：訂閱制模型綁 `mcode login` 瀏覽器登入（我們已知會損失全部 opencode zen 模型，此為第二筆損失）。

## 定案

1. **遷移凍結。** 現狀搬＝在無官方背書的表面上自造關鍵基礎設施，且性能優勢僅有廠商自測背書。
2. **等待條件（重試觸發器）**：MCode 任何一版發佈實裝 `app-server` 子命令（`--stdio` JSON-RPC 即可，Unix socket 更好）——這正是 Codex 的 `codex-rs/app-server` 同構物（Codex 的 app-server 有 thread/turn/approval 完整面，已被其 IDE/桌面整合大規模使用，證明這種架構能承接我們這種 gateway）。屆時遷移成本從「重寫」降為「寫一個 app-server 橋接層」，約 1–2 週量級。
3. **監測方式**：watch issue #139（官方承諾會通知）＋ npm registry `@minimax-ai/code` 新版本 tarball 內 grep `app-server`。
4. 我方現有痛點（opencode harness 性能墊底）屬實且已在評測圖中第三方印證，但不構成現在搬 MCode 的充分條件；Codex（66.7%、app-server 已公開、Apache-2.0、`model_providers` 支援 `base_url`+`env_key` 自訂 provider，但 `wire_api` 已收斂到僅 Responses API——我們的 chat-completions 渠道需確認能走 responses 形狀）是唯一「性能好且有公開 server API」的替代候選，如暴君日後要求性能搬家，那是首選，不在本報告 scope 內展開。
