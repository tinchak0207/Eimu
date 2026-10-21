# Kunpeng 资产包桥接 PRD（轮子钉版）

> 状态：草案 · 2026-08-27
> **读取规则（写死）**：每个 spec 的第一栏是「轮子钉」= 能力的源代码在 kunpeng 仓库的**确切档案路径**。实现 = 复制该档全文到目标路径，只改白名单栏位。**任何 spec 找不到轮子钉 = 不许开工，先回查**。禁止从零实现任何轮子钉指向的能力。

## 0. 暴君主线（目标，一句话/包）

一条 30 秒口播短剧：现在暴君要过 7 站（拆剧本半天、风格试错 7 轮、配音排期 2 小时、剪辑 4 小时）；接入后 = 一句话 → 工坊自动拆 → 风格一键 → 自动配音对齐 → 审片标记 → 暴君只在「确认」与「审美」下车。技术细节见附录，**spec 表是唯一施工依据**。

---

## 1. 包 A：风格资产（P0）

| Spec | 轮子钉（kunpeng 源档） | 复制到（我们） | 白名单（只准改这些） | 判定 |
|---|---|---|---|---|
| A1 风格资产载入 | `aigc-memory/style-library/index.json`（440KB，161 条四件套：promptTemplate/visualDNA/cameraLanguage/promptSuffix）+ `src/lib/styleLibrary.ts`（TS 型别与载入） | `vendor/kunpeng/style-library/` 原样 + 我们 loader | 无（资料契约一行不动） | diff 等价；161 条全量载入 |
| A2 风格→提示词改写 | `src/lib/styleRewriter.ts`（DNA+镜头语言=system prompt，模板=输出范例，走 LLM 改写） | `src/vendor-bridges/style/` 原样 | LLM 呼叫端点/金钥注入点 | diff 除白名单逐行等价；试错轮数 ≤1 |
| A3 风格卡 UI | `StyleLibraryPicker.tsx`（分类页签+搜寻+onApply 交互） | 挂载到工作台 | 事件汇流排名称、import 路径 | 交互逻辑 diff 等价 |
| A4 提交前门禁 | `aigc-memory/checklists/pre-generation.md`（17 条规则） | 内容原样复制；转 agent 门禁规则 = 桥层改编 | 只准转格式，不准改规则语义 | 17 条逐一对应 |

**禁造**：风格四件套结构、改写 prompt 结构（三段式）、UI 交互逻辑。

## 2. 包 B：ASR/配音（P0，渠道 = groq）

| Spec | 轮子钉（kunpeng 源档） | 复制到（我们） | 白名单（只准改这些） | 判定 |
|---|---|---|---|---|
| B1 音讯管线 M1 | `src/lib/editor/transcribe.ts`（460 行：整轨 filter_complex 合成、`anullsrc` 静音占位、16kHz mono、分块 24MiB/均分/并发 2、`-ss` 快速 seek） | 后端 worker `src/vendor-bridges/audio/` | ffmpeg 路径注入、COS 端点 | diff 等价；时间戳 = 时间轴座标 |
| B2 ASR 结果契约 | `src/lib/doubaoAsr/client.ts` 的结果形状 `utterances[{text,words[{w,startSec,endSec,blankMs?}]}]`（型别照搬；提交协议换 groq 同步化） | 同上 | 端点/认证头；**结果契约形状禁改** | groq 返回映射后契约逐栏等价 |
| B3 TTS 编排 M4 | `src/lib/kuaizi/seedAudio.ts`（克隆标记「参考录音N」、轮询 4s/10min/退避 30s、429/40001 余额映射）+ 工坊 `generate.ts` 的逐角色落盘（`dubbing/{镜号}-{角色}.mp3`）+ `trim.ts`（等比例裁切 min 0.1s） | 后端 worker | 供应商端点/金钥（渠道注册进 supplier registry） | diff 等价；落盘结构与对齐行为一致 |
| B4 审片证据链 M5 | `src/lib/editor/speechAudit/`（1,005 行：engine/audio/verify/prompt/types——五证据、词边界吸附、剪后 ±1.2s 验证、只标记） | 后端 worker | LLM 判定走我们网关（注入点） | diff 等价；证据链五种全保 |
| B5 波形/节拍 | `src/lib/editor/waveform.ts`（50 桶/秒+快取）+ `beatDetect.ts`（能量阈值） | 同上 | 无 | diff 等价 |
| B6 计费安全 | **不搬代码**：kunpeng 的 M3（PaidSubmissionUnknown/PaidTaskCreated）语义由我们三阶段计费覆盖 | — | — | 无重复扣费（现有测试） |

