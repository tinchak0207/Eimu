---
name: editor-assembly
description: 剪輯素材入軌與時間線編排配方。觸發時機：把素材加入時間線／剪切／合併／排序／修剪／拆分／變速／鎖定／分組／設轉場／多軌音頻字幕／回退版本。時間線結構有任何變更（add/remove/reorder/trim/split/speed/lock/group/transition）時必載。
---
<!--
來源（輪子）: 自有配方（非第三方輪子）。依據 docs/timeline-post-production-plan.md §2 B1/B2 拆片表
              （時間線資料對象 + ops 9 類指令 + 版本 + 決策日誌）與 §7；記憶
              2026-08-31-b1-timeline-lifecycle-layer（版本/鎖定/冪等語義）。
工具真源: VPS /opt/agent-harness/workspace/.opencode/tools/{timeline_ops,timeline_query,
          timeline_restore,editing_manifest,video_upload}.ts 與 gateway/timeline.ts。
入庫批次: 2026-09-27 剪輯域 Agent 能力面活化。
-->

# 素材入軌與時間線編排

## 工具鏈

```
video_upload → editing_manifest → timeline_query → timeline_ops（整批原子）→ timeline_query（回讀 diff）→ timeline_lint（過閘）→（必要時）timeline_restore
```

## 逐步配方

1. **素材進入**：`video_upload` 把視頻／音頻素材上傳進 gateway 會話，拿到後續可引用的素材引用。**禁把超過 `video_upload` 限制的原片直接用 `run_py` 讀本機路徑**（gateway 會話外不可見）。
2. **交底剪輯清單**：`editing_manifest` 生成 manifest（素材 → 鏡頭 → 順序的顯式清單）。它是**語義層交底**：把「哪個素材放第幾、意圖是什麼」顯式化，後續 ops 依它落軌，不靠記憶。
3. **摸底真狀態**（強制）：`timeline_query(what=state)` 取現有 clips／時長／版本號／決策日誌。**動手前必須有這一讀**——猜狀態＝必錯。
4. **批量落軌**：`timeline_ops` 一次帶整批 op，形如 `{op, clip_id/clip_ids, to_index, ...}`：
   - 插入／刪除：`add` / `remove`（remove 帶 `reason`，會進決策日誌）
   - 排序／移動：`reorder`（`to_index`）
   - 精度：`trim`（`in`/`out`）、`split`、`speed`
   - 守衛：`lock` / `unlock`（locked clip 被改 → 409 `{blocked,reason:"locked"}` **整批拒**，不是部分套用）；`group` / `ungroup`
   - 疊層：`set_transition`、`set_meta`、`add_audio`、`add_subtitle`、`set_aspect`
   整批先驗證後套用；有任一非法 → 整批不動、版本號不變。
5. **回讀 diff**：`timeline_query` 再讀一次，確認實際結果（版本號 +1、clip 數與時長如預期）。**禁止跳過回讀直接回報完成**。
6. **過 lint 閘**：任何交付前必須 `timeline_lint`；must 未清不得往下走。
7. **回退**（僅在需要時）：`timeline_restore` 回目標版本。語義：內容 = 該版本內容，但**版本號單調遞增**、歷史不刪；回退本身也進日誌。

## 不可違反的語義（來自 B1 生命週期層）

- 有效時長 = `(out - in) / speed` 逐 clip 求和，與輪子 `clipLength` 一致——不要自算一套時長口徑。
- `split` 後半段**不繼承** `costCoins`（生成成本屬源鏡頭，拆分不翻倍計帳）。
- 冪等 op（無實際 diff）**不 bump 版本、不寫日誌**；不要用「版本號有動」當成操作成功的唯一判據，回讀 diff 為準。
- `unlock` 是唯一對 locked clip 開放的變更 op。
- 部分失敗不存在的：整批原子，要嘛全成、要嘛全不動。

## 交付

payload 三欄之一：`timeline_ops`（回執 `timeline_ops_echo` 為實際執行操作；無回顯時回退委託單清單，兩處皆空才落「（剪輯師自主編排，未顯式指定）」佔位——佔位是誠實標記，非交付）。成片交付另需 `duration_sec` + `qc`。
