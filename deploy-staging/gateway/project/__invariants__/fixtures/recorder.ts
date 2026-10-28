// fake opencode（127.0.0.1:随机端口）：只做一件事——把网关投递的请求体原样记下来。
// 「伪用户消息=0」与「上下文 ≤65536 字节」都以这里收到的原始字节为准，不看被测实现的自报数字。
import "./env.ts"

export interface RecordedRequest {
  path: string
  body: string
  bytes: number
  at: number
}

const requests: RecordedRequest[] = []

export const opencodeRecorder = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname
    const body = await req.text()
    if (req.method === "POST") requests.push({ path, body, bytes: Buffer.byteLength(body, "utf8"), at: Date.now() })
    return Response.json({ ok: true, id: `msg_rec_${requests.length}` }, { status: 200 })
  },
})

export const recorder = {
  requests,
  get base(): string {
    return `http://127.0.0.1:${opencodeRecorder.port}`
  },
  reset(): void {
    requests.length = 0
  },
  last(): RecordedRequest | undefined {
    return requests[requests.length - 1]
  },
}

export function recorderOf(): typeof recorder {
  return recorder
}
