# 审计 1：重复代码 / 多份副本漂移 / 真源不明

范围：/home/user/Eimu（git 跟踪 4593 个文件；src 下 TS/TSX 约 34.4 万行）。只读审计，未改仓库任何文件（`git status --porcelain` 前后均为 0 行）。

方法与局限：
- 副本组用 `git ls-files -s` 的 blob sha 判定；目录对统计用相对路径比对。
- **git 历史只有 20 个提交，全部在 2026-10-19 至 2026-10-24（`git log --format=%cs | sort | uniq -c`），是开源发布时的压缩历史。** 所以 `git log -1 --format=%cs` 对所有副本都给出同一两天，**无法判断谁更新**。下文"谁更新"一律依据文件内带日期的注释、功能是否存在，以及脚本头部的"真源"声明来判断，每条都标明了依据。
- 含非 ASCII 的路径在 `git ls-files` 里是引号加八进制转义。两侧处理一致，不影响配对，但按字节统计时漏了 13 个这类文件，量级可忽略。
- `src/` 之外没有 `.git` 之外的第二个 src 副本。

---

## 发现 1　【P1】`src/vendor-bridges/gateway` 是 `deploy-staging/gateway` 的静默过期镜像，不过 tsc、不过 CI

【证据】
- 目录对：`deploy-staging/gateway`（310 个文件）↔ `src/vendor-bridges/gateway`（22 个文件）：相同 4，同名不同内容 13，仅 gateway 有 293，仅 vendor-bridges 有 5（4 个 `.test.ts` 加 `subtitle-splitter.ts`）。
- `tsconfig.json:43` 把 `src/vendor-bridges` 排除出类型检查。`.github/workflows/ci.yml:54` 只跑 `tsc -p deploy-staging/gateway`。`.vercelignore:270` 也排除了它。**这个镜像从不被编译。**
- 漂移实例（新旧依据：前者是部署真源，`deploy/vps/gateway-release.sh` 用 `git archive deploy-staging/gateway` 发布）：
  - `deploy-staging/gateway/lint.ts:40` 引入 `./ffmpeg-limiter`，用来限制 ffmpeg 并发，注释写明是"VPS OOM 治本，2026-10-02"。vendor-bridges 版的 `lint.ts` 没有，`runFF` 是旧实现，`resolveLocal(src)` 签名也不同。整个 `ffmpeg-limiter.ts` 在镜像里不存在。diff 共 86 行。
  - `deploy-staging/gateway/timeline.ts:29` 有 `export type { AudioClip, AudioTrack }`，注释说 `mix.ts` 消费它。镜像缺这行（889 行对 892 行）。镜像的 `mix.ts` 因此多半过不了类型检查，但没人编译所以没人知道。
  - `deploy-staging/gateway/director-store.ts:1-25` 内联了 `DIRECTOR_DIR`、`KEEP_RECENT`、`MILESTONE_EVERY`，并带 `DIRECTOR_DATA_ROOT` 隔离修复（"验尸修复 R3-⑧"）。镜像把这些常量搬到 `director-types.ts`，import 路径改成 `../../lib/director-engine/`，还少了 `loadVersion()`。
  - `rhythm.ts` 只差 1 行：`writeFile(local, new Uint8Array(buf))` 对 `writeFile(local, buf)`。
  - 也有反向差异：`editor/subtitleExport.ts`（见发现 5）里镜像更新。
- 各文件 diff 行数（`diff|grep -c '^[<>]'`）：lint 86、mix 57、master 43、director-store 35、director-emit 28、director-types 27、director 20。

【影响】
- 谁都以为 `src/vendor-bridges` 是"可读可编译的源码镜像"，实际是没人维护、不被编译的旧快照。
- 日后有人按镜像改 gateway，或从镜像复制，会把已修复的 OOM、隔离问题带回来。
- 它还被 `src/lib/*.ts` 的注释当作"形状轮子"引用（`blender-tools.ts:5` 等），误导读者。

【建议】
1. 先确认 `src/vendor-bridges` 的消费者（grep 只发现注释引用和 `.vercelignore`，没有 import）。若没有，整个目录归档或删除。
2. 若要保留，写成 `tools/export-*` 机械导出并加 `--check` 进 CI。目前没有任何脚本生成它。
3. 过渡期在目录根放 `README`，写明"非真源"。

---

## 发现 2　【P1】director 引擎有 4 份副本，前端 `src/lib/director-engine` 最新，网关和 opencode 侧都落后，无任何同步机制

