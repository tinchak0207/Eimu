"""PixAI 號池核心：YesCaptcha 解題 + PixAI API 客戶端。

已驗證鏈路（2026-07-31 實測）：
- 註冊/登入：YesCaptcha RecaptchaV3TaskProxyless(action=registerOrLogin)
  -> POST /v2/auth/sign-in/email -> 200 created + JWT(7天) 於回應 header `token`
- 每日積分：YesCaptcha TurnstileTaskProxyless(managed sitekey)
  -> POST /v2/claim/pixai-daily-credits (header x-turnstile-token) -> 10000 點
- 生成：GraphQL createGenerationTask(modelVersionId=Haruka v2)
"""
import json
import random
import string
import time
import urllib.error
import urllib.request

RECAPTCHA_KEY = "6Ld_hskiAAAAADfg9HredZvZx8Z_C8FrNJ519Rc6"
RECAPTCHA_ACTION = "registerOrLogin"
TURNSTILE_MANAGED_KEY = "0x4AAAAAABkbsz0wsSnkOIKt"
API_BASE = "https://api.pixai.art"
GRAPHQL_URL = "https://api.pixai.art/graphql"
LOGIN_PAGE = "https://pixai.art/en/login"


class CaptchaError(Exception):
    pass


class PixaiError(Exception):
    def __init__(self, status, code, message):
        self.status = status
        self.code = code
        super().__init__(f"[{status}] {code}: {message}")


class YesCaptcha:
    def __init__(self, client_key, base="https://api.yescaptcha.com"):
        self.client_key = client_key
        self.base = base

    def _post(self, path, payload):
        req = urllib.request.Request(
            self.base + path,
            data=json.dumps(payload).encode(),
            method="POST",
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode())

    def solve(self, task, timeout_sec=120):
        resp = self._post("/createTask", {"clientKey": self.client_key, "task": task})
        task_id = resp.get("taskId")
        if not task_id:
            raise CaptchaError(f"createTask failed: {resp}")
        deadline = time.time() + timeout_sec
        while time.time() < deadline:
            time.sleep(5)
            resp = self._post("/getTaskResult",
                              {"clientKey": self.client_key, "taskId": task_id})
            if resp.get("status") == "ready":
                return resp.get("solution", {})
            if resp.get("errorId"):
                raise CaptchaError(f"task error: {resp}")
        raise CaptchaError("captcha solve timeout")

    def recaptcha_v3(self, website_url=LOGIN_PAGE, action=RECAPTCHA_ACTION):
        task = {
            "type": "RecaptchaV3TaskProxyless",
            "websiteURL": website_url,
            "websiteKey": RECAPTCHA_KEY,
            "pageAction": action,
        }
        sol = self.solve(task)
        return sol.get("gRecaptchaResponse") or sol.get("token")

    def turnstile_managed(self, website_url="https://pixai.art"):
        task = {
            "type": "TurnstileTaskProxyless",
            "websiteURL": website_url,
            "websiteKey": TURNSTILE_MANAGED_KEY,
        }
        sol = self.solve(task)
        return sol.get("token")


def http_json(url, payload=None, headers=None, method=None, timeout=90):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data,
                                 method=method or ("POST" if payload is not None else "GET"))
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    if payload is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode()


def parse_error_body(body):
    try:
        obj = json.loads(body)
        return obj.get("code"), obj.get("message", body[:200])
    except Exception:
        return None, body[:200]


def sign_in_email(recaptcha_token, email, password, user_agent="webstar/5.0"):
    st, hd, body = http_json(
        f"{API_BASE}/v2/auth/sign-in/email",
        {"email": email, "password": password, "recaptchaToken": recaptcha_token},
        {"User-Agent": user_agent, "Origin": "https://pixai.art",
         "Referer": LOGIN_PAGE},
    )
    if st == 200:
        auth_token = hd.get("token") or hd.get("Token")
        obj = json.loads(body)
        return auth_token, obj.get("result"), obj.get("user", {})
    code, msg = parse_error_body(body)
    raise PixaiError(st, code or "UNKNOWN", msg)


def claim_daily(auth_token, turnstile_token, claim_id="pixai-daily-credits"):
    st, hd, body = http_json(
        f"{API_BASE}/v2/claim/{claim_id}",
        {"id": claim_id},
        {"Authorization": f"Bearer {auth_token}", "User-Agent": "webstar/5.0",
         "Origin": "https://pixai.art", "x-turnstile-token": turnstile_token},
    )
    if st == 200:
        return json.loads(body)
    code, msg = parse_error_body(body)
    raise PixaiError(st, code or "UNKNOWN", msg)


def claim_status(auth_token, claim_id="pixai-daily-credits"):
    st, hd, body = http_json(
        f"{API_BASE}/v2/claim/{claim_id}",
        None,
        {"Authorization": f"Bearer {auth_token}", "User-Agent": "webstar/5.0",
         "Origin": "https://pixai.art"},
        method="GET",
    )
    if st == 200:
        return json.loads(body)
    code, msg = parse_error_body(body)
    raise PixaiError(st, code or "UNKNOWN", msg)


def generate(auth_token, version_id, prompt, negative_prompt,
             width=768, height=1024, steps=20, cfg=7,
             sampler="DPM++ 2M Karras", seed=0, batch=1):
    mutation = (
        "mutation createGenerationTask($parameters: JSONObject!) "
        "{createGenerationTask(parameters: $parameters) {id status}}"
    )
    params = {
        "prompts": prompt,
        "negativePrompts": negative_prompt,
        "samplingSteps": steps,
        "samplingMethod": sampler,
        "cfgScale": cfg,
        "autoPublish": False,
        "priority": 1000,
        "width": width,
        "height": height,
        "clipSkip": 2,
        "modelVersionId": str(version_id),
        "controlNets": [],
        "extra": {},
        "quantity": batch,
    }
    st, hd, body = http_json(
        GRAPHQL_URL,
        {"query": mutation, "variables": {"parameters": params}},
        {"Authorization": f"Bearer {auth_token}", "User-Agent": "webstar/5.0",
         "Origin": "https://pixai.art"},
    )
    obj = json.loads(body)
    if obj.get("errors"):
        err = obj["errors"][0]
        raise PixaiError(st, err.get("extensions", {}).get("code") or "GRAPHQL",
                         err.get("message", body[:200]))
    return obj.get("data", {}).get("createGenerationTask")


def task_image_url(auth_token, task_id):
    q = {"query": "query getTaskById($id: ID!) {task(id: $id) {id status media {urls {variant url}}}}",
         "variables": {"id": task_id}}
    st, hd, body = http_json(
        GRAPHQL_URL, q,
        {"Authorization": f"Bearer {auth_token}", "User-Agent": "webstar/5.0",
         "Origin": "https://pixai.art"},
    )
    obj = json.loads(body)
    task = obj.get("data", {}).get("task", {}) or {}
    urls = {}
    for u in (task.get("media") or {}).get("urls") or []:
        urls[u.get("variant")] = u.get("url")
    return task.get("status"), urls


def gen_password(length=14):
    alphabet = string.ascii_letters + string.digits + "!@#"
    return "".join(random.choices(alphabet, k=length))


def gen_email(domain="outlook.com", prefix_len=10):
    rnd = "".join(random.choices(string.ascii_lowercase + string.digits, k=prefix_len))
    return f"pix{rnd}@{domain}"
