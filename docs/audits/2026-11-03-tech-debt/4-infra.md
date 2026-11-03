# 审计 4：Agent 网关 / 运行时 / 部署与运维技术债

审计方式：只读。所有数字来自 `git ls-files` / `grep` / `wc` 的实际输出（工作目录 /home/user/Eimu，git 共 20 次提交，HEAD=c035f0a）。未改任何仓库文件，未调用任何生产网络。
范围：deploy-staging/、deploy/、render.yaml、vercel.json、next.config.mjs、desktop/、mcp-server/、bridge/、.github/workflows/ci.yml。
注：本仓库是开源镜像快照（提交 `9d4ee73 Update open-source release: sync to image tip fcd0e656`），所以「生产真源」在 repo 之外这一点天然存在，下文只评估 repo 内可见的证据。

---

## F1 【P1】部署链只有一半入库：repo 能发布，但「服务本身怎么装」不在 repo
**证据**
- 已入库的发布脚本：`deploy/vps/gateway-release.sh`（602 行，git archive → release 目录 → 原子 symlink）、`opencode-release.sh`（476 行，白名单同步）、`deploy-control-plane.sh`（500 行）、`import-prebuilt-image.sh`（25 行）、`prompt-release.sh`（29 行）。
- 全仓库 `*.service` 只有 1 个：`deploy-staging/blender-bridge-tunnel/blender-bridge-tunnel.service`（而且是笔记本侧的，ExecStart 写死 `/home/lenovo/.nvm/.../node /home/lenovo/Desktop/image-app/...`，见该文件第 11 行）。
- 文档里提到但 repo 没有的 unit/脚本：`agent-gateway.service`、`opencode-server.service`（只有 drop-in：`deploy/vps/systemd/opencode-server.oom.conf` 等 3 个 `.conf`）、`agent-poller.service`、`eimu-asr.service`、`dsh-groq-tunnel.service`、`blender-bridge.service`，以及 `/opt/agent-harness/deploy.sh`（`git ls-files | grep deploy.sh` 无结果）。`gateway-release.sh:37` 明说「服务闸门重用既有轮子 `sudo /opt/agent-harness/deploy.sh`」——这个闸门（flock + bun build 语法闸 + restart + healthz）不在 repo，无法审计、无法重建。
- `gateway-release.sh:42` 自陈：「未验证假设（本脚本只在本机做过 `bash -n` 与 `--dry-run`，从未对生产执行）」，下面列了 A–G 共 7 条未验证假设（包括 systemd unit 的 WorkingDirectory 是否走同一路径）。
- 同一份 opencode drop-in 有两个互相矛盾的版本：`deploy/vps/systemd/opencode-server.oom.conf`（17 行，含 MemoryMax=1800M、MemorySwapMax=0、StartLimit）vs `deploy-staging/vps-tools/systemd/opencode-server.oom.conf`（5 行左右，无 MemoryMax）。`diff` 有差异；哪份是生产现役，repo 内无法判定。
**影响** repo 不能从零重建生产（缺 unit、缺 deploy.sh、缺 env 模板中除控制面外的部分）；换机/灾备依赖人脑与 VPS 现场。重复且分叉的 drop-in 会让人拿旧版覆盖新版。
**建议** 把 agent-gateway / opencode-server / agent-poller / eimu-asr 的 unit 与 `/opt/agent-harness/deploy.sh` 入库到 `deploy/vps/systemd/`（单一位置，删掉 vps-tools 里的重复 drop-in）；`gateway-release.sh` 的 A–G 假设逐条在预发验证后改写成事实；加一个 `bootstrap-vps.sh`（幂等）。

## F2 【P1】多个服务仍靠手工、非 repo 工具部署，且有一处在生产机上 build
**证据**
- poller：`deploy-staging/poller/README.md:83-95` 的部署命令是 `node .dsh-ssh/exec-443.js "echo $(base64 -w0 ...) | base64 -d > /opt/agent-harness/poller/$f"` 逐档覆盖 + `systemctl restart`。`.dsh-ssh/` 与 `.pixai-refresh/start-ssh443.sh` 都不在 repo（`git ls-files | grep -c dsh-ssh` = 0），README 的路径还写死 `/home/lenovo/Desktop/image-app`。没有 drain、没有备份、没有回滚、没有校验和。
- flowmusic2api：`deploy-staging/flowmusic2api/README.md:60-95` 的配方是在生产机上 `git clone https://github.com/genz27/FlowMusic2API`（未固定 commit，取默认分支 HEAD）→ `git apply fix-p1p2-20261003.patch` → `sudo docker build` → `sed -i` 改 compose 的 image。补丁打在「上游当天的 HEAD」上，上游一动补丁就可能 apply 失败或悄悄偏移；README 自己也说「上游更新时需重新 clone → 重新套本补丁 → 重新 build」。这是在承载在线服务的主机上原地 build，与 AGENTS.md「生产构建事故禁令」同类风险（Go 构建比 Next 轻，但仍占 IO/内存）。
- 补丁文件两个：`fix-p1p2-20261003.patch`（12695 字节）、`fix-session-commit-20261008.patch`（7144 字节）；repo 里只有 3 个 `.go`（accounts.go / flowmusic.go / config_store.go）作为「补丁后快照」，没有 go.mod，无法在 repo 内编译验证补丁。
- `deploy/vps/docker-compose.yml`（105 行）的 nextjs / generation-worker 服务用 `build: ./app`，即在生产机上 build，与 `deploy-control-plane.sh:19-26` 里「禁止原地全量构建」的硬拒绝相矛盾。
- ASR：`deploy-staging/vps-tools/asr-service/` 只有 `engine.py` 一个文件，但它 `from .audio / .config / .models / .resources import ...`（engine.py:10-13），这 4 个模块不在 repo ——整个服务无法重建。
**影响** 这几个组件的「生产跑的是哪一版」无法用 repo 验证（对比 gateway/opencode 已有 recon 闸）；回滚靠人工 tag；flowmusic 补丁不可重现。
**建议** poller 套用 gateway-release.sh 的模式（release 目录 + symlink + 回滚），把 exec-443.js 入库或改用标准 ssh；flowmusic 固定上游 commit SHA（git clone 后 `git checkout <sha>`）并在离机构建镜像、推 registry；补全或删除 asr-service；删除/改写 docker-compose.yml 的 `build:`。

