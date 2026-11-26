from ..i18n import source_message
import json
import re
import time
from typing import Any

import httpx

from .base import BaseSearchProvider
from ..provider_errors import classify_provider_exception, sanitize_provider_error_message


def _error_payload(exc: Exception, api_key: str = "") -> dict[str, str]:
    error_type, error = classify_provider_exception(exc, additional_secrets=(api_key,))
    return {"error_type": error_type, "error": error}


def _extract_text(result: dict[str, Any]) -> str:
    content = result.get("content") or []
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "\n".join(parts).strip()
    if isinstance(content, str):
        return content.strip()
    return ""


def _parse_markdown_results(text: str) -> list[dict[str, str]]:
    results: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    for line in text.splitlines():
        heading = re.match(r"^###\s+\d+\.\s+(.+?)\s*$", line)
        if heading:
            if current:
                results.append(current)
            current = {"title": heading.group(1).strip(), "url": "", "description": ""}
            continue
        if current is None:
            continue
        url_match = re.match(r"^-\s+\*\*URL\*\*:\s+(\S+)", line)
        if url_match:
            current["url"] = url_match.group(1).strip()
            continue
        if line.strip() and not line.startswith("#") and not line.startswith("- **URL**"):
            description = current.get("description", "")
            current["description"] = (description + " " + line.strip()).strip()
    if current:
        results.append(current)
    if results:
        return results
    urls = re.findall(r"https?://[^\s)>\]]+", text)
    return [{"title": url, "url": url, "description": ""} for url in dict.fromkeys(urls)]


def _split_domain(domain: str, sub_domain: str = "") -> tuple[str, str]:
    if sub_domain or "." not in domain:
        return domain, sub_domain
    parent, child = domain.split(".", 1)
    return parent, child


def _batch_query_object(query: str, max_results: int) -> dict[str, Any]:
    return {"query": query, "max_results": max_results}


def parse_sub_domain_params(
    raw_json: str = "",
    key_values: list[str] | None = None,
) -> dict[str, Any]:
    """Parse `--sub-domain-params JSON` and repeatable `--param key=value`."""
    params: dict[str, Any] = {}
    raw = (raw_json or "").strip()
    if raw:
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError(source_message('invalid --sub-domain-params JSON: {0}', exc)) from exc
        if not isinstance(parsed, dict):
            raise ValueError(source_message('--sub-domain-params must be a JSON object'))
        params.update(parsed)
    for item in key_values or []:
        token = (item or "").strip()
        if not token or "=" not in token:
            raise ValueError(source_message('invalid --param value (expected key=value): {0!r}', item))
        key, value = token.split("=", 1)
        key = key.strip()
        if not key:
            raise ValueError(source_message('invalid --param value (empty key): {0!r}', item))
        params[key] = value
    return params


def _truncate_extract_text_fields(data: dict[str, Any], max_length: int) -> None:
    fields = ("content", "raw_content", "text", "description", "snippet", "body")
    for key in fields:
        value = data.get(key)
        if isinstance(value, str) and len(value) > max_length:
            data[key] = value[:max_length]
    for item in data.get("results") or []:
        if not isinstance(item, dict):
            continue
        for key in fields:
            value = item.get(key)
            if isinstance(value, str) and len(value) > max_length:
                item[key] = value[:max_length]


