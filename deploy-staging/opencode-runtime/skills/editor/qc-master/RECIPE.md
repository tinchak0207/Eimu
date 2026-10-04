---
name: editor-qc-master
description: 剪輯質檢閘與母帶導出配方。觸發時機：成片導出、交付、質檢、QC、檢查後導出、豎屏／橫屏／影院畫幅、封面幀、交付規格、導出被拒排障。任何「把片子交出來」的請求必載——lint 是閘門不是可選步驟。
---
<!--
來源（輪子）: 自有配方（非第三方輪子）。依據 docs/timeline-post-production-plan.md §2 片B4+B6
              （B4 信號層 linter：黑幀/白閃/爆音/靜音段/音量跳變/音畫時長錯位，ffmpeg blackdetect·freezedetect·
              astats·silencedetect，must/should 分級；B6 母帶 check+export 閘，must 未清拒導，預設
              9:16/16:9/2.39:1/封面幀）與 §7（master 14/14 含負向閘：聲明 > 源實測 → av_mismatch must → export 400）。
工具真源: VPS .opencode/tools/{timeline_lint,timeline_master}.ts 與 gateway/{lint,master}.ts。
入庫批次: 2026-09-27 剪輯域 Agent 能力面活化。
-->

# 質檢閘與母帶導出（qc-master）

## 鐵律

**`timeline_lint` 是閘門：must 級未清不得交付、不得導出。** 不是建議、不是可選步；`timeline_master` 的 export 對 must 未清時間線直接 400 拒（機器層硬閘）。

## 工具鏈

```
timeline_query（摸底）→ timeline_lint（信號層質檢，must/should 分級）→（清 must）→ timeline_master check（聚合質檢：時長／解析度／畫幅 + lint + 響度）→ timeline_master export（過閘才出片）
```

## 逐步配方

1. **摸底**：`timeline_query` 取當前版本號與時長。
2. **信號層 lint**（閘門）：`timeline_lint` 檢 8 類信號項：
   - 視頻：黑幀（`blackdetect`）、白閃、凍結（`freezedetect`）
   - 音頻：爆音、靜音段（`silencedetect`）、音量跳變（`astats`）、音畫時長錯位（`av_mismatch`）
   - 分級：**must / should**；語義層（越軸／動作連續性／光不一致／角色臉一致性／口型同步）**誠實跳過如實 unsupported**。
   - **must 未清 → 停**：回 `timeline_ops` 修（黑幀 → trim／換素材；靜音 → trim 氣口；av_mismatch → 修時長），再重跑 lint。
3. **母帶 check**：`timeline_master` 的 `check` 聚合：時長／解析度／畫幅 + B4 lint + B5 響度；回報 must/should。
4. **導出**：`timeline_master` 的 `export`，預設畫幅 `portrait_916`（豎 9:16）／`landscape_169`（橫 16:9）／`cinema_239`（影院 2.39:1），可含封面幀。
   - **blockers 非空 → 400 拒**（含 `av_mismatch`：聲明時長 > 源 ffprobe 實測時長）。
   - 過閘產物：成片 URL + 質檢報告 + **版本號** + 小結欄位。

## 負向閘（交付驗收必知）

- **宣告時長必須 ≤ 源實測**：`聲明 5s 但源只有 3s` 會被 `av_mismatch` must 攔下，export 400。不要為了符合 `duration_hint` 而虛報時長——回報真實實測值。
- **時長／解析度以 ffprobe 實測為準**，模型自報不算。
- `check ok:true` 只代表 check 過，**不代表 export 過**；交付前的判據是 export 真的產出 URL 且 URL 可取。

## 交付契約（三欄釘死）

回執 JSON 頂層必須帶：
- `ok: true`
- `url`：成片公網 URL（未上傳 gateway 即 `missing_deliverables`）
- `duration_seconds`：成片實測秒數（>0；缺失即 `missing_deliverables`）
- `qc`：**lint／master 的真實質檢結論**（缺失即 `missing_deliverables`——站點側 `editor-delegate.ts` collect 閘門直接判未交付）
- 可選：`timeline_ops_echo`（實際執行操作）、`video_bytes`

**`qc` 空 = 未交付**，不是「先交再補」；成片 URL 有了但 qc 空，交付物組裝閘門照樣拒。