## F3 【P2】原地 patch 脚本遗留：6 个 patch 脚本 + 2 个 .patch，其中 patch-gateway.py 已失效
**证据**
- `git ls-files` 中的 patch 类文件：`deploy-staging/patch-gateway.py`（51 行）、`blender-director-persona/patch-agent-models.py`、`patch-director-dispatch.py`、`patch-opencode-agent.py`、`blender-bridge-tunnel/patch-blender-auth.py`、`flowmusic2api/*.patch`×2、`opencode-runtime/lib/smartsearch/keyless.patch`。
- `patch-gateway.py:3,5` 直接对 `/opt/agent-harness/gateway/index.ts` 做字符串锚点替换（`src.replace(ANCHOR_HELPER, HELPER + ANCHOR_HELPER, 1)`），读写同一个活文件。其内容已被吸收进 `deploy-staging/gateway/uploads-media.ts`（`grep -c zipProbe` = 2），而 `index.ts` 里 `async function handleAttachmentUpload` 匹配数 = 0，所以今天再跑它会在 `assert ANCHOR_HELPER in src` 处失败（安全失败，但文件仍在 repo 里诱人误用）。
- `patch-director-dispatch.py` 的文档头自己写着「锚点 = 08-31 现状 … 先 diff live 档再对齐锚点，禁硬改」，且目标是 `/opt/agent-harness/gateway/index.ts` 与 `subagent.ts`；`index.ts` 已被拆成 310 个文件，这些锚点都已过期。`blender-gateway/PATCH-PLAN.md`（12794 字节）、`blender-director-persona/PATCH-PLAN.md`（8192 字节）、`blender-bridge-tunnel/TUNNEL-PLAN.md`（18105 字节）是同类「计划稿」。
- `docs/runbooks/infra-debugging.md:43-47,72` 记载过「VPS 上直接改 index.ts → `bun build index.ts` → `systemctl restart agent-gateway`」的现场修复流程（08-20 的历史）。
**影响** 过期 patch 与 PLAN 稿占据 deploy-staging 下 5 个目录，新人无法分辨哪些还是流程的一部分；原地修改活文件正是「repo 不是真源」的根源，现在已有 gateway-release.sh 取代，但旧脚本没有被标记作废。
**建议** 把已吸收的 patch-*.py / PATCH-PLAN.md 移到 `docs/archive/` 或删除（git 历史保留），在 `deploy-staging/README` 写明唯一合法路径是 release 脚本；`.patch` 文件只保留仍需对上游生效的。