【证据】
- 目录对：
  - `src/lib/director-engine`（21 个文件）↔ `deploy-staging/gateway/director-engine`（11 个文件）：相同 6，不同 5，仅 src 有 10，仅 gateway 有 0。
  - `deploy-staging/gateway/director-engine` ↔ `deploy-staging/opencode-runtime/lib/director`（7 个文件）：相同 4，不同 2，仅 gateway 有 5，仅 lib 有 1。
  - `deploy-staging/opencode-runtime/lib/director` ↔ `src/vendor-bridges/lib/director`：**7 对 7 全部相同**，是纯重复。
  - `src/lib/director-engine` ↔ 以上两份 7 文件副本：相同 2，不同 4。
- 同名不同内容的文件：`motionTemplates.ts`（78 行对 108 行，diff 32）、`planning-core.ts`（429 对 504，diff 163）、`playback.ts`（302 对 364，diff 78）、`types.ts`（281 对 297，diff 22）、`svgSchematic.ts`（259 对 257，diff 2）。
- 漂移实例：
  - `src/lib/director-engine/types.ts:153` 新增 27 个武侠动作 id（`'slash' | 'chop' | 'stab' …`），注释"S2 武侠金样补齐"。`grep -c "'slash'"` 的结果：src=1，gateway=0，`opencode-runtime/lib/director/types.ts`=0，`vendor-bridges/lib/director/types.ts`=0。
  - `src/lib/director-engine/motionTemplates.ts:6,58` 新增 `'打斗'` 分类和一整组 `row('打斗', …)`。gateway 版没有。
  - `src/lib/director-engine/planning-core.ts:19` 新 import `./actionClipCatalog`，该文件在 gateway/director-engine 里不存在。
  - 反向：`deploy-staging/gateway/director-engine/svgSchematic.ts:28` 有 `MAX_BYTES = 32*1024`，src 版没有。这是 gateway 侧的补丁没有回流。
- 同步机制：`grep -n director-engine tools/*.ts deploy/` 零命中。**director 家族没有任何导出脚本。**

【影响】
- 前端已有的武侠动作和打斗模板，部署到 VPS 的 gateway 和 agent 工具链识别不了。前端存下的 director 文档，在 gateway 侧可能校验失败或丢动作。
- 4 个目录互相比对只能靠手工，修一处漏三处。

【建议】
1. 定 `src/lib/director-engine` 为唯一真源（它最新，且前端编译它）。
2. 写一个 `export-director-engine` 机械导出（白名单：import 路径、`nanoid`），参照现有 `export-*-staging.ts` 的范式，并带 `--check`。
3. 把 `svgSchematic.ts` 的 `MAX_BYTES` 先回流到 src，再导出。
4. 删掉 `src/vendor-bridges/lib/director`（与 runtime 7 对 7 相同）。

---

## 发现 3　【P1】现有 5 个 `tools/export-*` 导出器在仓库当前状态下 `--check` 全部失败，CI 没有接入，且导出目标被 .gitignore 吞掉

【证据（实际运行 `npx tsx tools/<x> --check`，运行前后 `git status --porcelain` 均为 0 行）】
- `export-music-tools-staging.ts --check`：退出码 1，`ENOENT … staging/music-tools/music_yue2.ts`。
- `export-vision-tools-staging.ts --check`：退出码 1，`ENOENT … staging/vision-tools/vision_tools.ts`。
- `export-web-search-tools-staging.ts --check`：退出码 1，`ENOENT … staging/web-search-tools/web_search_impl.ts`。
- `export-blender-tools-staging.ts --check`：退出码 1，`EXPORT_CHECK_FAIL：staging 稿与机械导出产物不一致（手工漂移或白名单变动）`。
- `export-expert-agents.ts --check`：退出码 1，`deploy-staging/expert-gateway/*（产物缺失）`。
- 根因：`.gitignore:152-153` 写了 `/staging/` 和 `/deploy-staging/*`，只靠白名单例外放行部分目录。`git ls-files -ci --exclude-standard` 显示有 55+8+7+6+5+4+4+… 个文件是"被忽略却被跟踪"的（`staging/music-tools` 8 个、`deploy-staging/blender-*` 约 26 个、`open-source/eimu-music-agent` 55 个等）。新生成的 `music_yue2.ts` 等因此无法入库，`staging/vision-tools`、`staging/web-search-tools` 完全不在仓库里。
- CI：`grep -n "export-\|--check" .github/workflows/ci.yml` 零命中。CI 唯一的相关闸是 `tsc -p deploy-staging/gateway`（`ci.yml:54`）。
- `tools/export-music-tools-staging.ts:26-60` 自己声明了三类状态：`sync`、`preserve`（`music_prompt_director*` 刻意不同步）、`known-drift`（`music_flowmusic.ts`）。也就是说"已知漂移"是被登记的，而不是被消除的。

