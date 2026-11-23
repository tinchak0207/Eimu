/** 没有账号就建不了会话。返回 "auth" 时，发送路径必须把原句交给登录后补送。 */
export function refusalWhenNoOwner(owner: number | null): "auth" | null {
  return owner === null ? "auth" : null
}

export type SessionClosedReason = "session" | "auth" | "manual"

/** runStartCore 在建会话前调用。未登录时把连接标成 auth，send() 才能留住原句。 */
export function markClosedForLoggedOutOwner(
  owner: number | null,
): { closed: true; closedReason: "auth" } | null {
  if (refusalWhenNoOwner(owner) !== "auth") return null
  return { closed: true, closedReason: "auth" }
}

/** 还没有 sessionId 时，send() 对这句话的处置。stash＝原句交给登录后补送。 */
export function unsentSentenceDisposition(
  closed: boolean,
  closedReason: SessionClosedReason | null,
): "stash" | "nosession" {
  if (closed && closedReason === "auth") return "stash"
  return "nosession"
}

/**
 * send() 在 start() 之后的分叉。sessionId 仍空时，要么把修剪后的原句交给 keep，
 * 要么 drop。有 sessionId 则继续真正发送，不改这句话。
 */
export function keepSentenceOnSend(input: {
  sessionId: string | null
  closed: boolean
  closedReason: SessionClosedReason | null
  text: string
  keep: (sentence: string) => void
  drop: () => void
}): "deliver" | "kept" | "dropped" {
  if (input.sessionId) return "deliver"
  if (unsentSentenceDisposition(input.closed, input.closedReason) === "stash") {
    input.keep(input.text)
    return "kept"
  }
  input.drop()
  return "dropped"
}