class AnySearchProvider(BaseSearchProvider):
    def __init__(self, api_url: str, api_key: str | None = None, timeout: float = 30.0):
        super().__init__(api_url.rstrip("/"), api_key or "")
        self.timeout = timeout

    def get_provider_name(self) -> str:
        return "AnySearch"

    async def search(self, query: str, max_results: int = 5) -> str:
        return await self.call_tool("search", {"query": query, "max_results": max_results})

    async def get_sub_domains(self, domain: str = "") -> str:
        if not domain:
            return await self.list_available_domains()
        arguments = {"domain": domain} if domain else {}
        return await self.call_tool("get_sub_domains", arguments)

    async def list_domains(self, domain: str = "") -> str:
        return await self.get_sub_domains(domain)

    async def list_available_domains(self) -> str:
        start = time.time()
        payload = {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        try:
            timeout = httpx.Timeout(connect=6.0, read=self.timeout, write=10.0, pool=None)
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
                response = await client.post(self.api_url, headers=headers, json=payload)
                response.raise_for_status()
                data = response.json()
            output = self._normalize_domain_schema(data, start)
        except Exception as e:
            error = _error_payload(e, self.api_key)
            output = {
                "ok": False,
                "provider": "anysearch",
                "tool": "get_sub_domains",
                "error_type": error["error_type"],
                "error": error["error"],
                "elapsed_ms": round((time.time() - start) * 1000, 2),
            }
        return json.dumps(output, ensure_ascii=False, indent=2)

    async def vertical_search(
        self,
        query: str,
        domain: str = "",
        sub_domain: str = "",
        max_results: int = 5,
        sub_domain_params: dict[str, Any] | None = None,
    ) -> str:
        arguments: dict[str, Any] = {"query": query, "max_results": max_results}
        domain, sub_domain = _split_domain(domain, sub_domain)
        if domain:
            arguments["domain"] = domain
        if sub_domain:
            arguments["sub_domain"] = sub_domain
        if sub_domain_params:
            arguments["sub_domain_params"] = sub_domain_params
        return await self.call_tool("search", arguments)

    async def extract(self, url: str, max_length: int = 20000) -> str:
        # Live extract schema only accepts `url`; truncate locally when requested.
        raw = await self.call_tool("extract", {"url": url})
        if max_length is None or max_length <= 0:
            return raw
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return raw
        if not data.get("ok"):
            return raw
        _truncate_extract_text_fields(data, max_length)
        data["max_length"] = max_length
        return json.dumps(data, ensure_ascii=False, indent=2)

    async def batch_search(self, queries: list[str], max_results: int = 3) -> str:
        if len(queries) > 5:
            return json.dumps(
                {
                    "ok": False,
                    "provider": "anysearch",
                    "tool": "batch_search",
                    "error_type": "parameter_error",
                    "error": source_message('too many queries: {0} (max 5)', len(queries)),
                    "elapsed_ms": 0,
                },
                ensure_ascii=False,
                indent=2,
            )
        return await self.call_tool(
            "batch_search",
            {"queries": [_batch_query_object(query, max_results) for query in queries]},
        )

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> str:
        start = time.time()
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        }
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        try:
            timeout = httpx.Timeout(connect=6.0, read=self.timeout, write=10.0, pool=None)
            async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
                response = await client.post(self.api_url, headers=headers, json=payload)
                response.raise_for_status()
                data = response.json()
            output = self._normalize_response(name, arguments, data, start)
        except Exception as e:
            error = _error_payload(e, self.api_key)
            output = {
                "ok": False,
                "provider": "anysearch",
                "tool": name,
                "error_type": error["error_type"],
                "error": error["error"],
                "elapsed_ms": round((time.time() - start) * 1000, 2),
            }
        return json.dumps(output, ensure_ascii=False, indent=2)

    def _normalize_response(self, name: str, arguments: dict[str, Any], data: dict[str, Any], start: float) -> dict[str, Any]:
        if "error" in data:
            error = data.get("error") or {}
            message = error.get("message") if isinstance(error, dict) else str(error)
            return {
                "ok": False,
                "provider": "anysearch",
                "tool": name,
                "error_type": "provider_error",
                "error": sanitize_provider_error_message(
                    message or "AnySearch JSON-RPC error", additional_secrets=(self.api_key,)
                ),
                "elapsed_ms": round((time.time() - start) * 1000, 2),
            }

        result = data.get("result") or {}
        text = _extract_text(result)
        is_error = bool(result.get("isError"))
        parsed_results = [] if is_error else _parse_markdown_results(text)
        if text and not is_error and not parsed_results:
            parsed_results = [
                {
                    "title": f"{name} structured evidence",
                    "url": "",
                    "description": text[:500],
                    "evidence_type": "structured",
                    "raw_content": text,
                }
            ]
        output: dict[str, Any] = {
            "ok": not is_error,
            "provider": "anysearch",
            "tool": name,
            "content": text,
            "raw_content": text,
            "results": parsed_results,
            "total": len(parsed_results),
            "elapsed_ms": round((time.time() - start) * 1000, 2),
        }
        for key in ("query", "domain", "sub_domain", "url"):
            if arguments.get(key):
                output[key] = arguments[key]
        if isinstance(arguments.get("sub_domain_params"), dict):
            output["sub_domain_params_keys"] = sorted(arguments["sub_domain_params"])
        if is_error:
            safe_error = sanitize_provider_error_message(
                text or "AnySearch tool returned isError=true", additional_secrets=(self.api_key,)
            )
            output["content"] = safe_error
            output["raw_content"] = safe_error
            output["error_type"] = "provider_error"
            output["error"] = safe_error
        return output

    def _normalize_domain_schema(self, data: dict[str, Any], start: float) -> dict[str, Any]:
        if "error" in data:
            error = data.get("error") or {}
            message = error.get("message") if isinstance(error, dict) else str(error)
            return {
                "ok": False,
                "provider": "anysearch",
                "tool": "get_sub_domains",
                "error_type": "provider_error",
                "error": sanitize_provider_error_message(
                    message or "AnySearch JSON-RPC error", additional_secrets=(self.api_key,)
                ),
                "elapsed_ms": round((time.time() - start) * 1000, 2),
            }
        tools = (data.get("result") or {}).get("tools") or []
        schema: dict[str, Any] = {}
        for tool in tools:
            if tool.get("name") == "get_sub_domains":
                schema = tool.get("inputSchema") or {}
                break
        properties = schema.get("properties") or {}
        domain_property = properties.get("domain") or {}
        domains_property = properties.get("domains") or {}
        domain_values = domain_property.get("enum") or ((domains_property.get("items") or {}).get("enum") or [])
        results = [
            {
                "domain": domain,
                "title": domain,
                "url": "",
                "description": f"Run anysearch-domains {domain} to inspect subdomains.",
            }
            for domain in domain_values
        ]
        content = "\n".join(domain_values)
        return {
            "ok": bool(domain_values),
            "provider": "anysearch",
            "tool": "get_sub_domains",
            "content": content,
            "raw_content": content,
            "results": results,
            "total": len(results),
            "elapsed_ms": round((time.time() - start) * 1000, 2),
        }
