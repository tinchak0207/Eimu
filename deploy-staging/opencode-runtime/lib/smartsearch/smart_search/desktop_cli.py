"""Read-only CLI ownership discovery and narrowly scoped update arguments."""
from __future__ import annotations
from .i18n import tr

import json
import os
from pathlib import Path
import shutil
import subprocess

from .desktop_updates import PACKAGE, stable_version

try:
    import tomllib
except ImportError:  # App bundles Python 3.12; older source runtimes remain read-only.
    tomllib = None

MISE_TOOL = "npm:" + PACKAGE


def tools_directory():
    """Independent CLI data; deliberately outside the App and its update cache."""
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local")) / "SmartSearchTools"
    return Path.home() / ".local/share/smart-search-tools"


def managed_cli_info(env, directory=None):
    base = Path(directory) if directory else tools_directory()
    prefix = base / "cli"
    root = prefix / ("node_modules" if os.name == "nt" else "lib/node_modules") / PACKAGE
    try:
        saved = json.loads((base / "environment.json").read_text(encoding="utf-8"))
        package = json.loads((root / "package.json").read_text(encoding="utf-8"))
        if package.get("name") != PACKAGE:
            return None
        node, npm = Path(saved["node"]), Path(saved["npm"])
        if not node.is_absolute() or not npm.is_absolute():
            return None
        entry = prefix / ("smart-search.cmd" if os.name == "nt" else "bin/smart-search")
        return {"external_path": str(entry), "resolved_path": str(entry.resolve()), "package_root": str(root),
                "external_version": package.get("version"), "manager": "npm", "manager_label": tr('npm 用户独立安装'),
                "manager_command": [str(node), str(npm)], "manager_options": ["--prefix", str(prefix)],
                "can_update": node.is_file() and npm.is_file(), "managed_tools": str(base),
                "python_path": saved.get("python", ""),
                "update_note": tr('独立于 App 的 npm 安装；升级与卸载 App 不会移除它。')}
    except (OSError, ValueError, KeyError, TypeError):
        return None