【影响】
- 脚本头部反复写"根治手工漂移"，实际没有一个能通过自检。
- 导出物不入库，就没有可审的 diff，也无法在 CI 里复现。

【建议】
1. 决定 `staging/` 是产物还是源码：产物则把 `--check` 改成直接对比 `deploy-staging/opencode-runtime/lib`（部署真源）；源码则从 `.gitignore` 去掉。
2. CI 增加 `for s in …; do tsx tools/export-$s --check; done`（先把现有失败修到绿）。
3. 把"已知漂移"清单写进一个文件，限期清零。

---

## 发现 4　【P1】`skills/` 与 `deploy-staging/opencode-runtime/skills/` 整树镜像，占全仓库冗余字节的 76.7%，部署版比源码版新

【证据】
- 目录对：`skills`（625 个文件）↔ `deploy-staging/opencode-runtime/skills`（847 个文件）：相同路径同内容 487，同名不同内容 20，仅 skills 有 118，仅 runtime 有 340。
- 仅 skills 有的 118 个里，114 个是 `SKILL.md` → `RECIPE.md` 的改名（blob 完全一致，`onlyA_but_blob_in_B_elsewhere=114`）。`grep` 证明 `RECIPE.md` 是部署侧约定：`deploy-staging/opencode-runtime/AGENTS.md`、`tools/export-expert-agents.ts` 的"嵌套 SKILL.md→RECIPE.md 规则"。剩下 4 个（`recipes/procedural-modeling`、`sculpting`、`text-to-blender`、`editor/audio-first` 的 SKILL.md）在 runtime 里找不到对应 blob。
- 仅 runtime 有的 340 个文件主要是 `higgsfield`（99）、`fang-wenshan`（22）、`nuyoah-*`（29）、`_prompt-routing`（9）等，没有源码侧对应。
- 体积：`git cat-file` 统计，全仓库总字节 236,240,804，冗余（同 blob 多余副本）14,910,803（6.3%）。其中 `skills + opencode-runtime/skills` 一类就是 11,433,086 字节，609 个冗余副本。单个最大的是 `web-3d-awwwards/docs/screenshots/*.png`（4 张共约 5.96MB 重复一次）。
- 实质漂移（20 个不同文件里，11 个只是 SKILL.md 与 RECIPE.md 措辞，每个 diff 2 行）：
  - `blender-director/SKILL.md`：部署版 137 行，源码版 127 行。部署版 `:16` 多出"## 能力闸门（2026-10-20 现场）"整节（blender_* 工具不可用时的降级顺序）。源码版没有。
  - `music-director/files/DATA_FLOWMUSIC_2026-09.md`：部署版 `valid_as_of: "2026-10-03"`，加了"2026-10-03 re-measure"实测段；源码版仍是 `2026-09-11`。
  - `music-director/SKILL.md`（diff 49 行）、`editor/SKILL.md`（diff 16 行）同理。
- 谁在读源码版：`src/lib/blender-director-persona.ts:93` 的 `DIRECTOR_PERSONA_SKILL_PATH = "skills/blender-director/SKILL.md"`、`src/lib/editor-persona.ts:118-122` 引用 `skills/editor/*/SKILL.md`。**源码路径读到的是过期的那份。**
- 同步机制：无。`deploy/vps/opencode-release.sh` 只把 `deploy-staging/opencode-runtime` 发布到 VPS，不涉及 `skills/`。

【影响】
- 同一个技能在"本地 persona 加载"和"VPS agent 运行"两个入口看到不同内容。2026-10-20 的能力闸门只在 VPS 侧生效。
- 每次改技能要改两处加一次改名，漏一处就漂。

【建议】
1. 选一个真源（实际在被更新的是 `deploy-staging/opencode-runtime/skills`），`skills/` 要么删除，要么改成构建时由脚本生成（含 RECIPE 改名）。
2. 若 `skills/` 只为本地 persona 读取，让 `src/lib/*persona.ts` 直接读 runtime 路径。
3. 先把 4 个 SKILL.md 的内容差异合并回去，再删。

---

## 发现 5　【P1】opencode 工具、lib 的三向副本（runtime ↔ vendor-bridges ↔ vps-tools）：部署版较新，且有行为差异，没有机械同步

