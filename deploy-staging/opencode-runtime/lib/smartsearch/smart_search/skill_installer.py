from __future__ import annotations
from .i18n import tr

import os
import shlex
import shutil
import stat
import uuid
from dataclasses import dataclass
from hashlib import sha256
from importlib import resources
from pathlib import Path
from typing import Any
from .state_files import file_lock


SKILL_NAME = "smart-search-cli"
PACKAGE_ROOT_ENV = "SMART_SEARCH_PACKAGE_ROOT"


@dataclass(frozen=True)
class SkillTarget:
    target_id: str
    label: str
    relative_root: str
    default: bool = False

    @property
    def skill_relative_path(self) -> str:
        return f"{self.relative_root}/{SKILL_NAME}"


SKILL_TARGETS: tuple[SkillTarget, ...] = (
    SkillTarget("codex", "Codex", ".agents/skills", True),
    SkillTarget("claude", "Claude Code", ".claude/skills", True),
    SkillTarget("cursor", "Cursor", ".cursor/skills", True),
    SkillTarget("opencode", "OpenCode", ".config/opencode/skills"),
    SkillTarget("copilot", "GitHub Copilot", ".copilot/skills"),
    SkillTarget("gemini", "Gemini CLI", ".gemini/skills"),
    SkillTarget("cline", "Cline", ".cline/skills"),
    SkillTarget("roo", "Roo Code", ".roo/skills"),
    SkillTarget("kiro", "Kiro", ".kiro/skills"),
    SkillTarget("qoder", "Qoder", ".qoder/skills"),
    SkillTarget("codebuddy", "CodeBuddy", ".codebuddy/skills"),
    SkillTarget("droid", "Factory Droid", ".factory/skills"),
    SkillTarget("pi", "Pi Agent", ".pi/agent/skills"),
    SkillTarget("kilo", "Kilo CLI", ".kilocode/skills"),
    SkillTarget("antigravity", "Antigravity", ".agent/skills"),
    SkillTarget("windsurf", "Windsurf", ".windsurf/skills"),
    SkillTarget("hermes", "Hermes Agent", ".hermes/skills"),
)

SKILL_TARGET_BY_ID = {target.target_id: target for target in SKILL_TARGETS}
DEFAULT_SKILL_TARGET_IDS = [target.target_id for target in SKILL_TARGETS if target.default]
LEGACY_SKILL_ROOTS_BY_TARGET: dict[str, tuple[str, ...]] = {
    "codex": (".codex/skills",),
    "opencode": (".opencode/skills",),
}

_TARGET_ALIASES = {
    "agents": "codex",
    "agentskills": "codex",
    "agent-skills": "codex",
    "claude-code": "claude",
    "github-copilot": "copilot",
    "gh-copilot": "copilot",
    "factory": "droid",
    "factory-droid": "droid",
    "pi-agent": "pi",
    "kilo-cli": "kilo",
    "hermes-agent": "hermes",
    "nous-hermes": "hermes",
}


class SkillInstallError(ValueError):
    pass


def target_path(target_id: str, home: Path, env: dict) -> Path:
    if target_id == "claude" and env.get("CLAUDE_CONFIG_DIR"):
        root = Path(env["CLAUDE_CONFIG_DIR"]).expanduser()
        if not root.is_absolute():
            raise SkillInstallError(tr('CLAUDE_CONFIG_DIR 必须是绝对路径。'))
        return root / "skills" / SKILL_NAME
    return home / SKILL_TARGET_BY_ID[target_id].skill_relative_path


def split_local_note(content: bytes) -> tuple[bytes, bytes]:
    content = content.replace(b"\r\n", b"\n")
    for heading in ("\n## Independent CLI on this computer", "\n## 本机独立 CLI"):
        start = content.find(heading.encode("utf-8"))
        if start >= 0:
            return content[:start].rstrip() + b"\n", content[start:]
    return content, b""