def run_read(command, env):
    result = subprocess.run(command, cwd=Path.home(), env=env, stdin=subprocess.DEVNULL,
                            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=5,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    if result.returncode:
        raise ValueError(tr('管理器来源检查未完成。'))
    return result.stdout.strip()


def package_root(entry):
    path = Path(entry).resolve()
    for root in (path.parent / f"node_modules/{PACKAGE}", path.parent.parent / PACKAGE, path.parent.parent.parent):
        try:
            data = json.loads((root / "package.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if data.get("name") == PACKAGE:
            return root.resolve(), data
    return None, {}


def npm_command(env, mise):
    entry = shutil.which("npm", path=env.get("PATH"))
    if not entry:
        return None
    path = Path(entry)
    if path.parent.name == "shims" and "mise" in str(path).lower() and mise:
        path = Path(run_read([mise, "which", "npm"], env))
    if os.name != "nt":
        return [str(path.resolve())]
    # Spawn the actual Node program. Never interpolate a .cmd command into a shell.
    node = path.parent / "node.exe"
    script = path.parent / "node_modules/npm/bin/npm-cli.js"
    return [str(node), str(script)] if node.is_file() and script.is_file() else None


def path_entries(env=None):
    entries = []
    suffixes = (".exe", ".cmd", ".bat", "") if os.name == "nt" else ("",)
    for directory in os.get_exec_path(env):
        for suffix in suffixes:
            path = Path(directory) / ("smart-search" + suffix)
            if path.is_file():
                # npm creates several wrappers in one directory for the same package.
                if not any(old.parent.resolve() == path.parent.resolve() for old in entries):
                    entries.append(path)
                break
    return entries


def discover(entry, env):
    data = {"manager": "unknown", "manager_label": tr('来源尚未确认'), "can_update": False,
            "resolved_path": str(Path(entry).resolve()), "manager_command": [], "manager_options": [],
            "update_note": tr('请使用原安装方式更新，然后刷新状态。')}
    mise = shutil.which("mise", path=env.get("PATH"))
    path = Path(entry)
    stage = tr('解析 CLI 入口')
    try:
        if path.parent.name == "shims" and "mise" in str(path).lower():
            if not mise:
                data.update(probe_error="manager_missing", update_note=tr('已找到 mise 的 CLI 入口，但当前 App 环境找不到 mise；请重新打开 App 后检查。'))
                return data
            path = Path(run_read([mise, "which", "smart-search"], env))
            data["resolved_path"] = str(path.resolve())
        root, package = package_root(path)
        if root is None:
            data.update(probe_error="package_unrecognized", update_note=tr('未能核对 CLI 入口对应的安装包；请检查原安装后刷新。'))
            return data
        data.update(package_root=str(root), external_version=package.get("version"))
        managed = managed_cli_info(env)
        if managed and root == Path(managed["package_root"]):
            data.update(managed)
            data["external_path"] = entry
            data["other_paths"] = [str(other) for other in path_entries(env)
                                   if package_root(other)[0] != root]
            if data["other_paths"]:
                data.update(can_update=False, update_note=tr('PATH 中有其他同名 CLI，请先处理冲突。'))
            return data
        if path.parent.name == ".bin" and "mise" not in str(path).lower():
            data["update_note"] = tr('这是项目内安装；请在所属项目更新。')
            return data
        if mise and "mise" in str(path).lower():
            stage = tr('核对 mise 全局安装')
            rows = json.loads(run_read([mise, "ls", "--global", "--json", MISE_TOOL], env))
            if isinstance(rows, dict):
                rows = rows.get(MISE_TOOL, [])
            rows = [r for r in rows if r.get("active") and r.get("installed") and root.is_relative_to(Path(r["install_path"]).resolve())]
            if len(rows) != 1:
                return data
            row = rows[0]
            source = Path(row.get("source", {}).get("path", "")).resolve()
            global_path = Path(env.get("MISE_GLOBAL_CONFIG_FILE", Path.home() / ".config/mise/config.toml")).resolve()
            if source != global_path or row.get("source", {}).get("type") != "mise.toml":
                return data
            data.update(manager="mise", manager_label=tr('mise 全局 npm'), manager_command=[mise], manager_config=str(source))
            if any(env.get(k) for k in ("MISE_CONFIG_FILE", "MISE_ENV")) or not tomllib:
                data["update_note"] = tr('当前有 mise 环境覆盖或运行时无法解析配置，请在原终端更新。')
                return data
            stage = tr('读取 mise 安装配置')
            table = tomllib.loads(source.read_text(encoding="utf-8"))["tools"][MISE_TOOL]
            if isinstance(table, str):
                requested, options = table, {}
            elif isinstance(table, dict):
                requested = table.get("version")
                options = {k: v for k, v in table.items() if k != "version"}
            else:
                return data
            if requested != row.get("requested_version") or not isinstance(requested, str):
                return data
            if any(k != "allow_low_downloads" or v not in (True, False, "true", "false") for k, v in options.items()):
                data["update_note"] = tr('此 mise 条目有复杂工具选项，请在原终端更新以保留配置。')
                return data
            data["manager_options"] = [argument for key, value in options.items()
                                       for argument in ("--tool-option", f"{key}={json.dumps(value, ensure_ascii=False)}")]
            data["requested_version"] = requested
            # Explicitly replacing a global exact pin is the user's selected update.
            # Ranges/prefixes remain constraints; do not silently broaden them.
            if stable_version(requested) is None and requested != "latest":
                data["update_note"] = tr('当前 mise 有版本范围约束，请在原终端确认更新范围。')
                return data
        else:
            stage = tr('核对 npm 全局安装')
            npm = npm_command(env, mise)
            if not npm:
                return data
            global_root = Path(run_read([*npm, "root", "--global"], env)).resolve()
            if root != (global_root / PACKAGE).resolve():
                data["update_note"] = tr('这是项目内或开发安装；请在所属项目更新。')
                return data
            data.update(manager="npm", manager_label=tr('npm 全局安装'), manager_command=npm)
        alternatives = []
        for other in path_entries(env):
            if other.parent.resolve() in {Path(entry).parent.resolve(), path.parent.resolve()}:
                continue
            other_root, _ = package_root(other)
            if other_root != root:
                alternatives.append(str(other))
        data["other_paths"] = alternatives
        if alternatives:
            data["update_note"] = tr('PATH 中有其他来源的同名 CLI，请先在终端明确要更新的安装。')
            return data
        data.update(can_update=True, update_note=tr('只更新此全局 Smart Search 安装；保留原管理器，完成后重新读取实际版本。'))
    except subprocess.TimeoutExpired:
        data.update(probe_error="timeout", update_note=tr('CLI 检查超时（{0}）；请点击“刷新已安装版本”重试。', stage))
    except OSError:
        data.update(probe_error="launch_failed", update_note=tr('CLI 检查无法启动或读取（{0}）；请检查原安装后刷新。', stage))
    except (ValueError, KeyError, TypeError):
        data.update(probe_error="invalid_result", update_note=tr('CLI 检查未通过（{0}）；请点击“刷新已安装版本”重试。', stage))
    return data


def update_command(info, version):
    if not info.get("can_update") or stable_version(version) is None:
        raise ValueError(tr('CLI 来源或目标稳定版本未确认，不能自动更新。'))
    if info["manager"] == "mise":
        return [*info["manager_command"], "use", "--global", "--pin", *info["manager_options"], f"{MISE_TOOL}@{version}"]
    if info["manager"] == "npm":
        return [*info["manager_command"], "install", "--global", *info.get("manager_options", []), f"{PACKAGE}@{version}"]
    raise ValueError(tr('此 CLI 必须使用原安装方式手动更新。'))
