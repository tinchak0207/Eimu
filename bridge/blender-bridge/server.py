#!/usr/bin/env python3
"""Image Studio blender-bridge HTTP server (stdlib only).

Listens on 127.0.0.1:8765 and fronts the headless Blender sandbox managed by
launcher.py (which runs the verbatim blender-mcp addon inside `unshare -rn`
where available).

Contract (pinned, shared with the tool layer; additive-only):

    GET  /v1/health
         → 200 {ok:true, blender_version:string, gpu:"egl"|"cpu", workdir:string,
                queue_depth:int, concurrency:int}

    POST /v1/execute  body {script:string, timeout_ms?:number (default 300000, cap 600000)}
         Authorization: Bearer $BLENDER_BRIDGE_TOKEN (required). Missing
         environment variable or a bad token → 401, script is not executed.
         → 200 {ok:true, artifacts:[{path,bytes,kind:"blend|png|mp4|glb|other"}],
                scene_summary:string, stdout_tail:string(<=2000 chars), duration_ms:number,
                queued:bool, queue_position:int}
         → 429 {ok:false, error:"queue_full"}
         → 500 {ok:false, error:string, stdout_tail:string, queued:bool, queue_position:int}

    POST /v1/cancel
         Authorization: Bearer $BLENDER_BRIDGE_TOKEN (same rule as execute).
         If the bridge Blender process is alive, SIGKILL its process group.
         → 200 {ok:true, killed:bool}
         → 401 {ok:false, error:"unauthorized"}

artifacts: files created or modified under $BLENDER_WORK/out/ during the
job (session snapshot diff: the out/ tree is snapshotted path→mtime when
the job starts and diffed at completion; a file is reported iff it is new
or its mtime changed — no clock-tolerance assumptions, so a previous
job's tail file can never be repicked). kind inferred from extension.
Before each script the bridge ensures blender's CWD is $BLENDER_WORK (the
process is spawned with that CWD and the bootstrap chdirs to it, so every
script inherits it).

    GET  /v1/artifact?path=<relative-path-under-out/>
         → 200 binary body (Content-Type by extension; whitelist below)
         → 400 bad path (traversal / outside out/ / extension not whitelisted)
         → 404 not found

    GET  /v1/artifact?path=<.asset-cache/<relative-path>>
         → 200 binary body (asset whitelist: glb/gltf/fbx/bvh/json/blend/png/hdr/jpg)
         → 400 bad path (traversal / outside .asset-cache/ / extension not whitelisted)
         → 404 not found

         Artifact retrieval channel: files land on the bridge host's
         $BLENDER_WORK/out/, which the agent sandbox cannot see (bridge host
         and sandbox are different machines). The tool layer therefore
         returns an artifact_base_url with every success result and the agent
         fetches bytes through this endpoint. path is a single relative path
         under out/ (subdirectories allowed, no ".." segments, no absolute
         paths, no backslashes); only render artifact extensions are served —
         never .py/.log/.json sidecars beyond meta-style data. /v1/execute
         and /v1/cancel require Authorization: Bearer equal to the
         BLENDER_BRIDGE_TOKEN environment variable (unset or mismatch is
         401 and does not run). This endpoint stays loopback/tunnel bound.

         Asset byte channel (piece AN, eval REPORT S2 dead-line 2): GLB/BVH
         pack bodies live in the bridge host's .asset-cache/ (multi-GB, never
         on the VPS, never in git). path may instead be the pack item's
         artifactPath verbatim (".asset-cache/<relpath>"); those paths route
         to <repo-root>/.asset-cache/ under a separate whitelist (>=2 path
         segments, first segment exactly ".asset-cache", no "..", no absolute
         paths, no backslashes; extensions limited to
         glb/gltf/fbx/bvh/json/blend/png/hdr/jpg). Same 512MB cap and
         realpath-containment double check as the out/ branch. Registry/
         api-url pack items whose artifactPath is a remote URL are not served
         here — the agent fetches those URLs directly.

Queue semantics: execute requests run through a FIFO queue in front of the
blender supervisor (FIFO order, bounded depth, failure self-healing).
CONCURRENCY is fixed at 1 (BLENDER_BRIDGE_CONCURRENCY is ignored).
BLENDER_BRIDGE_QUEUE_DEPTH waiting slots (default 16) — overflow answers
429 queue_full immediately. queue_position is 1-based at enqueue time
(0 when a slot was free).

Timeout semantics: timeout_ms budgets execution only (queue wait is not
deducted from it). Total wait (queue + execution) beyond timeout_ms x 2 hits
the hard deadline: a still-queued job is abandoned with 500 without running;
a running job's blender process group is SIGKILLed, every job still waiting
is dropped (500, not executed), and the request answers 500. A later new
request relaunches a fresh factory-startup Blender.

Run:  python3 bridge/blender-bridge/server.py
"""
import hmac
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import launcher  # noqa: E402

