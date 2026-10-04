# Kunpeng 五项对称差 · 深度调查存档（2026-08-27）

> 调查对象：pengfeiqiao/kunpeng v2.9.16（MIT，Tauri+React+three.js 桌面应用）。方法：5 个 subagent 并行深挖源码 + 实跑测试。本文是 `docs/kunpeng-bridge-prd.md` 的支撑材料。

## 总览

全部真实系统、非 demo。README 三处注水：风格「245 种」实为 161 条；审片「P0–P8」实为六类口癖；「百万赞」无证据。开源构建预设排除内容资产（aigc-memory 素材图），但仓库内档案可 clone。

| 项目 | 规模 | 真实度 | 系统本质 |
|---|---|---|---|
| 静态资产 | index.json 440KB + 改写器 | 测试 25/25 过 | 结构化风格四件套 + LLM 改写链 |
| ASR/配音 | ~2,800 行 | 无测试、无 stub | M1-M5 五模组系统 |
| 3D 导演台 | ~7,700 行 | 零测试、零 stub | 序列化工程 + 纯函数求值器 |
| AI 剪辑 | 12,991 行 | 0 测试、0 stub | FFmpeg 三段式 + 审片证据链 |
| Harness | 桥 1,094 + runtime 945 + Rust 1,074 | 22/22 过 | 官方包内嵌 + 双桥架构 |

## A. 静态资产

- `aigc-memory/style-library/index.json`：161 条风格，每条 `promptTemplate / visualDNA / cameraLanguage / promptSuffix` 四件套（无负向词/参数）
- 消费链：`StyleLibraryPicker` 选风格 → `styleRewriter.ts`（DNA+镜头语言=system prompt，模板=输出范例，LLM 改写）→ 注入生图节点
- 另有 `prompt-templates/`（seedance/kling/gpt-image-2 可执行模板）、`shot-patterns/`、`checklists/pre-generation.md`（17 条门禁）
- 开源版 tauri-build 仅在作者私建时打包 aigc-memory/skills

## B. ASR/配音系统蓝图（模型只占一角）

```
媒体 → [M1 ffmpeg 管线] → 16kHz mono wav / COS 公网 URL
工坊 → [M4 TTS 编排] → dubbing/落盘 → trim 对齐 → 时间轴
[M2 ASR 状态机] → Transcript{words 词级} → [M5 审片证据链] → 只标记不自动剪
[M3 计费安全] 贯穿 M2/M4
```

- M1（transcribe.ts）：整轨合成一条 wav 只识别一次（atrim/asetpts/atempo/volume→concat→amix，anullsrc 静音占位），时间戳天然是时间轴座标；分块 24MiB/均分/并发 2
- M2：豆包 AUC 协议（X-Api-Key 头、X-Api-Status-Code 状态码 20000000/1/2、轮询 60×3s）；结果契约 `utterances[{text, words[{w,startSec,endSec,blankMs?}]}]`
- M4：工坊逐角色 `audioPrompts[{characterId,prompt}]` → 音色 base64 参考 → `dubbing/{镜号}-{角色}.mp3` → trim 等比例裁切对齐；文字内嵌「参考录音N」绑 1-10 条参考 URL；轮询 4s/10min/退避 30s
- M5 证据链五证据：raw 重转写（并发 3）、pause_pattern（词级 blankMs，可降级）、energy_xcorr ≥0.62（纯本地）、filler 本地正则、LLM 语义（批量 6×2）；词边界吸附 + 剪后 ±1.2s 验证
- M3：PaidSubmissionUnknownError（禁自动重发）vs PaidTaskCreatedError（续查）；429/40001=余额不足

**groq 移植**：唯一缺口 blank_duration → 词间隙/silencedetect 补，审片全保。

## C. 3D 导演台

- 纯函数求值器 `evaluateDirectorFrame`（playback.ts:179）：无 three 依赖，播放/离线渲染/agent 三端共用
- 白模 ref#1 闭环（finalRender.ts:44）：白模锁构图，prompt 明示不保留灰模材质 → gpt-image-2/seedream → seedance 成片
- 几何健康检查（playback.ts:230）：越轴/入地/碰撞/动作跳变
- 57 动作（三角函数关节角）+ 27 运镜模板（球坐标 K 帧）+ 12 姿势；四层产出：截图/预演 MP4/分镜图/成片
- 15 个 director_* agent 工具（两阶段确认、导出强制手动确认）

## D. 剪辑

- FFmpeg 三段式（Pass1 归一含曲线变速→Pass2 concat/xfade→Pass3 合成）+ Chromium worker 花字特效（逐帧 PNG→alpha.mov→overlay）；分步落盘 + hash 快取 + 成片 ffprobe 校验门
- 审片六类：filler/repeat/pause/stutter/rambling/manual；只标记不自动剪 + 剪后边界验证
- renderGraph IR + renderBackends 决策器（内建 FFmpeg→native 迁移路径）

## E. Harness

- 内嵌官方 `@deepseek-ai/dsh@0.1.0-rc.6`（199 包），fork 的 ACP 桥仅 94 行差异（image 块支援）
- 双桥：ACP 管会话/流 + MCP 管工具（TCP→Rust→webview ToolRegistry，保留风险确认）；取消=杀子进程
- 只读 observer 边车（stderr `__KUNPENG_DSH_EVENT__`）：思考/用量/压缩事件，零改官方源码
- visibleOutput 防重放 + MCP 媒体 6MiB 内联预算
- 限制：官方 rc.6 不支援 session resume
