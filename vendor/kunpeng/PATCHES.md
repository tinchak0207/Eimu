# PATCHES — kunpeng vendor 轮子复制记账

- 轮子来源：`/home/user/Desktop/kunpeng-vendor`（pengfeiqiao/kunpeng，MIT），pin commit `872a58b`，复制时工作区干净（无未提交改动）。
- 复制纪律：整档逐行 cp；白名单只允许 import 路径行改写，其余任何一行不许动。
- 本档记录每一笔白名单改动（档:行 → 改前/改后 → 理由），供后续 vendor 升级双向 diff。
- 本轮拆片方案：`eval-qinshihuang-polarbear/F-SHARDING.md` 片1（纯 A 类 5 档）。
- 目标镜像本地为 `src/vendor-bridges/editor/`（对应 VPS 部署树 `/opt/eimu-harness/gateway/editor/`），相对 import 路径两边同构。

## 白名单改动清单（片1，2026-08-29）

1. `src/vendor-bridges/editor/presets/filterPresets.ts:5`
   - 改前：`import type { ClipFilter } from '@/stores/editorStore';`
   - 改后：`import type { ClipFilter } from '../adapter/editorStore';`
   - 理由：kunpeng `@/` alias（→ vendor `src/`）在 harness 树不存在；方案目标树中 store 替身落位 `editor/adapter/editorStore.ts`（片2 产物），从 `presets/` 子目录出发相对路径为 `../adapter/editorStore`。目标模块尚不存在，import 解析错误为预期（待片2补）。

2. `src/vendor-bridges/editor/subtitleExport.ts:4`
   - 改前：`import type { SubtitleCue, EditorAspect } from '@/stores/editorStore';`
   - 改后：`import type { SubtitleCue, EditorAspect } from './adapter/editorStore';`
   - 理由：同上，editorStore 替身（片2）落位 `editor/adapter/editorStore.ts`，从 editor 根出发为 `./adapter/editorStore`。目标模块尚不存在，预期解析错误（待片2补）。

3. `src/vendor-bridges/editor/subtitleExport.ts:5`
   - 改前：`import { aspectOutputSize, isPortraitAspect } from '@/lib/editor/aspect';`
   - 改后：`import { aspectOutputSize, isPortraitAspect } from './aspect';`
   - 理由：方案片1白名单明文「`@/lib/editor/` → 相对路径」；aspect.ts 同为本片产物，落位于 editor 根，故 `./aspect`。

## tsc 归因验证（2026-08-29，片1验收）

- image-app `npx tsc --noEmit`：本片 5 档共产出 5 条错误，全仓无其他新增错误——3 × TS2307（缺模块：`../adapter/editorStore`×1、`./adapter/editorStore`×1 → 待片2；`./renderGraph`×1 → 待片5）+ 2 × TS7006（renderBackends.ts:70 `acc`/`n` 隐式 any）。
- TS7006 归因：vendor 候 tsc 实测 renderBackends.ts 零错误（renderGraph 在位时 `graph.nodes` 有类型、回呼参数可推断）；故该 2 条是 L1 `./renderGraph` 解析失败的下游效应，非复制引入，待片5补档后消失。非语法错误，不计失败。

## 未改动即合规的 import（备案）

- `src/vendor-bridges/editor/renderBackends.ts:1` — `import type { RenderGraph } from './renderGraph';`：方案明文「renderBackends 的 `./renderGraph` 不变」。renderGraph.ts 是片5产物，当前不存在 → 预期 import 解析错误（待片5补），非本片失败项。
- `editor/aspect.ts`、`editor/presets/transitionPresets.ts`：vendor 原档零 import，逐行等价，无任何改动。

## 非代码合规落盘（非白名单偏差）

- `src/vendor-bridges/editor/LICENSE` — vendor MIT LICENSE 逐字节副本（方案 §6 风险1：「LICENSE 副本须随 editor/ 目录落盘」）。

---

## 白名单改动清单（片3：fx 边界替身 + ffmpeg 探测，2026-08-29）

新档两份（均为方案明文的抽取档，非整档 cp）：`src/vendor-bridges/editor/adapter/fxRenderStub.ts`、`src/vendor-bridges/editor/canvas/videoCompose.ts`。

