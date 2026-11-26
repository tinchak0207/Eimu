import { tool } from "@opencode-ai/plugin/tool"
import { productionScope, ok, fail } from "../lib/client"
import { gameProject, gameCheckpoint } from "../lib/game-project"

export default tool({
  description:"游戏项目工作区与步骤检查点。首次执行create；每次重启先status取回最近检查点、资产回执和付费账本，从未完成步骤继续。研究、设计、资产导入、关卡搭建、运行、审图、交付各步骤完成后checkpoint；receipt记录真实路径、actor读回、截图、operation_id与未达成项，禁止把计划当成功。工程与资产保留在项目workspace。",
  args:{
    action:tool.schema.enum(["create","status","checkpoint"]),
    project:tool.schema.string().min(1).max(160).describe("稳定项目标识，续做须沿用原值"),
    operation_id:tool.schema.string().min(1).max(160).optional().describe("checkpoint必填，同一次步骤执行的稳定身份"),
    stage:tool.schema.enum(["research","design","assets","level","runtime","visual_review","delivery"]).optional(),
    state:tool.schema.enum(["completed","blocked","unknown"]).optional(),
    receipt:tool.schema.record(tool.schema.string(),tool.schema.unknown()).optional(),
  },
  async execute(args,context){
    try {
      const scope=await productionScope(context.sessionID,args.project,context.abort)
      if(args.action==="checkpoint") {
        if(!args.operation_id||!args.stage||!args.state||!args.receipt) return fail("missing_checkpoint_fields","checkpoint需要operation_id、stage、state和真实receipt。")
        return ok(gameCheckpoint(scope,args.project,context.sessionID,args.operation_id,args.stage,args.state,args.receipt))
      }
      return ok(gameProject(scope,args.project,context.sessionID,args.action==="create"))
    }catch(e:any){return fail("game_project_unavailable",String(e.message??e))}
  },
})
