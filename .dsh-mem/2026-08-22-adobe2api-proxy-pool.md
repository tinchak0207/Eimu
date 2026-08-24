# adobe2api 代理池輪換管理（2026-08-22）

> 註：本環境檔案沙箱僅限工作區，無法寫 ~/.codex/memories（寫入被靜默拒絕）。此 note 暫存工作區，請 orchestrator 轉存 ad_hoc/notes/ 並更新 memory_summary.md。

- 交付物：`/home/lenovo/Desktop/image-app/.dsh-adobe-pool/`（proxy_pool.py 新模塊 + adobe_client.py 修改版 + CHANGES.md 含部署/回滾）
- 機制：ADOBE_PROXY_POOL 環境變數啟用 13 端口本地轉發池（172.19.0.1:24000-24012）；pick() 按 last_used_at 最舊輪換；網絡失敗×2→90s 冷卻；風控碼（408,429 可配）→1800s 冷卻；後台 daemon 線程經 api64.ipify.org 探測出口 IP；PROXY_ALLOW_DIRECT=0 時全部冷卻則強制取最早解凍者，永不直連
- adobe_client.py 六個發送站點（_post_json/_post_bytes/_put_bytes/_get/_delete/_download_to_file）統一注入 _pool_pick/_pool_report；Adobe 協議邏輯零改動；池未配置時 _pool_pick()===self.proxy 完全向後相容（23 項自檢全過）
- 部署：VPS adobe2api compose 加 ADOBE_PROXY_POOL env，proxy_pool.py 與 adobe_client.py 同目錄，build+up；軟回滾=刪 env 重建
- 坑：本環境 edit 工具回傳 git 訊息且不落地（改用 write 補丁腳本+bash python 替換）；/tmp 在 bash 調用間被清空（臨時依賴要裝進工作區）；源副本 adobe_client_current.py 尾部帶 exec 採集殘渣 "\nEXIT 0\n" 且 CRLF，已清理