1. `fxRenderStub.ts:16`（vendor fxRender.ts:19 改写）
   - 改前：`import { DEFAULT_FX_TRANSFORM, useEditorStore, type EditorRenderError, type TextClip, type FxClip } from '@/stores/editorStore';`
   - 改后：`import type { TextClip, FxClip } from './editorStore';`
   - 理由：片3 抽取面只有 5 个导出签名 + hashContent + 类型块，签名只消费 `TextClip`/`FxClip` 两类型；其余绑定（DEFAULT_FX_TRANSFORM/useEditorStore/EditorRenderError）属 Chromium worker 渲染层本体，不在抽取面。`@/stores/editorStore` → `./editorStore`（片2 产物，同目录）。

2. `canvas/videoCompose.ts:11-13`（vendor videoCompose.ts:7/9/11 改写）
   - 改前：`import { convertFileSrc, invoke } from '@tauri-apps/api/tauri';` + `import { homeDir } from '@tauri-apps/api/path';` + `import { isWindowsSync } from '@/lib/platform';`
   - 改后：三条统一 `from '../adapter/tauri-adapter'`（`invoke` / `homeDir` / `isWindowsSync`）
   - 理由：方案片5 白名单同映射（`@tauri-apps/*` → adapter、`@/lib/platform` → `./adapter/tauri-adapter`）；adapter 是片4 产物，当前缺档 → TS2307 × 3 为待片4 预期态（与片1 备案的 renderGraph 同类）。vendor:7 的 `convertFileSrc` 探测面用不到，未随档。

3. `canvas/videoCompose.ts:22`（vendor L20 `shellQuote`）
   - 计划明文抽取段为 L21-48，但 Windows 候选分支引用 `shellQuote`，缺它 tsc 不过；逐行随档，记为「计划行段 +1 依赖行」。

4. `fxRenderStub.ts` 四函数抛错体（buildTextClipDoc/buildFxClipDoc/renderFxTimelineLayer/renderFxTimelineOpaqueSegments）
   - 全方案唯一非逐行偏差（F-SHARDING §6 风险2 授权），契约 = 同签名诚实抛错。文案 = 任务指定「特效/花字渲染层未接入：纯拼接场景不需要；带字幕烧录需 Chromium worker 农场另立项」+ 方案原文「fx 渲染需 Chromium，harness 场景不支援」。vendor fxRender L17 的 Vite `?raw`（MOTION_RUNTIME_SRC）确认隔离在替身之外，不进 Bun 解析器。

### 类型块逐行抽取（diff 等价备案）

- `FxDoc`（fxRender.ts L29-32）、`FxLayerResult`（L464-469）、`FxSegmentLayerResult`（L471-475，vendor L476 尾随空行并入文档流）、`FxTimelineLayerItem`（L477-482）、`FxTimelineProgress`（L486-494）、`hashContent`（L42-46）——逐块 diff = IDENTICAL。
- vendor fxRender.ts:485 的本地 `interface CommandResult` 不随档（fxRender 内部用，非抽取面）；videoCompose 侧的 `CommandResult`（vendor L13）随档（detectFfmpeg 泛型实参所需）。

## 验收记录（2026-08-29，片3）

- diff：hashContent（vendor fxRender.ts L42-46）与 ffmpegCandidates+detectFfmpeg（vendor videoCompose.ts L21-48）对目标档逐行 `diff` = IDENTICAL。
- `npx tsc --noEmit | grep vendor-bridges`：renderBackends 3 条（片5 前基线，不变）+ `videoCompose.ts` 3 × TS2307（`../adapter/tauri-adapter` 待片4）；`fxRenderStub.ts` 0 错（签名对片2 类型全过）。
- 实弹（/tmp 测试钩子，resolve hook 把 `../adapter/tauri-adapter` 重定向到 `bash -lc` 契约替身模拟片4，跑真实 shipped 档，非副本）：`detectFfmpeg() => "ffmpeg"` + `ffmpeg version n9.0.1`——本机候选前三位（`~/.kunpeng/bin/ffmpeg`、`/opt/homebrew/bin/ffmpeg`、`/usr/local/bin/ffmpeg`）127 落空，第 4 位 PATH 命中，vendor 循环语义如实；stub 4 函数运行时抛错文案逐一验证；`hashContent('kunpeng') = kbzut9`、`hashContent('') = 45h`（djb2 初值 5381 的 base36，正确）。
- 事故记录：fxRenderStub.ts 初版头注释含 `build*/render*` 字样，`*/` 提前终结块注释 → TS1127 一串；改写为「build* 及 render*」。教训：块注释内不得出现 `*/` 字样。

---

## 白名单改动清单（片4：tauri 适配器，2026-08-29）

