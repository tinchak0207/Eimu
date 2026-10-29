# DSL写面回到实际工程（本地候选）

工程模式的`workflow_write`现在复用已有`expandProjectDsl(target:project)`，将同一节点id的差量PatchOp连同读到的baseVersion原子写入现有ProjectStore。不是另一个执行器。`canvas_get_state`从同一个工程读节点和版本，再经既有站点decompileProject反向读取DSL；不再把旧画布快照当工程执行真源。非工程模式由网关明确返回false后，原canvas分支保持。

需要三部分匹配上线：gateway的project_mode/节点版本只读契约、runtime工具与project-client、站点现有`/v1/workflow/compile`新增action=decompile只读分支。runtime不跨部署树import src，也没有复制反编译器。仅网关/runtime上线不足以接通站点读分支；本片尚未上线。

工程DSL仍保留已有diff、人工字段锁和产物。source携带baseVersion，旧快照改同一镜头会整批VERSION_CONFLICT，不自动覆盖。dry_run通过create:false读取已有工程；尚未建工程也不会因为预览创建文件，实际patch才建工程。源中缺席节点不删除、不reset已done产物；按targets和签名运行。

旧机制卡不再警告后忽略：image_generate/video_generate/music_gen/tts/blender_render仅映射真正已有的对应节点类型；含kind冲突报错。gate事前批准与未接同工程的工具（例如image_edit、研究工具）明确unsupported并整批拒绝，不假称已经执行，也不替用户删去该义务。旧工具入口本身没有被删除；非工程的旧canvas编译保持。尚未等价映射的义务仍未闭合，不能宣称全量旧DSL无损兼容。

验证：`bun test deploy-staging/gateway/project/project-dsl-roundtrip.test.ts src/lib/workflow-dsl/project-ops.test.ts` 原21通过，随后新增说明卡真实作者边界1例通过，合22。真实Next route、真实编译/反编译器、runtime工具、gateway路由、ProjectStore/patch/runProject参与，仅鉴权外围与生成执行器为无付费夹具：

- 两镜先真实落文件并跑完；从实际工程读DSL，改第二镜、写回，再按targets跑。首镜sha不变，执行记录只有第二镜获得新输入。
- 同一旧source版本再次写回被拒，当前输入不变。
- 首次dry_run不生成project.json；实际写入才创建，旧audio/music_gen映射真实music节点。
- gate义务原子拒绝，不伪落成节点；明确非工程仍走旧画布读取。
- 已有compiler的锁/钉住/forEach/只发差量/roundtrip性质继续通过。
- v1 text说明卡经实际scriptExecutor运行仍partial/awaitingAuthor，没有params.text和成品outputs；已有作者责任承接。未接入的search_web机制卡整批拒绝，不能被改成注释后声称已完成研究。

未证明：生产会话走这套匹配版本、每一种旧工具都能等价编译、真实MV/真实模型评审最终完成。此片是已接通的本地写读执行链，不是“自然语言进，成片出”全局完成声明。