def with_invocation(files: dict[str, bytes], invocation: list[str], config_dir: str) -> dict[str, bytes]:
    files = dict(files)
    if invocation:
        command = ("& " + " ".join("'" + str(arg).replace("'", "''") + "'" for arg in invocation)
                   if os.name == "nt" else shlex.join(invocation))
        note = ("\n## Independent CLI on this computer\n\nThis independent CLI installation does not depend on the Smart Search App. "
                "Replace the `smart-search` command in this skill with the following full invocation prefix, then append the original arguments:\n\n"
                f"```{'powershell' if os.name == 'nt' else 'sh'}\n{command}\n```\n\n"
                f"Configuration directory: `{config_dir}`. If this is not the default, set SMART_SEARCH_CONFIG_DIR to it before calling the CLI. "
                "Never copy API keys into command arguments. Check `--version` first, then search when the user requests it.\n")
        files["SKILL.md"] = split_local_note(files["SKILL.md"])[0].rstrip() + b"\n" + note.encode("utf-8")
    return files


def _same_content(rel: str, installed: bytes, expected: bytes) -> bool:
    if rel == "SKILL.md" and not split_local_note(expected)[1]:
        installed = split_local_note(installed)[0]
    return installed.replace(b"\r\n", b"\n").rstrip() == expected.replace(b"\r\n", b"\n").rstrip()


def _refuse_links(path: Path) -> None:
    for part in (path, *path.parents):
        try:
            attributes = getattr(part.lstat(), "st_file_attributes", 0)
        except FileNotFoundError:
            attributes = 0
        # Path.is_junction is unavailable on supported Python 3.10/3.11.
        if part.is_symlink() or attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            raise SkillInstallError(tr('技能路径包含链接，未覆盖：{0}', path))


def write_skill_files(dest: Path, files: dict[str, bytes], backup_root: Path, *, backup_prefix: str = "") -> dict:
    """Back up before atomic file replacements; keep extras and recover after a failed write."""
    _refuse_links(dest)
    lock = dest.parent / ".smart-search-cli-write"
    _refuse_links(lock.with_name(lock.name + ".lock"))
    with file_lock(lock):
        return _write_skill_files(dest, files, backup_root, backup_prefix=backup_prefix)


def _write_skill_files(dest: Path, files: dict[str, bytes], backup_root: Path, *, backup_prefix: str) -> dict:
    _refuse_links(dest)
    changes = {}
    for rel, content in files.items():
        path = dest / rel
        if not path.resolve().is_relative_to(dest.resolve()):
            raise SkillInstallError(tr('归档包含越界路径。'))
        _refuse_links(path)
        original = path.read_bytes() if path.exists() else None
        if original is not None and _same_content(rel, original, content):
            continue
        if rel == "SKILL.md" and original is not None and not split_local_note(content)[1]:
            note = split_local_note(original)[1]
            if note:
                content = content.rstrip() + b"\n" + note
        if original != content:
            changes[path] = (original, content)
    backup = None
    if changes and dest.exists():
        backup = backup_root / (backup_prefix + uuid.uuid4().hex)
        _refuse_links(backup)
        shutil.copytree(dest, backup, symlinks=True)

    def replace(path, content):
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
        try:
            with temporary.open("xb") as stream:
                stream.write(content)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)

    written = []
    try:
        for path, (_, content) in changes.items():
            _refuse_links(path)
            replace(path, content)
            written.append(path)
    except (OSError, SkillInstallError) as error:
        for path in reversed(written):
            original = changes[path][0]
            try:
                if original is None:
                    path.unlink(missing_ok=True)
                else:
                    replace(path, original)
            except OSError:
                pass  # The pre-write backup remains available even if recovery is denied.
        raise SkillInstallError(tr('Skills 写入失败；备份位置：{0}', str(backup or "—"))) from error
    return {"changed_files": len(changes), "backup": str(backup) if backup else ""}


