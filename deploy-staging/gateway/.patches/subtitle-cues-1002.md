# Patch：成片裝配接入「字幕軌 + 標題字」（2026-10-02）

**目標檔**：`deploy-staging/gateway/workflow-gw.ts`（`assembleFilmNode` 內，唯一函式）
**配對檔（已部署，不需重放）**：`deploy-staging/gateway/editor/composeEngine.ts` 的 `exportSelectedMainClips`
（新增字幕燒錄；見文末「配對契約」）

> ⚠️ baseline = owner 12:27 版（本 patch 作者動手時的 `workflow-gw.ts`）。owner 之後會再改並部署，
> **行號一定會對不上**。請只認下方每個 hunk 的「錨點」，在新版上按語義重放，不要硬套行號。
> 本檔已於 12:30 隨 owner 整目錄同步誤上 VPS 一次（md5 `93d876f9…`）；owner 收工後請以本 patch 重放為準。

---

## Hunk 1／3：`sources` 多帶 `role`（+2 行）

**改了什麼**：`assembleFilmNode` 內 `sources` 的 map/filter 型別各加 `role: n.role` / `role: string`。

**錨點**（插入/改動點前後原文，baseline 行 819-826）：

```
  const allVideoUpstream = incoming
    .map((from) => graph?.nodes.find((n) => n.id === from))
    .filter((n): n is VideoUpstream => Boolean(n) && typeof n.id === "string" && n.kind === "video")
  const sources = allVideoUpstream
    .map((n) => ({ id: n.id, url: upstream.get(n.id) }))            ← 改這兩行
    .filter((s): s is { id: string; url: string } => Boolean(s.url))
  // 配音混流素材：上游 audio 節點（TTS mp3）的內容 URL，成片後自動混入音軌。
```

**為什麼必要**：字幕文本要按「鏡頭 role → 分鏡腳本 text 節點」對位；`sources` 原本丟掉 role，
只剩 id/url，無法反查腳本節點。（`VideoUpstream` 型別本來就有 `role`，只是映射時沒帶出來。）

**拿掉會怎樣**：Hunk 2 的 `subTextOfShot(sources[i].role)` 取不到 role → 編譯錯；或退化成用 id 硬猜。

```diff
   const sources = allVideoUpstream
-    .map((n) => ({ id: n.id, url: upstream.get(n.id) }))
-    .filter((s): s is { id: string; url: string } => Boolean(s.url))
+    .map((n) => ({ id: n.id, role: n.role, url: upstream.get(n.id) }))
+    .filter((s): s is { id: string; role: string; url: string } => Boolean(s.url))
```

---

## Hunk 2／3：在逐鏡 probe 迴圈之後，建構字幕 cue 與標題 cue（+31 行）

**改了什麼**：`clipSecs` 累積完（`clipIds.push`/`clipSecs.push` 的 for 迴圈結束）之後、
`setHarnessState({...})` 之前，插入字幕/標題 cue 建構。

**錨點**（baseline 行 886-892）：

```
      const sec = Number.isFinite(dur) && dur > 0 ? dur : 0
      if (sec <= 0) return { nodeId, ok: false, error: "成片环读不到镜头时长（ffprobe 失败），拒绝盲拼" }
      totalInputSec += sec
      clipIds.push(`h${i}`)
      clipSecs.push(sec)
    }                                        ← 這個 for 迴圈的右大括號之後插入
    setHarnessState({                        ← 插在這一行的前面
```

**為什麼必要**：這是要接的「字幕軌 + 標題字」本體——把真實文本與時間軸算成 `SubtitleCue[]`，
下一 hunk 才餵進 composeEngine。

**拿掉會怎樣**：`setHarnessState` 沒有 `subtitles`，字幕/標題不會進畫面（即修復前的現狀）。

```diff
       clipIds.push(`h${i}`)
       clipSecs.push(sec)
     }
+    // 字幕轨 + 标题字（2026-10-02 接线）：字幕文本真源 = 各镜头上游分镜脚本 text 节点
+    // metadata.content（同 TTS 取文本口径 text→content→prompt，非新造抽取逻辑）；
+    // 时间轴 = 各镜头成片段时长累加。标题字真源 = 会话标题（项目标题）。两者交给
+    // composeEngine 既有字幕烧录轮子（toAss + `subtitles=` 滤镜）落进画面。
+    const subTextOfShot = (videoRole: string): string => {
+      const shotRole = videoRole.replace(/_video$/, "")
+      const scriptNode = graph?.nodes.find((n) => n.role === shotRole && n.kind === "text")
+      const md = scriptNode?.metadata
+      const raw = typeof md?.content === "string" ? md.content : typeof md?.text === "string" ? md.text : typeof md?.prompt === "string" ? md.prompt : ""
+      return raw.trim()
+    }
+    // 标题字真源 = 会话标题（项目标题；opencode 首条消息后异步生成），
+    // 生产走 stateForWorkflow.sessionTitle；harness/测试可经 metadata.project_title 注入。
+    const projectTitle = String(
+      (node.metadata as Record<string, unknown>).project_title ?? stateForWorkflow?.sessionTitle ?? "",
+    ).trim()
+    const subtitleCues: { id: string; startSec: number; endSec: number; text: string }[] = []
+    {
+      let cursor = 0
+      for (let i = 0; i < sources.length; i += 1) {
+        const text = subTextOfShot(sources[i].role)
+        if (text) subtitleCues.push({ id: `sub_${i}`, startSec: cursor, endSec: cursor + clipSecs[i], text })
+        cursor += clipSecs[i]
+      }
+      if (projectTitle) {
+        const titleEnd = Math.min(3, Math.max(1, clipSecs[0] ?? 3))
+        subtitleCues.unshift({ id: "title", startSec: 0, endSec: titleEnd, text: projectTitle })
+        // 标题与首镜字幕同区不叠字：首镜字幕从标题退场后开始。
+        if (subtitleCues.length > 1) subtitleCues[1].startSec = Math.max(subtitleCues[1].startSec, titleEnd)
+      }
+    }
     setHarnessState({
```