新档两份：`src/vendor-bridges/editor/adapter/tauri-adapter.ts`（Tauri IPC 命令面 Bun 替身，本片主交付）、`src/vendor-bridges/editor/adapter/artifactsStub.ts`（工件注册表替身，片5 import 改写表 `@/lib/artifacts`→`./adapter/artifactsStub` 的落盘依赖）。

语义基准（kunpeng @ 872a58b，逐点对照）：`src-tauri/src/tools/bash.rs` execute_command(L320)/kill_command(L465)、`src-tauri/src/commands.rs` get_home_dir(L7)/ensure_workspace(L165)、`src-tauri/src/tools/file_ops.rs` append_file(L262)、`@tauri-apps/api`（tauri.invoke / fs.createDir|exists|removeDir / path.homeDir）、`src/lib/platform.ts`（userAgentPlatform/isWindowsSync/stopBackgroundProcessCommand）。

白名单逐笔：

1. `execute_command` 命令通道（方案 §2 明文）
   - 改前（vendor Rust）：`/bin/zsh -c` + `unsetopt EQUALS` 前缀，tokio Command + `process_group(0)`。
   - 改后：`Bun.spawn(['bash','-lc',cmd])`，返回 `{ stdout, stderr, exit_code }` 同构（Rust CommandResult 8 字段中前端 composeEngine/videoCompose 本地 interface 只消费这 3 个；`output_id`/`*_total_chars`/`*_truncated` 属 read_command_output 分页面，无前端消费，不随）。
2. timeout 语义：缺省 120000ms（对齐 bash.rs `unwrap_or(120_000)`）；自管 timer → SIGKILL 树杀；超时 reject 文案对齐 vendor `Command timed out after Nms`；被信号杀 `exit_code = -1`（对齐 `status.code().unwrap_or(-1)`）。
3. `kill_command`（方案 §4 片4「kill 语义（AbortSignal → SIGKILL）」）：vendor 为进程组 `killpg` TERM→1.5s grace→SIGKILL；Bun.spawn 无 `process_group(0)` 等价 → 进程表（requestId→pid，对应 BashProcessState.active）+ 树杀复用 `stopBackgroundProcessCommand(pid, true)` Unix 分支公式（pkill -KILL -P 先杀直接子进程、再 kill -KILL 父，顺序保证 reparent 前可寻址）。表内无此 id 静默 Ok（对齐 vendor pgid None）。
4. `get_home_dir` / `homeDir`（@tauri-apps/api/path）：`dirs::home_dir()` → `process.env.HOME`；缺失时抛同文案 `Cannot find home directory`。
5. `ensure_workspace`（方案 §3 存储路径注入明文）：vendor `~/.kunpeng/workspace/YYYY-MM-DD/` 日期分桶 + images/code/docs/videos 四子目录 → harness 固定 `/opt/eimu-harness/workspace/kunpeng`（env `KUNPENG_WORKSPACE` 可覆写），`mkdir -p` 即返；日期分桶与四子目录不随（composeEngine 自己 `ensureDir(`${workspace}/videos`)`）。
6. `createDir` / `exists` / `removeDir`：@tauri-apps/api/fs 同签名子集 → `node:fs/promises` mkdir/access/rm（recursive 缺省 false 同 tauri 语义）。
7. `append_file`：file_ops.rs L262 语义逐点对齐（先 mkdir 父目录，再 create+append；任一失败即抛）。
8. platform 替身（方案 §1.1 明文「isWindowsSync()=false、替身内固定 'linux'」）：
   - `userAgentPlatform`：vendor navigator.userAgent 判别（3 行）→ 固定 `return 'linux'`（唯一白名单函数体改写点）。
   - `isWindowsSync`、`stopBackgroundProcessCommand`（含 Windows 分支与 JSDoc）：vendor 逐行随档，diff 等价。
   - `getShellInfo` / `isPosixShell` / `osDisplayName`（shell_info IPC 面）：composeEngine/videoCompose 零消费，不随。
9. Bun 全局最小类型面 `declare`：本仓 tsc 无 bun-types，仅声明适配器消费的子集（spawn/stdin/stdout/stderr/cwd/pid/exitCode/exited/kill）；运行时由真 Bun（VPS 1.3.14）或实弹脚本同构注入满足。
10. stdin 显式 `'ignore'`：vendor 继承父进程 stdin；gateway 为 systemd 服务 stdin 为 null，显式 ignore 防交互挂起。
11. 未替身命令（`read_dir` 等）诚实抛错，文案列明替身面五命令。