def parse_skill_targets(raw: str) -> list[str]:
    if not raw.strip():
        return []
    tokens = [part.strip().lower() for part in raw.replace(";", ",").replace("+", ",").split(",")]
    if len(tokens) == 1 and " " in tokens[0]:
        tokens = [part.strip().lower() for part in tokens[0].split()]

    selected: list[str] = []
    invalid: list[str] = []
    for token in tokens:
        if not token:
            continue
        if token in {"skip", "none", "no", "n", tr('跳过'), tr('无'), tr('否')}:
            return []
        if token in {"all", tr('全部')}:
            return [target.target_id for target in SKILL_TARGETS]
        target_id = _TARGET_ALIASES.get(token, token)
        if target_id not in SKILL_TARGET_BY_ID:
            invalid.append(token)
            continue
        if target_id not in selected:
            selected.append(target_id)

    if invalid:
        valid = ", ".join(target.target_id for target in SKILL_TARGETS)
        raise SkillInstallError(tr('Unknown skill target(s): {0}. Valid targets: {1}', ', '.join(invalid), valid))
    return selected


def _resource_skill_root() -> Any:
    try:
        root = resources.files("smart_search").joinpath("assets", "skills", SKILL_NAME)
        if root.is_dir():
            return root
    except (FileNotFoundError, ModuleNotFoundError, AttributeError):
        pass
    return None


def _filesystem_skill_root() -> Path | None:
    candidates: list[Path] = []
    package_root = os.getenv(PACKAGE_ROOT_ENV, "").strip()
    if package_root:
        base = Path(package_root)
        candidates.extend([
            base / "src" / "smart_search" / "assets" / "skills" / SKILL_NAME,
            base / "skills" / SKILL_NAME,
        ])

    repo_root = Path(__file__).resolve().parents[2]
    candidates.extend([
        repo_root / "src" / "smart_search" / "assets" / "skills" / SKILL_NAME,
        repo_root / "skills" / SKILL_NAME,
    ])

    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    return None


def _iter_resource_files(root: Any) -> list[tuple[str, bytes]]:
    files: list[tuple[str, bytes]] = []

    def visit(node: Any, prefix: str = "") -> None:
        for child in node.iterdir():
            rel = f"{prefix}/{child.name}" if prefix else child.name
            if child.is_dir():
                visit(child, rel)
            elif child.is_file():
                files.append((rel, child.read_bytes()))

    visit(root)
    return files


def _iter_filesystem_files(root: Path) -> list[tuple[str, bytes]]:
    return [
        (str(path.relative_to(root)).replace("\\", "/"), path.read_bytes())
        for path in root.rglob("*")
        if path.is_file()
    ]


def _load_skill_files(source_root: Path | None = None) -> list[tuple[str, bytes]]:
    if source_root is not None:
        if not source_root.is_dir():
            raise SkillInstallError(tr('Skill source directory not found: {0}', source_root))
        return _iter_filesystem_files(source_root)

    resource_root = _resource_skill_root()
    if resource_root is not None:
        files = _iter_resource_files(resource_root)
        if files:
            return files

    filesystem_root = _filesystem_skill_root()
    if filesystem_root is not None:
        files = _iter_filesystem_files(filesystem_root)
        if files:
            return files

    raise SkillInstallError(tr('Bundled smart-search-cli skill files were not found.'))


