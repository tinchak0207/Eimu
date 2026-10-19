"""CLI-owned receipts and conservative maintenance of explicitly connected Agents."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import time
import uuid

from . import skill_installer as skills
from .state_files import file_lock


def state_directory(home=None):
    if home:
        return Path(home) / ".local/share/smart-search-tools/skills"
    from .desktop_cli import tools_directory
    return tools_directory() / "skills"


def load(directory=None):
    directory = Path(directory) if directory else state_directory()
    try:
        value = json.loads((directory / "state.json").read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            return {}
        if not isinstance(value.get("managed", {}), dict):
            value["managed"] = {}
        return value
    except (OSError, ValueError):
        return {}


def save(value, directory=None):
    """Caller holds state.json's lock across read, mutation, and save."""
    directory = Path(directory) if directory else state_directory()
    directory.mkdir(parents=True, exist_ok=True)
    temporary = directory / f"state-{uuid.uuid4().hex}.tmp"
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
        temporary.replace(directory / "state.json")
    finally:
        temporary.unlink(missing_ok=True)


def set_automatic(enabled, directory):
    with file_lock(Path(directory) / "state.json"):
        state = load(directory)
        state["auto_check"] = bool(enabled)
        save(state, directory)


def hashes_at(dest, names):
    hashes = {}
    for name in names:
        if not isinstance(name, str) or not name or "\\" in name or ":" in name:
            raise ValueError("Invalid managed Skill receipt")
        path = dest / name
        if not path.resolve().is_relative_to(dest.resolve()):
            raise ValueError("Invalid managed Skill receipt")
        skills._refuse_links(path)
        hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return hashes


def cli_owner():
    """Identify the installation, independent of its product version or config profile."""
    import sys
    if os.getenv(skills.PACKAGE_ROOT_ENV):
        return str(Path(os.environ[skills.PACKAGE_ROOT_ENV]).resolve())
    if getattr(sys, "frozen", False):
        from .desktop_cli import tools_directory
        root = tools_directory()
        if Path(sys.executable).resolve().is_relative_to(root / "standalone/versions"):
            return str(root / "standalone")
        return str(Path(sys.executable).resolve())
    return str(Path(__file__).resolve().parent)


def register(installed, files, *, directory=None):
    directory = Path(directory) if directory else state_directory()
    if not installed:
        return
    from .config import config
    with file_lock(directory / "state.json"):
        state = load(directory)
        managed = state.setdefault("managed", {})
        for row in installed:
            managed[row["target"]] = {"path": row["path"], "files": hashes_at(Path(row["path"]), files),
                                      "owner": cli_owner(), "config_dir": str(config.config_file.parent)}
        state.setdefault("auto_check", True)
        save(state, directory)


def maintain(*, directory=None, force=False):
    """No network or output; only opted-in targets, and personal edits always win."""
    directory = Path(directory) if directory else state_directory()
    state = load(directory)
    if not state.get("managed") or not state.get("auto_check", True):
        return state
    try:
        with file_lock(directory / "state.json", timeout=0):
            return _maintain_locked(directory, force)
    except TimeoutError:
        return state


def _maintain_locked(directory, force):
    from .cli import _get_version
    state = load(directory)
    if not state.get("auto_check", True):
        return state
    version, owner = _get_version(), cli_owner()
    checks = state.get("checks")
    if not isinstance(checks, dict):
        checks = {}
    last_check = checks.get(owner, {})
    if not isinstance(last_check, dict):
        last_check = {}
    last = last_check.get("last_attempt", 0)
    if not force and last_check.get("cli_version") == version and isinstance(last, (int, float)) and 0 <= time.time() - last < 86400:
        return state
    from .config import config
    results = []
    for target, receipt in state.get("managed", {}).items():
        if target not in skills.SKILL_TARGET_BY_ID:
            continue
        try:
            if not isinstance(receipt, dict) or not isinstance(receipt.get("path"), str):
                raise ValueError("Invalid managed Skill receipt")
            if receipt.get("owner", owner) != owner:
                continue
            config_dir = receipt.get("config_dir")
            if config_dir is not None and (not isinstance(config_dir, str) or not Path(config_dir).is_absolute()):
                raise ValueError("Invalid managed Skill configuration")
            with config.snapshot(directory=config_dir):
                files = dict(skills._local_skill_files(None))
            dest = Path(receipt["path"])
            hashes = receipt.get("files")
            if not dest.is_absolute() or dest.name != skills.SKILL_NAME or not isinstance(hashes, dict) or not hashes:
                raise ValueError("Invalid managed Skill receipt")
            skills._refuse_links(dest)
            # Hold the same write lock as manual sync while checking and replacing.
            with file_lock(dest.parent / ".smart-search-cli-write"):
                if hashes_at(dest, hashes) != hashes:
                    results.append({"target": target, "status": "personal_changes"})
                    continue
                changed = skills._write_skill_files(dest, files, directory / "backups", backup_prefix=target + "-")
                receipt["files"] = hashes_at(dest, files)
            results.append({"target": target, "status": "updated", **changed})
        except (OSError, ValueError, TypeError):
            results.append({"target": target, "status": "needs_attention"})
    checks[owner] = {"last_attempt": time.time(), "cli_version": version}
    state.update(last_attempt=time.time(), cli_version=version, maintenance=results, checks=checks)
    save(state, directory)
    return state


def remove(target_ids, *, home=None, env=None, directory=None):
    root = Path(home) if home else Path.home()
    directory = Path(directory) if directory else state_directory(home)
    removed, failed = [], []
    with file_lock(directory / "state.json"):
        state = load(directory)
        for target in dict.fromkeys(target_ids):
            try:
                dest = skills.target_path(target, root, os.environ if env is None else env)
                skills._refuse_links(dest)
                backup = dest.parent / ".smart-search-backups" / f"removed-{target}-{time.time_ns()}"
                skills._refuse_links(backup)
                with file_lock(dest.parent / ".smart-search-cli-write"):
                    if dest.exists():
                        backup.parent.mkdir(parents=True, exist_ok=True)
                        dest.rename(backup)
                state.get("managed", {}).pop(target, None)
                removed.append({"target": target, "path": str(dest), "backup": str(backup) if backup.exists() else ""})
            except (OSError, ValueError, KeyError) as error:
                failed.append({"target": target, "error": str(error)})
        save(state, directory)
    return {"ok": not failed, "removed": removed, "failed": failed}