## F4 【P1】CI 覆盖面窄：deploy-staging 的测试一个都不跑，gateway 类型闸被放宽，且与生产解析的依赖不同
**证据（.github/workflows/ci.yml，3 个 job，全部 `runs-on: [self-hosted, eimu-local]`）**
- `typecheck`：`npm ci` + `npx tsc --noEmit`。根 `tsconfig.json` 的 `exclude`（第 36–45 行）排除了 `mcp-server`、`plugins`、`deploy-staging`、`staging`、`open-source`、`**/*.test.ts`。
- `gateway-typecheck`（ci.yml:36-56）：`npm install --prefix deploy-staging/gateway --no-package-lock`（ci.yml:49）——忽略已入库的 `bun.lock`，依赖按 `nanoid ^3` / `bun-types ^1.4.2` 现解析。gateway 实际由 Bun 运行（`package.json` 的 `"start": "bun run index.ts"`，40 个文件使用 `bun:sqlite`/`Bun.*`），CI 用 node+tsc，类型来自 `bun-types` 而非 Bun 运行时本身。`deploy-staging/gateway/tsconfig.json` 把 `strictNullChecks` 与 `noImplicitAny` 都关掉（该文件注释说关掉前有 73+约 40 条存量错误）；同目录 `tsc-baseline-0919.errors.txt`（111 行，82 条 `error TS`）是过期基线，没人用。`exclude` 里有 `**/*.test.ts`，所以 45 个 gateway 测试连类型都不检查。
- `test`（ci.yml:58-137）：只 `find src`（ci.yml:124）→ `npx --yes tsx --test`。`src/` 下共 414 个测试文件，11 个被显式排除（ci.yml:101-113）→ 实跑 403 个。
- **从不在 CI 跑的测试**：deploy-staging 下 60 个（gateway 45、vps-tools 13、poller 1、flowmusic2api 1 个 python）、desktop 7 个（5 个 lib + 2 个）、mcp-server 1 个 `smoke.test.ts`、bridge 1 个 `test_bridge_queue.py`，合计 69 个，覆盖率 0%。gateway 测试的专用跑法 `deploy-staging/vps-tools/run-tests.sh` 是本地脚本（其文件头说明 `bun test` 单次只跑 18 个文件却报 exit 0，是已知假绿源），CI 没有调用。
- 测试运行器混用：gateway+vps-tools+poller 的测试里 27 个 import `bun:test`，28 个 import `node:test`。
- `opencode-runtime/`（tools 153 个 + lib 282 个文件、约 41342 行 TS/py，见下方总表）**没有 tsconfig.json**、没有测试文件（0 个 `*.test.*`），不进任何类型检查。
- `desktop/` 不构建（CI 无 `electron-builder` 步骤）、不跑它自己的 7 个测试；`mcp-server/` 有 typecheck 脚本却不在 CI；`bridge/` Python 无任何 CI。
- 不跑 `next lint`、不跑 `next build`（ci.yml 头注释明说刻意不跑 build）；而 `next.config.mjs:11-12` 在 Vercel 上设了 `eslint.ignoreDuringBuilds` 与 `typescript.ignoreBuildErrors`（`process.env.VERCEL === "1"`）——也就是说生产构建的类型/lint 闸完全依赖 CI 里的 `tsc --noEmit`，而 `tsc` 又排除了 `**/*.test.ts`。
- Node 版本三处不一致：`.node-version`=24.15.0，CI `node-version: "24"`，生产 Dockerfile `FROM node:22-alpine`（deploy/vps/Dockerfile 第 1/6/28 行）。
- `npx --yes tsx`（ci.yml:137）：`tsx` 其实在 package.json devDependencies（`^4.20.6`），`--yes` 允许网络拉取，且是 `^` 范围。
- 无依赖审计/secret 扫描/dependabot：`ls -a` 无 `.github/dependabot.yml`，工作流内无 audit/gitleaks。
- 自托管 runner 在维护者本机（ci.yml:9-12 注释，原因是 GitHub 托管 runner 账号被锁）。不跑 pull_request 是正确的取舍，但 push 触发在公开仓上仍执行任意已合并代码于个人机器。
**影响** 绝大多数生产运行代码（gateway 70657 行、opencode-runtime、desktop）的回归不会被 CI 发现；`strictNullChecks=false` 让类型闸对空值错误基本失效。
**建议** (1) CI 增加 `bash deploy-staging/vps-tools/run-tests.sh` + `bun` 的 job（用 `oven-sh/setup-bun` 固定 1.4.2）；(2) gateway 安装用 `bun install --frozen-lockfile`，与生产同解析；(3) 给 opencode-runtime 加最小 tsconfig（允许 `noImplicitAny:false`）；(4) 桌面端加 `node --test desktop/**/*.test.js`；(5) 对齐 Node 22/24；(6) 加 dependabot 与 gitleaks。

