# aggregate-search telegram 通道修复（2026-08-25）

## 根因
- ~/.agents 所在根分区 / 被挂载为只读（/dev/nvme0n1p2 ext4 ro），容器内 sudo 被禁（no new privileges）
- telethon 连 session 时必须写 SQLite（connect 时 delete from sessions / update_state）→ 只读 FS 报
  sqlite3.OperationalError: attempt to write a readonly database
- 原入口 ~/.agents/skills/aggregate-search/scripts/search.py 硬编码只读 session 路径 → telegram 通道必失败

## 修复（工作区补丁，不动只读区）
- telegram_search.py：STATE_SESSION 指向本目录 telegram.session（可写）
- telegram.session：从只读区复制的登录态（用户 wrogwww）
- search.py：聚合入口副本，telegram 通道指向本目录 telegram_search.py

## 用法
- 聚合全平台（telegram 通道走修复版）：
  python3 /home/lenovo/Desktop/image-app/.agents-fix/search.py "关键词"
- 单独 telegram 搜索：
  /home/lenovo/.agents/skills/aggregate-search/.venv/bin/python \
    /home/lenovo/Desktop/image-app/.agents-fix/telegram_search.py "关键词" [--limit N]

## 注意
- 原入口（~/.agents/.../search.py）的 telegram 通道仍坏，勿用；其他通道（bilibili/web/github/tavily）正常
- xhs 通道未登录仍失败（本次未修）
- venv 在只读区但可读，python 解释器不受影响