artifactsStub（方案 §1.1 行 appendArtifact 明文「替身：no-op / JSONL 日志」）：

- `ArtifactType` / `ArtifactEntry` / `typeFromPath`：vendor 逐行随档（diff 等价）。
- `appendArtifact`：改写为 JSONL 追加 `${HOME}/.kunpeng/artifacts.jsonl`（vendor 写 Tauri Home 目录 `artifacts-manifest.json`，harness 无 Tauri fs）；串行写队列（manifestQueue）+ dedupe-by-path + 失败吞错文案 `[artifacts] append failed:` 同 vendor。
- scanner（`listArtifacts`/`scan_dir_meta` IPC）：UI 专用，composeEngine 零消费，不随。

## 验收记录（2026-08-29，片4）

- `npx tsc --noEmit | grep vendor-bridges`：`videoCompose.ts` 3 × TS2307（`../adapter/tauri-adapter`）全部消失；剩余仅 `renderBackends.ts` 3 条（`./renderGraph` 缺档 TS2307 ×1 + 下游 TS7006 ×2，片5 前预期态）；零新增。
- 实弹 15/15 PASS（`/tmp/kp4-smoke.mts` 临时脚本，用完已删）：本机 Arch Linux 无 bun，脚本以 node:child_process 注入 `Bun.spawn` 同构替身（stdout/stderr ReadableStream + exited + exitCode + kill），适配器代码原样走 `Bun.spawn` 调用路径——**Bun 真实实弹留待 VPS 片6 环境闭合时验证**。覆盖：`echo ok`（任务点名）→ `{"stdout":"ok\n","stderr":"","exit_code":0}`；ensure_workspace env 注入；get_home_dir；createDir/exists/removeDir 闭环；append_file；`stat -c '%Y:%s'`（方案判定标准）；`mkdir -p`（方案判定标准）；`ffmpeg -version`（n9.0.1，方案判定标准）；detectFfmpeg 片3→片4 契约闭环命中 `ffmpeg`；kill_command SIGKILL（exit_code=-1，113ms）；timeoutMs 超时 reject（`Command timed out after 500ms`）；isWindowsSync=false；stopBackgroundProcessCommand 树杀实弹（后台 sleep 60 被杀，kill -0 确认）；未知命令诚实抛错；appendArtifact JSONL 落盘。
- 发现备案（不改轮）：composeEngine `fileFingerprint` 公式 `stat -f '%m:%z' || stat -c '%Y:%s'` 在 GNU Linux 下 BSD 语法 fallback 也退出 0，stdout 含文件系统报告头 + 尾段 `mtime:size`——vendor 桌面版 Linux 行为相同，输出仅作 Pass1 缓存哈希输入不解析，键确定性强（mtime/size 变则键变），语义不破坏。

---

## 白名单改动清单（片5：主钉，2026-08-29）

整档逐行 cp 两份（pin 872a58b）：`src/vendor-bridges/editor/composeEngine.ts`（1,173 行）、`src/vendor-bridges/editor/renderGraph.ts`（203 行）。除下列 import 路径行外 diff 逐字节等价，函数体/常量/文案零改动。

### composeEngine.ts（9 行 / 7 条 import 语句改写）

1. `composeEngine.ts:18`
   - 改前：`import { invoke } from '@tauri-apps/api/tauri';`
   - 改后：`import { invoke } from './adapter/tauri-adapter';`
   - 理由：方案片5 白名单「`@tauri-apps/*`→adapter」；invoke = 片4 tauri-adapter 同签名导出。
2. `composeEngine.ts:19`
   - 改前：`import { createDir, exists, removeDir } from '@tauri-apps/api/fs';`
   - 改后：`import { createDir, exists, removeDir } from './adapter/tauri-adapter';`
   - 理由：同上；fs 三函数 = 片4 node:fs/promises 同签名替身。与 L18 分两条语句 import 同一模块，保持 vendor 行结构最小改动。
3. `composeEngine.ts:20`
   - 改前：`import { stopBackgroundProcessCommand } from '@/lib/platform';`
   - 改后：`import { stopBackgroundProcessCommand } from './adapter/tauri-adapter';`
   - 理由：任务改写表明文 `@/lib/platform`→`./adapter/tauri-adapter`；片4 已逐行随档该函数。
