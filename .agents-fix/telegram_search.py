#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Telegram 全局搜索（Telethon messages.SearchGlobal）——搜整个公开 Telegram（类似客户端顶部全局搜索）。

用法：
  python3 telegram_search.py "关键词" [--limit 8]   # 搜索（输出 JSON）
  python3 telegram_search.py --status               # 登录状态检查
  python3 telegram_search.py --login                # 交互登录（手机号+验证码，需在终端跑）

凭据：
  api_id/api_hash：环境变量 SCOUT_API_ID / SCOUT_API_HASH（或 TELEGRAM_API_ID / TELEGRAM_API_HASH）
  session：优先复用 telegram-channel-scout 的 .secrets/channel_scout.session；
           否则用 state/telegram.session（--login 生成）
"""
import argparse
import asyncio
import json
import os
import sys

SCOUT_SESSION = os.path.expanduser(
    "/home/lenovo/.openclaw/workspace/telegram-channel-scout/.secrets/channel_scout.session"
)
STATE_SESSION = os.path.expanduser(
    "/home/lenovo/Desktop/image-app/.agents-fix/telegram.session"
)


CREDS_FILE = os.path.expanduser("~/.agents/skills/aggregate-search/state/telegram_creds.json")


def get_api():
    api_id = os.environ.get("SCOUT_API_ID") or os.environ.get("TELEGRAM_API_ID")
    api_hash = os.environ.get("SCOUT_API_HASH") or os.environ.get("TELEGRAM_API_HASH")
    if not api_id or not api_hash and os.path.exists(CREDS_FILE):
        try:
            d = json.load(open(CREDS_FILE))
            api_id = api_id or d.get("api_id")
            api_hash = api_hash or d.get("api_hash")
        except Exception:
            pass
    if not api_id or not api_hash:
        return None, None
    return int(api_id), api_hash


def pick_session():
    if os.path.exists(STATE_SESSION):
        return STATE_SESSION
    return SCOUT_SESSION


async def search_global(client, query, limit):
    from telethon import functions
    from telethon.tl.types import InputPeerEmpty, InputMessagesFilterEmpty
    r = await client(functions.messages.SearchGlobalRequest(
        q=query, filter=InputMessagesFilterEmpty(), folder_id=None, min_date=None, max_date=None,
        offset_rate=0, offset_peer=InputPeerEmpty(), offset_id=0, limit=limit,
    ))
    chats = {getattr(c, "id", None): c for c in r.chats}
    users = {getattr(u, "id", None): u for u in r.users}
    results = []
    for m in r.messages:
        text = m.message or ""
        if not text.strip():
            continue
        chat_id = None
        pid = getattr(m, "peer_id", None)
        if pid is not None:
            chat_id = (getattr(pid, "chat_id", None) or getattr(pid, "channel_id", None)
                       or getattr(pid, "user_id", None))
        chat = chats.get(chat_id) or users.get(chat_id)
        title = getattr(chat, "title", None) or getattr(chat, "first_name", None) or ""
        username = getattr(chat, "username", None) or ""
        msg_id = m.id
        if username:
            url = f"https://t.me/{username}/{msg_id}"
        elif chat_id:
            url = f"https://t.me/c/{chat_id}/{msg_id}"
        else:
            url = ""
        results.append({
            "title": text[:80],
            "url": url,
            "snippet": text[:300],
            "author": title,
        })
    return results


async def main():
    ap = argparse.ArgumentParser(description="Telegram 全局搜索")
    ap.add_argument("query", nargs="?", default=None)
    ap.add_argument("--limit", type=int, default=8)
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--login", action="store_true")
    args = ap.parse_args()

    api_id, api_hash = get_api()
    if not api_id:
        print(json.dumps({"ok": False,
                          "error": "缺少 api_id/api_hash：export SCOUT_API_ID=... SCOUT_API_HASH=...（my.telegram.org 申请）"},
                         ensure_ascii=False))
        sys.exit(1)

    session = STATE_SESSION if args.login else pick_session()
    client = None
    try:
        from telethon import TelegramClient
        client = TelegramClient(session, api_id, api_hash)

        if args.login:
            await client.start()
            print(json.dumps({"ok": True, "session": session}, ensure_ascii=False))
            return

        await client.connect()
        if not await client.is_user_authorized():
            print(json.dumps({"ok": False,
                              "error": f"session 无效，请运行 --login（终端交互）：{session}"},
                             ensure_ascii=False))
            return

        if args.status:
            me = await client.get_me()
            print(json.dumps({"ok": True, "user": me.first_name,
                              "username": me.username, "session": session}, ensure_ascii=False))
            return

        results = await search_global(client, args.query, args.limit)
        print(json.dumps({"ok": True, "results": results}, ensure_ascii=False))
    finally:
        if client is not None:
            await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())

