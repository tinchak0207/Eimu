import { createHash } from "node:crypto"

/** 制作项目归属格式的唯一来源。ownerScope 来自服务端身份，project只是该身份内的标签。 */
export function sharedGenerationScope(ownerScope: string, project?: string): string {
  if (!ownerScope?.trim()) throw new Error("trusted stable owner identity unavailable")
  return project ? `project:${createHash("sha256").update(ownerScope + "\0" + project).digest("hex")}` : ownerScope
}
