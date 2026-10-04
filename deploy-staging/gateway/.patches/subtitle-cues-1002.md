# Patch：成片装配接入「字幕轨 + 标题字」（2026-10-02）

**目标档**：`deploy-staging/gateway/workflow-gw.ts`（`assembleFilmNode` 内，唯一函式）
**配对档（已部署，不需重放）**：`deploy-staging/gateway/editor/composeEngine.ts` 的 `exportSelectedMainClips`
（新增字幕烧录；见文末「配对契约」）

> ⚠️ baseline = owner 12:27 版（本 patch 作者动手时的 `workflow-gw.ts`）。owner 之后会再改并部署，
> **行号一定会对不上**。请只认下方每个 hunk 的「锚点」，在新版上按语义重放，不要硬套行号。
> 本档已于 12:30 随 owner 整目录同步误上 VPS 一次（md5 `93d876f9…`）；owner 收工后请以本 patch 重放为准。

---

## Hunk 1／3：`sources` 多带 `role`（+2 行）

**改了什么**：`assembleFilmNode` 内 `sources` 的 map/filter 型别各加 `role: n.role` / `role: string`。

**锚点**（插入/改动点前后原文，baseline 行 819-826）：

```
  const allVideoUpstream = incoming
    .map((from) => graph?.nodes.find((n) => n.id === from))
    .filter((n): n is VideoUpstream => Boolean(n) && typeof n.id === "string" && n.kind === "video")
  const sources = allVideoUpstream
    .map((n) => ({ id: n.id, url: upstream.get(n.id) }))            ← 改这两行
    .filter((s): s is { id: string; url: string } => Boolean(s.url))
  // 配音混流素材：上游 audio 节点（TTS mp3）的内容 URL，成片后自动混入音轨。
```

**为什么必要**：字幕文本要按「镜头 role → 分镜脚本 text 节点」对位；`sources` 原本丢掉 role，
只剩 id/url，无法反查脚本节点。（`VideoUpstream` 型别本来就有 `role`，只是映射时没带出来。）

**拿掉会怎样**：Hunk 2 的 `subTextOfShot(sources[i].role)` 取不到 role → 编译错；或退化成用 id 硬猜。

```diff
   const sources = allVideoUpstream
-    .map((n) => ({ id: n.id, url: upstream.get(n.id) }))
-    .filter((s): s is { id: string; url: string } => Boolean(s.url))
+    .map((n) => ({ id: n.id, role: n.role, url: upstream.get(n.id) }))
+    .filter((s): s is { id: string; role: string; url: string } => Boolean(s.url))
```

---

## Hunk 2／3：在逐镜 probe 回圈之后，建构字幕 cue 与标题 cue（+31 行）

**改了什么**：`clipSecs` 累积完（`clipIds.push`/`clipSecs.push` 的 for 回圈结束）之后、
`setHarnessState({...})` 之前，插入字幕/标题 cue 建构。

**锚点**（baseline 行 886-892）：

```
      const sec = Number.isFinite(dur) && dur > 0 ? dur : 0
      if (sec <= 0) return { nodeId, ok: false, error: "成片环读不到镜头时长（ffprobe 失败），拒绝盲拼" }
      totalInputSec += sec
      clipIds.push(`h${i}`)
      clipSecs.push(sec)
    }                                        ← 这个 for 回圈的右大括号之后插入
    setHarnessState({                        ← 插在这一行的前面
```

**为什么必要**：这是要接的「字幕轨 + 标题字」本体——把真实文本与时间轴算成 `SubtitleCue[]`，
下一 hunk 才喂进 composeEngine。

**拿掉会怎样**：`setHarnessState` 没有 `subtitles`，字幕/标题不会进画面（即修复前的现状）。

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

## Hunk 3／3：`setHarnessState` 补 `subtitles`（+1 行）

**改了什么**：现有 `setHarnessState({ clips, aspect, exportSettings })` 多一个键 `subtitles: subtitleCues`。

