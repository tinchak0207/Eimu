"""CLI-owned Skill catalog and installation protocol for native clients."""
from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path
import time

from . import skill_installer as skills, skill_maintenance
from .i18n import tr


class Skills:
    def __init__(self, emit, environment, *, directory=None):
        self.emit, self.environment = emit, environment
        self.directory = Path(directory) if directory else skill_maintenance.state_directory()
        self.task = None
        self.files = dict(skills._local_skill_files(None))
        self.expected_files = self.files
        self.context = None
        saved = skill_maintenance.load(self.directory)
        self.state = {"auto_check": saved.get("auto_check", True), "last_attempt": 0,
                      "checking": False, "busy": False, "source": {}, "cached": False,
                      "error": "", "targets": [], "plan_id": "", "can_sync": False,
                      "result": None, "maintenance": saved.get("maintenance", [])}

    def save(self):
        skill_maintenance.set_automatic(self.state["auto_check"], self.directory)

    def changed(self):
        self.emit("skills", self.state)

    def snapshot(self, env, info, config_dir):
        self.context = (dict(env), dict(info), config_dir)
        return self.refresh()

    def refresh(self):
        if not self.context:
            return self.state
        from .cli import _get_version
        env, info, config_dir = self.context
        self.files = self.expected_files = dict(skills._local_skill_files(None))
        result = skills.status_skill_targets(list(skills.SKILL_TARGET_BY_ID),
            project_root=self.environment.home, files=self.files, env=env)
        fingerprint = {"source": result["bundled_hash"], "targets": [(t["path"], t["installed_hash"]) for t in result["targets"]]}
        self.state.update(targets=result["targets"], cli_version=_get_version(), cli_ready=True,
            source={"version": _get_version(), "managed_by": "cli"}, compatibility="", cached=False,
            can_sync=not self.state["busy"],
            plan_id=hashlib.sha256(json.dumps(fingerprint, sort_keys=True).encode()).hexdigest())
        return self.state

    def auto_check(self, env, info, config_dir):
        if self.state["auto_check"] and time.time() - self.state["last_attempt"] >= 86400:
            skill_maintenance.maintain(directory=self.directory)
            self.state["maintenance"] = skill_maintenance.load(self.directory).get("maintenance", [])
            self.snapshot(env, info, config_dir)
            self.state["last_attempt"] = time.time()
            self.changed()

    def check(self, context=None):
        if self.state["busy"]:
            return self.state
        if context:
            self.snapshot(*context)
        self.refresh()
        self.state.update(last_attempt=time.time(), error="")
        self.changed()
        return self.state

    def remove(self, params):
        if self.state["busy"] or not self.context or params.get("confirm") is not True:
            raise ValueError(tr('请确认并选择有效的 Skills 目标。'))
        targets = params.get("targets")
        if not isinstance(targets, list) or not targets or any(not isinstance(t, str) or t not in skills.SKILL_TARGET_BY_ID for t in targets):
            raise ValueError(tr('请确认并选择有效的 Skills 目标。'))
        self.state["result"] = skill_maintenance.remove(targets, home=self.environment.home,
            env=self.context[0], directory=self.directory)
        self.refresh()
        self.changed()
        return self.state

    def sync(self, params):
        if self.state["busy"] or self.state["checking"]:
            raise ValueError(tr('Skills 操作正在进行，请等待完成。'))
        self.refresh()
        targets = params.get("targets")
        if (params.get("confirm") is not True or not isinstance(targets, list) or not targets
                or any(not isinstance(t, str) or t not in skills.SKILL_TARGET_BY_ID for t in targets)):
            raise ValueError(tr('请确认并选择有效的 Skills 目标。'))
        if not self.state["can_sync"] or params.get("plan_id") != self.state["plan_id"]:
            raise ValueError(tr('Skills 来源或本机状态已变化，请重新检查后确认更新。'))
        env = self.context[0]
        files = dict(self.expected_files)
        self.state.update(busy=True, result=None)
        self.task = asyncio.create_task(self._sync(list(dict.fromkeys(targets)), files, env))
        self.changed()
        return self.state

    async def _sync(self, targets, files, env):
        installed, failed = [], []
        try:
            for target in targets:
                try:
                    dest = skills.target_path(target, self.environment.home, env)
                    row = next(row for row in self.state["targets"] if row["target"] == target)
                    if row["status"] in {"up_to_date", "extra_files"}:
                        installed.append({"target": target, "path": str(dest), "changed_files": 0, "backup": ""})
                        continue
                    receipt = await asyncio.to_thread(skills.write_skill_files, dest, files,
                                                     self.directory / "backups", backup_prefix=target + "-")
                    installed.append({"target": target, "path": str(dest), **receipt})
                except (OSError, ValueError) as error:
                    failed.append({"target": target, "error": str(error)})
            try:
                skill_maintenance.register(installed, files, directory=self.directory)
            except OSError:
                failed.extend({"target": row["target"], "error": tr("自动维护登记失败；Skill 文件已保留，请重试。")} for row in installed)
            self.state["result"] = {"ok": not failed, "installed": installed, "failed": failed}
        finally:
            self.state["busy"] = False
            self.refresh()
            self.changed()

    async def close(self):
        if self.task and not self.task.done():
            if self.state["checking"]:
                self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