## F5 【P2】硬编码：生产 IP、SSH 端口/密钥名/用户名、绝对路径、域名
**证据（范围内 773 个文件，已排除 skills 与 vendored 包）**
- 生产主机 IP `43.172.85.76`：整个仓库 18 个文件 21 处（`git grep -c`）。范围内：`deploy/vps/gateway-release.sh:57`、`opencode-release.sh`、`deploy-control-plane.sh`、`vps-tools/vps-gateway-recon.sh`、`vps-opencode-recon.sh`、`blender-bridge-tunnel/TUNNEL-PLAN.md`。范围外但同类：`docs/runbooks/infra-debugging.md`（3 处）、`src/app/api/auth/wechat/qr/route.ts:8`（**明文 HTTP** 默认值 `http://43.172.85.76:8780/new-qr`，可被 `WECHAT_WORKER_NEW_QR_URL` 覆盖）、`src/app/api/auth/wechat/start/route.ts`；`src/lib/new-api-auth-server.ts:34` 的注释说明旧的裸 IP 明文网关已弃用，但 wechat 两处仍在用。
- SSH 端口 `22443`：14 个文件 20 处；密钥名 `new.pem`：15 个文件 19 处；用户 `ubuntu@` 同处出现。这些全部在公开仓库中，等于公开了管理入口的端口、用户名与密钥文件名（仅信息泄露，无私钥）。
- 本机路径 `/home/lenovo/...`：范围内 18 个文件 28 处，仓库全局 51 个文件 86 处，例如 `deploy/vps/deploy-control-plane.sh:34` 的 `VPS_KEY` 默认值、`blender-bridge-tunnel.service`、`bridge-reverse-tunnel.js:28,39`、`bridge/blender-bridge/launcher.py:63`、`flowmusic2api/README.md`、`poller/README.md`。`C:/Users` 型 Windows 路径：3 个文件 13 行（`DEPLOYMENT.md:50,61,62` 的链接指向 `C:/Users/user/Documents/New project/...`，全部是死链）。
- 生产绝对路径：`/opt/agent-harness` 范围内 111 个文件 208 行；仅看运行代码（ts/js/py/mjs，非测试）124 行，热点：`gateway/subagent-types.ts`(4)、`opencode-runtime/lib/sandbox.ts`(3，`:27` 默认 WORKSPACE、`:213` PATH、`:266` bwrap 绑定)、`image-journal.ts`/`img-composite.ts`/`vision_impl.ts`/`video-fetch.ts`/`storyboard-voiceover.ts`/`audio_first_timeline.ts`(各 3)、`desktop/lib/policy.js`(2)。gateway 内 42 个非测试文件含 `/opt/agent-harness`，其中 `process.env.SESSIONS_DB_PATH || "/opt/agent-harness/state/sessions.db"` 在 review-findings.ts:80、artifact-store-index.ts:6、session-wakeups.ts:95 各自重复一遍默认值（`SESSIONS_DB_PATH` 在 gateway 出现 11 次）。
- 域名：`tinchak0207.xyz` 全仓库 135 个文件 303 处；范围内的运行时默认值：`opencode-runtime/lib/client.ts:15`（store…/image-control/api/v1）与 `:257`（`SITE_BASE = "https://image.tinchak0207.xyz"`，旁边 `:254` 有 `TODO（WP3 待验证）`）、`gateway/constants-gateway.ts:130,198,261`、`poller/index.ts:11`、`desktop/device-bridge-client.js:54`、`desktop/updater.js`/`package.json` publish URL（`store.tinchak0207.xyz/downloads/desktop`）。同时 `eimu.dev` 与 `image.tinchak0207.xyz` 与 `store.tinchak0207.xyz` 三个域名并存，不同组件默认值不同（mcp-server 默认 `https://eimu.dev/api/v1`，gateway 默认 `image.`，opencode client 默认 `store.`）。
- 本机回环端口：非测试运行脚本中 137 处，`127.0.0.1:8081`(92，gateway)、`:8765`(11，blender bridge)、`:3001`(7，new-api)、`:4096`(4，opencode)、`:8082`(3，laya)。
- gateway 引用 153 个不同的 `process.env.*`（非测试），`deploy-staging/gateway/README.md` 只文档化 1 个（`EIMU_OPENUI`），其余只能读码。
**影响** 搬机/换域/换用户都需要全仓 sed；公开了管理面指纹；wechat 的明文 HTTP 默认值若环境变量缺失会让二维码请求走明文。
**建议** 把主机、端口、域名收敛到一个 `deploy/vps/vps.env.example`，脚本统一 `source`；SSH 目标不放进公开仓（只留 `GW_SSH_TARGET` 的占位）；wechat 两处默认值改为空并在缺失时报错；gateway 增加 `docs/ENV.md`（可由 grep 自动生成）。

## F6 【P3】秘密泄露扫描：未发现真实密钥（含 git 历史）
**证据**
- `git grep -nIoE 'sk-[A-Za-z0-9_-]{20,}'`：12 处，全部在测试文件内，且是夹具形状：`sk-biz-0a1b2c3d4e5f6...`（只有 16 个不同字符，十六进制递增串）、`sk-collab-gate-collaborate`、`sk-test-c...`、`sk-regula...`。文件：gateway/collaborate-gate.test.ts:111、desktop/lib/bridge-credential.test.js:15、src/lib/agent-memory-injection.test.ts(5 处)、api-rejection.test.ts:29、generation-workflow.test.ts:302、mcp/protocol.test.ts(2 处)、agent/route.test.ts:99。
- `ghp_/gho_/github_pat_`：0；`AKIA...`：1 处，`gateway/memory-gate.test.ts:97`（`AKIA12...`，测试里验证「机密不得入库」的负样本）；`BEGIN PRIVATE KEY`：同文件:98 的负样本字符串；JWT `eyJhbG...`：2 处，均为测试（analytics-meta.test.ts:27、memory-gate.test.ts:99）；`Bearer <24+ 位>`：0；`password = "…"`：全部在 `*.test.ts` 里（`test-only-password`、`Gh0123456789abcd` 等）。
- 配置：`opencode-runtime/opencode.json` 的 14 个 provider 的 apiKey 全是 `{env:EIMU_KEY_...}` 占位；`.env.example` 的敏感项都是 `REPLACE_WITH_...`；`deploy/vps/control-plane.env.example` 仅模板。
- git 历史（`git log --all -p`）：`sk-` 匹配 14 行，抽查前 5 行均为上述夹具；ghp_/AKIA/PRIVATE KEY 仅命中同一批测试负样本；`git log --all --diff-filter=D` 无 env/key/pem/secret/cred 类被删文件；已追踪的 `.pem` 只有 `smartsearch/certifi/cacert.pem`（CA 根证书包，公共数据）。
- 非机密但敏感的拓扑信息：`opencode-runtime/opencode.json` 列出 10 个第三方中转 baseURL（api.shuaiapi.com ×4、herohao、chaozhiyuanai、oaifree 等）——说明上游供应商关系，属商业信息泄露而非凭证泄露。
**影响** 无凭证泄露；但没有自动化手段防止未来误提交。
**建议** CI 加 gitleaks/trufflehog；考虑把 opencode.json 里第三方中转 baseURL 外置为 env。

