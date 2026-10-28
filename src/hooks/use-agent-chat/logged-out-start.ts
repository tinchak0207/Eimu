/** 没有账号就建不了会话。返回 "auth" 时，发送路径必须把原句交给登录后补送。 */
export function refusalWhenNoOwner(owner: number | null): "auth" | null {
  return owner === null ? "auth" : null
}
