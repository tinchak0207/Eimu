"""One private process per desktop operation; credentials arrive through stdin."""
from __future__ import annotations
from .i18n import tr

import asyncio
import contextlib
import io
import json
import sys
import threading

from . import activity, cli, service, ui_api
from .config import config
from .desktop_catalog import command_arguments
from .i18n import Message, render_messages, use_language
from .provider_errors import sanitize_provider_error_message as sanitize_error_message


async def execute(payload: dict) -> dict:
    result = None
    original_print = cli._print_result

    def capture(command, data, *args, **kwargs):
        nonlocal result
        result = data
        return original_print(command, data, *args, **kwargs)

    cli._print_result = capture
    with config.snapshot(payload["values"], merge=False, directory=payload["config_dir"], source_overrides=payload.get("sources")):
        with activity.observe(payload["command"], origin="app", version=cli._get_version(), run_id=payload["run_id"]) as run:
            try:
                activity.progress(payload["command"], payload.get("params", {}).get("provider", ""))
                if payload["method"] == "provider.test":
                    result = await service.test_provider_connection(
                        payload["params"]["provider"], overrides=payload["params"].get("overrides", {}), record_health=False)
                    presence_complete = result.get("probe") == "presence" and result.get("status") == "configured"
                    code = 0 if result.get("ok") or presence_complete else 4
                elif payload["method"] == "skills.install":
                    result = ui_api.skills_install(payload["params"])
                    code = 0 if result.get("ok") else 5
                elif payload["command"] == "regression":
                    result = await service.smoke("mock")
                    code = 0 if result.get("ok") else 5
                else:
                    argv = command_arguments(payload["command"], payload["params"].get("arguments", []))
                    parsed = cli.build_parser().parse_args(argv)
                    parsed.format = "json"
                    if parsed.command == "model":
                        code = cli._run_model(parsed)
                    else:
                        code = await cli._run_async(parsed)
                if result is None:
                    result = {"ok": code == 0}
                activity.result(result)
                run.finish(code)
                result = dict(result)
                if payload["method"] == "run.start":
                    render_command = "smoke" if payload["command"] == "regression" else payload["command"].split("/")[0]
                    result["display_text"] = cli._render(render_command, result, "markdown")
                return {"status": "finished" if code == 0 else "failed", "result": redact(result), "exit_code": code}
            except asyncio.CancelledError:
                run.finish(5, "cancelled")
                return {"status": "cancelled", "result": {"ok": False, "error_type": "cancelled", "error": tr('任务已取消。')}, "exit_code": 5}
            except (Exception, SystemExit) as error:
                run.finish(2 if isinstance(error, SystemExit) else 5)
                return {"status": "failed", "result": {"ok": False, "error_type": "parameter_error" if isinstance(error, (ValueError, SystemExit)) else "runtime_error",
                        "error": tr('参数无效。请检查必填项及参数范围。') if isinstance(error, SystemExit) else sanitize_error_message(str(error))}, "exit_code": 5}
            finally:
                cli._print_result = original_print


def redact(value):
    # Results stay in memory, but upstream errors can echo a raw credential anywhere.
    if isinstance(value, Message):
        value = render_messages(value)
    if isinstance(value, str):
        for secret in sorted(config.secret_values(), key=len, reverse=True):
            value = value.replace(secret, "[REDACTED]")
        return value
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, dict):
        return {key: redact(item) for key, item in value.items()}
    return value


async def _run(payload):
    loop = asyncio.get_running_loop()
    task = asyncio.create_task(execute(payload))

    def listen():
        try:
            for line in sys.stdin:
                if json.loads(line).get("cancel"):
                    return
        except (ValueError, OSError, AttributeError):
            pass
        finally:
            # EOF, a truncated control frame, or a broken pipe all end ownership.
            try:
                loop.call_soon_threadsafe(task.cancel)
            except RuntimeError:
                pass

    threading.Thread(target=listen, daemon=True).start()
    return await task


def main():
    payload = json.loads(sys.stdin.readline(2 * 1024 * 1024))
    # Only the final envelope uses stdout. Parsing/provider diagnostics are private.
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()), use_language(payload.get("language", "zh")):
        envelope = asyncio.run(_run(payload))
        envelope = render_messages(envelope)
    print(json.dumps(envelope, ensure_ascii=False), flush=True)
    return 0
