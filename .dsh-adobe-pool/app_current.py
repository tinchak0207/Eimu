import os
import json
import logging
import time
import uuid
import threading
import traceback
import base64
import binascii
import io
from dataclasses import asdict
from pathlib import Path
from typing import Optional, Any, Callable
from urllib.parse import unquote_to_bytes

import requests
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask
from starlette.middleware.sessions import SessionMiddleware

from api.routes.admin import build_admin_router
from api.routes.entity import build_entity_router
from api.routes.generation import build_generation_router

try:
    from PIL import Image
except Exception:
    Image = None

from core.adobe_client import (
    AdobeRequestError,
    AdobeClient,
    AuthError,
    QuotaExhaustedError,
    UpstreamTemporaryError,
)
from core.token_mgr import token_manager
from core.config_mgr import config_manager
from core.refresh_mgr import refresh_manager
from core.lease import lease_manager
from core.stores import (
    ErrorDetailRecord,
    ErrorDetailStore,
    JobStore,
    LiveRequestStore,
    RequestLogRecord,
    RequestLogStore,
)
from core.models import (
    MODEL_CATALOG,
    SUPPORTED_RATIOS,
    VIDEO_MODEL_CATALOG,
    resolve_model,
    resolve_ratio_and_resolution,
)


logger = logging.getLogger("adobe2api")


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = BASE_DIR / "data"
GENERATED_DIR = DATA_DIR / "generated"
STATIC_DIR.mkdir(parents=True, exist_ok=True)
GENERATED_DIR.mkdir(parents=True, exist_ok=True)

_GENERATED_RECONCILE_INTERVAL_SEC = 300
_generated_storage_lock = threading.Lock()
_generated_prune_lock = threading.Lock()
_generated_usage_bytes = 0
_generated_file_count = 0
_generated_last_reconcile_ts = 0.0


def _drop_generated_file_cache(file_path: Path) -> None:
    if not hasattr(os, "posix_fadvise"):
        return
    if not file_path.exists():
        return
    try:
        flag = getattr(os, "POSIX_FADV_DONTNEED", 4)
        with file_path.open("rb") as f:
            os.posix_fadvise(f.fileno(), 0, 0, flag)
    except Exception:
        return


