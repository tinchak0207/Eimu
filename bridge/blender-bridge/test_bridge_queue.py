#!/usr/bin/env python3
"""Queue behaviour tests for bridge/blender-bridge/server.py (stdlib only).

Covers (mock blender — a fake supervisor whose execute_code sleeps):
  1. FIFO order, concurrency=1 never parallel, queued/queue_position fields
  2. concurrency>1 honours BLENDER_BRIDGE_CONCURRENCY semantics
  3. queue_full → immediate 429 {"ok":false,"error":"queue_full"}
  4. failure self-healing: a job whose blender died (or timed out) leaves the
     queue with 500 and never blocks the jobs behind it
  5. queue hard deadline: a still-queued job is abandoned at timeout_ms x 2
     (500, queued:true) without ever running
  6. /v1/health carries queue_depth + concurrency (additive fields)
  7. env parsing (_env_int) defaults on garbage
  8. HTTP wiring on an ephemeral port (additive response fields flow through)
  9. artifact session-snapshot diff: unchanged files never repicked, new
     files all picked, mtime changes picked; adjacent jobs never cross-pick
     the previous job's tail files (0.5s-tolerance regression)
 10. stdout_tail is job-scoped: job-output.log delta since job start —
     pre-job residue and other jobs' prints never resurface

Run: python3 bridge/blender-bridge/test_bridge_queue.py
"""
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server  # noqa: E402
import launcher  # noqa: E402


class FakeSupervisor:
    """Stands in for launcher.BlenderSupervisor.

    execute_code sleeps for the duration encoded in the script
    ("SLEEP <seconds>") or blocks on a per-job event ("WAIT <name>").
    Side effects (mirroring a real blender run):
      - "WRITE <path>" appends a file under workdir/out/
      - "PRINT <text>" appends a line to workdir/job-output.log
    """

    def __init__(self):
        self.workdir = tempfile.mkdtemp(prefix="bridge-queue-test-")
        os.makedirs(os.path.join(self.workdir, "out"), exist_ok=True)
        self.lock = threading.Lock()
        self.active = 0
        self.max_active = 0
        self.completed = []          # completion order (job names)
        self.events = {}             # name -> threading.Event (WAIT jobs)
        self.killed = False
        self.dead = False            # when True, execute_code fails like a
                                     # dead blender (ConnectionLost)
        self.scene = "mock scene summary"

    # -- side-effect helpers (script grammar) --------------------------------
    def _side_effects(self, code):
        """Returns prints captured for the job's own stdout window."""
        prints = []
        for part in code.split("|"):
            tokens = part.split()
            if len(tokens) >= 3 and tokens[0] == "RUN":
                if tokens[2] == "WRITE" and len(tokens) >= 4:
                    # RUN <name> WRITE out/<file> -> write under out/
                    target = os.path.join(self.workdir, *tokens[3:])
                    os.makedirs(os.path.dirname(target), exist_ok=True)
                    with open(target, "a") as f:
                        f.write("data-%s\n" % tokens[1])
                elif tokens[2] == "PRINT" and len(tokens) >= 4:
                    line = "JOB %s: %s\n" % (tokens[1], " ".join(tokens[3:]))
                    with open(os.path.join(self.workdir, "job-output.log"),
                              "a") as f:
                        f.write(line)
                    prints.append(line.strip())
        return prints

    # -- scripting helpers ---------------------------------------------------
    def release_later(self, name, delay_s):
        ev = self.events.setdefault(name, threading.Event())

        def _go():
            time.sleep(delay_s)
            ev.set()
        threading.Thread(target=_go, daemon=True).start()
        return ev

    # -- supervisor API used by server.py -------------------------------------
    def is_alive(self):
        return not self.dead

    def kill(self):
        was_dead = self.dead
        self.killed = True
        self.dead = True
        return not was_dead

    def start(self):
        # "relaunch": production ensure_blender brings up a fresh factory
        # instance; the mock just resurrects a clean process.
        self.dead = False
        return {}

    def stdout_tail(self, max_chars=2000):
        return "mock blender log tail"

    def call(self, cmd_type, params=None, timeout_s=60.0):
        if cmd_type == "get_addon_info":
            if self.dead:
                raise launcher.ConnectionLost("blender process exited")
            return {"status": "success",
                    "result": {"blender_version": "5.2.1-mock"}}
        if cmd_type == "get_scene_info":
            return {"status": "success", "result": self.scene}
        if cmd_type == "execute_code":
            return self._execute(params or {}, timeout_s)
        raise AssertionError("unexpected cmd %r" % cmd_type)

    def _execute(self, params, timeout_s):
        code = params.get("code") or ""
        with self.lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
        try:
            if self.dead:
                raise launcher.ConnectionLost("connection closed by blender")
            # script grammar: "RUN <name> <SLEEP|WAIT> [arg]"
            parts = code.split()
            name = parts[1] if len(parts) > 1 and parts[0] == "RUN" else "job"
            mode = parts[2] if len(parts) > 2 else "SLEEP"
            try:
                arg = float(parts[3]) if len(parts) > 3 else 0.0
            except ValueError:
                arg = 0.0
            if mode == "WAIT":
                ev = self.events.setdefault(name, threading.Event())
                deadline = time.monotonic() + max(timeout_s, 60)
                while True:
                    if ev.is_set():
                        break
                    if self.dead:
                        raise launcher.ConnectionLost(
                            "connection closed by blender")
                    if time.monotonic() >= deadline:
                        raise launcher.ExecutionTimeout("recv timeout")
                    time.sleep(0.01)
            else:  # SLEEP
                deadline = time.monotonic() + timeout_s
                while True:
                    if self.dead:
                        raise launcher.ConnectionLost(
                            "connection closed by blender")
                    elapsed = timeout_s - (deadline - time.monotonic())
                    if elapsed >= arg:
                        break
                    if elapsed >= timeout_s:
                        # mimic the real transport: recv deadline fires first
                        raise launcher.ExecutionTimeout("recv timeout")
                    time.sleep(min(0.01, arg - elapsed))
            self._side_effects(code)
            with self.lock:
                self.completed.append(name)
            return {"status": "success", "result": {"result": "done %s" % name}}
        finally:
            with self.lock:
                self.active -= 1


