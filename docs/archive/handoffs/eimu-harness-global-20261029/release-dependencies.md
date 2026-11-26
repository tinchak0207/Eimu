# 发布依赖梳理（只读，未发布）

本轮不是只发gateway。相同候选至少覆盖gateway、runtime tools/lib/plugin、exec-bridge以及Next的workflow/compile路由与DSL库。主树与生产有并发工作，发布前需独立提交候选、核对生产漂移，不能拿隔离树整体覆盖他人工作。

## 可直接复用的现有入口

从已经锁定、提交的候选树执行（下列仅配方，本轮未执行）：

```bash
bash deploy/vps/gateway-release.sh status
bash deploy/vps/opencode-release.sh status
bash deploy/vps/opencode-release.sh plan --sha "$CANDIDATE_SHA"
bash deploy/vps/opencode-release.sh release --sha "$CANDIDATE_SHA"
bash deploy/vps/gateway-release.sh release --sha "$CANDIDATE_SHA"
```

两条release均只取git快照；现有recon、内容身份冲突检查、activation锁、备份/回滚与drain继续使用。不要用`--fast/--force/--skip-recon`跳掉并发漂移和在途检查。两脚本各自加锁，**并不提供gateway+runtime+bridge+站点四者整组原子发布**，不能把分段成功当全局同版本。新增接单需在现有维护/排空边界内停止，待全部依赖就绪后恢复，未获release授权本轮不操作。

## 两个现有发布缺口

1. `opencode-release.sh:46`的SCOPE仅tools/lib/skills/plugin，配置4项另行列；备份/恢复白名单同样不含exec-bridge。它只重启opencode-server，不会安装或重启agent-exec-bridge。所以只跑这两个release音乐修复仍不会上线。
2. `deploy-control-plane.sh deploy`明确硬停用线上源码全量build，尚无预构建镜像导入发布入口。`platformFetch`默认API_BASE是VPS控面`.../image-control/api/v1`；canvas_get_state与workflow_write实际调用`/workflow/compile`的project编译/反编译。只发Vercel前端不能证明这个实际入口已更新。必须离机按候选构建控面镜像、使用既有获准的预构建产物导入流程；没有现成完整命令时不虚构一条“可部署”命令，更不绕回生产build。

exec-bridge已有真实配方在`deploy/vps/systemd/agent-exec-bridge.service:4-8`：将同候选`deploy-staging/opencode-runtime/exec-bridge/server.ts`安装至`/opt/agent-harness/workspace/.opencode/exec-bridge/server.ts`，服务名agent-exec-bridge。应复用当前已安装unit与账户，不默认重新enable/daemon-reload；备份、内容比对、受控install、restart需纳入本次同候选批次。当前没有独立版本化bridge release脚本，本轮不另造工具。

## 动态journal的硬依赖

调用目标源码已逐层核对：`canvas_get_state.ts:28`与`lib/project-client.ts:137`均用platformFetch(`/workflow/compile`)；`lib/client.ts:15,281-287`的API_BASE默认是`https://store.tinchak0207.xyz/image-control/api/v1`，fetchWithBase直接拼base+path。因此默认真实目标是控面`https://store.tinchak0207.xyz/image-control/api/v1/workflow/compile`，不经过eimu.dev。若生产设置PLATFORM_API_BASE则以该真实覆盖为准，本轮未读取线上配置值，不能将默认当已核验的当前环境。

若入口被配置为image.tinchak0207.xyz或eimu.dev，且配置了GENERATION_CONTROL_PLANE_PROXY_ORIGIN，`next.config.mjs:75-103`会先经beforeFiles的controlPlaneRewrites；该列表包含`/v1/:path*`与`/api/v1/:path*`，destination由该origin组成。未配origin则函数返回空代理表，不能据源码推断当前线上落点。Vercel READY只证明边缘候选已起，不能证明控面新decompile协议存在。须验实际服务请求落点与控面容器内容。

gateway `project/generation-journal.ts`真实加载路径：`EIMU_RUNTIME_DIR/lib/image-journal.ts`，未设则`WORKSPACE_DIR/.opencode/lib/image-journal.ts`。它realpath后动态import，并校验`IMAGE_JOURNAL_CONTRACT_VERSION===1`与方法。runtime新库确实导出版本1；`lib/`属于opencode-release同步白名单。