**锚点**（baseline 行 902-905）：

```
      aspect: "16:9",
      exportSettings: { ...DEFAULT_EXPORT_SETTINGS, resolution: "720p", fps: 24 },
    })                                       ← 在右大括号前加一行
    const outPath = await exportSelectedMainClips(clipIds)
```

**为什么必要**：这是唯一的写入口——`exportSelectedMainClips` 从 `useEditorStore.getState()` 读
`s.subtitles`，只有经 `setHarnessState` 写进去，composeEngine 才看得到字幕轨。

**拿掉会怎样**：Hunk 2 算出的 cue 全部丢弃，等于没接。

```diff
       aspect: "16:9",
       exportSettings: { ...DEFAULT_EXPORT_SETTINGS, resolution: "720p", fps: 24 },
+      subtitles: subtitleCues,
     })
     const outPath = await exportSelectedMainClips(clipIds)
     const probe = await probeRenderedVideo(ffmpeg, outPath)
```

---

## 字幕 cue 的资料来源（接手验什么）

| 内容 | 真源 | 取值方式 |
|---|---|---|
| 每镜字幕文本 | `graph.nodes` 中 `kind === "text"` 且 `role === <镜头 role 去掉 `_video` 后缀>` 的节点 | `metadata.content`（次 `text`、再 `prompt`，与 TTS 端 `runNode` 的 `meta?.text ?? meta?.content ?? meta?.prompt` 同口径） |
| 每镜时间轴 | 各镜头成片段经 ffprobe 探得的时长 `clipSecs[]`，按 `sources` 排序（title 最前、shotN 升幂）累加 | 既有的逐镜 probe 回圈 |
| 标题字 | `node.metadata.project_title`（仅测试/harness 注入）→ 否则 `stateForWorkflow.sessionTitle`（＝会话标题／项目标题，opencode 首条讯息后异步生成） | 直取，不新造抽取 |
| 叠字处理 | 标题 cue 占 `[0, min(3s, 首镜时长)]`，首镜字幕 `startSec` 被抬到 `titleEnd` 后 | 同一 ASS `Default` 样式同区不叠字 |

真实样本（验证用）：workflow `wf_muq3d4wv_1` 的分镜节点 `feature_film-shot1/2/3`（role=`shot1/2/3`，
`kind=text`，`metadata.content` 为真实分镜脚本）；标题＝ session `9b346621…` 的 `title`
「日系治愈番30秒短片PV制作为mp4」。

---

## 配对契约（composeEngine 侧，已部署）

`exportSelectedMainClips`（`editor/composeEngine.ts`）在 concat 之后新增一段：若
`s.subtitles`（非 disabled）非空 → `writeTextViaShell` 产 ASS（`toAss(s.subtitles, s.aspect)`）→
`ffmpeg -vf "subtitles='<ass>'"` 重编码烧录 → `mv` 回 `outPath`。逐行复制自同档
`composeEditorTimeline` 既有实现（ASS 生成 L1021-1026 ＋ `subtitles=` 滤镜 L1106-1110）。
**只依赖 `setHarnessState` 传入 `subtitles` 这个契约**；`workflow-gw` 三个 hunk 就是产生这个契约的生产者。
`composeEngine.ts` 无 owner 冲突，已上 VPS（md5 `1f57d0a7c424a2fa7ea6fb02e747e653`）。

## 验收要点（重放后怎么证）

1. `grep -c subtitleCues workflow-gw.ts` ≥ 5（Hunk 2 的 4 处 + Hunk 3 的 1 处）。
2. 重组一次成片（既有素材、零上游呼叫），抽帧看：首 3 秒画面下方有标题、各镜时段下方有分镜字幕。
3. 客观墨迹量测：同时间点 burn 帧 vs 无字幕控制帧，底部字幕带亮/暗像素大幅增加、上方区域 Δ≈0。