# 极简配置启动
app = FastAPI(
    title="adobe2api",
    version="0.1.0",
    docs_url=None,  # 关闭 swagger，节省资源
    redoc_url=None,
)
session_secret = str(
    os.getenv("ADOBE_ADMIN_SESSION_SECRET")
    or config_manager.get("admin_session_secret")
    or "adobe2api-dev-session-secret"
).strip()
app.add_middleware(
    SessionMiddleware,
    secret_key=session_secret,
    session_cookie="adobe2api_session",
    same_site="lax",
    https_only=False,
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/generated/{filename:path}", include_in_schema=False)
def serve_generated_file(filename: str):
    raw = str(filename or "").strip()
    safe_name = Path(raw).name
    if not safe_name or safe_name != raw:
        raise HTTPException(status_code=404, detail="file not found")
    target = GENERATED_DIR / safe_name
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    background = BackgroundTask(_drop_generated_file_cache, target)
    return FileResponse(path=target, filename=safe_name, background=background)

store = JobStore()
log_store = RequestLogStore(DATA_DIR / "request_logs.jsonl", max_items=5000)
error_store = ErrorDetailStore(DATA_DIR / "request_errors.jsonl", max_items=5000)
live_log_store = LiveRequestStore(max_items=2000)
client = AdobeClient()
refresh_manager.start()


def _extract_logging_fields(raw_body: bytes) -> dict[str, Optional[str]]:
    if not raw_body:
        return {"model": None, "prompt_preview": None}
    try:
        import json

        data: Any = json.loads(raw_body.decode("utf-8"))
        if not isinstance(data, dict):
            return {"model": None, "prompt_preview": None}

        model = str(data.get("model") or "").strip() or None
        prompt = str(data.get("prompt") or "").strip()
        entity_name = str(data.get("name") or data.get("displayName") or "").strip()
        if entity_name:
            entity_type = str(data.get("type") or data.get("entityType") or "object").strip()
            description = str(data.get("description") or "").strip()
            prompt = f"entity: {entity_name}"
            if description:
                prompt = f"{prompt} - {description}"
            model = f"entity:{entity_type or 'object'}"
        if not prompt:
            prompt = _extract_prompt_from_messages(data.get("messages") or [])
        if prompt:
            prompt = prompt.replace("\r", " ").replace("\n", " ").strip()
            prompt = prompt[:180]
        return {"model": model, "prompt_preview": prompt or None}
    except Exception:
        return {"model": None, "prompt_preview": None}


def _upsert_live_request(request: Request, patch: dict) -> None:
    try:
        log_id = str(getattr(request.state, "log_id", "") or "").strip()
        if not log_id or not isinstance(patch, dict):
            return
        live_log_store.upsert(log_id, patch)
    except Exception:
        pass


def _set_request_preview(request: Request, url: str, kind: str = "image") -> None:
    if not url:
        return
    try:
        request.state.log_preview_url = url
        request.state.log_preview_kind = kind
        _upsert_live_request(
            request,
            {
                "preview_url": url,
                "preview_kind": kind,
                "ts": time.time(),
            },
        )
    except Exception:
        pass


def _set_request_error_detail(
    request: Request,
    *,
    error: Exception | str,
    status_code: Optional[int] = None,
    error_type: Optional[str] = None,
    include_traceback: bool = False,
) -> str:
    code = f"ERR-{uuid.uuid4().hex[:10].upper()}"
    message = str(error or "Unknown error").strip() or "Unknown error"
    trace_text = None
    error_class = None
    if isinstance(error, Exception):
        error_class = type(error).__name__
        if include_traceback:
            trace_text = traceback.format_exc()
            if not trace_text or trace_text.strip() == "NoneType: None":
                trace_text = "".join(
                    traceback.format_exception(type(error), error, error.__traceback__)
                )
    elif include_traceback:
        trace_text = traceback.format_exc()
        if trace_text and trace_text.strip() == "NoneType: None":
            trace_text = None

    op_map = {
        "/v1/chat/completions": "chat.completions",
        "/v1/images/generations": "images.generations",
        "/api/v1/generate": "api.generate",
    }
    path = str(getattr(getattr(request, "url", None), "path", "") or "")
    operation = op_map.get(path, "")

    record = ErrorDetailRecord(
        code=code,
        ts=time.time(),
        message=message,
        error_type=(str(error_type or "").strip() or None),
        status_code=int(status_code) if status_code is not None else None,
        operation=operation or None,
        method=str(getattr(request, "method", "") or "").upper() or None,
        path=path or None,
        log_id=str(getattr(request.state, "log_id", "") or "") or None,
        model=str(getattr(request.state, "log_model", "") or "") or None,
        prompt_preview=(
            str(getattr(request.state, "log_prompt_preview", "") or "") or None
        ),
        task_status=str(getattr(request.state, "log_task_status", "") or "") or None,
        task_progress=getattr(request.state, "log_task_progress", None),
        upstream_job_id=(
            str(getattr(request.state, "log_upstream_job_id", "") or "") or None
        ),
        token_id=str(getattr(request.state, "log_token_id", "") or "") or None,
        token_account_name=(
            str(getattr(request.state, "log_token_account_name", "") or "") or None
        ),
        token_account_email=(
            str(getattr(request.state, "log_token_account_email", "") or "") or None
        ),
        token_source=str(getattr(request.state, "log_token_source", "") or "") or None,
        token_attempt=getattr(request.state, "log_token_attempt", None),
        exception_class=error_class,
        traceback=(str(trace_text or "") or None),
    )
    error_store.add(record)
    request.state.log_error = message[:240]
    request.state.log_error_code = code
    _upsert_live_request(
        request,
        {
            "error": message[:240],
            "error_code": code,
            "ts": time.time(),
        },
    )
    return code


def _set_request_task_progress(
    request: Request,
    task_status: str,
    task_progress: Optional[float] = None,
    upstream_job_id: Optional[str] = None,
    retry_after: Optional[int] = None,
    error: Optional[str] = None,
) -> None:
    patch: dict[str, Any] = {"task_status": str(task_status or "").upper()}
    if task_progress is not None:
        try:
            progress_val = float(task_progress)
            if progress_val < 0:
                progress_val = 0.0
            if progress_val > 100:
                progress_val = 100.0
            patch["task_progress"] = round(progress_val, 2)
        except Exception:
            pass
    if upstream_job_id:
        patch["upstream_job_id"] = str(upstream_job_id)
    if retry_after is not None:
        try:
            patch["retry_after"] = int(retry_after)
        except Exception:
            pass
    if error:
        patch["error"] = str(error)[:240]

    try:
        request.state.log_task_status = patch.get("task_status")
        request.state.log_task_progress = patch.get("task_progress")
        request.state.log_upstream_job_id = patch.get("upstream_job_id")
        request.state.log_retry_after = patch.get("retry_after")
        if patch.get("error"):
            request.state.log_error = patch.get("error")
        _upsert_live_request(
            request,
            {
                "task_status": patch.get("task_status"),
                "task_progress": patch.get("task_progress"),
                "upstream_job_id": patch.get("upstream_job_id"),
                "retry_after": patch.get("retry_after"),
                "error": patch.get("error"),
                "error_code": getattr(request.state, "log_error_code", None),
                "model": getattr(request.state, "log_model", None),
                "prompt_preview": getattr(request.state, "log_prompt_preview", None),
                "ts": time.time(),
            },
        )
    except Exception:
        pass

    # Do not write partial records here.
    # Final request logs are emitted either by per-attempt logging
    # (_append_attempt_log) or by middleware finalization.


def _set_request_token_context(request: Request, token: str, attempt: int) -> dict:
    meta = token_manager.get_meta_by_value(token)
    try:
        request.state.log_token_id = meta.get("token_id")
        request.state.log_token_account_id = meta.get("token_account_id")
        request.state.log_token_account_name = meta.get("token_account_name")
        request.state.log_token_account_email = meta.get("token_account_email")
        request.state.log_token_source = meta.get("token_source")
        request.state.log_token_attempt = int(attempt)
        _upsert_live_request(
            request,
            {
                "token_id": meta.get("token_id"),
                "token_account_id": meta.get("token_account_id"),
                "token_account_name": meta.get("token_account_name"),
                "token_account_email": meta.get("token_account_email"),
                "token_source": meta.get("token_source"),
                "token_attempt": int(attempt),
                "ts": time.time(),
            },
        )
    except Exception:
        pass
    return meta


def _append_attempt_log(
    request: Request,
    operation: str,
    token_meta: dict,
    attempt: int,
    attempt_started: float,
    status_code: int,
    error: Optional[str] = None,
    error_code: Optional[str] = None,
    task_status_override: Optional[str] = None,
) -> None:
    try:
        root_log_id = str(getattr(request.state, "log_id", "") or uuid.uuid4().hex[:12])
        attempt_id = f"{root_log_id}-a{attempt}"
        method = str(getattr(request, "method", "POST") or "POST").upper()
        path = str(getattr(getattr(request, "url", None), "path", "") or "")
        model = getattr(request.state, "log_model", None)
        prompt_preview = getattr(request.state, "log_prompt_preview", None)
        preview_url = getattr(request.state, "log_preview_url", None)
        preview_kind = getattr(request.state, "log_preview_kind", None)
        task_status = task_status_override
        if task_status is None:
            task_status = getattr(request.state, "log_task_status", None)
        task_status = str(task_status or "").upper() or None
        task_progress = getattr(request.state, "log_task_progress", None)
        upstream_job_id = getattr(request.state, "log_upstream_job_id", None)
        retry_after = getattr(request.state, "log_retry_after", None)
        duration_sec = int(max(0.0, time.time() - float(attempt_started)))
        payload = asdict(
            RequestLogRecord(
                id=attempt_id,
                ts=time.time(),
                method=method,
                path=path,
                status_code=int(status_code),
                duration_sec=duration_sec,
                operation=operation,
                preview_url=preview_url,
                preview_kind=preview_kind,
                model=model,
                prompt_preview=prompt_preview,
                error=(str(error)[:240] if error else None),
                error_code=(str(error_code or "") or None),
                task_status=task_status,
                task_progress=task_progress,
                upstream_job_id=upstream_job_id,
                retry_after=retry_after,
                token_id=str(token_meta.get("token_id") or "") or None,
                token_account_name=(
                    str(token_meta.get("token_account_name") or "") or None
                ),
                token_account_email=(
                    str(token_meta.get("token_account_email") or "") or None
                ),
                token_source=str(token_meta.get("token_source") or "") or None,
                token_attempt=int(attempt),
            )
        )
        records = getattr(request.state, "log_attempt_records", None)
        if not isinstance(records, list):
            records = []
            request.state.log_attempt_records = records
        records.append(payload)
        request.state.log_has_attempt_logs = True
    except Exception:
        pass


@app.middleware("http")
async def request_logger(request: Request, call_next):
    started = time.time()
    method = request.method.upper()
    path = request.url.path
    preview_url = None
    preview_kind = None
    raw_body = b""
    body_meta = {"model": None, "prompt_preview": None}
    error_text = None
    status_code = 500

    op_map = {
        "/v1/chat/completions": "chat.completions",
        "/v1/images/generations": "images.generations",
        "/v1/entities": "entities.create" if method == "POST" else "",
    }
    operation = op_map.get(path, "")
    should_log = bool(operation)

    if method in {"POST", "PUT", "PATCH"} and should_log:
        try:
            raw_body = await request.body()
            request._body = raw_body
            if path in {
                "/v1/images/generations",
                "/v1/chat/completions",
                "/v1/entities",
                "/api/v1/generate",
            }:
                body_meta = _extract_logging_fields(raw_body)
                request.state.log_model = body_meta.get("model")
                request.state.log_prompt_preview = body_meta.get("prompt_preview")
            request.state.log_id = uuid.uuid4().hex[:12]
            log_id = str(getattr(request.state, "log_id", "") or "")
            if log_id:
                live_log_store.upsert(
                    log_id,
                    {
                        "id": log_id,
                        "ts": time.time(),
                        "method": method,
                        "path": path,
                        "status_code": 102,
                        "duration_sec": 0,
                        "operation": operation,
                        "model": body_meta.get("model"),
                        "prompt_preview": body_meta.get("prompt_preview"),
                        "task_status": "IN_PROGRESS",
                        "task_progress": 0.0,
                    },
                )
        except Exception:
            pass

    response = None
    try:
        response = await call_next(request)
        status_code = response.status_code
    except Exception as exc:
        _set_request_error_detail(
            request,
            error=exc,
            status_code=500,
            error_type="server_error",
            include_traceback=True,
        )
        error_text = f"{type(exc).__name__}: {str(exc)}"[:240]
        logger.exception(
            "Unhandled exception in request pipeline method=%s path=%s log_id=%s",
            method,
            path,
            getattr(request.state, "log_id", ""),
        )
        raise
    finally:
        if should_log:
            has_attempt_logs = bool(
                getattr(request.state, "log_has_attempt_logs", False)
            )
            log_id = (
                str(getattr(request.state, "log_id", "") or "") or uuid.uuid4().hex[:12]
            )
            live_log_store.remove(log_id)

            attempt_records = getattr(request.state, "log_attempt_records", None)
            if isinstance(attempt_records, list) and attempt_records:
                for payload in attempt_records:
                    log_store.add_payload(payload)

            if not has_attempt_logs:
                duration_sec = int(time.time() - started)
                preview_url = getattr(request.state, "log_preview_url", None)
                preview_kind = getattr(request.state, "log_preview_kind", None)
                task_status = getattr(request.state, "log_task_status", None)
                task_progress = getattr(request.state, "log_task_progress", None)
                upstream_job_id = getattr(request.state, "log_upstream_job_id", None)
                retry_after = getattr(request.state, "log_retry_after", None)
                error_final = getattr(request.state, "log_error", None) or error_text
                error_code = getattr(request.state, "log_error_code", None)
                if int(status_code or 0) >= 400 and not error_code:
                    generated_error_type = (
                        "invalid_request_error"
                        if 400 <= int(status_code or 0) < 500
                        else "server_error"
                    )
                    error_code = _set_request_error_detail(
                        request,
                        error=error_final or f"HTTP {status_code}",
                        status_code=int(status_code or 500),
                        error_type=generated_error_type,
                        include_traceback=False,
                    )
                token_id = getattr(request.state, "log_token_id", None)
                token_account_name = getattr(
                    request.state, "log_token_account_name", None
                )
                token_account_email = getattr(
                    request.state, "log_token_account_email", None
                )
                token_source = getattr(request.state, "log_token_source", None)
                token_attempt = getattr(request.state, "log_token_attempt", None)
                log_id = (
                    str(getattr(request.state, "log_id", "") or "")
                    or uuid.uuid4().hex[:12]
                )
                log_store.upsert(
                    log_id,
                    asdict(
                        RequestLogRecord(
                            id=log_id,
                            ts=time.time(),
                            method=method,
                            path=path,
                            status_code=status_code,
                            duration_sec=duration_sec,
                            operation=operation,
                            preview_url=preview_url,
                            preview_kind=preview_kind,
                            model=body_meta.get("model"),
                            prompt_preview=body_meta.get("prompt_preview"),
                            error=error_final,
                            error_code=error_code,
                            task_status=task_status,
                            task_progress=task_progress,
                            upstream_job_id=upstream_job_id,
                            retry_after=retry_after,
                            token_id=token_id,
                            token_account_name=token_account_name,
                            token_account_email=token_account_email,
                            token_source=token_source,
                            token_attempt=token_attempt,
                        )
                    ),
                )
    return response


def _resolve_video_options(data: dict) -> tuple[bool, str, str]:
    generate_audio = bool(data.get("generate_audio", data.get("generateAudio", True)))
    negative_prompt = str(
        data.get("negative_prompt") or data.get("negativePrompt") or ""
    ).strip()
    reference_mode = (
        str(
            data.get("video_reference_mode")
            or data.get("videoReferenceMode")
            or data.get("reference_mode")
            or data.get("referenceMode")
            or "frame"
        )
        .strip()
        .lower()
    )
    if reference_mode not in {"frame", "image"}:
        reference_mode = "frame"
    return generate_audio, negative_prompt, reference_mode


def _run_with_token_retries(
    request: Request,
    operation_name: str,
    run_once: Callable[[str], Any],
    set_request_error_detail: Optional[Callable[..., str]] = None,
    token_selector: Optional[Callable[[], Optional[str]]] = None,
) -> Any:
    max_attempts = client.retry_max_attempts if client.retry_enabled else 1
    max_attempts = max(1, int(max_attempts))
    last_exc: Optional[Exception] = None
    report_error = set_request_error_detail or _set_request_error_detail
    attempt = 0
    limited_retry_attempts = 0
    tried_tokens: set[str] = set()
    tried_accounts: set[str] = set()
    preferred_account_id = ""
    lease_owner = lease_manager.new_owner("generation")
    lease_model = str(
        getattr(request.state, "log_model", None) or operation_name
    ).strip()
    try:
        lease_ttl_seconds = int(
            config_manager.get("account_lease_ttl_seconds", 900) or 900
        )
    except Exception:
        lease_ttl_seconds = 900
    try:
        lease_max_concurrency = int(
            config_manager.get("account_lease_max_concurrency", 1) or 1
        )
    except Exception:
        lease_max_concurrency = 1
    lease_ttl_seconds = max(30, min(3600, lease_ttl_seconds))
    lease_max_concurrency = max(1, min(20, lease_max_concurrency))

    while True:
        attempt += 1
        if attempt > max_attempts:
            break
        token = ""
        token_meta = {}
        account_id = ""
        lease = None
        pinned_account = token_selector is not None
        excluded_accounts = set() if pinned_account else set(tried_accounts)
        if preferred_account_id:
            excluded_accounts.discard(preferred_account_id)

        if token_selector is not None:
            for _ in range(max(3, len(tried_tokens) + 1)):
                candidate = str(token_selector() or "").strip()
                if not candidate or candidate in tried_tokens:
                    break
                candidate_meta = token_manager.get_meta_by_value(candidate)
                candidate_account = str(
                    candidate_meta.get("token_account_id") or ""
                ).strip()
                if (
                    candidate_account
                    and candidate_account in excluded_accounts
                    and candidate_account != preferred_account_id
                ):
                    continue
                account_key = candidate_account or f"token:{candidate_meta.get('token_id') or candidate[:16]}"
                lease = lease_manager.try_acquire(
                    kind="adobe2api",
                    account_id=account_key,
                    model=lease_model,
                    owner=f"{lease_owner}:{attempt}",
                    ttl_seconds=lease_ttl_seconds,
                    max_concurrency=lease_max_concurrency,
                )
                if lease is not None:
                    token = candidate
                    token_meta = candidate_meta
                    account_id = candidate_account or account_key
                    break
        else:
            candidates = token_manager.get_available_candidates(
                strategy=client.token_rotation_strategy,
                exclude_accounts=excluded_accounts,
                exclude_values=tried_tokens,
                preferred_account_id=preferred_account_id or None,
            )
            if not candidates and excluded_accounts:
                # Degraded fallback is only allowed after every untried account
                # is unavailable. Never reuse the same token in one request.
                candidates = token_manager.get_available_candidates(
                    strategy=client.token_rotation_strategy,
                    exclude_values=tried_tokens,
                )
            for candidate in candidates:
                candidate_value = str(candidate.get("value") or "").strip()
                candidate_account = str(candidate.get("account_id") or "").strip()
                account_key = candidate_account or f"token:{candidate.get('id') or candidate_value[:16]}"
                lease = lease_manager.try_acquire(
                    kind="adobe2api",
                    account_id=account_key,
                    model=lease_model,
                    owner=f"{lease_owner}:{attempt}",
                    ttl_seconds=lease_ttl_seconds,
                    max_concurrency=lease_max_concurrency,
                )
                if lease is None:
                    continue
                token = candidate_value
                token_meta = token_manager.get_meta_by_value(token)
                account_id = candidate_account or account_key
                break

        if not token or lease is None:
            if preferred_account_id:
                preferred_account_id = ""
                continue
            break

        tried_tokens.add(token)
        if account_id:
            tried_accounts.add(account_id)
        preferred_account_id = ""
        token_meta = _set_request_token_context(request, token, attempt)
        lease.__enter__()
        attempt_started = time.time()
        retryable = False
        retry_reason = ""
        delay = 0.0
        retry_error_text = ""

        try:
            result = run_once(token)
            token_manager.report_success(token)
            _append_attempt_log(
                request=request,
                operation=operation_name,
                token_meta=token_meta,
                attempt=attempt,
                attempt_started=attempt_started,
                status_code=200,
                task_status_override="COMPLETED",
            )
            return result
        except QuotaExhaustedError as exc:
            token_manager.report_exhausted(token)
            token_manager.report_account_failure(
                account_id,
                category="quota_exhausted",
                status_code=429,
                cooldown_seconds=300,
            )
            last_exc = exc
            retryable = True
            retry_reason = "quota_exhausted"
            err_code = report_error(
                request,
                error=exc,
                status_code=429,
                error_type="rate_limit_error",
                include_traceback=False,
            )
            _append_attempt_log(
                request=request,
                operation=operation_name,
                token_meta=token_meta,
                attempt=attempt,
                attempt_started=attempt_started,
                status_code=429,
                error=str(exc),
                error_code=err_code,
                task_status_override="FAILED",
            )
            retry_error_text = str(exc)
        except AuthError as exc:
            auth_result = token_manager.handle_auth_failure(token)
            auth_status = str(auth_result.get("status") or "invalid").strip().lower()
            if auth_status == "invalid":
                token_manager.report_account_failure(
                    account_id,
                    category="auth_invalid",
                    status_code=401,
                    cooldown_seconds=300,
                )
                last_exc = exc
                retry_reason = "auth_invalid"
                err_status_code = 401
                err_type = "authentication_error"
                err_value = exc
            else:
                if auth_status == "refreshed":
                    preferred_account_id = account_id
                else:
                    token_manager.report_account_failure(
                        account_id,
                        category="auth_refresh_failed",
                        status_code=503,
                        cooldown_seconds=120,
                    )
                refresh_message = str(
                    auth_result.get("message")
                    or "token auth failed, cookie refresh recovery triggered"
                ).strip()
                last_exc = UpstreamTemporaryError(
                    refresh_message,
                    status_code=503,
                    error_type="upstream_unavailable",
                )
                retry_reason = (
                    "auth_refresh_success"
                    if auth_status == "refreshed"
                    else "auth_refresh_retry"
                )
                err_status_code = 503
                err_type = "server_error"
                err_value = refresh_message
            retryable = True
            err_code = report_error(
                request,
                error=err_value,
                status_code=err_status_code,
                error_type=err_type,
                include_traceback=False,
            )
            _append_attempt_log(
                request=request,
                operation=operation_name,
                token_meta=token_meta,
                attempt=attempt,
                attempt_started=attempt_started,
                status_code=err_status_code,
                error=str(err_value),
                error_code=err_code,
                task_status_override="FAILED",
            )
            retry_error_text = str(err_value)
        except UpstreamTemporaryError as exc:
            last_exc = exc
            limited_retry_attempts += 1
            status_code = int(exc.status_code or 0)
            transient_status = status_code in {408, 429, 451} or status_code >= 500
            retryable = limited_retry_attempts < max_attempts and (
                transient_status or client.should_retry_temporary_error(exc)
            )
            if retryable:
                if status_code == 429:
                    cooldown = 60
                    category = "rate_limit"
                else:
                    cooldown = 90 if status_code == 408 else 120
                    category = "upstream_temporary"
                token_manager.report_failure(
                    token,
                    category=category,
                    status_code=status_code or None,
                    cooldown_seconds=cooldown,
                )
                token_manager.report_account_failure(
                    account_id,
                    category=category,
                    status_code=status_code or None,
                    cooldown_seconds=cooldown,
                )
            status_part = f"status={exc.status_code}" if exc.status_code else "status=?"
            type_part = f"type={exc.error_type or 'temporary'}"
            retry_reason = f"upstream_temporary {status_part} {type_part}"
            delay = client._retry_delay_for_attempt(limited_retry_attempts)
            err_code = report_error(
                request,
                error=exc,
                status_code=int(exc.status_code or 503),
                error_type=str(exc.error_type or "server_error"),
                include_traceback=False,
            )
            _append_attempt_log(
                request=request,
                operation=operation_name,
                token_meta=token_meta,
                attempt=attempt,
                attempt_started=attempt_started,
                status_code=int(exc.status_code or 503),
                error=str(exc),
                error_code=err_code,
                task_status_override="FAILED",
            )
            retry_error_text = str(exc)
        except AdobeRequestError as exc:
            status_code = int(getattr(exc, "status_code", None) or 500)
            detail = str(
                getattr(exc, "user_message", "") or str(exc) or "Adobe request failed"
            ).strip()
            err_type = str(getattr(exc, "error_type", "") or "").strip().lower() or (
                "invalid_request_error" if 400 <= status_code < 500 else "server_error"
            )
            detail_lower = detail.lower()
            result_empty = any(
                marker in detail_lower
                for marker in (
                    "no image url",
                    "without image url",
                    "no poll url",
                    "no outputs",
                    "empty result",
                )
            )
            if result_empty and attempt < max_attempts:
                last_exc = UpstreamTemporaryError(
                    detail,
                    status_code=503,
                    error_type="empty_result",
                )
                retryable = True
                retry_reason = "empty_result"
                retry_error_text = detail
                token_manager.report_failure(
                    token,
                    category="empty_result",
                    status_code=503,
                    cooldown_seconds=90,
                )
                token_manager.report_account_failure(
                    account_id,
                    category="empty_result",
                    status_code=503,
                    cooldown_seconds=90,
                )
                err_code = report_error(
                    request,
                    error=detail,
                    status_code=503,
                    error_type="upstream_empty_result",
                    include_traceback=False,
                )
                _append_attempt_log(
                    request=request,
                    operation=operation_name,
                    token_meta=token_meta,
                    attempt=attempt,
                    attempt_started=attempt_started,
                    status_code=503,
                    error=detail,
                    error_code=err_code,
                    task_status_override="FAILED",
                )
                continue
            err_code = report_error(
                request,
                error=detail,
                status_code=status_code,
                error_type=err_type,
                include_traceback=False,
            )
            _append_attempt_log(
                request=request,
                operation=operation_name,
                token_meta=token_meta,
                attempt=attempt,
                attempt_started=attempt_started,
                status_code=status_code,
                error=detail,
                error_code=err_code,
                task_status_override="FAILED",
            )
            raise HTTPException(status_code=status_code, detail=detail)
        except HTTPException as exc:
            err_code = report_error(
                request,
                error=str(exc.detail),
                status_code=int(exc.status_code or 500),
                error_type=(
                    "invalid_request_error"
                    if 400 <= int(exc.status_code or 500) < 500
                    else "server_error"
                ),
                include_traceback=False,
            )
            _append_attempt_log(
                request=request,
                operation=operation_name,
                token_meta=token_meta,
                attempt=attempt,
                attempt_started=attempt_started,
                status_code=int(exc.status_code or 500),
                error=str(exc.detail),
                error_code=err_code,
                task_status_override="FAILED",
            )
            raise
        except Exception as exc:
            err_code = report_error(
                request,
                error=exc,
                status_code=500,
                error_type="server_error",
                include_traceback=True,
            )
            _append_attempt_log(
                request=request,
                operation=operation_name,
                token_meta=token_meta,
                attempt=attempt,
                attempt_started=attempt_started,
                status_code=500,
                error="Unhandled runtime error",
                error_code=err_code,
                task_status_override="FAILED",
            )
            raise
        finally:
            if lease is not None:
                lease.__exit__(None, None, None)

        if retryable:
            logger.warning(
                "retrying operation=%s attempt=%s reason=%s delay=%.2fs strategy=%s",
                operation_name,
                attempt,
                retry_reason,
                delay,
                client.token_rotation_strategy,
            )
            _set_request_task_progress(
                request,
                task_status="IN_PROGRESS",
                error=retry_error_text or f"retry attempt {attempt}: {retry_reason}",
            )
            if delay > 0:
                time.sleep(delay)
            continue
        break

    if last_exc is not None:
        if isinstance(last_exc, AuthError):
            raise HTTPException(
                status_code=401, detail="All available tokens are invalid or expired"
            )
        if isinstance(last_exc, QuotaExhaustedError):
            raise HTTPException(
                status_code=503,
                detail="Upstream is temporarily unavailable. Please retry later.",
            )
        if isinstance(last_exc, UpstreamTemporaryError):
            raise HTTPException(
                status_code=503,
                detail="Upstream is temporarily unavailable. Please retry later.",
            )
        raise last_exc
    raise HTTPException(
        status_code=503, detail="No active tokens available in the pool"
    )


def _extract_prompt_from_messages(messages) -> str:
    if not isinstance(messages, list):
        return ""
    for msg in reversed(messages):
        if not isinstance(msg, dict):
            continue
        if msg.get("role") != "user":
            continue
        chunks = []
        content = msg.get("content")
        if isinstance(content, str):
            if content.strip():
                chunks.append(content.strip())
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    txt = str(part.get("text") or "").strip()
                    if txt:
                        chunks.append(txt)
        return "\n".join(chunks).strip()
    return ""


def _data_url_to_bytes(url: str) -> tuple[bytes, str]:
    raw = str(url or "").strip()
    if not raw.startswith("data:"):
        raise ValueError("not a data url")
    head, sep, body = raw.partition(",")
    if not sep:
        raise ValueError("invalid data url")

    mime_type = "image/jpeg"
    mime_part = head[5:]
    if ";" in mime_part:
        mime_type = (mime_part.split(";", 1)[0] or "image/jpeg").strip()
    elif mime_part:
        mime_type = mime_part.strip()

    if ";base64" in head:
        try:
            return base64.b64decode(body, validate=True), mime_type
        except binascii.Error:
            raise ValueError("invalid base64 image data")

    return unquote_to_bytes(body), mime_type


def _extract_image_urls_from_messages(messages, max_items: int = 6) -> list[str]:
    urls: list[str] = []
    if not isinstance(messages, list):
        return urls
    for msg in reversed(messages):
        if not isinstance(msg, dict):
            continue
        if msg.get("role") != "user":
            continue
        content = msg.get("content")
        if not isinstance(content, list):
            return urls
        for part in content:
            if not isinstance(part, dict):
                continue
            if part.get("type") != "image_url":
                continue
            image_url = part.get("image_url")
            if isinstance(image_url, str):
                image_url = image_url.strip()
            elif isinstance(image_url, dict):
                image_url = str(image_url.get("url") or "").strip()
            else:
                image_url = ""
            if image_url:
                urls.append(image_url)
                if len(urls) >= max_items:
                    return urls
        return urls
    return urls


def _normalize_image_mime(mime_type: str) -> str:
    allowed = {"image/jpeg", "image/jpg", "image/png", "image/webp"}
    normalized = str(mime_type or "").lower()
    if normalized == "image/jpg":
        normalized = "image/jpeg"
    if normalized not in allowed:
        normalized = "image/jpeg"
    return normalized


def _load_input_images(messages) -> list[tuple[bytes, str]]:
    image_urls = _extract_image_urls_from_messages(messages, max_items=6)
    if not image_urls:
        return []

    loaded: list[tuple[bytes, str]] = []
    for image_url in image_urls:
        if image_url.startswith("data:"):
            try:
                image_bytes, mime_type = _data_url_to_bytes(image_url)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc))
        else:
            if not image_url.lower().startswith(("http://", "https://")):
                raise HTTPException(
                    status_code=400,
                    detail="Only http/https or data URL images are supported",
                )
            resp = requests.get(image_url, timeout=30)
            if resp.status_code != 200:
                raise HTTPException(
                    status_code=400,
                    detail=f"Failed to fetch image_url: {resp.status_code}",
                )
            image_bytes = resp.content
            mime_type = (resp.headers.get("content-type") or "image/jpeg").split(";")[
                0
            ].strip() or "image/jpeg"

        if not image_bytes:
            raise HTTPException(status_code=400, detail="image_url is empty")
        if len(image_bytes) > 10 * 1024 * 1024:
            raise HTTPException(status_code=400, detail="image too large, max 10MB")

        loaded.append((image_bytes, _normalize_image_mime(mime_type)))

    return loaded