---

## Hunk 3／3：`setHarnessState` 補 `subtitles`（+1 行）

**改了什麼**：現有 `setHarnessState({ clips, aspect, exportSettings })` 多一個鍵 `subtitles: subtitleCues`。

**錨點**（baseline 行 902-905）：

```
      aspect: "16:9",
      exportSettings: { ...DEFAULT_EXPORT_SETTINGS, resolution: "720p", fps: 24 },
    })                                       ← 在右大括號前加一行
    const outPath = await exportSelectedMainClips(clipIds)
```

**為什麼必要**：這是唯一的寫入口——`exportSelectedMainClips` 從 `useEditorStore.getState()` 讀
`s.subtitles`，只有經 `setHarnessState` 寫進去，composeEngine 才看得到字幕軌。

**拿掉會怎樣**：Hunk 2 算出的 cue 全部丟棄，等於沒接。

```diff
       aspect: "16:9",
       exportSettings: { ...DEFAULT_EXPORT_SETTINGS, resolution: "720p", fps: 24 },
+      subtitles: subtitleCues,
     })
     const outPath = await exportSelectedMainClips(clipIds)
     const probe = await probeRenderedVideo(ffmpeg, outPath)
```

---

## 字幕 cue 的資料來源（接手驗什麼）

| 內容 | 真源 | 取值方式 |
|---|---|---|
| 每鏡字幕文本 | `graph.nodes` 中 `kind === "text"` 且 `role === <鏡頭 role 去掉 `_video` 後綴>` 的節點 | `metadata.content`（次 `text`、再 `prompt`，與 TTS 端 `runNode` 的 `meta?.text ?? meta?.content ?? meta?.prompt` 同口徑） |
| 每鏡時間軸 | 各鏡頭成片段經 ffprobe 探得的時長 `clipSecs[]`，按 `sources` 排序（title 最前、shotN 升冪）累加 | 既有的逐鏡 probe 迴圈 |
| 標題字 | `node.metadata.project_title`（僅測試/harness 注入）→ 否則 `stateForWorkflow.sessionTitle`（＝會話標題／項目標題，opencode 首條訊息後異步生成） | 直取，不新造抽取 |
| 疊字處理 | 標題 cue 佔 `[0, min(3s, 首鏡時長)]`，首鏡字幕 `startSec` 被抬到 `titleEnd` 後 | 同一 ASS `Default` 樣式同區不疊字 |

真實樣本（驗證用）：workflow `wf_muq3d4wv_1` 的分鏡節點 `feature_film-shot1/2/3`（role=`shot1/2/3`，
`kind=text`，`metadata.content` 為真實分鏡腳本）；標題＝ session `9b346621…` 的 `title`
「日系治愈番30秒短片PV制作为mp4」。

---

## 配對契約（composeEngine 側，已部署）

`exportSelectedMainClips`（`editor/composeEngine.ts`）在 concat 之後新增一段：若
`s.subtitles`（非 disabled）非空 → `writeTextViaShell` 產 ASS（`toAss(s.subtitles, s.aspect)`）→
`ffmpeg -vf "subtitles='<ass>'"` 重編碼燒錄 → `mv` 回 `outPath`。逐行複製自同檔
`composeEditorTimeline` 既有實現（ASS 生成 L1021-1026 ＋ `subtitles=` 濾鏡 L1106-1110）。
**只依賴 `setHarnessState` 傳入 `subtitles` 這個契約**；`workflow-gw` 三個 hunk 就是產生這個契約的生產者。
`composeEngine.ts` 無 owner 衝突，已上 VPS（md5 `1f57d0a7c424a2fa7ea6fb02e747e653`）。

## 驗收要點（重放後怎麼證）

1. `grep -c subtitleCues workflow-gw.ts` ≥ 5（Hunk 2 的 4 處 + Hunk 3 的 1 處）。
2. 重組一次成片（既有素材、零上游呼叫），抽幀看：首 3 秒畫面下方有標題、各鏡時段下方有分鏡字幕。
3. 客觀墨跡量測：同時間點 burn 幀 vs 無字幕控制幀，底部字幕帶亮/暗像素大幅增加、上方區域 Δ≈0。
