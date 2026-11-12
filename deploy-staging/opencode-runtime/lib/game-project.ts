import { mkdirSync, lstatSync, existsSync, realpathSync } from "node:fs"
import path from "node:path"
import { contentHash, gameProjectRecord, gameProjectSnapshot, saveGameCheckpoint } from "./image-journal"
import { allowedUploads, checkAgentPath, UPLOADS } from "./sandbox"

/** 项目名只作标识，目录由可信项目scope派生，不接收模型指定的任意根目录。 */
export function gameProject(scope: string, project: string, sessionID: string, create = true): any {
  if (!project.trim() || project.length>160) throw new Error("invalid_project: 项目标识必须为1至160字符。")
  let row=gameProjectRecord(scope)
  if (!row) {
    if(!create) throw new Error("game_project_not_found: 该项目尚无工作区或检查点，不能将未创建误报成空项目。")
    const owner=[...allowedUploads(sessionID)].sort()[0]
    if(!owner) throw new Error("project_owner_unavailable: 缺可信上传目录归属，无法创建项目工作区。")
    const workspace=path.join(UPLOADS,owner,"game-projects",contentHash(scope))
    assertProjectPath(workspace,sessionID)
    mkdirSync(workspace,{recursive:true,mode:0o700})
    row=gameProjectRecord(scope,project,workspace)
  }
  assertProjectPath(row.workspace,sessionID)
  return {project:row.project,workspace:row.workspace,...gameProjectSnapshot(scope)}
}
function assertProjectPath(workspace: string, sessionID: string): void {
  if(!checkAgentPath(workspace,sessionID).ok) throw new Error("project_path_denied: 项目目录不在本账号已授权上传目录内。")
  // 逐层拒绝链接（包括指回允许范围的链接），不让路径在检查与写入间偷偷改变归属。
  let current=path.parse(workspace).root
  for(const segment of workspace.slice(current.length).split(path.sep)) {
    current=path.join(current,segment)
    if(existsSync(current)&&lstatSync(current).isSymbolicLink()) throw new Error("project_symlink_denied: 项目路径包含符号链接。")
  }
  if(existsSync(workspace)&&realpathSync(workspace)!==workspace) throw new Error("project_path_denied: 项目路径解析不一致。")
}
export function gameCheckpoint(scope: string, project: string, sessionID: string, operationID: string, stage: string, state: string, receipt: unknown): any {
  gameProject(scope,project,sessionID)
  saveGameCheckpoint(scope,operationID,stage,state,receipt)
  return gameProject(scope,project,sessionID)
}