4. `composeEngine.ts:24`
   - 改前：`} from '@/stores/editorStore';`
   - 改后：`} from './adapter/editorStore';`
   - 理由：任务改写表明文；片2 产物（useEditorStore/EXPORT_RESOLUTIONS/五类型均已在位）。
5. `composeEngine.ts:25`
   - 改前：`import { detectFfmpeg } from '@/lib/canvas/videoCompose';`
   - 改后：`import { detectFfmpeg } from './canvas/videoCompose';`
   - 理由：任务改写表明文；片3 产物。
6. `composeEngine.ts:36`
   - 改前：`} from './fxRender';`
   - 改后：`} from './adapter/fxRenderStub';`
   - 理由：任务改写表明文；片3 stub 导出面与 vendor fxRender 五函数+两类型同签名（FxSegmentLayerResult/FxTimelineProgress 随档）。
7. `composeEngine.ts:38`
   - 改前：`import { appendArtifact } from '@/lib/artifacts';`
   - 改后：`import { appendArtifact } from './adapter/artifactsStub';`
   - 理由：任务改写表明文；片4 产物。

未改动即合规的 import（备案）：L26 `./presets/transitionPresets`、L27 `./presets/filterPresets`、L37 `./subtitleExport`（片1 产物，vendor 原相对路径直接命中）；L39 `./renderGraph`（本片落位后解析成功）；L40 `./renderBackends`、L41 `./aspect`（片1 产物）。全档 import 仅 L18-41，无动态 `import()`，无其他改动点。

### renderGraph.ts（2 行改写）

1. `renderGraph.ts:8`
   - 改前：`import { useEditorStore, EXPORT_RESOLUTIONS, type EditorAspect } from '@/stores/editorStore';`
   - 改后：`from './adapter/editorStore'`（片2 产物；EditorAspect 已在替身类型面）。
2. `renderGraph.ts:9`
   - 改前：`import { aspectOutputSize } from '@/lib/editor/aspect';`
   - 改后：`from './aspect'`（片1 产物）。

## 验收记录（2026-08-29，片5）

- diff（对 vendor 872a58b 逐字节）：composeEngine.ts 差异块仅 18-20/24-25/36/38 共 9 行（全为 import）；renderGraph.ts 差异块仅 8-9 共 2 行。其余 1,364 + 201 行逐字节等价。
- `npx tsc --noEmit | grep vendor-bridges`：零命中；全仓 `grep -c 'error TS'` = 0（整个 image-app tsc 干净）。片1 备案的 renderBackends.ts 3 条（TS2307 `./renderGraph` ×1 + 下游 TS7006 ×2）随 renderGraph 落位全部消失，归因闭合。
- `npm test`：1225 pass / 0 fail，与本片落地前基线完全一致，全仓不因本片变红。
- 待决清单：无——14 条 import 全部落在方案/任务改写表内，无自造、无替身缺口。
- 方案 §4 片5 判定标准中的 `bun build editor/composeEngine.ts` 留待 VPS 片6 环境闭合时执行（本机无 bun，与片4 备案同因）；tsc 全仓零错已覆盖类型解析面。


## 片6（gateway 挂载，2026-08-29，orchestrator 内联接管——subagent 两次撞并发上限阵亡）

- VPS `/opt/eimu-harness/gateway/editor/` = 本地 `src/vendor-bridges/editor/` 整树逐档 md5 等价（13 档对账通过）。
- `index.ts`：film 分支占位 return → `assembleFilmNode`（唯一函数级改动）+ 静态路由 Content-Type 加 `.mp4 → video/mp4` 一行（成片交付必要项）。model 解析三级/报价/confirm 零触碰。
- `assembleFilmNode` 白名单内组合：收集上游 video 产物 → title 最前/shotN 升幂 → **store URL 直映射本盘 `/opt/image-data-api/data`**（VPS 内 fetch 公网回环会挂死，实弹发现）→ ffprobe 逐段真时长 → setHarnessState 注入 → `exportSelectedMainClips` → `probeRenderedVideo` 校验门（≥输入总长 90%）→ TTS 同款公网目录，costCoins: 0。
- 本地辅助行（非轮子改动）：`shq` 引号函数一行内联（轮内 shellQuote 为模块私有，不扩其导出面）。
- 终极实弹：Bun 1.3.14 真身（VPS），7 段真实素材 36.225s 输入 → 成片 36.248s / 1280x720 / h264，PASS（`/tmp/qsbear-film-test.ts` 可重放）。bun build 门禁 + smoke health/auth/agent_text 3 PASS。