【证据】
- 目录对：
  - `deploy-staging/opencode-runtime/tools`（153 个文件）↔ `src/vendor-bridges/opencode-tools`（34 个文件）：相同 20，不同 14，仅 runtime 有 119，仅 vendor-bridges 有 0。
  - `deploy-staging/opencode-runtime/tools` ↔ `deploy-staging/vps-tools`（42 个文件）：相同 7，不同 8，仅 runtime 有 138，仅 vps-tools 有 27。
  - `deploy-staging/opencode-runtime/lib`（282 个文件）↔ `src/vendor-bridges/lib`（13 个文件）：相同 12，不同 1（`client.ts`）。
  - `deploy-staging/gateway/editor` ↔ `src/vendor-bridges/editor`：各 17 个文件，相同 11，不同 6。
- 漂移实例：
  - `deploy-staging/opencode-runtime/tools/director_delete.ts:2` import `directorFail`，vendor-bridges 版没有。`director_create_element`、`manage_plan`、`manage_shot` 等 10 个 director 工具每个都只差这 1 处（各 diff 2 行），说明 vendor-bridges 整批晚于 `director-common` 的一次改动。
  - `opencode-runtime/tools/image_result_download.ts:29` 有 `artifact_is_video` 防护（拒绝把视频当图片下载），vendor-bridges 版没有。
  - `opencode-runtime/lib/client.ts:15` 的 `API_BASE` 走 `process.env.PLATFORM_API_BASE || "https://store.tinchak0207.xyz/image-control/api/v1"`，`:19` 有 `harnessInternalHeaders()`，`:80` 有 `loadModelMediaTypes()`；`src/vendor-bridges/lib/client.ts:11` 仍是写死的 `"https://image.tinchak0207.xyz/v1"`，`grep -c loadModelMediaTypes` 为 0。
  - `deploy-staging/vps-tools/image_get_result.ts`（192 行）和 `opencode-runtime/tools/image_get_result.ts`（69 行）是完全不同的实现，前者没有 journal reconcile。`image_generate.ts` 266 行 diff、`video_result_fetch.ts` 90 行 diff 同理。
  - `vps-tools/canvas_get_state.ts` 头部自称"真源＝opencode-runtime/tools/…；本档＝逐行复制，唯一 diff＝本注释头"，实测 diff 正好 10 行注释头，这几个是准确的。但同目录的 `image_generate/image_get_result/quote_bundle/video_result_fetch` 并不满足这条声明。头部写"机械导出"，却找不到任何导出脚本：`grep -l 机械导出 tools/ deploy/` 只命中 5 个已有的 export-* 脚本，没有一个覆盖 vps-tools。
  - 发现 1 里的 `editor/subtitleExport.ts`（见下）。
- `deploy-staging/gateway/editor/subtitleExport.ts` ↔ `src/vendor-bridges/editor/subtitleExport.ts`，两边各有更好的一半：
  - `:43` 部署版字体 `Style: Default,PingFang SC,…`（macOS 字体，Linux VPS 上没有），镜像版用 `'Noto Sans CJK SC','Source Han Sans SC',sans-serif`。
  - `:48-50` 镜像版对字幕文本转义 `{}`（防 ASS override tag 注入），部署版直接拼接 `c.text`。
  - 这是一个"谁都没有完整修复"的例子，两个方向都需要回流。该对副本没有同步机制，改动方向不能由日期判断（见方法说明），需要人工确认。
- Blender 工具三份：`src/lib/blender-tools.ts`（890 行）、`deploy-staging/blender-gateway/blender_tools.ts`（981 行，`export-blender-tools-staging.ts:23` 的目标）、`deploy-staging/opencode-runtime/lib/blender-tools-impl.ts`（950 行，**没有任何导出脚本覆盖它**）。后两份互相 diff 59 行，实质差异在桥鉴权：staging 版 `bridgeHeaders()` 无条件发 `Authorization: Bearer ${BLENDER_BRIDGE_TOKEN ?? ""}`；runtime 版 `bridgeAuthHeaders()` 只在设了 token 时才发。未设置 token 时，两份行为不同。

【影响】工具层是 agent 真正运行的代码。存在多份实现，就无法确定生产跑的是哪份，修 bug 时也不知道要改几处。

【建议】
1. 明确 `deploy-staging/opencode-runtime` 是 tools/lib 的唯一真源，其他副本（vendor-bridges、vps-tools 内的同名文件）删除或生成。
2. 先人工裁定 `subtitleExport` 两处差异和 Blender 鉴权，再合并。
3. `vps-tools` 里"测试支线稿"类文件若只服务测试，用相对 import 指向 runtime，不要复制。