## F7 【P2】多运行时/多语言：TS(Bun/Node) + Python + Go + Shell，依赖管理不统一
**证据（deploy-staging，git 跟踪共 1694 个文件）**
- 扩展名：`.md` 593、`.ts` 547、`.py` 332、`.json` 67、`.js` 9、`.mjs` 4、`.sh` 5、另有 `.go` 3；`.glb` 8、`.webp` 28 等二进制素材混在其中。按目录：opencode-runtime 1291、gateway 310、vps-tools 42，其余 9 个目录各 1–8 个文件。
- Python 332 个文件里 318 个在 `opencode-runtime/`；其中第三方依赖被 **直接解压进源码树** 而非 requirements 安装：`lib/smartsearch/` 下 anyio(46)、smart_search(42)、httpcore(31)、httpx(23)、tenacity(12)、h11(11)、idna(10)、sniffio(5)、certifi(3)、typing_extensions(1) 个 `.py`（第三方包合计 142 个，smart_search 42 个是打过补丁的上游 fork，见 `keyless.patch`）。好的一面：`requirements-vendored.txt` 带 `--require-hashes` 并写了重现步骤；坏的一面：`.dist-info` 被删除（该文件重现步骤里 `rm -rf lib/smartsearch/*.dist-info`），任何 pip-audit/SBOM 工具扫不到这些包的版本；`certifi/cacert.pem` 靠 .gitignore 例外（.gitignore:31）才入库，CA 包不会自动更新。
- 其它 Python 依赖：`laya-server/requirements.txt` 全是下限约束（`laya>=0.3.4`、`torch>=2.4`、`transformers>=4.44` …）无上限无 lock，`Dockerfile` 以 root 运行（无 `USER`），镜像基于 `python:3.12-slim` 未固定 digest；`requirements-onnx.txt` 同样；`blender-modal/`、`bridge/blender-bridge/`、`flowmusic2api/watchdog.py` 无 requirements；`video-fetch-runtime/pyproject.toml` 固定 `yt-dlp==2026.8.19`（好）。
- Node 侧：gateway 有 `bun.lock`（979 字节）但 CI 忽略它；`opencode-runtime` 同时存放 `bun.lock`（12246 字节）和 `package-lock.json`（20926 字节），两个 lock 并存；根目录同时有 `package-lock.json`（535082 字节）与 `pnpm-lock.yaml`（189672 字节），`pnpm-workspace.yaml` 内容是占位文字（`esbuild: set this to true or false`）。
- 同一功能的两份 `opencode.json`：`deploy-staging/opencode.json`（3622 字节，顶层键 5 个）和 `opencode-runtime/opencode.json`（99792 字节，顶层键 8 个）。AGENTS.md 已声明前者是旧快照，但没有删除也没有加注释。
- 运行时矩阵：gateway/poller=Bun；opencode-runtime tools=Bun/Node（opencode 插件）；CI=Node 24；控制面容器=Node 22；desktop=Electron 44 自带 Node；blender bridge/modal/laya/asr/watchdog=Python 3；flowmusic2api=Go+Docker。
**影响** 同一台 4GB 机器要维护 5 套运行时的升级；vendored 包的 CVE 无法被工具发现；pip 无上限依赖在镜像重建时可能漂移。
**建议** 给 vendored 目录补一个 `VENDORED.json`（包名/版本/sha256）并在 CI 里 diff 校验；laya 依赖加 `==` 与 hash，Dockerfile 加 `USER`；删掉 `pnpm-lock.yaml`、`pnpm-workspace.yaml`、`deploy-staging/opencode.json`；opencode-runtime 选定 bun.lock 或 package-lock.json 其一。