HTTP_HOST = "127.0.0.1"
HTTP_PORT = 8765
DEFAULT_TIMEOUT_MS = 300000
MAX_TIMEOUT_MS = 600000
MIN_TIMEOUT_MS = 1000
# Concurrency-pool semantics mirrored from the generation worker
# (GENERATION_WORKER_CONCURRENCY): env-tunable pool size, FIFO queue,
# bounded waiting depth with immediate rejection on overflow.
DEFAULT_QUEUE_DEPTH = 16


def _env_int(name, default, minimum=1):
    try:
        return max(minimum, int(os.getenv(name) or default))
    except (TypeError, ValueError):
        return default


# Fixed at 1. BLENDER_BRIDGE_CONCURRENCY is ignored: a timeout kill drops
# the Blender process, so a second slot must not keep running beside it.
CONCURRENCY = 1
QUEUE_DEPTH = _env_int("BLENDER_BRIDGE_QUEUE_DEPTH", DEFAULT_QUEUE_DEPTH)

_KIND_BY_EXT = {
    ".blend": "blend",
    ".blend1": "blend",
    ".png": "png",
    ".mp4": "mp4",
    ".glb": "glb",
}

# /v1/artifact 副档名 → Content-Type（只出渲染产物；.py/.log 一律 400）。
_ARTIFACT_CONTENT_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".blend": "application/x-blender",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".json": "application/json",
}

# path 白名单：单段相对路径（out/ 内允许一层子目录档案，如 render_frames/frame_0001.png）。
# 禁 traversal：无 ".."、无绝对路径、无反斜线、不以点开头（同构
# src/app/api/blender-artifact/route.ts 的 isSafeArtifactName，多允许一段子目录）。
_ARTIFACT_PATH_RE = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}(/[A-Za-z0-9][A-Za-z0-9._-]{0,120})?$"
)

# 死线②（片AN）：.asset-cache 资产字节通路白名单。repo 根 = server.py 上两级
# （bridge/blender-bridge/server.py → image-app/），.asset-cache 就在 repo 根下。
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# path 形状：首段必为 ".asset-cache"，其后 1-7 段普通路径段（cmu 4 段
# .asset-cache/cmu-mocap/data/001/01_01.bvh 也在界内）；段内禁 ".."/空白/反斜线，
# traversal 由 regex + realpath 收容双档。out/ 白名单禁首段以点开头，两分支零交叠。
_ASSET_CACHE_PATH_RE = re.compile(
    r"^\.asset-cache(/[A-Za-z0-9][A-Za-z0-9._-]{0,120}){1,7}$"
)

# 资产副档名白名单（评测规格死线②指定）：glb/gltf/fbx/bvh/json/blend/png/hdr/jpg。
# 在 out/ 白名单基础上追加 .fbx/.bvh/.hdr（.jpg/.jpeg 同族）。
_ASSET_CACHE_CONTENT_TYPES = dict(_ARTIFACT_CONTENT_TYPES)
_ASSET_CACHE_CONTENT_TYPES.update({
    ".fbx": "application/octet-stream",
    ".bvh": "text/plain",
    ".hdr": "image/vnd.radiance",
})

