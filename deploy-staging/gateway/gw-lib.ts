// gw-lib.ts — 共享小工具（從 index.ts 逐行抽取，2026-09-19 無損重構第一階段）
// 內容：sleep / jsonError / getBearer（原 index.ts ≈969–983）

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function jsonError(status: number, message: string, type: string, code: string): Response {
  return Response.json({ error: { message, type, code } }, { status })
}

export function getBearer(req: Request): string | null {
  const auth = req.headers.get("authorization")
  if (!auth) return null
  const m = auth.match(/^Bearer\s+(.+)$/i)
  return m ? m[1].trim() : null
}