## F8 【P2】desktop（Electron）：基础隔离配置合格，更新通道没有代码签名
**证据**
- `desktop/package.json`：`electron ^44.5.1`、`electron-builder ^26.0.12`、`electron-updater ^6.8.10`，版本号 0.3.5，`package-lock.json` 133544 字节。
- `main.js:309-314`（子窗口）与 `main.js:363-376`（主窗口）：`nodeIntegration:false`、`contextIsolation:true`、`webSecurity:true`；未显式写 `sandbox:true`（依赖 Electron 默认值）。没有 `will-attach-webview` 处理、没有 CSP 注入、没有 Electron Fuses 配置（`grep fuses` 无命中）。`setPermissionRequestHandler` 白名单仅 `clipboard-sanitized-write/clipboard-read`（main.js:449-452）。`openInSystemBrowser` 只放 http/https（main.js:237-248）；`will-navigate`+`will-redirect` 双挂（main.js:281）；`requestSingleInstanceLock` 已用（main.js:434）。主窗口加载远端 `https://www.eimu.dev`（main.js:62-64,425），`APP_ORIGIN` 覆盖仅在 `EIMU_E2E=1` 时生效（main.js:61-62）。
- `preload.js`（166 行）：`contextBridge` 暴露 `window.eimuLocal`（capabilities / pickFiles / probe / extractFrames / transcode / authorizedRoots / bridge.{status,enable,disable,setMode,setCredential} / onBridgeStatus / onCredentialRequired）与 `window.eimuShell`（minimize/toggleMaximize/close/isMaximized/…/applyUpdate）。逐一固定 channel，不暴露通用 `ipcRenderer`。真正的闸在主进程：`local-worker.js` 每个 handler 先验 `event.senderFrame` 的 host ∈ `APP_HOSTS={www.eimu.dev, eimu.dev}`（local-worker.js:6，main.js:64）。信任边界等于「eimu.dev 页面没有 XSS」：任何能在该域执行脚本的人都能调用 transcode/extractFrames/setMode("full")。
- 更新：`updater.js`（168 行）用 `electron-updater` generic provider，feed=`https://store.tinchak0207.xyz/downloads/desktop`（package.json build.publish）。`package.json` 的 `build` 里没有任何代码签名配置（`grep "certificateFile|publisherName|win.sign|CSC_LINK"` 无命中）。electron-updater 对 Windows 的签名校验依赖 `publisherName`，未配置时只校验 latest.yml 里的 sha512，而 latest.yml 与安装包来自同一台服务器——服务器/CDN 被攻破即可推送任意安装包。`EIMU_UPDATE_FEED`（updater.js:128）在打包版里也可被环境变量覆盖，未像 `APP_ORIGIN` 那样受 `E2E_ENABLED` 限制（本地攻击面，较低）。Linux 目标是 `tar.gz`，注释承认 electron-updater 在 Linux 对 tar.gz 不会更新（updater.js:149 附近），所以 Linux 用户无自动更新。
- 构建不在 CI；测试 7 个（desktop 内 `*.test.js`）不在 CI；`scripts/e2e/` 有 12 个 e2e 脚本，含硬编码 `store.tinchak0207.xyz`（local-io-cases.mjs 3 处、final-b-cases.mjs 6 处）。
**影响** 更新通道的完整性完全信任 TLS+服务器；XSS→本机文件读/ffmpeg 执行是需要重点防守的链路。
**建议** 配置 Windows 代码签名证书与 `publisherName`；对 latest.yml 做离线签名或把发布服务器与 web 服务隔离；给 `EIMU_UPDATE_FEED` 加 `E2E_ENABLED` 门；显式写 `sandbox:true` 并启用 Electron Fuses（`RunAsNode`、`EnableNodeCliInspectArguments` 关闭）；站点侧加严格 CSP。

## F9 【P3】mcp-server/ 与 bridge/：独立小包，均不在 CI
**证据**
- `mcp-server/`：自带 `package.json`（`image-studio-mcp-server@1.0.0`，deps：`@modelcontextprotocol/sdk ^1.30.0`、`zod ^4.4.3`）、`package-lock.json`、`tsconfig.json`，源码 `src/` 3 个文件共 291 行（client.ts 162、config.ts 34、index.ts 95）+ `smoke.test.ts` 147 行。`typecheck`、`smoke` 脚本存在，但根 tsconfig 排除它（第 41 行），CI 不触发，也没有 `npm ci`+`tsc` 的 job。默认 API 基址 `https://eimu.dev/api/v1`（config.ts），密钥只读 env `IMAGE_STUDIO_BIZ_KEY`，代码注释声明不入日志。包名/描述仍用旧品牌 "Image Studio"。
- `bridge/blender-bridge/`：纯 Python，5 个文件 6110 行（blender_addon.py 4370、server.py 743、launcher.py 401、test_bridge_queue.py 596）；`server.py:100` 绑定 `HTTP_HOST="127.0.0.1"`，`execute`/`cancel` 要 `Authorization: Bearer $BLENDER_BRIDGE_TOKEN`（server.py:351-359），未设置则拒绝——设计合理。launcher.py:63 与 README.md 写死 `/home/lenovo/Applications/blender-5.2*`。无 requirements、无 CI、测试 `test_bridge_queue.py` 不被任何流程执行。
**影响** 对外发布给用户的 MCP 包（可能被 npm/Claude 客户端使用）没有构建验证。
**建议** 加一个 `mcp-server` job（`npm ci && npm run typecheck && npm run smoke`）；bridge 加 `python -m unittest` job。