_GPU_PROBE = r'''
import json
_info = {"gpu": "cpu", "gpu_error": None}
try:
    import gpu
    # In background mode the gpu module ships uninitialized; explicit init
    # creates the headless EGL context (field-verified on Blender 5.2.1).
    try:
        gpu.init()
    except Exception:
        pass
    _off = gpu.types.GPUOffScreen(16, 16)
    try:
        _off.free()
    except Exception:
        pass
    _info["gpu"] = "egl"
except Exception as _e:
    _info["gpu_error"] = str(_e)
print("BRIDGE_GPU_PROBE " + json.dumps(_info))
'''

_STATE = threading.Lock()
_SUPERVISOR = None
_GPU_CACHE = {"generation": -1, "gpu": None}
_EXEC_LOCK = threading.RLock()

# FIFO execution queue. "waiters" holds waiting requests in arrival order;
# "running" counts jobs holding an execution slot. A slot is transferred
# hand-to-hand between waiters (condition notify) so that exactly one
# waiting job enters per exit and FIFO order is preserved.
_QUEUE_CV = threading.Condition(threading.Lock())
_QUEUE = {"waiters": [], "running": 0, "seq": 0, "epoch": 0}


_PROC_GENERATION = [0]  # incremented on every (re)launch


def supervisor():
    global _SUPERVISOR
    with _STATE:
        if _SUPERVISOR is None:
            _SUPERVISOR = launcher.BlenderSupervisor()
        return _SUPERVISOR


def ensure_blender():
    sup = supervisor()
    if not sup.is_alive():
        with _EXEC_LOCK:
            if not sup.is_alive():
                sup.kill()  # clear remnants (no-op if already dead)
                sup.start()
                _PROC_GENERATION[0] += 1
                with _STATE:
                    _GPU_CACHE["generation"] = -1
    return sup


def addon_call(sup, cmd_type, params, timeout_s):
    resp = sup.call(cmd_type, params, timeout_s=timeout_s)
    if resp.get("ok") is False:
        raise RuntimeError(str(resp.get("error", "addon error")))
    return resp


def probe_gpu(sup):
    with _STATE:
        if _GPU_CACHE["generation"] == _PROC_GENERATION[0]:
            return _GPU_CACHE["gpu"]
    try:
        resp = sup.call("execute_code", {"code": _GPU_PROBE}, timeout_s=60)
        out = ""
        if resp.get("status") == "success":
            result = resp.get("result")
            if isinstance(result, dict):
                out = str(result.get("result") or "")
        for line in out.splitlines():
            if line.startswith("BRIDGE_GPU_PROBE "):
                info = json.loads(line[len("BRIDGE_GPU_PROBE "):])
                gpu = "egl" if info.get("gpu") == "egl" else "cpu"
                with _STATE:
                    _GPU_CACHE["generation"] = _PROC_GENERATION[0]
                    _GPU_CACHE["gpu"] = gpu
                return gpu
    except Exception:
        pass
    return "cpu"


def snapshot_tree(out_dir):
    """Snapshot the out/ tree as {abspath: mtime}. Returns {} when the
    directory does not exist yet (a later full listing then counts every
    file as new, which is correct for a first job)."""
    tree = {}
    if not os.path.isdir(out_dir):
        return tree
    for root, _dirs, files in os.walk(out_dir):
        for name in files:
            path = os.path.join(root, name)
            try:
                tree[path] = os.path.getmtime(path)
            except OSError:
                continue
    return tree


def scan_artifacts(out_dir, before):
    """Diff two session snapshots: report every file that is new since
    `before` or whose mtime changed. Replaces the old start-timestamp +
    0.5s mtime tolerance heuristic, which mispicked the previous job's
    last-written files into a back-to-back job's artifacts (piece-L field
    evidence). Response contract unchanged (same artifact shape)."""
    after = snapshot_tree(out_dir)
    artifacts = []
    for path, mtime in after.items():
        if before.get(path) == mtime:
            continue
        ext = os.path.splitext(path)[1].lower()
        try:
            size = os.path.getsize(path)
        except OSError:
            continue
        artifacts.append({
            "path": os.path.relpath(path, out_dir),
            "bytes": size,
            "kind": _KIND_BY_EXT.get(ext, "other"),
        })
    artifacts.sort(key=lambda a: a["path"])
    return artifacts