def _prepare_video_source_image(
    image_bytes: bytes, aspect_ratio: str, resolution: str = "720p"
) -> tuple[bytes, str]:
    if not image_bytes:
        raise HTTPException(status_code=400, detail="image_url is empty")
    if Image is None:
        raise HTTPException(
            status_code=500,
            detail="Pillow is required for video image preprocessing (resize/crop)",
        )

    size = client._video_size(aspect_ratio, resolution)
    target_size = (int(size["width"]), int(size["height"]))
    try:
        with Image.open(io.BytesIO(image_bytes)) as src:
            src = src.convert("RGB")
            src_ratio = src.width / max(1, src.height)
            tgt_ratio = target_size[0] / target_size[1]

            if src_ratio > tgt_ratio:
                new_h = target_size[1]
                new_w = int(new_h * src_ratio)
            else:
                new_w = target_size[0]
                new_h = int(new_w / max(src_ratio, 1e-6))

            resized = src.resize((new_w, new_h), Image.Resampling.LANCZOS)
            left = max(0, (new_w - target_size[0]) // 2)
            top = max(0, (new_h - target_size[1]) // 2)
            cropped = resized.crop(
                (left, top, left + target_size[0], top + target_size[1])
            )

            out = io.BytesIO()
            cropped.save(out, format="PNG")
            return out.getvalue(), "image/png"
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"invalid image for video: {exc}")


def _extract_access_key(request: Request) -> str:
    auth = (request.headers.get("authorization") or "").strip()
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return (request.headers.get("x-api-key") or "").strip()


def _require_service_api_key(request: Request) -> None:
    required = str(config_manager.get("api_key", "")).strip()
    if not required:
        return
    provided = _extract_access_key(request)
    if provided != required:
        raise HTTPException(status_code=401, detail="Invalid API key")


def _is_admin_authenticated(request: Request) -> bool:
    sess = request.session or {}
    if not bool(sess.get("admin_auth")):
        return False
    username = str(sess.get("username") or "").strip()
    required_username = str(
        config_manager.get("admin_username", "admin") or "admin"
    ).strip()
    return bool(username) and username == required_username


def _require_admin_auth(request: Request) -> None:
    if not _is_admin_authenticated(request):
        raise HTTPException(status_code=401, detail="Unauthorized")


def _apply_client_config() -> None:
    client.apply_config(config_manager.get_all())


def _public_image_url(request: Request, job_id: str) -> str:
    return _public_generated_url(request, f"{job_id}.png")


def _public_generated_url(request: Request, filename: str) -> str:
    safe_name = str(filename or "").lstrip("/")
    path = f"/generated/{safe_name}"

    config_base = str(config_manager.get("public_base_url", "") or "").strip()
    if config_base:
        return f"{config_base.rstrip('/')}{path}"

    override = str(
        os.getenv("ADOBE_PUBLIC_BASE_URL") or os.getenv("PUBLIC_BASE_URL") or ""
    ).strip()
    if override:
        return f"{override.rstrip('/')}{path}"

    forwarded_host = str(request.headers.get("x-forwarded-host") or "").strip()
    if forwarded_host:
        forwarded_proto = str(
            request.headers.get("x-forwarded-proto") or "http"
        ).strip()
        forwarded_prefix = str(request.headers.get("x-forwarded-prefix") or "").strip()
        if forwarded_prefix and not forwarded_prefix.startswith("/"):
            forwarded_prefix = f"/{forwarded_prefix}"
        forwarded_prefix = forwarded_prefix.rstrip("/")
        return f"{forwarded_proto}://{forwarded_host}{forwarded_prefix}{path}"

    return f"{str(request.base_url).rstrip('/')}{path}"


def _scan_generated_dir() -> tuple[list[tuple[Path, int, float]], int, int]:
    files: list[tuple[Path, int, float]] = []
    total_bytes = 0
    file_count = 0
    for item in GENERATED_DIR.iterdir():
        if not item.is_file():
            continue
        try:
            st = item.stat()
            size = int(st.st_size)
            mtime = float(st.st_mtime)
        except Exception:
            continue
        files.append((item, size, mtime))
        total_bytes += size
        file_count += 1
    return files, total_bytes, file_count


def _reconcile_generated_storage(force: bool = False) -> None:
    global _generated_usage_bytes, _generated_file_count, _generated_last_reconcile_ts
    now = time.time()
    with _generated_storage_lock:
        if (
            not force
            and _generated_last_reconcile_ts > 0
            and (now - _generated_last_reconcile_ts) < _GENERATED_RECONCILE_INTERVAL_SEC
        ):
            return
    try:
        _files, total_bytes, file_count = _scan_generated_dir()
    except Exception:
        return
    with _generated_storage_lock:
        _generated_usage_bytes = max(0, int(total_bytes))
        _generated_file_count = max(0, int(file_count))
        _generated_last_reconcile_ts = now


def _on_generated_file_written(file_path: Path, old_size: int, new_size: int) -> None:
    global _generated_usage_bytes, _generated_file_count
    safe_old_size = max(0, int(old_size or 0))
    safe_new_size = max(0, int(new_size or 0))

    with _generated_storage_lock:
        delta = safe_new_size - safe_old_size
        _generated_usage_bytes = max(0, int(_generated_usage_bytes + delta))
        if safe_old_size == 0 and safe_new_size > 0:
            _generated_file_count += 1

    _prune_generated_files_if_needed()


def _prune_generated_files_if_needed() -> None:
    global _generated_usage_bytes, _generated_file_count, _generated_last_reconcile_ts

    def _conf_int(key: str, default: int) -> int:
        raw = config_manager.get(key, default)
        if isinstance(raw, bool):
            return default
        if isinstance(raw, (int, float, str)):
            try:
                return int(raw)
            except Exception:
                return default
        return default

    max_size_mb = _conf_int("generated_max_size_mb", 1024)
    prune_size_mb = _conf_int("generated_prune_size_mb", 200)

    if max_size_mb <= 0:
        return
    if prune_size_mb <= 0:
        prune_size_mb = 200

    max_bytes = max_size_mb * 1024 * 1024
    prune_bytes = prune_size_mb * 1024 * 1024

    _reconcile_generated_storage(force=False)
    with _generated_storage_lock:
        cached_usage = int(_generated_usage_bytes)
    if cached_usage <= max_bytes:
        return

    if not _generated_prune_lock.acquire(blocking=False):
        return

    try:
        files, total_bytes, file_count = _scan_generated_dir()
        if total_bytes <= max_bytes or not files:
            with _generated_storage_lock:
                _generated_usage_bytes = int(total_bytes)
                _generated_file_count = int(file_count)
                _generated_last_reconcile_ts = time.time()
            return

        newest_file_path = max(files, key=lambda row: row[2])[0]
        files.sort(key=lambda row: row[2])
        removed_bytes = 0
        current_bytes = total_bytes
        current_count = file_count

        for path, size, _mtime in files:
            if current_bytes <= max_bytes and removed_bytes >= prune_bytes:
                break
            if path == newest_file_path:
                continue
            try:
                path.unlink(missing_ok=True)
                current_bytes -= size
                current_count -= 1
                removed_bytes += size
            except Exception:
                continue

        with _generated_storage_lock:
            _generated_usage_bytes = max(0, int(current_bytes))
            _generated_file_count = max(0, int(current_count))
            _generated_last_reconcile_ts = time.time()

        logger.info(
            "pruned generated files: before=%s after=%s removed=%s",
            total_bytes,
            max(current_bytes, 0),
            removed_bytes,
        )
    finally:
        _generated_prune_lock.release()


def _get_generated_storage_stats() -> dict[str, int | float]:
    _reconcile_generated_storage(force=False)
    with _generated_storage_lock:
        total_bytes = int(_generated_usage_bytes)
        file_count = int(_generated_file_count)
    return {
        "generated_usage_bytes": total_bytes,
        "generated_usage_mb": round(total_bytes / (1024 * 1024), 2),
        "generated_file_count": file_count,
    }


def _video_ext_from_meta(meta: dict) -> str:
    content_type = str(meta.get("contentType") or "").lower()
    if "webm" in content_type:
        return "webm"
    if "ogg" in content_type or "ogv" in content_type:
        return "ogv"
    return "mp4"


def _sse_chat_stream(payload: dict):
    import json

    cid = payload["id"]
    created = payload["created"]
    model = payload["model"]
    content = payload["choices"][0]["message"]["content"]

    first = {
        "id": cid,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": {"role": "assistant", "content": content},
                "finish_reason": None,
            }
        ],
    }
    last = {
        "id": cid,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": {},
                "finish_reason": "stop",
            }
        ],
    }

    yield f"data: {json.dumps(first, ensure_ascii=False)}\n\n"
    yield f"data: {json.dumps(last, ensure_ascii=False)}\n\n"
    yield "data: [DONE]\n\n"