def _skill_digest(files: list[tuple[str, bytes]]) -> str:
    digest = sha256()
    for rel_path, content in sorted(files, key=lambda item: item[0]):
        digest.update(rel_path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(content)
        digest.update(b"\0")
    return digest.hexdigest()


def _local_skill_files(source: Path | None) -> list[tuple[str, bytes]]:
    files = dict(_load_skill_files(source))
    if source is not None:
        return list(files.items())
    document = files["SKILL.md"].decode("utf-8")
    frontmatter = document.split("---", 2)[1] if document.startswith("---") else "\nname: smart-search-cli\ndescription: Search and research with Smart Search.\n"
    files = {"SKILL.md": ("---" + frontmatter + "---\n\n# Smart Search\n\n"
             "Before searching, fetching pages or researching, run `smart-search agent-guide` and follow the current CLI's instructions. "
             "Read referenced documents with `smart-search agent-guide <relative-path>`. "
             "The guide and supported commands follow the installed CLI version.\n").encode("utf-8")}
    root, node = os.getenv(PACKAGE_ROOT_ENV), os.getenv("SMART_SEARCH_NODE_PATH")
    invocation = []
    if root and node and Path(node).is_file() and (Path(root) / "npm/bin/smart-search.js").is_file():
        invocation = [node, str(Path(root) / "npm/bin/smart-search.js")]
    else:
        import sys
        if getattr(sys, "frozen", False):
            invocation = [sys.executable]
            from .desktop_cli import tools_directory
            stable = tools_directory() / "bin" / ("smart-search.cmd" if os.name == "nt" else "smart-search")
            manifest = tools_directory() / "standalone/installation.json"
            try:
                import json
                installed = json.loads(manifest.read_text(encoding="utf-8"))
                if isinstance(installed, dict) and Path(installed.get("executable", "")).resolve() == Path(sys.executable).resolve() and stable.is_file():
                    invocation = [str(stable)]
            except (OSError, ValueError, TypeError):
                pass
    if invocation:
        from .config import config
        files = with_invocation(files, invocation, str(config.config_file.parent))
    return list(files.items())


def _target_installed_files(path: Path) -> list[tuple[str, bytes]]:
    _refuse_links(path)
    if not path.is_dir():
        return []
    for child in path.rglob("*"):
        _refuse_links(child)
    return _iter_filesystem_files(path)


def _describe_installed_skill(
    dest: Path,
    *,
    source_by_path: dict[str, bytes],
    bundled_digest: str,
) -> dict[str, Any]:
    item: dict[str, Any] = {
        "path": str(dest),
        "status": "missing",
        "files": len(source_by_path),
        "installed_files": 0,
        "bundled_hash": bundled_digest,
        "installed_hash": "",
        "hash_match": False,
        "managed_hash_match": False,
        "extra_files": [],
        "missing_files": sorted(source_by_path),
        "stale_files": [],
        "content_stale_files": [],
        "invocation_changed": False,
        "needs_update": True,
    }
    try:
        installed_files = _target_installed_files(dest)
        installed_by_path = {rel_path: content for rel_path, content in installed_files}
        item["installed_files"] = len(installed_files)
        if not dest.exists():
            return item
        if not dest.is_dir():
            item["status"] = "error"
            item["needs_update"] = False
            item["error"] = "Installed skill path exists but is not a directory."
            return item

        installed_digest = _skill_digest(installed_files)
        extra_files = sorted(rel_path for rel_path in installed_by_path if rel_path not in source_by_path)
        missing_files = sorted(rel_path for rel_path in source_by_path if rel_path not in installed_by_path)
        stale_files = sorted(
            rel_path
            for rel_path, content in source_by_path.items()
            if rel_path in installed_by_path and not _same_content(rel_path, installed_by_path[rel_path], content)
        )
        content_stale_files = [rel for rel in stale_files if rel != "SKILL.md" or not _same_content(
            rel, split_local_note(installed_by_path[rel])[0], split_local_note(source_by_path[rel])[0])]
        expected_note = split_local_note(source_by_path.get("SKILL.md", b""))[1]
        invocation_changed = bool(expected_note and "SKILL.md" in installed_by_path and
                                  split_local_note(installed_by_path["SKILL.md"])[1].strip() != expected_note.strip())
        managed_hash_match = not missing_files and all(installed_by_path.get(rel) == content for rel, content in source_by_path.items())
        hash_match = installed_digest == bundled_digest
        item.update(
            {
                "installed_hash": installed_digest if installed_files else "",
                "hash_match": hash_match,
                "managed_hash_match": managed_hash_match,
                "extra_files": extra_files,
                "missing_files": missing_files,
                "stale_files": stale_files,
                "content_stale_files": content_stale_files,
                "invocation_changed": invocation_changed,
                "needs_update": bool(missing_files or stale_files),
            }
        )
        if missing_files or stale_files:
            item["status"] = "stale"
        elif extra_files:
            item["status"] = "extra_files"
        else:
            item["status"] = "up_to_date"
    except (OSError, SkillInstallError) as e:
        item["status"] = "error"
        item["error"] = str(e)
    if item["status"] == "error":
        item["needs_update"] = False
    return item


def status_skill_targets(
    target_ids: list[str],
    *,
    project_root: str | Path | None = None,
    source_root: str | Path | None = None,
    files: dict[str, bytes] | None = None,
    env: dict | None = None,
) -> dict[str, Any]:
    root = Path(project_root).expanduser().resolve() if project_root else Path.home().expanduser().resolve()
    selected = [SKILL_TARGET_BY_ID[target_id] for target_id in target_ids]
    source = Path(source_root).expanduser().resolve() if source_root is not None else None
    source_files = list(files.items()) if files is not None else _local_skill_files(source)
    source_by_path = {rel_path: content for rel_path, content in source_files}
    bundled_digest = _skill_digest(source_files)
    targets: list[dict[str, Any]] = []

    for target in selected:
        try:
            dest = target_path(target.target_id, root, env if env is not None else os.environ if project_root is None else {})
        except SkillInstallError as error:
            targets.append({"target": target.target_id, "label": target.label, "path": "", "installed_hash": "", "status": "error", "error": str(error)})
            continue
        item = _describe_installed_skill(
            dest,
            source_by_path=source_by_path,
            bundled_digest=bundled_digest,
        )
        item.update({"target": target.target_id, "label": target.label})
        legacy_locations = []
        for legacy_relative_root in LEGACY_SKILL_ROOTS_BY_TARGET.get(target.target_id, ()):
            legacy_dest = root / Path(legacy_relative_root) / SKILL_NAME
            if legacy_dest.exists():
                legacy_locations.append(
                    _describe_installed_skill(
                        legacy_dest,
                        source_by_path=source_by_path,
                        bundled_digest=bundled_digest,
                    )
                )
        if legacy_locations:
            item["legacy_locations"] = legacy_locations
        targets.append(item)

    status_counts: dict[str, int] = {}
    for item in targets:
        status = str(item.get("status", "error"))
        status_counts[status] = status_counts.get(status, 0) + 1

    return {
        "ok": not any(item.get("status") == "error" for item in targets),
        "root": str(root),
        "selected": [target.target_id for target in selected],
        "skill": SKILL_NAME,
        "bundled_files": len(source_files),
        "bundled_hash": bundled_digest,
        "targets": targets,
        "status_counts": status_counts,
    }


def install_skill_targets(
    target_ids: list[str],
    *,
    project_root: str | Path | None = None,
    source_root: str | Path | None = None,
) -> dict[str, Any]:
    root = Path(project_root).expanduser().resolve() if project_root else Path.home().expanduser().resolve()
    selected = [SKILL_TARGET_BY_ID[target_id] for target_id in target_ids]
    if not selected:
        return {
            "ok": True,
            "root": str(root),
            "installed": [],
            "skipped": [],
            "failed": [],
            "selected": [],
            "installed_count": 0,
            "skipped_count": 0,
            "failed_count": 0,
        }

    source = Path(source_root).expanduser().resolve() if source_root is not None else None
    files = dict(_local_skill_files(source))
    installed: list[dict[str, Any]] = []
    failed: list[dict[str, str]] = []

    for target in selected:
        dest = root / target.skill_relative_path
        try:
            dest = target_path(target.target_id, root, os.environ if project_root is None else {})
            receipt = write_skill_files(dest, files, dest.parent / ".smart-search-backups")
            installed.append(
                {
                    "target": target.target_id,
                    "label": target.label,
                    "path": str(dest),
                    "files": len(files),
                    **receipt,
                }
            )
        except (OSError, SkillInstallError) as e:
            failed.append(
                {
                    "target": target.target_id,
                    "label": target.label,
                    "path": str(dest),
                    "error": str(e),
                }
            )

    if source is None and installed:
        from . import skill_maintenance
        skill_maintenance.register(installed, files, directory=skill_maintenance.state_directory(project_root))

    return {
        "ok": not failed,
        "root": str(root),
        "installed": installed,
        "skipped": [],
        "failed": failed,
        "selected": [target.target_id for target in selected],
        "installed_count": len(installed),
        "skipped_count": 0,
        "failed_count": len(failed),
    }