def compose_stdout_tail(code_out, sup, job_out_before=0):
    """Script prints (code_out) own the stdout_tail window; the remaining
    budget is filled from the job's own output (the python-level stdout
    stream in $BLENDER_WORK/job-output.log, read as the bytes appended
    since this job started), falling back to the blender.log tail when the
    job log is unavailable or adds nothing. Field-verified failures this
    cures: the pre-pipeline code appended a full 2000-char blender.log
    tail (old crash tracebacks, render progress) that squeezed the
    script's prints out of the window entirely, and even the log-rotated
    version could show a stale engine tail instead of this job's output."""
    code = code_out.strip() if code_out and code_out.strip() else ""
    budget = 2000 - (len(code) + 1) if code else 2000
    proc_tail = job_output_tail(sup, job_out_before, budget) \
        if budget > 0 else ""
    if not proc_tail:
        proc_tail = sup.stdout_tail(budget) if budget > 0 else ""
    parts = [p.strip() for p in (proc_tail, code) if p and p.strip()]
    return "\n".join(parts)[-2000:]


def _job_output_size(sup):
    try:
        return os.path.getsize(
            os.path.join(getattr(sup, "workdir", ""), "job-output.log"))
    except OSError:
        return 0


def job_output_tail(sup, before_bytes, max_chars):
    """Tail of this job's own output: the bytes appended to
    $BLENDER_WORK/job-output.log since `before_bytes` (the job's start
    offset). Returns "" when the log is missing (old supervisor/mock) or
    added nothing, so callers can fall back to the engine log."""
    log_path = os.path.join(getattr(sup, "workdir", ""), "job-output.log")
    try:
        size = os.path.getsize(log_path)
        if size <= before_bytes:
            return ""
        with open(log_path, "rb") as f:
            f.seek(before_bytes)
            data = f.read()
        return data.decode("utf-8", errors="replace")[-int(max_chars):]
    except Exception:
        return ""


def _bearer_authorized(headers):
    """True only when Authorization Bearer equals BLENDER_BRIDGE_TOKEN.

    Missing env, empty token, or a mismatch is unauthorized. An unset
    token is never treated as anonymous access.
    """
    expected = os.environ.get("BLENDER_BRIDGE_TOKEN")
    if not expected:
        return False
    raw = headers.get("Authorization") or ""
    scheme, _, got = raw.partition(" ")
    if scheme.lower() != "bearer" or got == "":
        return False
    if len(got) != len(expected):
        return False
    return hmac.compare_digest(got, expected)


def _unauthorized(handler):
    handler.close_connection = True
    handler._json(401, {"ok": False, "error": "unauthorized"})


def _clear_wait_queue():
    """Drop every job still waiting after a timeout kill."""
    with _QUEUE_CV:
        _QUEUE["waiters"].clear()
        _QUEUE["epoch"] += 1
        _QUEUE_CV.notify_all()


def handle_cancel():
    with _STATE:
        sup = _SUPERVISOR
    if sup is None or not sup.is_alive():
        return 200, {"ok": True, "killed": False}
    return 200, {"ok": True, "killed": bool(sup.kill())}


