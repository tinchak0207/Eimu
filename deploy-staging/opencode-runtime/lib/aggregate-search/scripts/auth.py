#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""聚合搜索登录与环境配置引导。

免登录通道（bilibili/web/github 等）已覆盖大部分日常需求。
此脚本负责：当你需要 Telegram 全域搜索或小红书/X 等受限平台站内热度排序时，给出配置引导。
"""
import sys

GUIDE = {
    "telegram": {
        "why": "Telegram 全域搜索（Telethon）需要 Telegram API 凭据与账号 Session",
        "option_a": "配置环境变量 TELEGRAM_API_ID / TELEGRAM_API_HASH（在 my.telegram.org 申请）",
        "option_b": "运行 python3 scripts/telegram_search.py --login 登录并生成 session",
    },
    "xhs": {
        "why": "小红书站内搜索需配合 xhs-cli 或有效 Cookie",
        "option_a": "使用 Cookie-Editor 导出并在 ~/.xiaohongshu-cli/cookies.json 中配置",
    },
    "tavily": {
        "why": "Tavily AI 智能搜索需要官方 API Key",
        "option_a": "设置环境变量 export TAVILY_API_KEY=tvly-...",
    },
    "x": {
        "why": "X/Twitter 需 twikit 登录凭据",
        "option_a": "运行 python3 scripts/x_login.py 配置登录态",
    },
    "bilibili": {"why": "官方 API + WBI 签名，免登录开箱即用", "option_a": None},
    "github": {"why": "官方 Search API（10 req/min），免登录开箱即用", "option_a": None},
    "web": {"why": "Bing RSS，免登录开箱即用", "option_a": None},
}


def main():
    targets = sys.argv[1:] or ["all"]
    for t in targets:
        if t == "all":
            for k, v in GUIDE.items():
                print(f"### {k}: {v['why']}")
                if v.get("option_a"):
                    print(f"  -> {v['option_a']}")
                if v.get("option_b"):
                    print(f"  -> {v['option_b']}")
            continue
        v = GUIDE.get(t)
        if not v:
            print(f"未知平台: {t}")
            continue
        print(f"### {t}: {v['why']}")
        if v.get("option_a"):
            print(f"  -> {v['option_a']}")
        if v.get("option_b"):
            print(f"  -> {v['option_b']}")


if __name__ == "__main__":
    main()