class HelpersMixin:
    """Shared helpers (submit/script) for all queue test cases."""

    # helpers -----------------------------------------------------------------
    @staticmethod
    def submit(results, idx, script, timeout_ms):
        def run():
            results[idx] = server.handle_execute(script, timeout_ms)
        t = threading.Thread(target=run, daemon=True)
        t.start()
        return t

    @staticmethod
    def script(name, mode="SLEEP", arg="0.05"):
        return "RUN %s %s %s" % (name, mode, arg)

    def wait_completion(self, results, idx, timeout=30):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if results.get(idx) is not None:
                return results[idx]
            time.sleep(0.02)
        raise AssertionError("job %d did not finish in %.0fs" % (idx, timeout))

    def drain(self, timeout=15):
        """Wait until the queue is fully drained (hermetic teardown)."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            with server._QUEUE_CV:
                busy = server._QUEUE["running"] + len(server._QUEUE["waiters"])
            if busy == 0:
                return
            time.sleep(0.02)


class QueueTestBase(HelpersMixin, unittest.TestCase):
    def setUp(self):
        self.sup = FakeSupervisor()
        self.fresh = FakeSupervisor()
        self._orig = (server.ensure_blender, server.CONCURRENCY,
                      server.QUEUE_DEPTH)
        server.ensure_blender = lambda: self.sup
        server._QUEUE.update(waiters=[], running=0, seq=0)

    def tearDown(self):
        self.drain()
        server.ensure_blender, server.CONCURRENCY, server.QUEUE_DEPTH = \
            self._orig
        server._QUEUE.update(waiters=[], running=0, seq=0)

    def ensure_first_then_fresh(self):
        """ensure_blender returns self.sup on its first call, self.fresh on
        every later call (models the production relaunch without races)."""
        calls = []

        def _ensure():
            calls.append(1)
            return self.sup if len(calls) == 1 else self.fresh
        server.ensure_blender = _ensure


class TestFifoAndFields(QueueTestBase):
    def test_fifo_single_slot_no_parallelism(self):
        server.CONCURRENCY, server.QUEUE_DEPTH = 1, 16
        results = {}
        self.submit(results, 0, self.script("A", "SLEEP", "0.30"), 30000)
        time.sleep(0.05)  # A takes the slot
        self.submit(results, 1, self.script("B", "SLEEP", "0.20"), 30000)
        time.sleep(0.05)  # B queues behind A
        self.submit(results, 2, self.script("C", "SLEEP", "0.10"), 30000)

        code0, obj0 = self.wait_completion(results, 0)
        code1, obj1 = self.wait_completion(results, 1)
        code2, obj2 = self.wait_completion(results, 2)

        self.assertEqual((code0, code1, code2), (200, 200, 200))
        # additive fields
        self.assertIs(obj0["queued"], False)
        self.assertEqual(obj0["queue_position"], 0)
        self.assertIs(obj1["queued"], True)
        self.assertEqual(obj1["queue_position"], 1)
        self.assertIs(obj2["queued"], True)
        self.assertEqual(obj2["queue_position"], 2)
        # existing fields intact
        for obj in (obj0, obj1, obj2):
            self.assertTrue(obj["ok"])
            self.assertIn("artifacts", obj)
            self.assertIn("scene_summary", obj)
            self.assertIn("stdout_tail", obj)
            self.assertIn("duration_ms", obj)
        # FIFO completion order, never parallel
        self.assertEqual(self.sup.completed, ["A", "B", "C"])
        self.assertEqual(self.sup.max_active, 1)

    def test_concurrency_two_runs_parallel(self):
        server.CONCURRENCY, server.QUEUE_DEPTH = 2, 16
        results = {}
        self.submit(results, 0, self.script("A", "SLEEP", "0.30"), 30000)
        self.submit(results, 1, self.script("B", "SLEEP", "0.30"), 30000)
        time.sleep(0.1)
        self.assertEqual(self.sup.max_active, 2)  # two slots busy at once
        self.submit(results, 2, self.script("C", "SLEEP", "0.05"), 30000)
        code0, obj0 = self.wait_completion(results, 0)
        code1, obj1 = self.wait_completion(results, 1)
        code2, obj2 = self.wait_completion(results, 2)
        self.assertEqual((code0, code1, code2), (200, 200, 200))
        self.assertIs(obj2["queued"], True)
        self.assertEqual(obj2["queue_position"], 1)
        self.assertEqual(self.sup.max_active, 2)


class TestQueueFull(QueueTestBase):
    def test_overflow_immediate_429(self):
        server.CONCURRENCY, server.QUEUE_DEPTH = 1, 2
        self.sup.release_later("A", 0.6)
        results = {}
        self.submit(results, 0, self.script("A", "WAIT", "A"), 60000)
        time.sleep(0.1)
        self.submit(results, 1, self.script("B"), 60000)
        self.submit(results, 2, self.script("C"), 60000)
        time.sleep(0.1)
        # queue is full: running=1 + waiters=2 -> reject without queuing
        code, obj = server.handle_execute(self.script("D"), 60000)
        self.assertEqual(code, 429)
        self.assertIs(obj["ok"], False)
        self.assertEqual(obj["error"], "queue_full")
        # rejected job left nothing in the queue
        self.assertEqual(server.queue_depth(), 2)
        # drain: release A, B and C complete in order
        for ev in self.sup.events.values():
            ev.set()
        self.wait_completion(results, 0)
        self.wait_completion(results, 1)
        self.wait_completion(results, 2)
        self.assertEqual(self.sup.completed, ["A", "B", "C"])


class TestSelfHealing(QueueTestBase):
    def test_blender_death_500_does_not_block_queue(self):
        server.CONCURRENCY, server.QUEUE_DEPTH = 1, 16
        self.ensure_first_then_fresh()
        results = {}
        self.submit(results, 0, self.script("A", "WAIT", "never"), 60000)
        time.sleep(0.1)
        self.submit(results, 1, self.script("B"), 60000)
        time.sleep(0.1)
        # blender dies mid-job -> running job answers 500, releases the slot
        self.sup.dead = True
        code0, obj0 = self.wait_completion(results, 0)
        self.assertEqual(code0, 500)
        self.assertIs(obj0["ok"], False)
        self.assertIn("blender connection lost", obj0["error"])
        # job B behind the corpse still completes: ensure_blender "relaunches"
        # (self.fresh), mirroring production auto-restart
        code1, obj1 = self.wait_completion(results, 1)
        self.assertEqual(code1, 200)
        self.assertTrue(obj1["ok"])
        self.assertEqual(self.fresh.completed, ["B"])
        # queue fully drained
        self.assertEqual(server.queue_depth(), 0)

    def test_execution_timeout_kills_and_unblocks(self):
        server.CONCURRENCY, server.QUEUE_DEPTH = 1, 16
        self.ensure_first_then_fresh()
        results = {}
        # timeout_ms clamps to MIN_TIMEOUT_MS=1000; the 2s script overruns it
        self.submit(results, 0, self.script("A", "SLEEP", "2.0"), 1000)
        time.sleep(0.05)
        self.submit(results, 1, self.script("B"), 30000)
        code0, obj0 = self.wait_completion(results, 0)
        self.assertEqual(code0, 500)
        self.assertIs(obj0["ok"], False)
        self.assertIn("execution timed out after 1000ms", obj0["error"])
        self.assertTrue(self.sup.killed)  # process group killed
        code1, obj1 = self.wait_completion(results, 1)
        self.assertEqual(code1, 200)
        self.assertTrue(obj1["ok"])
        self.assertEqual(self.fresh.completed, ["B"])  # ran on relaunched sup

    def test_hard_deadline_abandons_queued_job(self):
        server.CONCURRENCY, server.QUEUE_DEPTH = 1, 16
        results = {}
        # A holds the slot until released (timeout_ms=4000 -> hard cap 8s)
        self.submit(results, 0, self.script("A", "WAIT", "A"), 4000)
        time.sleep(0.1)
        # B waits behind A with timeout_ms=500 -> abandoned at ~1s, never run
        self.submit(results, 1, self.script("B"), 500)
        t1 = time.monotonic()
        code1, obj1 = self.wait_completion(results, 1)
        waited = time.monotonic() - t1
        self.assertEqual(code1, 500)
        self.assertIs(obj1["ok"], False)
        self.assertIs(obj1["queued"], True)
        self.assertEqual(obj1["queue_position"], 1)
        self.assertIn("queue hard deadline", obj1["error"])
        self.assertLess(waited, 3.0)  # ~2 x timeout_ms, nowhere near A's cap
        self.assertNotIn("B", self.sup.completed)  # never executed
        # the abandoned job freed its queue slot: C can still queue behind A
        self.submit(results, 2, self.script("C"), 30000)
        self.sup.events["A"].set()
        code0, obj0 = self.wait_completion(results, 0)
        code2, obj2 = self.wait_completion(results, 2)
        self.assertEqual((code0, code2), (200, 200))
        self.assertEqual(self.sup.completed, ["A", "C"])
        self.assertEqual(server.queue_depth(), 0)


class TestHealthAndEnv(HelpersMixin, unittest.TestCase):
    def setUp(self):
        self.sup = FakeSupervisor()
        self._orig = server.ensure_blender
        server.ensure_blender = lambda: self.sup
        server._QUEUE.update(waiters=[], running=0, seq=0)

    def tearDown(self):
        self.drain()
        server.ensure_blender = self._orig
        server._QUEUE.update(waiters=[], running=0, seq=0)

    def test_health_additive_fields(self):
        server.CONCURRENCY, server.QUEUE_DEPTH = 1, 16
        code, obj = server.handle_health()
        self.assertEqual(code, 200)
        self.assertTrue(obj["ok"])
        # existing fields intact
        self.assertEqual(obj["blender_version"], "5.2.1-mock")
        self.assertIn("gpu", obj)
        self.assertIn("workdir", obj)
        # new fields
        self.assertEqual(obj["queue_depth"], 0)
        self.assertEqual(obj["concurrency"], 1)

    def test_health_queue_depth_counts_waiters(self):
        server.CONCURRENCY, server.QUEUE_DEPTH = 1, 16
        results = {}
        self.submit(results, 0, self.script("A", "WAIT", "A"), 60000)
        time.sleep(0.05)
        self.submit(results, 1, self.script("B"), 60000)
        time.sleep(0.05)
        _, obj = server.handle_health()
        self.assertEqual(obj["queue_depth"], 1)  # B waits, A runs
        for ev in self.sup.events.values():
            ev.set()
        self.wait_completion(results, 0)
        self.wait_completion(results, 1)

    def test_env_int_defaults(self):
        cases = [(None, 7, 7), ("garbage", 7, 7), ("0", 7, 1), ("-3", 7, 1),
                 ("4", 7, 4)]
        for raw, default, expected in cases:
            name = "BRIDGE_TEST_ENV_%s" % (raw or "NONE")
            if raw is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = raw
            self.assertEqual(server._env_int(name, default), expected)
            os.environ.pop(name, None)


class TestHttpWiring(HelpersMixin, unittest.TestCase):
    """End-to-end through a real (ephemeral-port) ThreadingHTTPServer."""

    def setUp(self):
        self.sup = FakeSupervisor()
        self._orig = server.ensure_blender
        server.ensure_blender = lambda: self.sup
        server._QUEUE.update(waiters=[], running=0, seq=0)
        server.ThreadingHTTPServer.allow_reuse_address = True
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.drain()
        server.ensure_blender = self._orig
        server._QUEUE.update(waiters=[], running=0, seq=0)
        self.httpd.shutdown()

    def _post(self, path, payload):
        req = urllib.request.Request(
            "http://127.0.0.1:%d%s" % (self.port, path),
            data=json.dumps(payload).encode(), method="POST")
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read().decode())
            finally:
                e.close()

    def _get(self, path):
        with urllib.request.urlopen(
                "http://127.0.0.1:%d%s" % (self.port, path), timeout=30) as r:
            return r.status, json.loads(r.read().decode())

    def test_http_execute_and_health(self):
        server.CONCURRENCY, server.QUEUE_DEPTH = 1, 16
        status, obj = self._get("/v1/health")
        self.assertEqual(status, 200)
        self.assertEqual(obj["queue_depth"], 0)
        self.assertEqual(obj["concurrency"], 1)
        self.assertEqual(obj["blender_version"], "5.2.1-mock")

        status, obj = self._post("/v1/execute", {
            "script": self.script("H", "SLEEP", "0.1"), "timeout_ms": 30000})
        self.assertEqual(status, 200)
        self.assertIs(obj["queued"], False)
        self.assertEqual(obj["queue_position"], 0)
        self.assertEqual(obj["scene_summary"], "mock scene summary")

        status, obj = self._post("/v1/execute", {"script": ""})
        self.assertEqual(status, 400)

    def test_http_queue_full_429(self):
        server.CONCURRENCY, server.QUEUE_DEPTH = 1, 0  # no waiting slots
        self.sup.release_later("A", 0.5)
        results = {}
        self.submit(results, 0, self.script("A", "WAIT", "A"), 60000)
        time.sleep(0.1)
        status, obj = self._post("/v1/execute",
                                 {"script": self.script("B"), "timeout_ms": 30000})
        self.assertEqual(status, 429)
        self.assertIs(obj["ok"], False)
        self.assertEqual(obj["error"], "queue_full")
        for ev in self.sup.events.values():
            ev.set()
        self.wait_completion(results, 0)


class TestArtifactSnapshotDiff(QueueTestBase):
    """scan_artifacts session snapshot diff (replaces the 0.5s mtime
    tolerance that mispicked the previous job's tail files)."""

    def _paths(self, obj):
        return [a["path"] for a in obj["artifacts"]]

    def test_unchanged_files_never_repicked(self):
        server.CONCURRENCY, server.QUEUE_DEPTH = 1, 16
        # residue: a file that exists BEFORE job A runs, with a "stale"
        # mtime well older than 0.5s (the old heuristic repicked it)
        stale = os.path.join(self.sup.workdir, "out", "residue.png")
        with open(stale, "w") as f:
            f.write("old")
        old_ts = time.time() - 3600
        os.utime(stale, (old_ts, old_ts))

        code, obj = server.handle_execute(
            self.script("A", "SLEEP", "0.05"), 30000)
        self.assertEqual(code, 200)
        self.assertEqual(self._paths(obj), [])  # residue not repicked

    def test_new_files_all_picked_and_adjacent_jobs_do_not_cross_pick(self):
        server.CONCURRENCY, server.QUEUE_DEPTH = 1, 16
        # job A writes its tail file; job B starts immediately after and
        # writes a different file — B must report only its own file.
        results = {}
        self.submit(results, 0, "RUN A SLEEP 0.05|RUN A WRITE out/tail_a.png",
                    30000)
        code_a, obj_a = self.wait_completion(results, 0)
        self.assertEqual(code_a, 200)
        self.assertEqual(self._paths(obj_a), ["tail_a.png"])

        self.submit(results, 1, "RUN B SLEEP 0.05|RUN B WRITE out/only_b.png",
                    30000)
        code_b, obj_b = self.wait_completion(results, 1)
        self.assertEqual(code_b, 200)
        # back-to-back: A's tail file (written <0.5s before B started) must
        # NOT appear in B's artifacts
        self.assertEqual(self._paths(obj_b), ["only_b.png"])

    def test_mtime_change_is_picked_with_new_size(self):
        server.CONCURRENCY, server.QUEUE_DEPTH = 1, 16
        target = os.path.join(self.sup.workdir, "out", "seq.png")
        with open(target, "w") as f:
            f.write("v1")
        old_ts = time.time() - 3600
        os.utime(target, (old_ts, old_ts))
        code0, obj0 = server.handle_execute(self.script("A"), 30000)
        self.assertEqual(code0, 200)
        self.assertEqual(self._paths(obj0), [])  # untouched by job A

        # job B rewrites the file (new mtime + new size) -> picked
        code1, obj1 = server.handle_execute(
            "RUN B SLEEP 0.05|RUN B WRITE out/seq.png", 30000)
        self.assertEqual(code1, 200)
        paths = self._paths(obj1)
        self.assertEqual(paths, ["seq.png"])
        art = obj1["artifacts"][0]
        self.assertEqual(art["kind"], "png")
        self.assertGreater(art["bytes"], 0)
        self.assertTrue(os.path.exists(os.path.join(
            self.sup.workdir, "out", art["path"])))


class TestStdoutTailJobScoped(QueueTestBase):
    """stdout_tail composes this job's own output (job-output.log delta)
    plus the script's captured prints; pre-job residue never resurfaces."""

    def test_job_print_lands_in_tail_and_residue_stays_out(self):
        server.CONCURRENCY, server.QUEUE_DEPTH = 1, 16
        # pre-job residue in job-output.log (another job's line)
        with open(os.path.join(self.sup.workdir, "job-output.log"), "a") as f:
            f.write("OTHER JOB residue line\n")

        code, obj = server.handle_execute(
            "RUN A SLEEP 0.05|RUN A PRINT hello-from-A", 30000)
        self.assertEqual(code, 200)
        tail = obj["stdout_tail"]
        self.assertIn("hello-from-A", tail)
        self.assertIn("done A", tail)      # code_out owns the window
        self.assertNotIn("OTHER JOB residue line", tail)

    def test_silent_script_falls_back_to_blender_log(self):
        server.CONCURRENCY, server.QUEUE_DEPTH = 1, 16
        code, obj = server.handle_execute(self.script("A"), 30000)
        self.assertEqual(code, 200)
        # job-output.log has no new bytes for this job -> engine log fallback
        self.assertEqual(obj["stdout_tail"], "mock blender log tail\ndone A")


if __name__ == "__main__":
    unittest.main(verbosity=2)