def handle_execute(script, timeout_ms):
    timeout_ms = max(MIN_TIMEOUT_MS, min(MAX_TIMEOUT_MS,
                                         int(timeout_ms or DEFAULT_TIMEOUT_MS)))
    # --- enqueue phase (bounded FIFO) -------------------------------------
    with _QUEUE_CV:
        if len(_QUEUE["waiters"]) + _QUEUE["running"] >= CONCURRENCY + QUEUE_DEPTH:
            return 429, {"ok": False, "error": "queue_full"}
        _QUEUE["seq"] += 1
        ticket = _QUEUE["seq"]
        epoch = _QUEUE["epoch"]
        _QUEUE["waiters"].append(ticket)
        enqueue_position = len(_QUEUE["waiters"])

    # --- wait for an execution slot ---------------------------------------
    # timeout_ms budgets execution only; the hard deadline (timeout_ms x 2)
    # bounds the *total* of queue wait + execution. A job still queued at the
    # hard deadline is abandoned without ever running (self-healing: it
    # never blocks the waiters behind it).
    hard_deadline = time.monotonic() + (2 * timeout_ms / 1000.0)
    abandoned = False
    cleared = False
    promoted = False
    waited = False
    try:
        with _QUEUE_CV:
            while True:
                if _QUEUE["epoch"] != epoch:
                    cleared = True
                    break
                if _QUEUE["running"] < CONCURRENCY and _QUEUE["waiters"][:1] == [ticket]:
                    _QUEUE["waiters"].pop(0)
                    _QUEUE["running"] += 1
                    promoted = True
                    break
                remaining = hard_deadline - time.monotonic()
                if remaining <= 0:
                    try:
                        _QUEUE["waiters"].remove(ticket)
                    except ValueError:
                        pass  # already gone; the pool accounting stays balanced
                    abandoned = True
                    # Wake the new head so it takes the slot immediately.
                    _QUEUE_CV.notify_all()
                    break
                waited = True
                _QUEUE_CV.wait(timeout=min(remaining, 1.0))
    except BaseException:
        # Never leak a ticket or a slot (thread death etc.).
        with _QUEUE_CV:
            try:
                _QUEUE["waiters"].remove(ticket)
            except ValueError:
                pass
            if promoted:
                _QUEUE["running"] -= 1
                _QUEUE_CV.notify_all()
        raise
    if cleared:
        return 500, {"ok": False,
                     "error": ("queue cleared after blender execution timeout; "
                               "waiting job dropped without running"),
                     "queued": True, "queue_position": enqueue_position}
    if abandoned:
        return 500, {"ok": False,
                     "error": ("queue hard deadline: still queued after %dms "
                               "(total wait cap = timeout_ms x 2); job "
                               "abandoned without running" % (2 * timeout_ms)),
                     "queued": True, "queue_position": enqueue_position}

    # queued = the job had to wait for a slot; queue_position is 1-based at
    # enqueue time (0 when a slot was immediately available).
    queued = waited
    queue_position = enqueue_position if queued else 0

    # --- execution phase (timeout_ms budgets execution only) ---------------
    try:
        return _run_job(script, timeout_ms, queued, queue_position)
    finally:
        # Hand the slot to the next waiter in FIFO order (if any). All
        # waiters re-check; only the head can be promoted, so FIFO order is
        # strict regardless of which thread the notify wakes.
        with _QUEUE_CV:
            _QUEUE["running"] -= 1
            _QUEUE_CV.notify_all()


def _run_job(script, timeout_ms, queued, queue_position):
    """Execution phase: holds exactly one queue slot (the FIFO queue, not a
    global lock, is the concurrency control — CONCURRENCY>1 must run jobs in
    parallel)."""
    sup = ensure_blender()
    out_dir = os.path.join(sup.workdir, "out")
    before_tree = snapshot_tree(out_dir)
    job_out_before = _job_output_size(sup)
    t0 = time.monotonic()
    try:
        resp = sup.call("execute_code", {"code": script},
                        timeout_s=timeout_ms / 1000.0)
    except launcher.ExecutionTimeout:
        killed = sup.kill()
        _clear_wait_queue()
        error = ("execution timed out after %dms; blender process group %s"
                 % (timeout_ms, "killed" if killed else "already gone"))
        return 500, {"ok": False, "error": error,
                     "stdout_tail": sup.stdout_tail(2000),
                     "queued": queued, "queue_position": queue_position}
    except launcher.ConnectionLost as e:
        sup.kill()
        return 500, {"ok": False,
                     "error": "blender connection lost: %s" % e,
                     "stdout_tail": sup.stdout_tail(2000),
                     "queued": queued, "queue_position": queue_position}
    duration_ms = int((time.monotonic() - t0) * 1000)

    if resp.get("ok") is False:
        return 500, {"ok": False,
                     "error": str(resp.get("error", "addon error")),
                     "stdout_tail": sup.stdout_tail(2000),
                     "queued": queued, "queue_position": queue_position}
    if resp.get("status") != "success":
        return 500, {"ok": False,
                     "error": "unexpected addon response: %s"
                              % json.dumps(resp)[:500],
                     "stdout_tail": sup.stdout_tail(2000),
                     "queued": queued, "queue_position": queue_position}

    result = resp.get("result")
    code_out = ""
    if isinstance(result, dict):
        code_out = str(result.get("result") or "")
    elif result is not None:
        code_out = str(result)

    # Scene summary (whitelisted <=500-char text from the addon).
    scene_summary = ""
    try:
        si = sup.call("get_scene_info", {}, timeout_s=20)
        if si.get("status") == "success":
            scene_summary = str(si.get("result") or "")[:500]
    except Exception as e:
        scene_summary = "scene_info_error: %s" % e

    return 200, {
        "ok": True,
        "artifacts": scan_artifacts(out_dir, before_tree),
        "scene_summary": scene_summary,
        "stdout_tail": compose_stdout_tail(code_out, sup, job_out_before),
        "duration_ms": duration_ms,
        "queued": queued, "queue_position": queue_position,
    }


