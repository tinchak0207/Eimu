import { atomicWrite } from "../lib/artifact-files"
import { tool } from "@opencode-ai/plugin/tool"
import { constants, accessSync, existsSync, mkdirSync, realpathSync, readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { gatewayRequest, flushTaskRegistrations, productionScope, ok, fail } from "../lib/client"
import { WORKSPACE, checkAgentPath, safeFetch } from "../lib/sandbox"
import { reconcileSubmissions, recordArtifacts, verifiedArtifactEntries } from "../lib/image-journal"

const exec = promisify(execFile)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_BYTES = 20 * 1024 * 1024
function assertPath(path:string,session:string):void{const verdict=checkAgentPath(path,session);if(!verdict.ok)throw new Error(`unsafe_output_path:${verdict.reason}`)}
async function imageDimensions(path:string):Promise<{width:number;height:number}> {
  // 复用生产剪辑已具备的ffprobe：不安装yt-dlp，不依赖shell联网。
  const {stdout}=await exec("ffprobe",["-v","error","-select_streams","v:0","-show_entries","stream=width,height,codec_name","-of","json",path],{timeout:10000,maxBuffer:65536})
  const stream=JSON.parse(stdout)?.streams?.[0]
  if(!stream||!["png","mjpeg","webp","av1"].includes(stream.codec_name)||!Number.isInteger(stream.width)||!Number.isInteger(stream.height)||stream.width<=0||stream.height<=0)throw new Error("invalid_image_dimensions")
  await exec("ffmpeg",["-v","error","-xerror","-i",path,"-frames:v","1","-f","null","-"],{timeout:15000,maxBuffer:65536})
  return {width:stream.width,height:stream.height}
}
async function bytesFrom(url:string, signal?:AbortSignal):Promise<Buffer> {
  const timed=AbortSignal.timeout(90000)
  const response=await safeFetch(url,{signal:signal?AbortSignal.any([signal,timed]):timed})
  if(!response.ok)throw new Error(`artifact_http_${response.status}`)
  const mime=(response.headers.get("content-type")??"").split(";")[0]
  if(mime.startsWith("video/"))throw new Error("artifact_is_video: 该产物是视频，请改用 video_fetch { task_id }")
  if(mime&&!mime.startsWith("image/")&&mime!=="application/octet-stream")throw new Error("artifact_not_image")
  if(Number(response.headers.get("content-length"))>MAX_BYTES){await response.body?.cancel();throw new Error("artifact_too_large")}
  const reader=response.body?.getReader()
  if(!reader)throw new Error("artifact_empty")
  const chunks:Uint8Array[]=[];let size=0
  try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES)throw new Error("artifact_too_large");chunks.push(value)}}
  catch(e){await reader.cancel().catch(()=>undefined);throw e} finally {reader.releaseLock()}
  if(!size)throw new Error("artifact_empty")
  return Buffer.concat(chunks)
}
function suffix(bytes:Buffer):string {
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return ".png"
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return ".jpg"
  if(bytes.toString("ascii",0,4)==="RIFF"&&bytes.toString("ascii",8,12)==="WEBP")return ".webp"
  throw new Error("artifact_not_supported_image")
}
export default tool({
  description:"显式图像产物能力：服务端按耐久job完整artifacts下载到共享工作区，验证真实图片尺寸与SHA256，原子落盘全部成功后才发送downloaded ACK。免费，不依赖沙箱网络或yt-dlp，不重生成。coverage从耐久job+本地字节hash得到。",
  args:{
    action:tool.schema.enum(["download","coverage","capabilities"]).optional(),
    task_ids:tool.schema.array(tool.schema.string()).optional().describe("完整job UUID；省略则按project/session取全量图片job"),
    project:tool.schema.string().optional(),
    frame:tool.schema.number().int().min(1).optional(),
    output_dir:tool.schema.string().optional().describe("共享工作区落盘目录，默认out/image-results/<项目或session>"),
    expected_width:tool.schema.number().int().min(1).optional(),
    expected_height:tool.schema.number().int().min(1).optional(),
  },
  async execute(args,context) {
    const action=args.action??"download"
    if(action==="capabilities") {
      try {
        accessSync(WORKSPACE,constants.W_OK)
        await exec("ffprobe",["-version"],{timeout:5000,maxBuffer:65536})
        await exec("ffmpeg",["-version"],{timeout:5000,maxBuffer:65536})
        return ok({image_artifact_download:true,workspace:WORKSPACE,tool:"image_result_download",network_execution:"trusted_server",yt_dlp_required:false,materializer:"ffprobe",max_bytes:MAX_BYTES,delivery_verified:false})
      } catch {return fail("image_result_download_unavailable","当前席位缺共享工作区写权限或图像解码工具；应转交具备明确图像回收能力的席位，不重生成。")}
    }
    try {
      await flushTaskRegistrations()
      const listing=await gatewayRequest("/internal/session-tasks",{session_id:context.sessionID,project:args.project,frame:args.frame},context.abort)
      if(listing.durable!==true||!Array.isArray(listing.tasks))return fail("invalid_task_index","缺耐久任务清单，不能假称coverage完整。")
      reconcileSubmissions(listing.tasks)
      const tasks=listing.tasks.filter((t:any)=>(!t.kind||t.kind==="image")&&(!args.task_ids||args.task_ids.includes(t.task_id)))
      const missing_ids=args.task_ids?.filter(id=>!tasks.some((t:any)=>t.task_id===id))??[]
      const scope=await productionScope(context.sessionID,args.project,context.abort)
      const bucket=createHash("sha256").update(scope).digest("hex").slice(0,20)
      const directory=resolve(WORKSPACE,args.output_dir??`out/image-results/${bucket}`)
      assertPath(directory,context.sessionID)
      const jobs:any[]=[]
      for(const task of tasks) {
        if(!UUID.test(task.task_id)){jobs.push({task_id:task.task_id,status:"invalid_task_id"});continue}
        const taskScope=task.project?await productionScope(context.sessionID,task.project,context.abort):scope
        const manifestPath=join(directory,`${task.task_id}.json`)
        if(action==="coverage") {
          try {
            assertPath(manifestPath,context.sessionID)
            const manifest={task_id:task.task_id,artifacts:verifiedArtifactEntries(taskScope,task.task_id)}
            const expected=(Array.isArray(task.artifacts)?task.artifacts:[]).filter((a:any)=>typeof a.url==="string")
            const remaining=[...expected]
            if(manifest.task_id!==task.task_id||!expected.length||manifest.artifacts.length!==expected.length)throw new Error("incomplete_manifest")
            for(const a of manifest.artifacts){
              assertPath(a.path,context.sessionID)
              const match=remaining.findIndex((authority:any)=>authority.url===a.url&&(!authority.sha256||authority.sha256===a.sha256))
              const bytes=readFileSync(a.path)
              if(match<0||bytes.length!==a.bytes||createHash("sha256").update(bytes).digest("hex")!==a.sha256)throw new Error("artifact_hash_mismatch")
              remaining.splice(match,1)
              const size=/^(\d+)x(\d+)$/.exec(task.size??"")
              if((size&&(a.width!==Number(size[1])||a.height!==Number(size[2])))||(args.expected_width!=null&&a.width!==args.expected_width)||(args.expected_height!=null&&a.height!==args.expected_height))throw new Error("artifact_dimensions_mismatch")
            }
            jobs.push({task_id:task.task_id,frame:task.frame,status:task.status,partial_result:task.status!=="succeeded"||expected.length<(task.requested_count??1),locally_verified:["succeeded","cancelled","refunded","failed"].includes(task.status),artifacts:manifest.artifacts,downloaded_ack:task.downloaded === true || task.downloaded_at != null})
          } catch {jobs.push({task_id:task.task_id,frame:task.frame,status:task.status,locally_verified:false})}
          continue
        }
        if(!["succeeded","cancelled","refunded","failed"].includes(task.status)){jobs.push({task_id:task.task_id,frame:task.frame,status:task.status??"unknown",locally_verified:false});continue}
        const artifacts=Array.isArray(task.artifacts)?task.artifacts.filter((a:any)=>typeof a.url==="string"):[]
        if(!artifacts.length){jobs.push({task_id:task.task_id,status:"artifact_missing",locally_verified:false});continue}
        const local:any[]=[]
        try {
          for(let index=0;index<artifacts.length;index++) {
            const artifact=artifacts[index]
            const bytes=await bytesFrom(artifact.url,context.abort)
            const path=join(directory,`${task.frame!=null?`f${String(task.frame).padStart(6,"0")}_`:""}${task.task_id}_${index}${suffix(bytes)}`)
            atomicWrite(path,bytes,context.sessionID)
            const dimensions=await imageDimensions(path)
            const requested=/^(\d+)x(\d+)$/.exec(task.size??"")
            if(requested&&(dimensions.width!==Number(requested[1])||dimensions.height!==Number(requested[2])))throw new Error("artifact_requested_dimensions_mismatch")
            if((args.expected_width!=null&&dimensions.width!==args.expected_width)||(args.expected_height!=null&&dimensions.height!==args.expected_height))throw new Error("artifact_dimensions_mismatch")
            const sha256=createHash("sha256").update(bytes).digest("hex")
            if(artifact.sha256&&artifact.sha256!==sha256)throw new Error("artifact_hash_mismatch")
            local.push({...artifact,path,sha256,bytes:bytes.length,...dimensions})
          }
          recordArtifacts(taskScope,task.task_id,local)
          atomicWrite(manifestPath,Buffer.from(JSON.stringify({task_id:task.task_id,project:task.project,frame:task.frame,artifacts:local},null,2)),context.sessionID)
          const receipt=await gatewayRequest("/internal/job-ack",{session_id:context.sessionID,task_id:task.task_id,stage:"downloaded",local_path:manifestPath,artifact_urls:local.map(a=>a.url),artifacts:local})
          jobs.push({task_id:task.task_id,frame:task.frame,status:task.status,partial_result:task.status!=="succeeded"||artifacts.length<(task.requested_count??1),locally_verified:true,artifacts:local,downloaded_ack:receipt.acknowledged===true})
        } catch(e:any){jobs.push({task_id:task.task_id,frame:task.frame,status:task.status,locally_verified:false,downloaded_ack:false,recoverable:true,error:e.message,partial_artifacts:local})}
      }
      const verified=jobs.filter(j=>j.locally_verified===true).length
      return ok({title:`图片产物：${verified}/${jobs.length}真实落盘`,action,jobs,missing_ids,coverage:{total:jobs.length,locally_verified:verified,downloaded_ack:jobs.filter(j=>j.downloaded_ack===true).length,complete:jobs.length>0&&verified===jobs.length&&missing_ids.length===0&&jobs.every(j=>j.status==="succeeded"&&!j.partial_result&&j.downloaded_ack===true)},output_dir:directory,note:"只回收已有产物，零生成费用；未落盘/未ACK均可用原task_id恢复。"})
    } catch(e:any){return fail("image_result_download_unavailable",e.message??"耐久索引或下载能力暂不可用。",{recoverable:true,new_generation:false})}
  },
})
