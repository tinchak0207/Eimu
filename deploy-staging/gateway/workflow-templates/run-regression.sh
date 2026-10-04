#!/usr/bin/env bash
# W6 模板目录常驻回归（2026-09-28）。
# 每日跑 13 模板逐支展开契约：节点数/衍生卡/role 命名/连线端点/泳道座标/placeholder 形状。
# 任一格漂移 → 非零退出（systemd 记 failed，可用 systemctl status 追）。
# 执行器：VPS 有 bun（agent-gateway.service 就是 bun 跑的），故用 bun 不用 node。
set -uo pipefail

cd /opt/agent-harness/gateway || exit 2
export PATH="/home/ubuntu/.bun/bin:$PATH"

exec bun test workflow-templates/workflow-templates.test.ts