def queue_depth():
    """Jobs waiting in the queue (running jobs hold slots, not queue depth)."""
    with _QUEUE_CV:
        return len(_QUEUE["waiters"])


def handle_health():
    try:
        sup = ensure_blender()
        info = addon_call(sup, "get_addon_info", {}, timeout_s=20)
        result = info.get("result") or {}
        version = str(result.get("blender_version") or "unknown")
        gpu = probe_gpu(sup)
        return 200, {"ok": True, "blender_version": version,
                     "gpu": gpu, "workdir": sup.workdir,
                     "queue_depth": queue_depth(),
                     "concurrency": CONCURRENCY}
    except launcher.ConnectionLost as e:
        return 500, {"ok": False, "error": str(e)}
    except Exception as e:
        return 500, {"ok": False, "error": "health check failed: %s" % e}


def handle_asset_cache_artifact(rel):
    """死线②（片AN）：.asset-cache 资产字节分支。

    path 必为 ".asset-cache/<relpath>"（regex 白名单 + realpath 收容双档），
    根 = REPO_ROOT/.asset-cache/。副档名限资产白名单。回传形状同 handle_artifact。
    """
    if not _ASSET_CACHE_PATH_RE.match(rel) or ".." in rel:
        return 400, None, "path 不合法（仅允许 .asset-cache/ 内相对路径）"
    ext = os.path.splitext(rel)[1].lower()
    content_type = _ASSET_CACHE_CONTENT_TYPES.get(ext)
    if not content_type:
        return 400, None, "不支持的资产类型（%s）" % (ext or "无扩展名")

    root = os.path.join(REPO_ROOT, ".asset-cache")
    candidate = os.path.join(root, rel[len(".asset-cache/"):])
    try:
        real_root = os.path.realpath(root)
        real_file = os.path.realpath(candidate)
    except OSError:
        return 404, None, "资产不存在"
    if not real_file.startswith(real_root + os.sep) or not os.path.isfile(real_file):
        return 404, None, "资产不存在（.asset-cache 内无此文件）"
    try:
        size = os.path.getsize(real_file)
        if size > 512 * 1024 * 1024:
            return 400, None, "资产过大（>512MB），拒绝经 HTTP 取回"
        with open(real_file, "rb") as fh:
            body = fh.read()
    except OSError as e:
        return 404, None, "资产读取失败: %s" % e
    return 200, body, content_type