---

## 发现 6　【P1】music 工具家族共 4 处副本，真源方向反了（生产补丁没有回流 src），第四份在 `open-source/` 里再分叉

【证据】
- 四处位置：`src/lib/music-*.ts`、`staging/music-tools/*`（8 个跟踪文件）、`deploy-staging/opencode-runtime/lib/music*`、`open-source/eimu-music-agent/agent/*`。
- 逐文件行数与 blob：

  | 模块 | src | staging | 部署 lib | open-source |
  |---|---|---|---|---|
  | flowmusic | 321 (`1576591b`) | 365 (`be1bc447`) | 365 (`be1bc447`) | 333 (`be238dca`) |
  | lyria | 420 (`1bba2477`) | 433 (`0d1b6dff`) | 433 (`0d1b6dff`) | 433 (`0d1b6dff`) |
  | yue2 | 507 | **缺失** | 533 | 445 |
  | prompt_director | 35（barrel） | 3 | 3 | 991 |

- 方向：`classifyFlowMusicFailure` 在 `deploy-staging/opencode-runtime/lib/music_flowmusic.ts:50` 和 `staging/…:50` 存在，`src/lib/music-flowmusic.ts` 和 open-source 里 `grep -c` 为 0。`isYue2TransientFailure` 在部署版有 2 处，src 和 open-source 为 0。
- `tools/export-music-tools-staging.ts:26-32` 自己写明：部署树带"src 没有的线上补丁"（FlowMusic 错误分类、YuE2 瞬时重试、9 段 harness-only 代码），`music_prompt_director*` 部署侧是旧版，因此 `preserve` 不同步。
- `staging/music-tools/music_prompt_director.ts` 仅 3 行（barrel），真实内容在 `_defs`、`_pipeline`；open-source 是 991 行的单文件。
- 同步机制：`export-music-tools-staging.ts` 覆盖 src → staging → 部署 lib 的单向复制，**不覆盖 `open-source/eimu-music-agent/agent/`**；`--check` 目前失败（见发现 3）。

【影响】
- "真源"`src/lib` 反而缺生产补丁，下次有人从 src 导出就会覆盖掉部署侧的错误分类和重试逻辑。脚本头部那条"勿回退"的警告就是在防这一点，但靠人记。
- 开源仓库对外发布的是第 4 份旧版。

【建议】
1. 把 `classifyFlowMusicFailure`、`isYue2TransientFailure` 等补丁先回流到 `src/lib`，再让导出重新变成无损。
2. `open-source/` 的 agent 副本改为发布时由同一脚本生成。
3. 解决 `preserve` 项，限期清零。

---

## 发现 7　【P2】被 vendored 的第三方代码：有来源和版本记录，但许可证文本被剥离，通知文件不全

【证据】
- `deploy-staging/opencode-runtime/lib/smartsearch/`：208 个跟踪文件，3,809,140 字节。
  - 上游 fork：`smart_search/`（53 个文件），`UPSTREAM.md` 记录 `konbakuyomu/smartsearch` 版本 0.1.25，commit `916743469d8abf8d6eae300170d2bfd61fae4949`，MIT，目录下有 `LICENSE` 和 `keyless.patch`。记录完整。
  - 依赖 wheel（解压后直接入库）：anyio 47 个文件、httpcore 32、httpx 24、tenacity 13、h11 12、idna 11、sniffio 6、certifi 5、`typing_extensions.py` 1。版本写在 `requirements-vendored.txt`（`anyio==4.15.1`、`httpx==0.28.1`、`certifi==2026.7.22` 等，带 sha256）。
  - 问题 1：该脚本注释写明 `rm -rf lib/smartsearch/*.dist-info`，我用 `git ls-files … | grep -i -E "LICENSE|dist-info|METADATA|NOTICE"` 检查，整个目录只有上游自己的 1 个 `LICENSE`，**各依赖包的许可证文本全部被剥掉**。
  - 问题 2：`requirements-vendored.txt` **没有列 `tenacity`**（`grep -n tenacity` 只在注释里出现），版本 9.1.2 只记在 `UPSTREAM.md:62`。重现 vendor 时 tenacity 会漏。
