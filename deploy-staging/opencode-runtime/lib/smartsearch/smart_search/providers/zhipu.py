from ..i18n import source_message
import json
import time
from typing import Any

import httpx
from tenacity import AsyncRetrying, retry_if_exception, stop_after_attempt, wait_random_exponential

from .base import BaseSearchProvider
from ..config import config
from ..logger import log_info
from ..provider_errors import ProviderCallError, classify_provider_exception, sanitize_provider_error_message


RETRYABLE_STATUS_CODES = {408, 500, 502, 503, 504}
# Zhipu reports several failures inside an HTTP 200 body, so the payload has to
# be classified as well; otherwise a dead key looks like an empty result set.
AUTH_ERROR_CODES = {"1000", "1001", "1002", "1003", "1004", "1110", "401"}
RATE_LIMITED_ERROR_CODES = {"1113", "1301", "1302", "1303", "1304", "1305", "429"}
AUTH_ERROR_KEYWORDS = ("api key", "apikey", "token", "鉴权", "认证", "未授权", "unauthorized", "invalid key")
RATE_LIMITED_ERROR_KEYWORDS = ("余额", "欠费", "quota", "rate limit", "限流", "频率", "并发", "too many requests")


def _is_retryable_exception(exc) -> bool:
    if isinstance(exc, (httpx.TimeoutException, httpx.NetworkError, httpx.ConnectError)):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code in RETRYABLE_STATUS_CODES
    return False


def _normalize_result(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "title": item.get("title") or "",
        "url": item.get("link") or item.get("url") or "",
        "description": item.get("content") or "",
        "provider": "zhipu",
        "source": item.get("media") or "",
        "published_date": item.get("publish_date") or "",
        "icon": item.get("icon") or "",
        "refer": item.get("refer") or "",
    }


def _classify_payload_error(code: str, message: str) -> str:
    normalized_code = str(code or "").strip()
    lowered = (message or "").lower()
    if normalized_code in AUTH_ERROR_CODES or any(keyword in lowered for keyword in AUTH_ERROR_KEYWORDS):
        return "auth_error"
    if normalized_code in RATE_LIMITED_ERROR_CODES or any(keyword in lowered for keyword in RATE_LIMITED_ERROR_KEYWORDS):
        return "rate_limited"
    return "provider_error"


def _raise_for_payload_error(data: dict[str, Any], api_key: str = "") -> None:
    """Raise when Zhipu reports a failure inside an HTTP 200 response body."""
    error = data.get("error")
    if isinstance(error, dict):
        code = str(error.get("code") or "")
        message = str(error.get("message") or error.get("msg") or "")
    elif isinstance(error, str) and error:
        code = str(data.get("code") or "")
        message = error
    elif data.get("code") not in (None, 0, "0", 200, "200") and "search_result" not in data:
        code = str(data.get("code") or "")
        message = str(data.get("message") or data.get("msg") or "")
    else:
        return
    detail = sanitize_provider_error_message(message or "Zhipu reported a request failure", additional_secrets=(api_key,))
    raise ProviderCallError(
        _classify_payload_error(code, message),
        source_message('Zhipu error {0}: {1}', code, detail) if code else detail,
        additional_secrets=(api_key,),
    )


def _error_payload(exc: Exception, api_key: str = "") -> dict[str, Any]:
    error_type, error = classify_provider_exception(exc, additional_secrets=(api_key,))
    return {"error_type": error_type, "error": error}


class ZhipuWebSearchProvider(BaseSearchProvider):
    def __init__(
        self,
        api_url: str,
        api_key: str,
        search_engine: str = "search_std",
        timeout: float = 30.0,
    ):
        super().__init__(api_url.rstrip("/"), api_key)
        self.search_engine = search_engine
        self.timeout = timeout

    def get_provider_name(self) -> str:
        return "Zhipu Web Search"

    async def search(
        self,
        query: str,
        count: int = 10,
        search_engine: str | None = None,
        search_intent: bool = True,
        search_domain_filter: str = "",
        search_recency_filter: str = "noLimit",
        content_size: str = "medium",
        user_id: str = "",
        ctx=None,
    ) -> str:
        endpoint = f"{self.api_url}/paas/v4/web_search"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
        payload: dict[str, Any] = {
            "search_query": query[:70],
            "search_engine": search_engine or self.search_engine,
            "search_intent": search_intent,
            "count": count,
            "search_recency_filter": search_recency_filter,
            "content_size": content_size,
        }
        if search_domain_filter:
            payload["search_domain_filter"] = search_domain_filter
        if user_id:
            payload["user_id"] = user_id

        await log_info(ctx, f"Zhipu search: {query}", config.debug_enabled)
        start_time = time.time()
        try:
            data = await self._request_with_retry(endpoint, headers, payload)
            _raise_for_payload_error(data, self.api_key)
            elapsed_ms = round((time.time() - start_time) * 1000, 2)
            results = [_normalize_result(item) for item in data.get("search_result", []) or []]
            output = {
                "ok": True,
                "query": query,
                "provider": "zhipu",
                "search_engine": payload["search_engine"],
                "results": results,
                "total": len(results),
                "search_intent": data.get("search_intent", []),
                "request_id": data.get("request_id", ""),
                "elapsed_ms": elapsed_ms,
            }
        except Exception as e:
            elapsed_ms = round((time.time() - start_time) * 1000, 2)
            error = _error_payload(e, self.api_key)
            output = {
                "ok": False,
                "query": query,
                "provider": "zhipu",
                "error_type": error["error_type"],
                "error": error["error"],
                "elapsed_ms": elapsed_ms,
            }
        return json.dumps(output, ensure_ascii=False, indent=2)

    async def _request_with_retry(self, endpoint: str, headers: dict, payload: dict) -> dict[str, Any]:
        timeout = httpx.Timeout(connect=6.0, read=self.timeout, write=10.0, pool=None)
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            async for attempt in AsyncRetrying(
                stop=stop_after_attempt(config.retry_max_attempts + 1),
                wait=wait_random_exponential(multiplier=config.retry_multiplier, max=config.retry_max_wait),
                retry=retry_if_exception(_is_retryable_exception),
                reraise=True,
            ):
                with attempt:
                    response = await client.post(endpoint, headers=headers, json=payload)
                    response.raise_for_status()
                    return response.json()
        return {}