**禁造**：filter_complex 合成链、分块算法、轮询/退避/并发数值（2/3/6×2/4s/10min/30s）、证据链判定逻辑、结果契约。

## 3. 包 C：3D 导演台（P1，白模→分镜先行）

| Spec | 轮子钉（kunpeng 源档） | 复制到（我们） | 白名单（只准改这些） | 判定 |
|---|---|---|---|---|
| C1 导演工程契约 | `src/lib/director/types.ts`（v2 序列化 schema） | `src/vendor-bridges/director/` | 无 | diff 等价 |
| C2 纯函数求值器 | `src/lib/director/playback.ts` 的 `evaluateDirectorFrame`（:179-221，无 three 依赖）+ `inspectDirectorPlan`（:230-302 几何健康检查） | 同上 | 无 | diff 等价；播放/离线/agent 三端共用 |
| C3 素模/姿势/镜头/动作 | `mannequin.ts`（11 关节）+ `poses.ts`（12 姿势）+ `presetCameras.ts` + `cameraTemplates.ts`（27 运镜）+ `motionTemplates.ts`（57 动作）+ `pathCurve.ts` | 同上 | 无 | diff 等价 |
| C4 生成闭环 | `src/lib/director/finalRender.ts`（白模 ref#1、prompt「不保留灰模材质」结构）+ `export.ts` | 同上 | 生图/影片渠道注入（我们供应商） | 闭环行为一致 |
| C5 agent 工具 | `src/lib/agent/tools/directorTools.ts`（15 个 director_* 工具：id/入参/出参/两阶段确认/导出强制手动确认） | 注册进我们 AgentToolRegistry | 事件名/artifact 映射 | 工具 id 与契约照搬 |
| C6 UI | `DirectorStage.tsx`（2,625 行） | 挂载工作台（three.js 浏览器原生） | 存储适配（工程 JSON 落我们存储） | 交互逻辑 diff 等价 |

**禁造**：素模骨骼/姿势/运动生成、球坐标镜头、求值器、健康检查规则、工具契约。

## 4. 包 D：剪辑审片（P1 审片 / P2 渲染）

| Spec | 轮子钉（kunpeng 源档） | 复制到（我们） | 白名单（只准改这些） | 判定 |
|---|---|---|---|---|
| D1 审片 | **与 B4 同一个轮子**（speechAudit/）——不写第二份 | 见 B4 | 见 B4 | 见 B4 |
| D2 渲染引擎 | `src/lib/editor/composeEngine.ts`（1,173 行 FFmpeg 三段式+快取+ffprobe 校验门）+ `fxRender.ts`（1,199 行 Chromium worker 特效）+ `renderGraph.ts`（IR+后端决策器） | P2 立项，worker 农场 | 渲染后端选择（native/FFmpeg） | 成片强制 probe 校验 |

**禁造**：Pass1/2/3 渲染链、花字逐帧管线、校验门。

## 5. 包 E：Harness（观望）

不排期。可偷设计点（双桥/边车/visibleOutput 防重放）已记入网关 backlog，spec 待官方 dsh 稳定后补钉（轮子 = `src/lib/agent/dsh/` + `dsh-runtime/`）。

---

## 附录 A：Vendor 规则（执行时强制）

- 源：pengfeiqiao/kunpeng，pin commit `872a58b`（2026-08-27）；调查存档 `docs/2026-08-27-kunpeng-symmetry-survey.md`
- 复制 = 整档复制，白名单之外一行不许改；每笔白名单改动记 `vendor/kunpeng/PATCHES.md`（档:行 → 改前/改后 → 理由）
- 验收门：`git diff` 对照源仓库，过滤白名单后逐行等价；不等价 = 没做完，不许交货
- 挂载点：`AgentToolRegistry.register()`（扩展点已有测试）；产出走 `canvas.ops`；计费走三阶段；B 端 `/v1/audio/transcriptions`（verbose_json 带词级）+ `/v1/audio/speech`
- 风险：MIT 合规（THIRD-PARTY-NOTICES 追加）；素材图商用前确认授权（index.json 文字无碍）；groq 缺 blank_duration → 词间隙/silencedetect 降级（kunpeng 现成 fallback，不新发明）