- `skills/blender-agent-os/img2threejs/`（139 个文件，1,677,103 字节）与 `deploy-staging/opencode-runtime/skills/blender-agent-os/img2threejs/`（139 个文件，1,677,118 字节）：整个外部仓库，带 `.github/`（6 个文件，含 `FUNDING.yml`、`workflows/ci.yml`、`release.yml`）、`LICENSE`、README 声明 Apache-2.0、版本徽章 1.5.0。**两份各一整套**。`THIRD-PARTY-NOTICES.md` 只列了 kunpeng 和 AID 两节，没有 img2threejs，也没有 smartsearch 及其依赖（`grep -n -i "anyio|httpx|certifi|smartsearch|img2threejs"` 只命中无关行）。两份之间有 8 个文件不同（多为 `SKILL.md`→`RECIPE.md` 措辞，另有 `UPGRADE_PLAN.md`、`release_metadata.py`、`test_release_metadata.py` 几处），也就是在外部库上还各自做过手改，但没有补丁记录（对照 smartsearch 有 `keyless.patch`）。
- `vendor/kunpeng`：只有 `PATCHES.md`（28KB 目录，1 个文件），源码副本在 `src/vendor-bridges/editor/`，有 LICENSE，版本 `872a58b`，记录在 `THIRD-PARTY-NOTICES.md:5-37`。记录最完整，但该镜像同时已落后于 `deploy-staging/gateway/editor`（发现 5）。
- 技能树里的外部内容：`blender-director/recipes` 约 160 处带 `License: MIT` 的文件级头；`higgsfield`（131 个文件）、`fang-wenshan`、`nuyoah-*`、`ai-ad-prompt-guide` 的许可证记录情况不一，`higgsfield` 17 个文件提到来源或许可证，目录下没有 LICENSE 文件。
- 许可证性质：certifi 按其公开信息为 MPL-2.0（此点来自常识，不是仓库内容），需要保留许可证文本。

【影响】再分发时缺许可证文本与归属声明，是合规债；img2threejs 复制两份加手改没有记录，升级上游时无法合并。

【建议】
1. 补各依赖的 LICENSE 文本，或在 `THIRD-PARTY-NOTICES.md` 加节；去掉 `rm -rf *.dist-info` 对许可证文件的影响（保留 `*.dist-info/licenses`）。
2. `requirements-vendored.txt` 补 `tenacity==9.1.2 --hash=…`。
3. img2threejs 只留一份，补 `UPSTREAM.md` 和补丁清单，通知文件加一节。

---

## 发现 8　【P2】`src/` 内部的复制粘贴式近重复（函数级，不是整文件）

方法：对非测试、非 vendor-bridges 的 .ts/.tsx 抽取 `function X` / `const X = (` 定义名，统计出现在 3 个及以上文件中的名字（共 1204 个名字，55 个出现于 ≥3 个文件）。整文件级别的 4 行滑窗相似度扫描（只看 ≥60 行有效代码的 627 个文件）几乎没有高相似对，**整文件克隆不多，重复集中在小型工具函数和"每个模块自带一份"的存储样板。**

【证据】
- blob 存储样板：`indexPrefix` / `enqueue` / `listIndexBlobs` / `readBlobDocument` 在 `src/lib/asset-pack-store.ts:140,144,153,364`、`asset-scope-store.ts:78,86,95,122`、`canvas/asset-store.ts:58,62,71,147`、`canvas/project-store.ts:48,52,69,180`、`character-card-store.ts:35,39,48,73`、`creative-project/store.ts:45,50,59,191`、`generation-gate-log.ts:46,50,59,94`、`server-history-store.ts:80,101,113,146`、`upload-record-store.ts:49,53,62,113`、`notification-store.ts:165,176,189` 各自重复定义。去掉泛型后抽样比较：`enqueue` 9 份实现只有 3 种不同函数体，`listIndexBlobs` 3 种，`indexPrefix` 2 种。
- 委派模块样板：`src/lib/` 下 9 个 `*-delegate.ts`（critic 392 行、editor 442、motion 385、blender 362、music 419、screenwriter 448、video 443、web3d 366、lyricist 24 行）。`strField` 出现 8 份，`defaultLoadConstitution` 7 份，`strArrayField` 4 份。两两行级相似度最高 0.66（motion 对 web3d）、0.65（editor 对 video）、0.65（critic 对 motion）。
- 最大的函数名重复：`errorResponse` 35 个文件、`gatewayResponse` 23 个（`src/app/api/agent/*`）、`isRecord` 21、`formatCoins` 12（admin 与 agent-chat 组件）、`ensureSchema` 12、`isPlainObject` 10、`reasonOf` 10。
- 其他：`src/app/api/pixai/edit/route.ts`、`upscale/route.ts`、`template-generations/route.ts` 之间 Jaccard 相似度 0.47/0.46/0.34；`src/components/PricingPlanCarousel/geometry.ts` 与 `canvas-workstation/agent-template-carousel/ring-model.ts` 各自定义 `smoothstep`（0.33）；`PricingPlanCarousel.tsx`（517 行）与 `AgentTemplateCarousel.tsx`（614 行）相似度 0.22。这条与 AGENTS.md"复用/复制现有实现"的规则相关：轮播有两套各自实现的物理参数，改一处不会带动另一处。