## F10 【P2】可观测性：以 console 为主，结构化日志只覆盖 metrics 一角；监控探针少且告警关闭
**证据**
- 日志计数（排除 `*.test.*`、skills、vendored）：deploy-staging/gateway 约 70657 行代码里 `console.log/info`=243、`console.warn`=115、`console.error`=178，合计 536 次调用分布在 85 个文件（`subagent-finish.ts` 26、`messages-gw-compaction.ts` 24、`opencode-event-handler.ts` 23、`timers-gw.ts` 21 …）；poller 4/11/4；desktop 20/5/14；opencode-runtime 的 Python 用 `print(` 47 次、TS `console.warn` 17；mcp-server 0。除 `vps-tools/asr-service/engine.py` 使用 `logging` 外，没有 pino/winston/structlog 等日志库。
- 结构化的部分：`metrics-gw.ts:33-35` 把每轮耗时以 `[gateway] turn.metrics {json}` 一行输出到 journal，并有内存 ring（200 条）和 `GET /agent/v1/metrics` 聚合 p50/p95/p99；`analytics-meta.ts:129` 的 `logLine(level,…)` 与 `LogSafeText` 品牌类型 + `redactForLog()`（用法 21 处）约束日志脱敏。但 85 个文件里的 536 次 `console.*` 直接调用大多没经过这个出口（metrics-gw.ts 注释「所有落 journal 的行都只走这两个函数（禁止直接 console.*）」只在该文件内成立）。
- 无 Sentry / OpenTelemetry / Prometheus（`git grep -liE "sentry|opentelemetry|prometheus"` 在 deploy-staging/deploy/desktop 命中的是无关文件，如 director-ops.ts 的 "otel" 子串、model-status route）。
- Gatus（`deploy/gatus/config/config.yaml`，84 行）：4 个探针——控制面 `/image-control/api/readyz`（15m）、Agent 网关 `/agent/healthz`（15m）、风控绊线 `/risk/status.json`（5m）、mPay 对账 `/payments/mapay/health`（30m）。存储 sqlite，保留 1500 条结果。**告警块被整段注释掉**（文件末尾 `# alerting: telegram`），所以没有任何外发通知。探针都从公网域名 `store.tinchak0207.xyz` 打；Gatus 容器与被监控服务在同一 docker 网络 `imagesite_imagesite`（deploy/gatus/docker-compose.yml），主机宕机时监控一起死。
- 没有被探针覆盖的组件：opencode-server(:4096)、agent-poller、flowmusic2api、laya、ASR、postgres、new-api(:3001)、磁盘/内存（4GB 主机已有 OOM 事故史，见 opencode-server.oom.conf 注释）、TLS 证书到期、官网 eimu.dev（Vercel）、桌面更新源。
- 镜像 `ghcr.io/twin/gatus:stable` 为浮动 tag。
**影响** 故障靠用户或人巡检发现；日志检索靠 `journalctl | grep`；4 个探针 + 无告警，等于一个无人值守看板。
**建议** 先打开 Gatus alerting（Telegram/邮件，凭据放 env，不进仓库）；探针加到 opencode-server、poller、postgres、磁盘与证书；在外部（另一台机器/第三方）加一个存活探针；gateway 统一出口 `logLine`，把 `console.*` 收口成 JSON 行。

## F11 【P1】单点与备份：全部服务集中在一台 4GB VPS，repo 内没有 Postgres 备份/恢复流程
**证据**
- AGENTS.md「生产构建事故禁令」明确是「承载在线服务的 4GB 生产主机」；同一台主机承载 nginx、Next 控制面 api+worker、Postgres（`deploy/vps/control-plane-compose.yml:20-21` 绑定 `./generation-postgres-data:/var/lib/postgresql/data`）、gateway(SQLite `sessions.db` ~41MB，gateway/.gitignore 注释)、opencode-server、poller、flowmusic2api、ASR、new-api、gatus。
- `git grep -iE "pg_dump|restic|borg|wal-g"` 在 deploy/、vps-tools/、poller/ 无命中（唯一一次出现的 "backup" 是 opencode-release 的配置备份目录）。没有数据库备份脚本、没有恢复演练记录、没有 sessions.db 备份。
- `deploy-control-plane.sh` 的 `deploy` 子命令被硬停用（第 19-26 行），官方路径是离机构建 + `import-prebuilt-image.sh`（25 行，`docker load -i` 后 `docker compose up -d --no-build`，无校验和/签名核对，无回滚）；`deploy-control-plane.sh rollback` 依赖 `rollback-*` 镜像 tag（ROLLBACK_KEEP=3）。
- `control-plane-compose.yml` 头注释：现役真源是 VPS `/opt/image-control-plane/control-plane-compose.yml`（含明文 env），repo 里只是模板；`deploy/vps/docker-compose.yml:44,88` 使用 `calciumion/new-api:latest`、`certbot/certbot:latest` 浮动 tag（new-api 是计费/网关核心，`latest` 升级会静默改变行为）。
**影响** 主机磁盘损坏/误删 = 控制面（含账务/付费订单）与会话数据丢失，且无可验证的恢复路径。
**建议** 加每日 `pg_dump` + 异地（对象存储）加密备份与每月恢复演练脚本；sessions.db 用 `sqlite3 .backup`；`new-api` 固定到具体版本/digest；预构建镜像导入脚本加 sha256 校验。

## F12 【P3】过期/误导性配置文件
**证据**
- `render.yaml`（20 行）：`plan: free`、`autoDeploy: true`、`healthCheckPath: /api/healthz`，env 为 `IMAGE_API_KEY`/`share-api.com`/`happycode.vip`（旧上游）；`DEPLOYMENT.md`（131 行）仍是 Vercel+Render 双部署方案，且 3 处死链指向 `C:/Users/user/Documents/New project/...`。现行生产是 VPS + Vercel（见 AGENTS.md）。
- `deploy/CHECKLIST.md`（50 行）建议分支名 `codex/image-tinchak0207`，是早期流程。
- `vercel.json`：`buildCommand` 带 `NODE_OPTIONS='--max-old-space-size=8192'`（Vercel 构建机是否有 8GB 取决于方案），`installCommand: npm install`（不是 `npm ci`，lock 不严格）；`regions:["sfo1"]` 而业务面向中国大陆。
- `deploy-staging/gateway/tsc-baseline-0919.errors.txt`（82 条 error）是 9 月 19 日的基线，现行 tsconfig 已放宽，文件无引用。
- `ci.yml:78-92` 的排除理由 B 说夹具在被忽略的 `deploy-staging/expert-gateway/` 里；实际上 `deploy-staging/gateway/expert/` 已有 `expert-constitution.md`、`expert-delivery-contracts.json`，可能能把 5 个被排除的测试改指向该目录（待核实，非本轮结论）。
**影响** 新人按 DEPLOYMENT.md 会误部署到 Render；CI 排除清单掩盖真实可修的测试。
**建议** 删除/归档 render.yaml、DEPLOYMENT.md 重写成现行流程、`npm install` → `npm ci`。