def handle_artifact(raw_path):
    """GET /v1/artifact?path=<relpath under out/> 或 .asset-cache/<relpath>。

    两分支（片 AJ out/ 产物 + 片 AN .asset-cache 资产字节）：各走各的 regex
    白名单（禁 traversal）＋ realpath 收容检查（防 symlink 逃逸），双重保险。
    回 binary + 按副档名的 Content-Type。回传 (status, bytes|dict)——
    dict 走 _json，bytes 走 binary。
    """
    rel = (raw_path or "").strip()
    if not rel:
        return 400, None, "缺少 path 参数"
    if rel.startswith(".asset-cache/"):
        return handle_asset_cache_artifact(rel)
    if not _ARTIFACT_PATH_RE.match(rel) or ".." in rel:
        return 400, None, "path 不合法（仅允许 out/ 内单段相对路径）"
    ext = os.path.splitext(rel)[1].lower()
    content_type = _ARTIFACT_CONTENT_TYPES.get(ext)
    if not content_type:
        return 400, None, "不支持的产物类型（%s）" % (ext or "无扩展名")

    sup = supervisor()
    out_root = os.path.join(sup.workdir, "out")
    candidate = os.path.join(out_root, rel)
    try:
        real_root = os.path.realpath(out_root)
        real_file = os.path.realpath(candidate)
    except OSError:
        return 404, None, "产物不存在"
    if not (real_file == real_root or real_file.startswith(real_root + os.sep)) \
            or not os.path.isfile(real_file):
        return 404, None, "产物不存在（桥可能还没生成该文件）"
    try:
        size = os.path.getsize(real_file)
        if size > 512 * 1024 * 1024:
            return 400, None, "产物过大（>512MB），拒绝经 HTTP 取回"
        with open(real_file, "rb") as fh:
            body = fh.read()
    except OSError as e:
        return 404, None, "产物读取失败: %s" % e
    return 200, body, content_type


class Handler(BaseHTTPRequestHandler):
    server_version = "image-studio-blender-bridge/1.0"
    protocol_version = "HTTP/1.1"

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _binary(self, code, body, content_type):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/v1/health":
            code, obj = handle_health()
            self._json(code, obj)
        elif self.path.startswith("/v1/artifact"):
            from urllib.parse import urlsplit, parse_qs
            query = parse_qs(urlsplit(self.path).query).get("path", [""])[0]
            try:
                code, body, info = handle_artifact(query)
            except Exception as e:  # never let the bridge hang or crash
                code, body, info = 500, None, "artifact error: %s" % e
            if body is None:
                self._json(code, {"ok": False, "error": info})
            else:
                self._binary(code, body, info)
        else:
            self._json(404, {"ok": False, "error": "not found: %s" % self.path})

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        if path == "/v1/cancel":
            if not _bearer_authorized(self.headers):
                _unauthorized(self)
                return
            try:
                code, obj = handle_cancel()
            except Exception as e:  # never let the bridge hang or crash
                code, obj = 500, {"ok": False, "error": "cancel failed: %s" % e}
            self._json(code, obj)
            return
        if path != "/v1/execute":
            self._json(404, {"ok": False, "error": "not found: %s" % self.path})
            return
        if not _bearer_authorized(self.headers):
            _unauthorized(self)
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > 8 * 1024 * 1024:
                raise ValueError("bad Content-Length")
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            script = body.get("script")
            if not isinstance(script, str) or not script.strip():
                raise ValueError("body.script must be a non-empty string")
            timeout_ms = body.get("timeout_ms", DEFAULT_TIMEOUT_MS)
        except (ValueError, json.JSONDecodeError) as e:
            self._json(400, {"ok": False, "error": "bad request: %s" % e})
            return
        try:
            code, obj = handle_execute(script, timeout_ms)
        except Exception as e:  # never let the bridge hang or crash
            code, obj = 500, {"ok": False, "error": "bridge error: %s" % e,
                              "stdout_tail": ""}
        self._json(code, obj)

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(),
                                        fmt % args))


def build_server():
    ThreadingHTTPServer.allow_reuse_address = True
    httpd = ThreadingHTTPServer((HTTP_HOST, HTTP_PORT), Handler)
    httpd.daemon_threads = True
    return httpd


def main():
    sup = supervisor()
    print("image-studio blender-bridge listening on %s:%d" % (HTTP_HOST, HTTP_PORT))
    print("workdir: %s | isolation(unshare -rn): %s"
          % (sup.workdir, sup.isolate))
    print("blender binary: %s" % sup.blender_bin)
    print("execution queue: concurrency=%d queue_depth_cap=%d"
          % (CONCURRENCY, QUEUE_DEPTH))
    httpd = build_server()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