【影响】单点修复无法传播（例如 blob 存储的并发队列 bug 要修 10 处）；新模块继续复制样板。

【建议】抽 `blob-index-store` 通用层（`indexPrefix/enqueue/listIndexBlobs/readBlobDocument`）；`delegate-common.ts` 收口 `strField/strArrayField/loadConstitution`；`api-response.ts` 收口 `errorResponse/gatewayResponse`。这是 P2/P3 级，不阻塞，但越晚越贵。

---

## 发现 9　【P3】`patch-gateway.py` 不是同步机制；二进制资源重复

【证据】
- `deploy-staging/patch-gateway.py`（51 行）：文件头 `Patch /opt/agent-harness/gateway/index.ts: zip 内容安检`，直接 `open("/opt/agent-harness/gateway/index.ts")` 做字符串替换并带 `assert "zipProbe" not in src` 一次性保护。它是针对 VPS 现网文件的一次性补丁，不是仓库内同步。它未被 CI 和任何脚本引用，`git grep -c zipProbe -- deploy-staging/gateway` 命中 `uploads-media.ts`（2 处），补丁内容已吸收进仓库真源。
- `deploy/vps/gateway-release.sh:408` 与 `opencode-release.sh:131` 是仓库到 VPS 的发布脚本，不处理仓库内副本之间的同步。
- 二进制/资源重复：`bridge/blender-bridge/blender_addon.py` 与 `public/downloads/eimu-blender-addon.py` 逐字节相同（185,854 字节，`cmp` 验证）；`desktop/build/icon.png` 与 `public/icon-512.png` 相同（266,402 字节）；`docs/preview/13-work-2.webp`、`promo-video/assets/showcase4.webp`、`public/showcase/showcase4.webp` 三份相同（各 311,658 字节）；`docs/preview/*.png` 与 `open-source/eimu-music-agent/figs/*.png` 两张海报相同（702,101 和 701,555 字节）；`promo-video/assets` 与 `public/showcase` 有多张相同。
- 14 个跟踪文件是空 blob（`e69de29…`），多半是 `__init__.py` 之类。

【影响】体积和维护成本小，但 `public/downloads/eimu-blender-addon.py` 是手工复制的用户可下载物，与 bridge 源码一旦分叉用户拿到的就是旧版。

【建议】下载物改为构建期复制（`prebuild` 脚本），不要双份入库。

---

# 同步机制覆盖表（结论）

