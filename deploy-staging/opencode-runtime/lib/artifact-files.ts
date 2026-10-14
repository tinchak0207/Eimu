import { constants, existsSync, mkdirSync, realpathSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from "node:fs"
import { basename, dirname } from "node:path"
import { randomUUID } from "node:crypto"
import { checkAgentPath } from "./sandbox"
function assertPath(path:string, session:string):void {
  const verdict=checkAgentPath(path,session)
  if (!verdict.ok) throw new Error(`unsafe_output_path:${verdict.reason}`)
}
export function atomicWrite(path:string, bytes:Uint8Array, session:string):void {
  assertPath(path,session)
  mkdirSync(dirname(path),{recursive:true,mode:0o700})
  assertPath(path,session)
  const directory=realpathSync(dirname(path))
  assertPath(directory,session)
  // 绑定真实目录FD；检查后替换祖先symlink也不能把写入改道工作区外。
  const dirfd=openSync(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
  const bound=`/proc/self/fd/${dirfd}`
  const tempName=`${basename(path)}.${randomUUID()}.partial`
  const temp=`${bound}/${tempName}`
  try {
    assertPath(realpathSync(bound),session)
    const fd=openSync(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
    try {writeFileSync(fd,bytes);fsyncSync(fd)} finally {closeSync(fd)}
    if(realpathSync(dirname(path))!==directory)throw new Error("output_directory_changed")
    assertPath(path,session)
    renameSync(temp,`${bound}/${basename(path)}`)
    fsyncSync(dirfd)
  } finally {
    if(existsSync(temp))unlinkSync(temp)
    closeSync(dirfd)
  }
}
