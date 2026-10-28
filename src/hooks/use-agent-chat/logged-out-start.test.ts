import { describe, expect, test } from "bun:test"
import { refusalWhenNoOwner } from "./logged-out-start.ts"

describe("未登录不能建会话", () => {
  test("没有账号时标记为 auth，登录后补送仍用原句", () => {
    expect(refusalWhenNoOwner(null)).toBe("auth")
  })

  test("已有账号不走这条拒绝", () => {
    expect(refusalWhenNoOwner(4242)).toBe(null)
  })
})