| 副本关系 | 有无机械同步 | 状态 |
|---|---|---|
| src/lib/music-* → staging/music-tools → opencode-runtime/lib | `export-music-tools-staging.ts` | `--check` 失败，已知漂移被登记（发现 3、6） |
| src/lib/music-* → open-source/eimu-music-agent/agent | 无 | 纯手工，已分叉（发现 6） |
| src/lib/blender-tools.ts → blender-gateway/blender_tools.ts | `export-blender-tools-staging.ts` | `--check` 失败 |
| blender_tools.ts → opencode-runtime/lib/blender-tools-impl.ts | 无 | 纯手工，鉴权行为已不同（发现 5） |
| src/lib/vision-tools.ts、web-search-tools.ts → staging/* | `export-vision/web-search-tools-staging.ts` | 目标目录不在仓库，`--check` ENOENT |
| EXPERT_REGISTRY → expert-gateway + gateway/expert/ | `export-expert-agents.ts` | 产物缺失，`--check` 失败 |
| src/lib/director-engine → gateway/director-engine → runtime/lib/director → vendor-bridges/lib/director | 无 | 纯手工，已漂移（发现 2） |
| deploy-staging/gateway → src/vendor-bridges/gateway、editor | 无 | 纯手工，镜像过期（发现 1、5） |
| runtime/tools、lib → vendor-bridges/opencode-tools、lib | 无 | 纯手工，已漂移（发现 5） |
| runtime/tools → vps-tools | 部分文件头自称"机械导出"，找不到脚本 | 4 个文件已分叉（发现 5） |
| skills/ ↔ opencode-runtime/skills | 无（约定 SKILL.md→RECIPE.md 改名由人执行） | 20 个文件漂移，部署版更新（发现 4） |
| 仓库 → VPS | `gateway-release.sh`、`opencode-release.sh`（`git archive`） | 正常，但发布对象是 deploy-staging，不是 src |
| 现网补丁 | `patch-gateway.py` | 一次性脚本 |

# 量化总表（均来自本次实际运行的命令）

| 指标 | 数值 | 命令 |
|---|---|---|
| git 跟踪文件数 | 4593 | `git ls-files \| wc -l` |
| 唯一 blob 数 | 3881 | `git ls-files -s` 去重 |
| 重复 blob 组 / 组内文件数 / 冗余副本 | 672 / 1384 / 712 | 同上 |
| 总字节 / 冗余字节 / 占比 | 236,240,804 / 14,910,803 / 6.3% | `git cat-file --batch-check` |
| 冗余字节中 skills 镜像一类 | 11,433,086（609 个副本，占冗余 76.7%） | 同上按目录归类 |
| 空 blob 文件数 | 14 | 同上 |
| 被忽略却被跟踪的文件 | `open-source/eimu-music-agent` 55、`staging/music-tools` 8、`deploy-staging/blender-*` 约 26 等 | `git ls-files -ci --exclude-standard` |
| `.git` 目录大小 | 187M | `du -sh .git` |
| git 提交数 / 日期跨度 | 20 / 2026-10-19 至 2026-10-24 | `git log` |
| gateway ↔ vendor-bridges/gateway | 相同 4 / 不同 13 / 仅 gateway 293 / 仅镜像 5 | 目录对比 |
| gateway/director-engine ↔ src/lib/director-engine | 相同 6 / 不同 5 / 仅 src 10 | 同上 |
| runtime/lib/director ↔ vendor-bridges/lib/director | 相同 7 / 不同 0 | 同上 |
| skills ↔ runtime/skills | 相同 487 / 不同 20 / 仅 skills 118（其中 114 为改名） / 仅 runtime 340 | 同上 |
| runtime/tools ↔ vps-tools | 相同 7 / 不同 8 / 仅 runtime 138 / 仅 vps-tools 27 | 同上 |
| runtime/tools ↔ vendor-bridges/opencode-tools | 相同 20 / 不同 14 / 仅 runtime 119 | 同上 |
| runtime/lib ↔ vendor-bridges/lib | 相同 12 / 不同 1 / 仅 runtime 269 | 同上 |
| gateway/editor ↔ vendor-bridges/editor | 相同 11 / 不同 6 | 同上 |
| `tools/export-*` 脚本数 / `--check` 通过数 | 5 / 0 | 实际运行 |
| CI 中调用 `export-*` 或 `--check` 的次数 | 0 | `grep` ci.yml |
| smartsearch 目录文件数 / 字节 | 208 / 3,809,140 | `git ls-files` + `cat-file -s` |
| img2threejs 副本数 / 单份文件数 / 单份字节 | 2 / 139 / 约 1,677,103 | 同上 |
| `THIRD-PARTY-NOTICES.md` 涉及的第三方 | 2 节（kunpeng、AID） | `grep '^## '` |
| src 内同名函数出现在 ≥3 个文件的名字数 | 55（共 1204 个函数名） | 正则扫描 |
| `errorResponse` / `gatewayResponse` / `isRecord` / `formatCoins` | 35 / 23 / 21 / 12 个文件 | 同上 |
| blob 存储样板重复文件数 | 10 | 同上 |
| `*-delegate.ts` 数量 / 相似度最高一对 | 9 / 0.66 | difflib |

# 优先处理顺序（建议）

1. 先裁定真源：director-engine → `src/lib`；tools/lib → `deploy-staging/opencode-runtime`；skills → `deploy-staging/opencode-runtime/skills`；music → 先把线上补丁回流 src。
2. 把 5 个导出器的 `--check` 修绿并接入 CI（发现 3），并让 `staging/` 的归属明确。
3. 删除或降级 `src/vendor-bridges`（发现 1，其中 `lib/director` 与 runtime 完全相同可直接删）。
4. 补第三方许可证文本、`tenacity` 的 requirements、img2threejs 的通知与单份化（发现 7）。
5. 人工裁定三个已确认的行为差异：Blender 桥鉴权头、`subtitleExport` 的字体和 `{}` 转义、`image_result_download` 的视频防护。