因此gateway激活前，同候选runtime journal文件必须已经存在且gateway服务账户可读，不能只有本地类型import能解析。gateway与runtime还必须指向同一个实际journal SQLite路径/同一预算作用域、账户拥有读写权限。核配置只核路径与权限，不能打印整份EnvironmentFile或密钥。若路径错误，正确行为是具名阻断，不回退另一套预留/直接POST。

bridge服务User/Group=agentsvc、WorkingDirectory=workspace，文件必须处于`.opencode`树中以解析相对tools/lib依赖。runtime release会运行既有derive-opencode-runtime.sh，需核派生目录、服务实际ExecStart与读取的journal文件是否还是同一候选，而非另一份旧镜像。

## 同候选只读证据

发布前后分别收集同一份清单，身份变化须重新判断而非覆盖：

- 候选commit与完整源文件SHA清单（包括新增文件，排除node_modules运行依赖symlink和私有证据）；gateway release的readlink/meta/manifest实算通过。
- runtime历史日志的候选commit、实际白名单文件hash；尤其plugin、project工具、image-journal及其合约版本。
- systemctl show仅取MainPID、ExecMainStartTimestamp、ExecStart、WorkingDirectory、User；`/proc/PID/cwd`与真实代码路径、journal文件可读性/SQLite权限。health只是相邻证据，不能代替运行内容。
- exec-bridge实际server.ts hash、MainPID起时、同一runtime依赖；结果接口的身份保护及已有订单恢复只读回执，不做未授权付费探针。
- 控面容器实际image ID/候选镜像标签、进程启动时间与原像；实际`/v1/workflow/compile`project compile/decompile结果与版本对应，不用Vercel alias或HTTP200代替功能。
- 原有用户会话/工作代/账本与已采用资产连续性，以及本轮真实用户路径最终产物；只读状态或配置一致不能证明自然语言到成片已完成。

任何线上生产身份在准备后变化，现有CAS/recon应中止激活并重做候选与生产差异核对。回滚需要四部分依赖成组回到兼容版本，不能只切gateway symlink留下新旧协议混用。

## 共享journal权限是激活前置

本轮只读现场：gateway用户ubuntu、补充组agentsvc；runtime用户/组agentsvc，两者UMask0022。真实默认DB是`/opt/agent-harness/workspace/.local/share/eimu/tool-journal/tool-jobs.sqlite`。`/opt`、`/opt/agent-harness`为755，workspace为agentsvc:agentsvc2775，`.local/share`为2755，eimu/tool-journal为2775，祖先均可遍历；既有DB/WAL/SHM为agentsvc:agentsvc0644。现场没有setfacl/getfacl。**仅发代码会具名blocked，不能据本地跨进程测试宣称生产可写。**

发布前先在现有运维授权范围准备系统acl依赖（本轮未安装），确认setfacl/getfacl可用；暂停新增生成并排空已有进程，确认两个服务使用同一真实DB路径；由agentsvc这个现有owner初始化该唯一leaf目录2770、默认ACL `d:u::rwx,d:g::rwx,d:o::---,d:m::rwx`，仅该DB及实际存在的`-wal/-shm`设同组0660。不要递归chmod `.local`或用户素材，不另建余额DB。新库在owner首次访问时执行同样的受控初始化，非owner只校验不替别人改权限；ACL依赖/目录/文件权限失效均具名拒绝生成，不fallback。默认ACL保WAL/SHM重建仍同组可写。

初始化后分别以ubuntu与agentsvc身份验证祖先可遍历、同一DB可读写且WAL重建不损坏组写权限，再激活候选gateway。若未来部署路径祖先私有，只针对这个journal路径必要祖先添加agentsvc组的遍历ACL，不能放开同目录其他私有内容。本机测试证明同UID真实SQLite、两个真实进程互斥、2770/defaultACL和0660文件；本机sudo需密码，未取得跨UID执行能力，跨UID生产放行仍是发布必验项。