---

## 量化总表

| 指标 | 数值 | 命令来源 |
|---|---|---|
| git 提交数 | 20 | `git log --oneline \| wc -l` |
| deploy-staging 跟踪文件数 | 1694（opencode-runtime 1291 / gateway 310 / vps-tools 42 / 其余 51） | `git ls-files deploy-staging` |
| deploy-staging 文件类型 | md 593, ts 547, py 332, json 67, js 9, mjs 4, sh 5, go 3 | 同上按扩展名 |
| gateway 文件数 / ts / 测试 | 310 / 288 / 45 | `git ls-files deploy-staging/gateway` |
| gateway 非测试 TS 行数 | 70657（含测试 ts 合计 79950） | `wc -l` |
| gateway 最大文件（非测试） | agent-memory-write.ts 988 行；最大测试 device-bridge.test.ts 1094 行；按字节最大 messages-gw-admission.ts 61615 | `wc -l` / `ls -l` |
| gateway package.json / 锁 | 有 / `bun.lock` 979 字节（CI 未使用） | 文件 |
| gateway tsconfig strictness | strict 但 `strictNullChecks=false`、`noImplicitAny=false` | tsconfig.json |
| gateway 引用 `process.env.*` 个数 / README 文档化 | 153 / 1 | `grep -oh` |
| 直接 `console.*`（gateway 非测试） | 536（log/info 243, warn 115, error 178），85 个文件 | `grep -c` |
| 生产 IP `43.172.85.76` | 21 处 / 18 个文件（全仓库） | `git grep -c` |
| SSH 端口 22443 / 密钥名 new.pem | 20 处 14 文件 / 19 处 15 文件 | `git grep -c` |
| `/opt/agent-harness`（范围内） | 208 行 / 111 文件；运行代码 124 行 | `grep` |
| `/home/lenovo`（全仓库） | 86 处 / 51 文件 | `git grep -c` |
| `tinchak0207`（全仓库） | 303 处 / 135 文件 | `git grep -c` |
| 疑似真实密钥 | 0（12 个 sk- 夹具、1 AKIA 夹具、2 JWT 夹具，全在测试） | 多条 grep + 历史 |
| patch 类脚本/补丁 | 6 个 `.py` 补丁 + 2 个 flowmusic `.patch` + 1 个 smartsearch `.patch`（另 `open-source/` 1 个） | `git ls-files` |
| systemd unit（完整）入库 / 文档提及 | 1（笔记本端）/ 约 6 个服务缺 unit | `git ls-files`、`git grep` |
| vendored 第三方 Python 文件 | 142（另 smart_search fork 42） | `git ls-files lib/smartsearch` |
| 完整 Python requirements 文件 | 3（laya×2 为 `>=` 下限；vendored 带 hash）+ 1 个 pyproject（yt-dlp 固定） | `git ls-files` |
| CI job 数 / 运行位置 | 3（typecheck, gateway-typecheck, test）/ 全部 self-hosted | ci.yml |
| src 测试文件 / CI 实跑 / 排除 | 414 / 403 / 11 | ci.yml:101-137 |
| 非 src 测试文件（CI 不跑） | 69（gateway 45, vps-tools 13, poller 1, desktop 7, mcp 1, bridge 1, flowmusic 1） | `git ls-files` |
| opencode-runtime TS/py 行数 / 测试 / tsconfig | 41342 / 0 / 无 | `wc -l` |
| desktop | Electron ^44.5.1；nodeIntegration=false；contextIsolation=true；无代码签名；无 Fuses；7 个测试不在 CI；`main.js` 614 行 | main.js:309-376 |
| mcp-server | 291 行 src + 147 行 smoke；不在 CI | wc -l |
| Gatus 探针 / 告警 | 4 / 全部关闭（注释） | config.yaml |
| 浮动镜像 tag | 4（new-api:latest, certbot:latest, gatus:stable, flowmusic 上游 latest） | compose 文件 |

## 优先级排序（只列建议动手的顺序）
1. F11（备份）→ 2. F1/F2（unit/deploy.sh 入库，poller 与 flowmusic 去手工化）→ 3. F4（CI 补 gateway/desktop/mcp 测试与锁文件一致）→ 4. F10（打开 Gatus 告警 + 补探针）→ 5. F8（桌面签名）→ 6. F5（硬编码收敛、wechat 明文 HTTP）→ 7. F3/F7/F12（清理死脚本与旧配置）。
