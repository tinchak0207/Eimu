import { tool } from "@opencode-ai/plugin/tool"
import { gatewayRequest, flushTaskRegistrations, ok, fail } from "../lib/client"
import { reconcileSubmissions } from "../lib/image-journal"

export default tool({
  description:"从耐久索引整批查视频终态、完整job UUID与全部artifacts（免费）。不必知道全部ID，不做30次单查假枚举。refunded/failed/cancelled是真实失败；未知和排队不是完成。读取只ACK observed；succeeded 有 artifact 后，用 video_fetch {task_id} 真实下载并提交 downloaded ACK。",
  args:{
    job_ids:tool.schema.string().optional().describe("可选JSON ID数组或逗号分隔完整ID；省略取当前session全部视频job"),
    project:tool.schema.string().optional(),
    frame:tool.schema.number().int().min(1).optional(),
  },
  async execute(args,context) {
    try {
      await flushTaskRegistrations()
      let ids:string[]|undefined
      if(args.job_ids){try{const raw=JSON.parse(args.job_ids);ids=Array.isArray(raw)?raw:typeof raw==="string"?[raw]:[]}catch{ids=args.job_ids.split(",").map(v=>v.trim()).filter(Boolean)};if(!ids?.length||ids.some(id=>typeof id!=="string"))return fail("bad_request","job_ids需要完整ID字符串数组。")}
      const listing=await gatewayRequest("/internal/session-tasks",{session_id:context.sessionID,project:args.project,frame:args.frame},context.abort)
      if(listing.durable!==true||!Array.isArray(listing.tasks))return fail("invalid_task_index","耐久索引响应无tasks；不推断没有视频。")
      const tasks=listing.tasks.filter((t:any)=>(t.kind==="video"||(Array.isArray(t.artifacts)&&t.artifacts.some((a:any)=>typeof a?.mimeType==="string"&&a.mimeType.startsWith("video/"))))&&(!ids||ids.includes(t.task_id)))
      reconcileSubmissions(tasks)
      const jobs=[]
      for(const task of tasks){
        let observed=false
        try{observed=(await gatewayRequest("/internal/job-ack",{session_id:context.sessionID,task_id:task.task_id,stage:"observed"})).acknowledged===true}catch{}
        const artifacts=Array.isArray(task.artifacts)?task.artifacts:[]
        jobs.push({...task,status:task.status??"unknown",artifacts,video_url:task.status==="succeeded"?artifacts[0]?.url??null:null,observed,...(task.status==="succeeded"&&artifacts.length?{download_tool:"video_fetch",download_args:{task_id:task.task_id}}:{})})
      }
      return ok({title:"耐久视频作业清单",jobs,missing_ids:ids?.filter(id=>!jobs.some(j=>j.task_id===id))??[],note:"查询零生成费用；observed不代表下载、可解码或动态审阅。"})
    }catch{return fail("task_index_unavailable","耐久任务索引暂不可达；原job继续追随，不重新生成。",{recoverable:true})}
  },
})