_reconcile_generated_storage(force=True)


app.include_router(
    build_admin_router(
        static_dir=STATIC_DIR,
        token_manager=token_manager,
        config_manager=config_manager,
        refresh_manager=refresh_manager,
        log_store=log_store,
        error_store=error_store,
        live_log_store=live_log_store,
        require_admin_auth=_require_admin_auth,
        is_admin_authenticated=_is_admin_authenticated,
        apply_client_config=_apply_client_config,
        get_generated_storage_stats=_get_generated_storage_stats,
    )
)

app.include_router(
    build_generation_router(
        store=store,
        token_manager=token_manager,
        client=client,
        generated_dir=GENERATED_DIR,
        model_catalog=MODEL_CATALOG,
        video_model_catalog=VIDEO_MODEL_CATALOG,
        supported_ratios=SUPPORTED_RATIOS,
        resolve_model=resolve_model,
        resolve_ratio_and_resolution=resolve_ratio_and_resolution,
        require_service_api_key=_require_service_api_key,
        set_request_task_progress=_set_request_task_progress,
        run_with_token_retries=_run_with_token_retries,
        set_request_error_detail=_set_request_error_detail,
        set_request_preview=_set_request_preview,
        public_image_url=_public_image_url,
        public_generated_url=_public_generated_url,
        resolve_video_options=_resolve_video_options,
        load_input_images=_load_input_images,
        prepare_video_source_image=_prepare_video_source_image,
        video_ext_from_meta=_video_ext_from_meta,
        extract_prompt_from_messages=_extract_prompt_from_messages,
        sse_chat_stream=_sse_chat_stream,
        on_generated_file_written=_on_generated_file_written,
        quota_error_cls=QuotaExhaustedError,
        auth_error_cls=AuthError,
        upstream_temp_error_cls=UpstreamTemporaryError,
        logger=logger,
    )
)

app.include_router(
    build_entity_router(
        client=client,
        token_manager=token_manager,
        require_service_api_key=_require_service_api_key,
    )
)


if __name__ == "__main__":
    import uvicorn

    # 为了在容器中更好工作，使用环境变量
    uvicorn.run("app:app", host="0.0.0.0", port=int(os.getenv("PORT", "6001")))
