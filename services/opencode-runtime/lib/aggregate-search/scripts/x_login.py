#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""X/Twitter 登录引导（一次性）。

用法：
  方式A（推荐，粘贴 cookie）：先在浏览器登录 https://x.com ，
    用 Cookie-Editor 扩展导出 JSON，然后：
    python3 x_login.py --cookie '{"auth_token":"...","ct0":"...",...}'
    或先存到文件：python3 x_login.py --file /path/cookies.json
  方式B（交互式账号登录，在终端跑）：
    python3 x_login.py --login

登录态默认保存到 state/x_cookies.json（twikit 格式）。
"""
import argparse
import json
import os
import sys

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_DIR = os.environ.get("AGGREGATE_SEARCH_STATE_DIR", os.path.join(BASE_DIR, "state"))
STATE = os.path.join(STATE_DIR, "x_cookies.json")


def save(cookies: dict) -> None:
    from twikit import Client
    client = Client("zh-CN")
    client.set_cookies(cookies)
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    client.save_cookies(STATE)
    print(f"登录态已保存: {STATE}")


def interactive() -> None:
    import asyncio
    import getpass
    from twikit import Client
    print("输入 X 账号信息（密码不回显，仅本机处理）:")
    email = input("  邮箱/手机号: ").strip()
    username = input("  X 用户名(不带@): ").strip()
    password = getpass.getpass("  密码: ")
    print("正在登录，可能需要邮箱/短信验证码……")

    async def _login():
        client = Client("zh-CN")
        await client.login(auth_info_1=email, auth_info_2=username, password=password)
        os.makedirs(os.path.dirname(STATE), exist_ok=True)
        client.save_cookies(STATE)
        return client

    asyncio.run(_login())
    print(f"登录成功，session 已保存: {STATE}")


def main():
    ap = argparse.ArgumentParser(description="X 登录引导")
    ap.add_argument("--cookie", help="cookie JSON 字符串")
    ap.add_argument("--file", help="cookie JSON 文件路径")
    ap.add_argument("--login", action="store_true", help="交互式账号登录")
    args = ap.parse_args()

    if args.login:
        interactive()
        return
    if args.file:
        with open(args.file, "r", encoding="utf-8") as f:
            cookies = json.load(f)
    elif args.cookie:
        cookies = json.loads(args.cookie)
    else:
        ap.print_help()
        sys.exit(1)
    cookies = {k: str(v) for k, v in cookies.items() if isinstance(v, (str, int, float))}
    save(cookies)


if __name__ == "__main__":
    main()
