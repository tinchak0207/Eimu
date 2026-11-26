import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { atomicWrite } from "../lib/artifact-files"
import { readFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { WORKSPACE, checkAgentPath } from "../lib/sandbox"
import { recordArtifacts, verifiedArtifactEntries } from "../lib/image-journal"
import { tool } from "@opencode-ai/plugin/tool"
import { ok, fail, gatewayRequest, productionScope } from "../lib/client"
import {
  videoDownloadEnvironment,
  requireVideoDownload,
  prepareVideoDownload,
  isVideoUrl,
  downloadVideo,
  downloadDirectMedia,
} from "../lib/video-fetch"

// 平台视频契约的 size 是「比例归一」而非精确像素：模型原生缩放（如 720x1280→768x1344）仍是同一比例。
// 解析请求 size 的宽高比，接受 WxH / W:H / W×H；无法解析时回 null（不设闸）。
function parseSizeAspect(size: string | undefined): number | null {
  const match = /^\s*(\d+)\s*[xX×:]\s*(\d+)\s*$/.exec(size ?? "")
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  if (!width || !height) return null
  return width / height
}

// 影片抓取（薄包）：全部逻辑在 lib/video-fetch.ts（照抄竞品 hypit packages/yt-dlp/src/*）。
// 本档只做参数转译与错误码映射。
export default tool({
  description:
    "**视频生成产物回收用本工具**：传 `task_id`（action 可省略或传 `fetch`）→ 服务端直链下载全部 artifact、校验 SHA256/尺寸、原子落盘并提交 downloaded ACK；直链 artifact 不需要 prepare/yt-dlp。" +
    "**图片产物用 image_result_download**，不要用本工具下载图片。" +
    "其次是 URL 抓取：把一个 **http(s) 连结**变成一个本机影片档（video＋audio 一起抓、一起封装）。" +
    "URL 抓取前若目标是站点页（不是直链媒体），必须先 `action=prepare`：yt-dlp 是显式准备的**钉版 Python 依赖**，不是机器刚好带的二进位——" +
    "它为追站点常改版而频繁发版，未钉版会让同一条连结在两台机器抓出不同结果。" +
    "action=prepare 会建**独立环境**（venv，路径含版本号）并安装 pyproject 钉死的 yt-dlp 版本；action=fetch **绝不自行安装**，" +
    "未就绪时回 code=video_fetch_unavailable 并附 prepare 指引；action=status 只读查环境与版本就绪状态。" +
    "只接受 http:/https: 连结（本机路径不是连结；Windows 单字母 scheme 如 c:\\clip.mp4 会被当成 URL 而误判，故明确排除）。" +
    "落地档名必须以 .mp4/.mkv/.webm/.mov 结尾（决定容器），并偏好 1080p H.264。",
  args: {
    task_id:tool.schema.string().optional().describe("生成视频原完整UUID；优先于 url；逐一回收全部artifact并提交真实downloaded ACK。回收生成产物不需要 action=prepare"),
    action: tool.schema
      .enum(["fetch", "prepare", "status"])
      .optional()
      .describe("省略＝fetch；prepare=显式准备钉版 yt-dlp 环境（建 venv＋安装，可能数十秒）|fetch=抓取（站点页需先 prepare；直链媒体直接 HTTP 下载）|status=只读查环境与版本就绪状态"),
    url: tool.schema.string().optional().describe("action=fetch 必填；只接受 http/https 连结"),
    to: tool.schema.string().optional().describe("action=fetch 必填；落地档名，必须以 .mp4/.mkv/.webm/.mov 结尾"),
  },
  async execute(args, context) {
    if (args.action === "status") {
      const environment = videoDownloadEnvironment()
      let ready = false
      let detail = ""
      try {
        ready = true
        detail = requireVideoDownload()
      } catch (e) {
        ready = false
        detail = (e as Error).message
      }
      return ok({
        action: "status",
        ready,
        version: environment.version,
        environment: environment.environment,
        executable: environment.executable,
        project: environment.project,
        detail,
      })
    }

    if (args.action === "prepare") {
      try {
        const executable = prepareVideoDownload()
        return ok({
          action: "prepare",
          version: videoDownloadEnvironment().version,
          executable,
          title: "钉版 yt-dlp 已就绪",
        })
      } catch (e) {
        return fail("video_fetch_prepare_failed", (e as Error).message || "准备失败")
      }
    }

    if(args.task_id) {
      try {
        const listing=await gatewayRequest("/internal/session-tasks",{session_id:context.sessionID},context.abort)
        const task=listing.tasks?.find((t:any)=>t.task_id===args.task_id)
        const hasVideoArtifact=Array.isArray(task?.artifacts)&&task.artifacts.some((a:any)=>typeof a?.mimeType==="string"&&a.mimeType.startsWith("video/"))
        if(listing.durable!==true||!task||(task.kind!=="video"&&!hasVideoArtifact))return fail("task_not_found","没有耐久视频原任务；不得猜ID或重生成。")
        if(!["succeeded","cancelled","refunded","failed"].includes(task.status))return ok({task_id:args.task_id,status:task.status,downloaded_ack:false})
        const artifacts=task.artifacts??[]
        if(!artifacts.length)return fail("artifact_missing","原视频终态没有可下载产物。",{task_id:args.task_id,status:task.status})
        const scope=await productionScope(context.sessionID,task.project,context.abort)
        const records:any[]=[]
        for(let index=0;index<artifacts.length;index++) {
          const artifact=artifacts[index]
          const target=resolve(WORKSPACE,args.to? (artifacts.length===1?args.to:`${args.to}.${index}.mp4`):`out/video-results/${task.task_id}_${index}.mp4`)
          if(!checkAgentPath(target,context.sessionID).ok)throw new Error("视频输出路径被沙箱拒绝")
          const staging=await mkdtemp(join(tmpdir(),"generation-video-"))
          let bytes:Buffer
          try {
            const staged=join(staging,"artifact.mp4")
            if(!await downloadDirectMedia(artifact.url,staged,{signal:context.abort}))throw new Error("原视频artifact不是可安全下载直链；保留原task_id待恢复")
            bytes=readFileSync(staged)
          }finally{await rm(staging,{recursive:true,force:true})}
          atomicWrite(target,bytes,context.sessionID)
          const sha256=createHash("sha256").update(bytes).digest("hex")
          if(!bytes.length||(artifact.sha256&&artifact.sha256!==sha256))throw new Error("视频产物hash不符")
          const probe=await promisify(execFile)("ffprobe",["-v","error","-select_streams","v:0","-show_entries","stream=width,height","-of","json",target],{timeout:15000,maxBuffer:65536})
          const stream=JSON.parse(probe.stdout).streams?.[0]
          if(!stream?.width||!stream?.height)throw new Error("视频尺寸读取失败")
          const requestedAspect=parseSizeAspect(task.size)
          if(requestedAspect){
            const actualAspect=stream.width/stream.height
            if(Math.abs(Math.log(actualAspect/requestedAspect))>Math.log(1.02))throw new Error(`视频比例与原请求尺寸不符：请求 ${task.size}，实测 ${stream.width}×${stream.height}`)
          }
          records.push({...artifact,path:target,bytes:bytes.length,sha256,width:stream.width,height:stream.height})
        }
        recordArtifacts(scope,task.task_id,records)
        const receipt=await gatewayRequest("/internal/job-ack",{session_id:context.sessionID,task_id:task.task_id,stage:"downloaded",artifact_urls:records.map(a=>a.url),artifacts:records},context.abort)
        return ok({task_id:task.task_id,status:task.status,partial_result:task.status!=="succeeded"||artifacts.length<(task.requested_count??1),artifacts:records,downloaded_ack:receipt.acknowledged===true,new_generation:false})
      }catch(e:any){return fail("video_download_pending",e.message,{task_id:args.task_id,recoverable:true,new_generation:false,downloaded_ack:false})}
    }

    // action === "fetch"
    if (!args.url || !isVideoUrl(args.url)) {
      return fail(
        "video_fetch_bad_url",
        "action=fetch 需要 http(s) 的 url；本机路径或 Windows 单字母 scheme（c:\\clip.mp4）不是连结",
      )
    }
    if (!args.to) {
      return fail("video_fetch_bad_target", "action=fetch 需要 to（落地档名，.mp4/.mkv/.webm/.mov）")
    }
    // 直链媒体（.mp4 等、回 video/*）先走普通下载，不经 yt-dlp（见 lib downloadDirectMedia 注解）
    try {
      if (await downloadDirectMedia(args.url, args.to, { signal: context.abort })) {
        return ok({ action: "fetch", url: args.url, to: args.to, via: "direct", title: `已抓取 ${args.to}` })
      }
    } catch (e) {
      if (context.abort?.aborted) return fail("video_fetch_failed", (e as Error).message || "抓取中止")
    }
    try {
      requireVideoDownload()
    } catch (e) {
      return fail(
        "video_fetch_unavailable",
        `${(e as Error).message}｜请先呼叫 video_fetch action=prepare（建独立 venv 并安装 pyproject 钉死的 yt-dlp 版本）`,
        { prepare: 'video_fetch { action: "prepare" }' },
      )
    }
    try {
      await downloadVideo(args.url, args.to, { signal: context.abort })
      return ok({ action: "fetch", url: args.url, to: args.to, title: `已抓取 ${args.to}` })
    } catch (e) {
      return fail("video_fetch_failed", (e as Error).message || "抓取失败")
    }
  },
})
