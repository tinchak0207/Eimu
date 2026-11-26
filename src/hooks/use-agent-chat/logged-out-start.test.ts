import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { readPendingTrial, stashBlockedSend, type PromoStorage } from "../../components/promo/promo-gate.ts"
import { REPLICATE_FILMS } from "../../lib/generation-core/replicate-films.ts"
import {
  keepSentenceOnSend,
  markClosedForLoggedOutOwner,
  refusalWhenNoOwner,
} from "./logged-out-start.ts"

function memoryStore(): PromoStorage {
  const box = new Map<string, string>()
  return {
    getItem: (key) => box.get(key) ?? null,
    setItem: (key, value) => { box.set(key, value) },
    removeItem: (key) => { box.delete(key) },
  }
}

describe("未登录不能建会话", () => {
  test("没有账号时标记为 auth，登录后补送仍用原句", () => {
    assert.strictEqual(refusalWhenNoOwner(null), "auth")
  })

  test("已有账号不走这条拒绝", () => {
    assert.strictEqual(refusalWhenNoOwner(4242), null)
  })

  test("未登录走 send 的留句分叉，登录后补送的是这张卡的原句", () => {
    const film = REPLICATE_FILMS.find((item) => item.sentence.includes("茶饮"))
    if (!film) throw new Error("茶饮卡不在复刻列表里")
    const marked = markClosedForLoggedOutOwner(null)
    assert.deepStrictEqual(marked, { closed: true, closedReason: "auth" })
    const store = memoryStore()
    const outcome = keepSentenceOnSend({
      sessionId: null,
      closed: marked!.closed,
      closedReason: marked!.closedReason,
      text: film.sentence.trim(),
      keep: (sentence) => { stashBlockedSend(store, sentence) },
      drop: () => { throw new Error("未登录不该把原句丢掉") },
    })
    assert.strictEqual(outcome, "kept")
    assert.strictEqual(readPendingTrial(store), film.sentence)
    assert.strictEqual(film.sentence.includes("换成"), true)
  })

  test("已有账号但会话没建成，不把这句话写进登录补送", () => {
    assert.strictEqual(markClosedForLoggedOutOwner(4242), null)
    const store = memoryStore()
    let dropped = false
    const outcome = keepSentenceOnSend({
      sessionId: null,
      closed: false,
      closedReason: null,
      text: "茶饮广告：15 秒，三镜，16:9。产品换成「茶饮」",
      keep: () => { throw new Error("不该留句") },
      drop: () => { dropped = true },
    })
    assert.strictEqual(outcome, "dropped")
    assert.strictEqual(dropped, true)
    assert.strictEqual(readPendingTrial(store), null)
  })

  test("会话已经在，原句继续送出，不进补送格", () => {
    const store = memoryStore()
    const outcome = keepSentenceOnSend({
      sessionId: "sid-1",
      closed: true,
      closedReason: "auth",
      text: "茶饮广告：15 秒，三镜，16:9。产品换成「茶饮」",
      keep: (sentence) => { stashBlockedSend(store, sentence) },
      drop: () => { throw new Error("有会话不该丢") },
    })
    assert.strictEqual(outcome, "deliver")
    assert.strictEqual(readPendingTrial(store), null)
  })
})
