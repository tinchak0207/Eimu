import { tool } from "@opencode-ai/plugin/tool"
import { classifyError, platformFetch, gatewayRequest, flushTaskRegistrations, productionScope, ok, fail } from "../lib/client"
import { reconcileSubmissions, outstandingSubmissions } from "../lib/image-journal"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function artifactsOf(body: any): any[] {
  const raw = Array.isArray(body.artifacts) ? body.artifacts : Array.isArray(body.data) ? body.data : []
  const artifacts = raw.filter((a:any) => typeof a?.url === "string" && /^https?:\/\//.test(a.url))
  if (!artifacts.length && typeof body.url === "string" && /^https?:\/\//.test(body.url)) artifacts.push({url:body.url})
  return artifacts
}
async function observe(task:any, sessionID:string): Promise<any> {
  try { return await gatewayRequest("/internal/job-ack", {session_id:sessionID,task_id:task.task_id,stage:"observed"}) }
  catch { return {acknowledged:false,recoverable:true} }
}
function render(task:any, receipt:any) {
  const status = task.status ?? "unknown"
  const artifacts = artifactsOf(task)
  const common = {...task,task_id:task.task_id,status,artifacts,observation_receipt:receipt,downloaded:task.downloaded === true || task.downloaded_at != null}
  // URL不得盖掉refunded/failed/cancelled真实终态。
  if (["failed","refunded","cancelled"].includes(status)) return fail("generation_failed", task.error?.message ?? task.reason ?? `任务${status}；不会自动重生成。`, {...common,title:"真实失败终态",recoverable:status !== "cancelled",partial_artifacts_available:artifacts.length>0,...(artifacts.length?{download_tool:"image_result_download"}:{})})
  if (status === "succeeded" && artifacts.length) return ok({...common,title:"生成完成，等待验证落盘",url:artifacts[0].url,download_tool:"image_result_download"})
  return fail(status === "succeeded" ? "artifact_missing" : "result_not_ready", status === "succeeded" ? "作业标记完成但缺完整artifact；先对账恢复，不重生成。" : "作业尚未完成或状态未知；保留原task_id，后台继续追随，不创建新job。", {...common,title:"尚未交付",recoverable:true})
}
export default tool({
  description:"耐久查询图片/视频作业，免费。不传ID按当前session及project/frame取全部真实jobs与完整artifacts，支持task_ids整批过滤，不猜ID、不依赖内存Map、不把退款当成功。读取产生observed回执，只有image_result_download真实验证全部落盘才产生downloaded回执。",
  args:{
    task_id:tool.schema.string().optional().describe("完整UUID；缺ID则耐久枚举当前session"),
    task_ids:tool.schema.array(tool.schema.string()).optional().describe("可选整批UUID清单，直接过滤耐久查询结果，不做30次单查假枚举"),
    project:tool.schema.string().optional().describe("项目稳定ID"),
    frame:tool.schema.number().int().min(1).optional().describe("项目帧号"),
  },
  async execute(args, context) {
    try {
      await flushTaskRegistrations()
      const listing = await gatewayRequest("/internal/session-tasks", {session_id:context.sessionID,project:args.project,frame:args.frame}, context.abort)
      if (listing.durable !== true || !Array.isArray(listing.tasks)) return fail("invalid_task_index", "网关没有返回耐久任务列表；不可解释为空或假称已完成。")
      const tasks:any[] = listing.tasks
      reconcileSubmissions(tasks)
      const scope = await productionScope(context.sessionID,args.project,context.abort)
      const pending_requests = outstandingSubmissions(scope)
      if (!args.task_id) {
        const selected = args.task_ids ? tasks.filter(t=>args.task_ids!.includes(t.task_id)) : tasks
        const receipts = await Promise.all(selected.map(t=>observe(t,context.sessionID)))
        const missing_ids = args.task_ids?.filter(id=>!selected.some(t=>t.task_id===id)) ?? []
        return ok({title:"耐久任务与产物清单",tasks:selected.map((t,i)=>({...t,artifacts:artifactsOf(t),observation_receipt:receipts[i]})),missing_ids,pending_requests,coverage:listing.coverage ?? null,note:"queued/running/unknown均未交付；成功URL也不等于本地落盘。"})
      }
      if (!UUID.test(args.task_id)) return fail("invalid_task_id", "必须提供完整UUID；请从耐久清单复制，不猜前缀。", {tasks})
      const registered = tasks.find(t=>t.task_id===args.task_id)
      if(registered?.result_source==="synchronous_receipt")return render(registered,await observe(registered,context.sessionID))
      const response = await platformFetch(`/images/${encodeURIComponent(args.task_id)}`, {method:"GET"}, context.sessionID,context.abort)
      const body = await response.json().catch(()=>({}))
      if (!response.ok) {const err=await classifyError(response,body);return fail(err.code,err.hint,{task_id:args.task_id,status:"unknown",recoverable:true,tasks})}
      if (!registered) {
        await gatewayRequest("/internal/job-import", {session_id:context.sessionID,task_id:args.task_id,kind:body.kind?.startsWith("video")?"video":"image",project:args.project,frame:args.frame},context.abort)
      }
      const task = {...registered,...body,task_id:args.task_id,artifacts:artifactsOf(body)}
      if (["succeeded","failed","refunded","cancelled"].includes(task.status)) {
        await gatewayRequest("/internal/job-completion", {task_id:args.task_id,status:task.status,artifacts:task.artifacts,reason:body.error?.message,cost_coins:body.cost_coins}).catch(()=>undefined)
      }
      reconcileSubmissions([task])
      return render(task,await observe(task,context.sessionID))
    } catch (e:any) {
      return fail("task_index_unavailable", "耐久任务索引暂不可达；原作业继续追随，不宣称无任务、不重新生成。", {recoverable:true})
    }
  },
})
