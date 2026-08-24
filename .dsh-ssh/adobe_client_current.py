import base64
import hashlib
import json
import logging
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import quote, urlparse

import requests

from core.config_mgr import config_manager
from core.models import build_image_payload_candidates

try:
    from curl_cffi.requests import Session as CurlSession
except Exception:
    CurlSession = None


logger = logging.getLogger("adobe2api")


def _decode_jwt_payload(token: str) -> dict[str, Any]:
    raw_token = str(token or "").strip()
    if not raw_token:
        return {}
    parts = raw_token.split(".")
    if len(parts) < 2:
        return {}

    payload_part = parts[1].strip()
    if not payload_part:
        return {}

    padding = (-len(payload_part)) % 4
    if padding:
        payload_part += "=" * padding

    try:
        decoded = base64.urlsafe_b64decode(payload_part.encode("ascii"))
        payload = json.loads(decoded.decode("utf-8"))
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def _build_submit_nonce(token: str, prompt: str) -> str:
    claims = _decode_jwt_payload(token)
    user_id = str(
        claims.get("user_id")
        or claims.get("aa_id")
        or claims.get("sub")
        or ""
    ).strip()
    prompt_prefix = str(prompt or "")[:256]
    if not user_id or not prompt_prefix:
        return ""
    nonce_input = f"{user_id}-{prompt_prefix}".encode("utf-8")
    return hashlib.sha256(nonce_input).hexdigest()


class AdobeRequestError(Exception):
    def __init__(
        self,
        message: str,
        *,
        status_code: Optional[int] = None,
        error_type: str = "",
        user_message: str = "",
    ):
        super().__init__(message)
        self.status_code = status_code
        self.error_type = str(error_type or "").strip().lower()
        self.user_message = (
            str(user_message or "").strip() or str(message or "").strip()
        )


class QuotaExhaustedError(AdobeRequestError):
    pass


class AuthError(AdobeRequestError):
    pass


class UpstreamTemporaryError(AdobeRequestError):
    def __init__(
        self,
        message: str,
        status_code: Optional[int] = None,
        error_type: str = "",
    ):
        super().__init__(message)
        self.status_code = status_code
        self.error_type = str(error_type or "").strip().lower()


class AdobeClient:
    submit_url = "https://firefly-3p.ff.adobe.io/v2/3p-images/generate-async"
    firefly_image5_submit_url = "https://image-v5.ff.adobe.io/v1/images/generate-async"
    video_submit_url = "https://firefly-3p.ff.adobe.io/v2/3p-videos/generate-async"
    ugs_video_submit_url = "https://firefly-3p.ff.adobe.io/v2/videos/generate"
    firefly_video_submit_url = "https://video-v1.ff.adobe.io/v2/videos/generate"
    upload_url = "https://firefly-3p.ff.adobe.io/v2/storage/image"
    entity_api_base = "https://firefly-entity.adobe.io/api/entities/"
    platform_cs_index_url = "https://platform-cs-edge.adobe.io/index"
    platform_cs_base = "https://platform-cs-va6.adobe.io/composite/component/path"

    def __init__(self) -> None:
        self.api_key = "clio-playground-web"
        self.impersonate = "chrome145"
        self.proxy = ""
        self.generate_timeout = 300
        self.retry_enabled = True
        self.retry_max_attempts = 3
        self.retry_backoff_seconds = 1.0
        self.retry_on_status_codes = [429, 451, 500, 502, 503, 504]
        self.retry_on_error_types = {"timeout", "connection", "proxy"}
        self.token_rotation_strategy = "round_robin"
        self.gpt_image_quality = "medium"
        self.user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
        self.sec_ch_ua = (
            '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"'
        )
        self._session_local = threading.local()

        self.apply_config(config_manager.get_all())

        env_api_key = os.getenv("ADOBE_API_KEY")
        env_impersonate = os.getenv("ADOBE_IMPERSONATE")
        env_proxy = os.getenv("ADOBE_PROXY")
        env_user_agent = os.getenv("ADOBE_USER_AGENT")
        env_sec_ch_ua = os.getenv("ADOBE_SEC_CH_UA")
        env_generate_timeout = os.getenv("ADOBE_GENERATE_TIMEOUT")

        if env_api_key:
            self.api_key = env_api_key.strip() or self.api_key
        if env_impersonate:
            self.impersonate = env_impersonate.strip() or self.impersonate
        if env_proxy is not None:
            self.proxy = env_proxy.strip()
        if env_user_agent:
            self.user_agent = env_user_agent.strip() or self.user_agent
        if env_sec_ch_ua:
            self.sec_ch_ua = env_sec_ch_ua.strip() or self.sec_ch_ua
        if env_generate_timeout:
            try:
                self.generate_timeout = int(env_generate_timeout)
                if self.generate_timeout <= 0:
                    self.generate_timeout = 300
            except Exception:
                pass

    def apply_config(self, cfg: dict) -> None:
        proxy = str(cfg.get("proxy", "")).strip()
        use_proxy = bool(cfg.get("use_proxy", False))
        timeout_val = cfg.get("generate_timeout", 300)
        try:
            timeout_val = int(timeout_val)
        except Exception:
            timeout_val = 300
        self.generate_timeout = timeout_val if timeout_val > 0 else 300
        self.proxy = proxy if use_proxy and proxy else ""
        self.retry_enabled = bool(cfg.get("retry_enabled", True))
        gpt_quality = str(cfg.get("gpt_image_quality", "medium") or "medium").strip().lower()
        if gpt_quality not in {"low", "medium", "high"}:
            gpt_quality = "medium"
        self.gpt_image_quality = gpt_quality
        try:
            attempts = int(cfg.get("retry_max_attempts", 3))
        except Exception:
            attempts = 3
        self.retry_max_attempts = max(1, min(attempts, 10))

        try:
            backoff = float(cfg.get("retry_backoff_seconds", 1.0))
        except Exception:
            backoff = 1.0
        self.retry_backoff_seconds = max(0.0, min(backoff, 30.0))

        status_codes_raw = cfg.get(
            "retry_on_status_codes", [429, 451, 500, 502, 503, 504]
        )
        parsed_status_codes: list[int] = []
        if isinstance(status_codes_raw, list):
            for item in status_codes_raw:
                try:
                    val = int(item)
                except Exception:
                    continue
                if 100 <= val <= 599:
                    parsed_status_codes.append(val)
        self.retry_on_status_codes = sorted(set(parsed_status_codes)) or [
            429,
            451,
            500,
            502,
            503,
            504,
        ]

        error_types_raw = cfg.get(
            "retry_on_error_types", ["timeout", "connection", "proxy"]
        )
        parsed_error_types: set[str] = set()
        if isinstance(error_types_raw, list):
            for item in error_types_raw:
                txt = str(item or "").strip().lower()
                if txt:
                    parsed_error_types.add(txt)
        self.retry_on_error_types = parsed_error_types or {
            "timeout",
            "connection",
            "proxy",
        }

        strategy = (
            str(cfg.get("token_rotation_strategy", "round_robin") or "round_robin")
            .strip()
            .lower()
        )
        if strategy not in {"round_robin", "random"}:
            strategy = "round_robin"
        self.token_rotation_strategy = strategy
        if self.proxy:
            logger.warning("proxy enabled for upstream requests: %s", self.proxy)
        else:
            logger.warning("proxy disabled for upstream requests")

    def _retry_delay_for_attempt(self, attempt: int) -> float:
        import random
        base = float(self.retry_backoff_seconds or 0.0)
        if base <= 0:
            return 0.0
        safe_attempt = max(1, int(attempt))
        jitter = random.uniform(0.0, 2.0)
        return min(10.0, base * (2 ** (safe_attempt - 1))) + jitter

    def should_retry_temporary_error(self, exc: UpstreamTemporaryError) -> bool:
        if not self.retry_enabled:
            return False
        if isinstance(exc, UpstreamTemporaryError):
            if exc.status_code is not None:
                try:
                    return int(exc.status_code) in set(self.retry_on_status_codes)
                except Exception:
                    return False
            if exc.error_type:
                return exc.error_type in set(self.retry_on_error_types)
        return False

    @staticmethod
    def _classify_network_error_type(exc: Exception) -> str:
        text = str(exc or "").strip().lower()
        if "timed out" in text or "timeout" in text:
            return "timeout"
        if "proxy" in text:
            return "proxy"
        if (
            "connection" in text
            or "dns" in text
            or "resolve" in text
            or "refused" in text
            or "reset" in text
            or "unreachable" in text
        ):
            return "connection"
        return "network"

    def _requests_proxies(self) -> Optional[dict]:
        if not self.proxy:
            return None
        return {"http": self.proxy, "https": self.proxy}

    def _session(self):
        if CurlSession is None:
            return None
        signature = (self.impersonate, self.proxy)
        session = getattr(self._session_local, "curl", None)
        session_closed = bool(getattr(session, "_closed", False)) if session is not None else False
        if (
            session is not None
            and not session_closed
            and getattr(self._session_local, "curl_signature", None) == signature
        ):
            return session
        if session is not None:
            try:
                session.close()
            except Exception:
                logger.debug("failed to close stale curl session", exc_info=True)
        kwargs = {"impersonate": self.impersonate, "timeout": 60}
        if self.proxy:
            kwargs["proxies"] = {"http": self.proxy, "https": self.proxy}
        session = CurlSession(**kwargs)
        self._session_local.curl = session
        self._session_local.curl_signature = signature
        return session

    def _requests_session(self) -> requests.Session:
        signature = self.proxy
        session = getattr(self._session_local, "requests", None)
        if session is not None and getattr(self._session_local, "requests_signature", None) == signature:
            return session
        if session is not None:
            session.close()
        session = requests.Session()
        if self.proxy:
            session.proxies.update(self._requests_proxies() or {})
        self._session_local.requests = session
        self._session_local.requests_signature = signature
        return session

    @staticmethod
    def _poll_delay(elapsed_seconds: float) -> float:
        if elapsed_seconds < 10.0:
            return 0.75
        if elapsed_seconds < 30.0:
            return 1.0
        return 1.5

    def _browser_headers(self) -> dict:
        return {
            "origin": "https://firefly.adobe.com",
            "referer": "https://firefly.adobe.com/",
            "accept-language": "en-US,en;q=0.9",
            "sec-fetch-site": "same-site",
            "sec-fetch-mode": "cors",
            "sec-fetch-dest": "empty",
        }

    @staticmethod
    def _add_arp_session_header(headers: dict, arp_session_id: Optional[str]) -> dict:
        session_id = str(arp_session_id or "").strip()
        if session_id:
            headers["x-arp-session-id"] = session_id
        return headers

    def _submit_headers(
        self,
        token: str,
        prompt: str = "",
        arp_session_id: Optional[str] = None,
    ) -> dict:
        headers = self._browser_headers()
        headers.update(
            {
                "Authorization": f"Bearer {token}",
                "x-api-key": self.api_key,
                "content-type": "application/json",
                "accept": "*/*",
            }
        )
        submit_nonce = _build_submit_nonce(token, prompt)
        if submit_nonce:
            headers["x-nonce"] = submit_nonce
        return self._add_arp_session_header(headers, arp_session_id)

    def _submit_headers_minimal(self, token: str) -> dict:
        return {
            "Authorization": f"Bearer {token}",
            "x-api-key": self.api_key,
            "content-type": "application/json",
            "accept": "*/*",
        }

    def _video_submit_headers(
        self, token: str, arp_session_id: Optional[str] = None
    ) -> dict:
        headers = self._browser_headers()
        headers.update(
            {
                "Authorization": f"Bearer {token}",
                "x-api-key": self.api_key,
                "content-type": "application/json",
                "accept": "*/*",
            }
        )
        return self._add_arp_session_header(headers, arp_session_id)

    def _poll_headers(self, token: str) -> dict:
        return {
            "Authorization": f"Bearer {token}",
            "accept": "*/*",
            "referer": "https://firefly.adobe.com/",
            "origin": "https://firefly.adobe.com",
        }

    def _entity_headers(self, token: str) -> dict:
        return {
            "Authorization": f"Bearer {token}",
            "x-api-key": self.api_key,
            "content-type": "application/json",
            "accept": "application/json",
        }

    def _post_json(self, url: str, headers: dict, payload: dict):
        session = self._session()
        if session is None:
            try:
                return self._requests_session().post(
                    url,
                    headers=headers,
                    json=payload,
                    timeout=60,
                    proxies=self._requests_proxies(),
                )
            except requests.Timeout as exc:
                raise UpstreamTemporaryError(
                    f"upstream timeout: {exc}", error_type="timeout"
                )
            except requests.ProxyError as exc:
                raise UpstreamTemporaryError(
                    f"upstream proxy error: {exc}", error_type="proxy"
                )
            except requests.ConnectionError as exc:
                raise UpstreamTemporaryError(
                    f"upstream connection error: {exc}", error_type="connection"
                )
            except requests.RequestException as exc:
                raise UpstreamTemporaryError(
                    f"upstream request error: {exc}", error_type="network"
                )
        try:
            resp = session.post(url, headers=headers, json=payload)
        except Exception as exc:
            raise UpstreamTemporaryError(
                f"upstream session error: {exc}",
                error_type=self._classify_network_error_type(exc),
            )
        if resp.status_code == 451:
            try:
                return self._requests_session().post(
                    url,
                    headers=headers,
                    json=payload,
                    timeout=60,
                    proxies=self._requests_proxies(),
                )
            except requests.Timeout as exc:
                raise UpstreamTemporaryError(
                    f"upstream timeout: {exc}", status_code=451, error_type="timeout"
                )
            except requests.ProxyError as exc:
                raise UpstreamTemporaryError(
                    f"upstream proxy error: {exc}", status_code=451, error_type="proxy"
                )
            except requests.ConnectionError as exc:
                raise UpstreamTemporaryError(
                    f"upstream connection error: {exc}",
                    status_code=451,
                    error_type="connection",
                )
            except requests.RequestException as exc:
                raise UpstreamTemporaryError(
                    f"upstream request error: {exc}",
                    status_code=451,
                    error_type="network",
                )
        return resp

    def _post_bytes(self, url: str, headers: dict, payload: bytes):
        session = self._session()
        if session is None:
            try:
                return self._requests_session().post(
                    url,
                    headers=headers,
                    data=payload,
                    timeout=60,
                    proxies=self._requests_proxies(),
                )
            except requests.Timeout as exc:
                raise UpstreamTemporaryError(
                    f"upstream timeout: {exc}", error_type="timeout"
                )
            except requests.ProxyError as exc:
                raise UpstreamTemporaryError(
                    f"upstream proxy error: {exc}", error_type="proxy"
                )
            except requests.ConnectionError as exc:
                raise UpstreamTemporaryError(
                    f"upstream connection error: {exc}", error_type="connection"
                )
            except requests.RequestException as exc:
                raise UpstreamTemporaryError(
                    f"upstream request error: {exc}", error_type="network"
                )
        try:
            resp = session.post(url, headers=headers, data=payload)
        except Exception as exc:
            raise UpstreamTemporaryError(
                f"upstream session error: {exc}",
                error_type=self._classify_network_error_type(exc),
            )
        return resp

    def _put_bytes(self, url: str, headers: dict, payload: bytes):
        session = self._session()
        if session is None:
            try:
                return self._requests_session().put(
                    url,
                    headers=headers,
                    data=payload,
                    timeout=60,
                    proxies=self._requests_proxies(),
                )
            except requests.Timeout as exc:
                raise UpstreamTemporaryError(
                    f"upstream timeout: {exc}", error_type="timeout"
                )
            except requests.ProxyError as exc:
                raise UpstreamTemporaryError(
                    f"upstream proxy error: {exc}", error_type="proxy"
                )
            except requests.ConnectionError as exc:
                raise UpstreamTemporaryError(
                    f"upstream connection error: {exc}", error_type="connection"
                )
            except requests.RequestException as exc:
                raise UpstreamTemporaryError(
                    f"upstream request error: {exc}", error_type="network"
                )
        try:
            resp = session.put(url, headers=headers, data=payload)
        except Exception as exc:
            raise UpstreamTemporaryError(
                f"upstream session error: {exc}",
                error_type=self._classify_network_error_type(exc),
            )
        return resp

    def _get(self, url: str, headers: dict, timeout: int = 60):
        session = self._session()
        if session is None:
            try:
                return self._requests_session().get(
                    url,
                    headers=headers,
                    timeout=timeout,
                    proxies=self._requests_proxies(),
                )
            except requests.Timeout as exc:
                raise UpstreamTemporaryError(
                    f"upstream timeout: {exc}", error_type="timeout"
                )
            except requests.ProxyError as exc:
                raise UpstreamTemporaryError(
                    f"upstream proxy error: {exc}", error_type="proxy"
                )
            except requests.ConnectionError as exc:
                raise UpstreamTemporaryError(
                    f"upstream connection error: {exc}", error_type="connection"
                )
            except requests.RequestException as exc:
                raise UpstreamTemporaryError(
                    f"upstream request error: {exc}", error_type="network"
                )
        try:
            resp = session.get(url, headers=headers)
        except Exception as exc:
            raise UpstreamTemporaryError(
                f"upstream session error: {exc}",
                error_type=self._classify_network_error_type(exc),
            )
        return resp

    def _delete(self, url: str, headers: dict, timeout: int = 60):
        session = self._session()
        if session is None:
            try:
                return self._requests_session().delete(
                    url,
                    headers=headers,
                    timeout=timeout,
                    proxies=self._requests_proxies(),
                )
            except requests.Timeout as exc:
                raise UpstreamTemporaryError(
                    f"upstream timeout: {exc}", error_type="timeout"
                )
            except requests.ProxyError as exc:
                raise UpstreamTemporaryError(
                    f"upstream proxy error: {exc}", error_type="proxy"
                )
            except requests.ConnectionError as exc:
                raise UpstreamTemporaryError(
                    f"upstream connection error: {exc}", error_type="connection"
                )
            except requests.RequestException as exc:
                raise UpstreamTemporaryError(
                    f"upstream request error: {exc}", error_type="network"
                )
        try:
            resp = session.delete(url, headers=headers)
        except Exception as exc:
            raise UpstreamTemporaryError(
                f"upstream session error: {exc}",
                error_type=self._classify_network_error_type(exc),
            )
        return resp

    def _get_json(self, url: str, headers: dict, timeout: int = 60) -> Any:
        resp = self._get(url, headers=headers, timeout=timeout)
        if resp.status_code in (401, 403):
            raise AuthError("Token invalid or expired")
        if resp.status_code != 200:
            if resp.status_code in (408, 429, 451) or resp.status_code >= 500:
                raise UpstreamTemporaryError(
                    f"upstream get failed: {resp.status_code} {resp.text[:300]}",
                    status_code=resp.status_code,
                    error_type="status",
                )
            raise AdobeRequestError(
                f"upstream get failed: {resp.status_code} {resp.text[:300]}"
            )
        try:
            return resp.json()
        except Exception:
            raise AdobeRequestError("upstream get failed: invalid response")

    def _download_to_file(
        self,
        url: str,
        headers: Optional[dict],
        out_path: Path,
        timeout: int = 60,
        chunk_size: int = 1024 * 1024,
    ) -> int:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        total = 0
        try:
            with self._requests_session().get(
                url,
                headers=headers or {},
                timeout=timeout,
                proxies=self._requests_proxies(),
                stream=True,
            ) as resp:
                resp.raise_for_status()
                with out_path.open("wb") as f:
                    for chunk in resp.iter_content(chunk_size=chunk_size):
                        if not chunk:
                            continue
                        f.write(chunk)
                        total += len(chunk)
        except requests.Timeout as exc:
            raise UpstreamTemporaryError(f"upstream timeout: {exc}", error_type="timeout")
        except requests.ProxyError as exc:
            raise UpstreamTemporaryError(
                f"upstream proxy error: {exc}", error_type="proxy"
            )
        except requests.ConnectionError as exc:
            raise UpstreamTemporaryError(
                f"upstream connection error: {exc}", error_type="connection"
            )
        except requests.RequestException as exc:
            raise UpstreamTemporaryError(f"upstream request error: {exc}", error_type="network")
        return total

    def upload_image(
        self,
        token: str,
        image_bytes: bytes,
        mime_type: str = "image/jpeg",
        arp_session_id: Optional[str] = None,
    ) -> str:
        if not image_bytes:
            raise AdobeRequestError("image is empty")

        headers = {
            "authorization": f"Bearer {token}",
            "x-api-key": self.api_key,
            "content-type": mime_type,
            "accept": "application/json",
        }
        self._add_arp_session_header(headers, arp_session_id)
        resp = self._post_bytes(self.upload_url, headers=headers, payload=image_bytes)

        if resp.status_code in (401, 403):
            raise AuthError("Token invalid or expired")
        if resp.status_code != 200:
            if resp.status_code in (408, 429, 451) or resp.status_code >= 500:
                raise UpstreamTemporaryError(
                    f"upload image failed: {resp.status_code} {resp.text[:300]}",
                    status_code=resp.status_code,
                    error_type="status",
                )
            raise AdobeRequestError(
                f"upload image failed: {resp.status_code} {resp.text[:300]}"
            )

        try:
            data = resp.json()
        except Exception:
            raise AdobeRequestError("upload image failed: invalid response")

        image_id = (((data.get("images") or [{}])[0]) or {}).get("id")
        if not image_id:
            raise AdobeRequestError("upload image succeeded but no image id returned")
        return str(image_id)

    @staticmethod
    def _json_or_empty(resp) -> Any:
        if not str(getattr(resp, "text", "") or "").strip():
            return {}
        try:
            return resp.json()
        except Exception:
            return {}

    @staticmethod
    def _entity_urn_from_data(data: Any) -> str:
        if isinstance(data, dict):
            for key in ("id", "urn", "entityId", "entityUrn"):
                val = str(data.get(key) or "").strip()
                if val:
                    return val
            entity = data.get("entity")
            if isinstance(entity, dict):
                return AdobeClient._entity_urn_from_data(entity)
        return ""

    def create_entity(
        self,
        token: str,
        display_name: str,
        entity_type: str = "character",
        description: str = "",
    ) -> dict:
        name = str(display_name or "").strip()
        if not name:
            raise AdobeRequestError("entity displayName is required")
        payload = {
            "entityType": str(entity_type or "character").strip() or "character",
            "entityValue": {
                "displayName": name,
                "description": str(description or ""),
                "metaAttrs": None,
            },
        }
        resp = self._post_json(self.entity_api_base, self._entity_headers(token), payload)
        if resp.status_code in (401, 403):
            raise AuthError("Token invalid or expired")
        if resp.status_code not in (200, 201):
            if resp.status_code in (408, 429, 451) or resp.status_code >= 500:
                raise UpstreamTemporaryError(
                    f"create entity failed: {resp.status_code} {resp.text[:300]}",
                    status_code=resp.status_code,
                    error_type="status",
                )
            raise AdobeRequestError(
                f"create entity failed: {resp.status_code} {resp.text[:300]}"
            )
        data = self._json_or_empty(resp)
        if isinstance(data, dict):
            urn = self._entity_urn_from_data(data)
            if urn and "id" not in data:
                data = {**data, "id": urn}
            return data
        return {}

    def upload_entity_image(
        self,
        token: str,
        repo_urn: str,
        entity_name: str,
        image_bytes: bytes,
        mime_type: str = "image/png",
        component_upload_href: Optional[str] = None,
    ) -> dict:
        if not image_bytes:
            raise AdobeRequestError("entity image is empty")
        repo = str(repo_urn or "").strip()
        name = str(entity_name or "").strip()
        if not repo:
            raise AdobeRequestError("Adobe repository is required for entity image upload")
        if not name:
            raise AdobeRequestError("entity name is required for entity image upload")
        component_id = str(uuid.uuid4())
        upload_href = str(component_upload_href or "").strip()
        if upload_href:
            url = upload_href.split("{", 1)[0]
            separator = "&" if "?" in url else "?"
            url = f"{url}{separator}component_id={component_id}"
        else:
            url = (
                f"{self.platform_cs_base}/{quote(repo, safe='')}/"
                f"appassets/firefly/entities/{quote(name, safe='')}?component_id={component_id}"
            )
        headers = {
            "Authorization": f"Bearer {token}",
            "x-api-key": self.api_key,
            "content-type": mime_type,
            "accept": "application/json",
        }
        resp = self._put_bytes(url, headers=headers, payload=image_bytes)
        if resp.status_code in (401, 403):
            raise AuthError("Token invalid or expired")
        if resp.status_code not in (200, 201):
            if resp.status_code in (408, 429, 451) or resp.status_code >= 500:
                raise UpstreamTemporaryError(
                    f"upload entity image failed: {resp.status_code} {resp.text[:300]}",
                    status_code=resp.status_code,
                    error_type="status",
                )
            raise AdobeRequestError(
                f"upload entity image failed: {resp.status_code} {resp.text[:300]}"
            )

        def header_val(*names: str) -> str:
            for name_key in names:
                val = str(resp.headers.get(name_key) or "").strip()
                if val:
                    return val
            return ""

        length_raw = header_val("resource-length", "content-length")
        try:
            length = int(length_raw)
        except Exception:
            length = len(image_bytes)
        return {
            "component_id": component_id,
            "etag": header_val("etag"),
            "version": header_val("revision", "x-revision"),
            "md5": header_val("content-md5", "x-content-md5"),
            "length": length,
            "type": mime_type,
        }

    @staticmethod
    def entity_component_upload_href(entity_data: dict) -> str:
        upload_links = entity_data.get("uploadLinks") if isinstance(entity_data, dict) else {}
        if not isinstance(upload_links, dict):
            return ""
        links = upload_links.get("http://ns.adobe.com/adobecloud/rel/component")
        if not isinstance(links, list):
            return ""
        for item in links:
            if isinstance(item, dict):
                href = str(item.get("href") or "").strip()
                if href:
                    return href
        return ""

    def register_entity_base_resources(
        self, token: str, entity_urn: str, components: list[dict]
    ) -> Any:
        urn = str(entity_urn or "").strip()
        if not urn:
            raise AdobeRequestError("entity urn is required")
        if not components:
            raise AdobeRequestError("entity components are required")
        url = f"{self.entity_api_base}{quote(urn, safe='')}/base-resources/"
        body = []
        for idx, comp in enumerate(components):
            entry = {
                "component": {
                    "id": comp["component_id"],
                    "type": comp["type"],
                    "length": comp["length"],
                    "etag": comp["etag"],
                    "version": comp["version"],
                    "md5": comp["md5"],
                }
            }
            if idx == 0:
                entry["is_primary"] = True
            body.append(entry)
        resp = self._post_json(url, self._entity_headers(token), body)
        if resp.status_code in (401, 403):
            raise AuthError("Token invalid or expired")
        if resp.status_code not in (200, 201):
            if resp.status_code in (408, 429, 451) or resp.status_code >= 500:
                raise UpstreamTemporaryError(
                    f"register entity resources failed: {resp.status_code} {resp.text[:300]}",
                    status_code=resp.status_code,
                    error_type="status",
                )
            raise AdobeRequestError(
                f"register entity resources failed: {resp.status_code} {resp.text[:300]}"
            )
        return self._json_or_empty(resp)

    def list_entities(self, token: str, limit: int = 50) -> list[dict]:
        safe_limit = max(1, min(int(limit or 50), 100))
        data = self._get_json(
            f"{self.entity_api_base}?limit={safe_limit}", self._entity_headers(token)
        )
        if isinstance(data, list):
            return [item for item in data if isinstance(item, dict)]
        if isinstance(data, dict):
            for key in ("entities", "items", "data", "results"):
                items = data.get(key)
                if isinstance(items, list):
                    return [item for item in items if isinstance(item, dict)]
        return []

    def resolve_repo_urn(self, token: str) -> str:
        headers = self._submit_headers_minimal(token)
        headers["accept"] = "*/*"
        data = self._get_json(self.platform_cs_index_url, headers=headers)
        if not isinstance(data, dict):
            raise AdobeRequestError("unable to resolve Adobe repository: invalid index response")

        candidates: list[dict] = []

        def visit(value: Any) -> None:
            if isinstance(value, dict):
                repo_id = str(value.get("repo:repositoryId") or "").strip()
                if repo_id:
                    candidates.append(value)
                for child in value.values():
                    visit(child)
            elif isinstance(value, list):
                for child in value:
                    visit(child)

        visit(data.get("children") or [])

        def score(item: dict) -> tuple[int, int]:
            return (
                1 if str(item.get("repo:state") or "").upper() == "ACTIVE" else 0,
                1 if str(item.get("storage:directoryType") or "") == "assigned" else 0,
            )

        candidates.sort(key=score, reverse=True)
        for item in candidates:
            repo_id = str(item.get("repo:repositoryId") or "").strip()
            if repo_id:
                return repo_id
        raise AdobeRequestError("unable to resolve Adobe repository for current token")

    def delete_entity(self, token: str, entity_urn: str) -> bool:
        urn = str(entity_urn or "").strip()
        if not urn:
            raise AdobeRequestError("entity urn is required")
        resp = self._delete(
            f"{self.entity_api_base}{quote(urn, safe='')}/",
            self._entity_headers(token),
        )
        if resp.status_code in (401, 403):
            raise AuthError("Token invalid or expired")
        if resp.status_code in (200, 202, 204):
            return True
        if resp.status_code in (408, 429, 451) or resp.status_code >= 500:
            raise UpstreamTemporaryError(
                f"delete entity failed: {resp.status_code} {resp.text[:300]}",
                status_code=resp.status_code,
                error_type="status",
            )
        raise AdobeRequestError(
            f"delete entity failed: {resp.status_code} {resp.text[:300]}"
        )

    def _build_payload_candidates(
        self,
        prompt: str,
        aspect_ratio: str,
        output_resolution: str,
        upstream_model_id: str,
        upstream_model_version: str,
        quality_level: Optional[str] = None,
        detail_level: Optional[int] = None,
        source_image_ids: Optional[list[str]] = None,
        size_profile: str = "gemini-3",
        reference_usage: str = "source",
    ) -> list[dict]:
        return build_image_payload_candidates(
            prompt=prompt,
            aspect_ratio=aspect_ratio,
            output_resolution=output_resolution,
            upstream_model_id=upstream_model_id,
            upstream_model_version=upstream_model_version,
            quality_level=quality_level,
            detail_level=detail_level,
            source_image_ids=source_image_ids,
            size_profile=size_profile,
            reference_usage=reference_usage,
        )

    def _image_submit_url(self, channel: str) -> str:
        if str(channel or "").strip().lower() == "firefly-image5":
            return self.firefly_image5_submit_url
        return self.submit_url

    @staticmethod
    def _video_size(
        aspect_ratio: str,
        resolution: str = "720p",
        size_mode: str = "aspect",
    ) -> dict:
        if size_mode == "runway":
            return {
                "16:9": {"width": 1280, "height": 720},
                "9:16": {"width": 720, "height": 1280},
                "1:1": {"width": 960, "height": 960},
                "4:3": {"width": 1104, "height": 832},
                "3:4": {"width": 832, "height": 1104},
                "21:9": {"width": 1584, "height": 672},
            }.get(str(aspect_ratio or "16:9"), {"width": 1280, "height": 720})
        base_height = {
            "360p": 360,
            "480p": 480,
            "540p": 540,
            "720p": 720,
            "1080p": 1080,
            "4k": 2160,
        }.get(str(resolution or "720p").lower(), 720)
        ratio = str(aspect_ratio or "16:9")
        sizes = {
            "16:9": (round(base_height * 16 / 9), base_height),
            "9:16": (base_height, round(base_height * 16 / 9)),
            "1:1": (base_height, base_height),
            "4:3": (round(base_height * 4 / 3), base_height),
            "3:4": (base_height, round(base_height * 4 / 3)),
            "21:9": (round(base_height * 7 / 3), base_height),
            "9:21": (base_height, round(base_height * 7 / 3)),
        }
        width, height = sizes.get(ratio, sizes["16:9"])
        return {"width": int(width), "height": int(height)}

    @staticmethod
    def _landscape_video_size(resolution: str) -> dict:
        return {
            "360p": {"width": 640, "height": 360},
            "480p": {"width": 640, "height": 480},
            "540p": {"width": 960, "height": 540},
            "720p": {"width": 1280, "height": 720},
            "1080p": {"width": 1920, "height": 1080},
            "4k": {"width": 3840, "height": 2160},
        }.get(str(resolution or "720p").lower(), {"width": 1280, "height": 720})

    @staticmethod
    def _coerce_progress_percent(value: Any) -> Optional[float]:
        if value is None:
            return None

        val: Optional[float] = None
        if isinstance(value, (int, float)):
            val = float(value)
        elif isinstance(value, str):
            text = value.strip()
            if not text:
                return None
            if text.endswith("%"):
                text = text[:-1].strip()
            try:
                val = float(text)
            except Exception:
                return None
        elif isinstance(value, dict):
            for key in (
                "progress",
                "percentage",
                "percent",
                "task_progress",
                "taskProgress",
                "value",
            ):
                nested = AdobeClient._coerce_progress_percent(value.get(key))
                if nested is not None:
                    return nested
            return None
        else:
            return None

        if val <= 1.0:
            val = val * 100.0
        if val < 0:
            return 0.0
        if val > 100:
            return 100.0
        return val

    @staticmethod
    def _is_in_progress_status(status_val: str) -> bool:
        return str(status_val or "").upper() in {
            "IN_PROGRESS",
            "RUNNING",
            "PROCESSING",
            "PENDING",
            "QUEUED",
            "STARTED",
        }

    def _extract_progress_percent(self, latest: dict, poll_resp) -> Optional[float]:
        if not isinstance(latest, dict):
            latest = {}

        task_obj = latest.get("task") if isinstance(latest.get("task"), dict) else {}
        result_obj = (
            latest.get("result") if isinstance(latest.get("result"), dict) else {}
        )
        meta_obj = latest.get("meta") if isinstance(latest.get("meta"), dict) else {}
        metadata_obj = (
            latest.get("metadata") if isinstance(latest.get("metadata"), dict) else {}
        )

        candidates: list[Any] = [
            latest.get("progress"),
            latest.get("percentage"),
            latest.get("percent"),
            latest.get("task_progress"),
            latest.get("taskProgress"),
            task_obj.get("progress"),
            task_obj.get("percentage"),
            result_obj.get("progress"),
            result_obj.get("percentage"),
            meta_obj.get("progress"),
            metadata_obj.get("progress"),
            poll_resp.headers.get("x-task-progress"),
            poll_resp.headers.get("x-progress"),
            poll_resp.headers.get("progress"),
        ]

        for raw in candidates:
            parsed = self._coerce_progress_percent(raw)
            if parsed is not None:
                return parsed
        return None

    @staticmethod
    def _normalize_video_poll_url(raw_url: str) -> str:
        if not raw_url:
            return raw_url
        try:
            parsed = urlparse(raw_url)
            host = parsed.netloc
            path_parts = [p for p in parsed.path.split("/") if p]
            if not host or not path_parts:
                return raw_url
            if not host.startswith("firefly-epo"):
                return raw_url
            job_id = path_parts[-1]
            if not job_id:
                return raw_url
            host_suffix = host[len("firefly-epo") :].split(".", 1)[0]
            shard = host_suffix[:4].strip()
            if len(shard) != 4 or not shard.isdigit():
                return raw_url
            return f"https://bks-epo{shard}.adobe.io/v2/jobs/result/{job_id}?host={host}/"
        except Exception:
            return raw_url

    @staticmethod
    def _extract_job_id(raw_url: str) -> str:
        try:
            parsed = urlparse(str(raw_url or ""))
            path_parts = [p for p in parsed.path.split("/") if p]
            if path_parts:
                return path_parts[-1]
        except Exception:
            pass
        return ""

    @staticmethod
    def _extract_result_link(submit_resp, submit_data: Any) -> str:
        poll_url = str(submit_resp.headers.get("x-override-status-link") or "").strip()
        if poll_url:
            return poll_url

        links = submit_data.get("links") if isinstance(submit_data, dict) else {}
        if not isinstance(links, dict):
            links = {}

        result_link = links.get("result")
        if isinstance(result_link, str):
            return result_link.strip()
        if isinstance(result_link, dict):
            return str(result_link.get("href") or "").strip()
        return ""

    @staticmethod
    def _build_video_prompt_json(
        prompt: str, duration: int, negative_prompt: str = ""
    ) -> str:
        payload = {
            "id": 1,
            "duration_sec": int(duration),
            "prompt_text": prompt,
        }
        if negative_prompt:
            payload["negative_prompt"] = negative_prompt
        return json.dumps(payload, ensure_ascii=False)

    def _build_video_payload(
        self,
        video_conf: dict,
        prompt: str,
        aspect_ratio: str,
        duration: int,
        source_image_ids: Optional[list[str]] = None,
        entity_refs: Optional[list[dict]] = None,
        negative_prompt: str = "",
        generate_audio: bool = True,
        reference_mode: str = "frame",
    ) -> dict:
        seed_val = int(time.time()) % 999999
        engine = str(video_conf.get("engine") or "")
        upstream_model_id = str(video_conf.get("upstream_model_id") or "")
        upstream_model_version = str(video_conf.get("upstream_model_version") or "")
        resolution = str(video_conf.get("resolution") or "720p").lower()
        size_mode = str(video_conf.get("size_mode") or "aspect")
        size = (
            self._landscape_video_size(resolution)
            if size_mode == "landscape-resolution"
            else self._video_size(aspect_ratio, resolution, size_mode=size_mode)
        )
        supports_audio = bool(video_conf.get("supports_audio", False))
        audio_enabled = bool(generate_audio) if supports_audio else False

        if engine in {"veo31-fast", "veo31-standard"}:
            payload = {
                "n": 1,
                "seeds": [seed_val],
                "modelId": upstream_model_id or "veo",
                "modelVersion": upstream_model_version,
                "output": {"storeInputs": True},
                "prompt": prompt,
                "size": size,
                "generateAudio": audio_enabled,
                "referenceBlobs": [],
                "generationMetadata": {"module": "text2video"},
                "modelSpecificPayload": {
                    "parameters": {
                        "durationSeconds": int(duration),
                        "aspectRatio": aspect_ratio,
                        "addWaterMark": False,
                    }
                },
            }
            if source_image_ids:
                if engine == "veo31-standard" and str(reference_mode) == "image":
                    for image_id in source_image_ids[:3]:
                        payload["referenceBlobs"].append(
                            {
                                "id": str(image_id),
                                "usage": "asset",
                            }
                        )
                else:
                    for idx, image_id in enumerate(source_image_ids[:2], start=1):
                        payload["referenceBlobs"].append(
                            {
                                "id": str(image_id),
                                "usage": "general",
                                "promptReference": idx,
                            }
                        )
            return payload

        if engine in {"kling25", "kling3", "kling-o3"}:
            tier = "standard" if resolution == "720p" else "pro"
            if engine == "kling25":
                model_version = (
                    "kling_v2_5_turbo_pro_i2v"
                    if source_image_ids
                    else "kling_v2_5_turbo_pro"
                )
            elif engine == "kling3":
                mode = "i2v" if source_image_ids else "t2v"
                model_version = f"kling_v3_{tier}_{mode}"
            elif entity_refs:
                model_version = f"kling_o3_{tier}_reference_to_video"
            else:
                mode = "i2v" if source_image_ids else "t2v"
                model_version = f"kling_o3_{tier}_{mode}"

            payload = {
                "n": 1,
                "seeds": [seed_val],
                "modelId": upstream_model_id or "kling",
                "modelVersion": model_version,
                "output": {"storeInputs": True},
                "prompt": prompt,
                "size": size,
                "generateAudio": audio_enabled,
                "generationMetadata": {
                    "module": "image2video" if source_image_ids else "text2video"
                },
                "duration": int(duration),
                "generationSettings": {"aspectRatio": aspect_ratio},
                "referenceBlobs": [],
            }
            if negative_prompt:
                payload["negativePrompt"] = negative_prompt
            if source_image_ids:
                for idx, image_id in enumerate(source_image_ids[:2], start=1):
                    payload["referenceBlobs"].append(
                        {"id": str(image_id), "usage": "frame", "order": idx}
                    )
            if entity_refs:
                for ref in entity_refs:
                    urn = str(ref.get("urn") or ref.get("id") or "").strip()
                    mention_id = str(ref.get("mention_id") or "").strip()
                    if not urn or not mention_id:
                        continue
                    payload["referenceBlobs"].append(
                        {
                            "usage": "element",
                            "creativeCloudFileId": urn,
                            "mention": {"id": mention_id},
                        }
                    )
            return payload

        if engine == "seedance":
            payload = {
                "seeds": [seed_val],
                "modelId": upstream_model_id,
                "modelVersion": upstream_model_version,
                "output": {"storeInputs": True},
                "prompt": prompt,
                "size": size,
                "generateAudio": audio_enabled,
                "generationMetadata": {
                    "module": "image2video" if source_image_ids else "text2video"
                },
                "duration": int(duration),
                "generationSettings": {"aspectRatio": aspect_ratio},
                "referenceBlobs": [],
            }
            if source_image_ids:
                for idx, image_id in enumerate(source_image_ids[:2], start=1):
                    payload["referenceBlobs"].append(
                        {"id": str(image_id), "usage": "frame", "order": idx}
                    )
            return payload

        if engine == "firefly-video":
            payload = {
                "addOnTransparentBackground": False,
                "prompt": prompt,
                "seeds": [seed_val],
                "sizes": [
                    {
                        "width": int(size["width"]),
                        "height": int(size["height"]),
                        "numFrames": 128,
                    }
                ],
                "videoSettings": {},
                "locale": "en-US",
                "generationMetadata": {
                    "module": "image2video" if source_image_ids else "text2video",
                    "submodule": "ff-video-generate",
                },
                "output": {"storeInputs": True},
            }
            if source_image_ids:
                payload["referenceBlobs"] = [
                    {"id": str(image_id), "usage": "frame", "order": idx}
                    for idx, image_id in enumerate(source_image_ids[:2], start=1)
                ]
            return payload

        payload = {
            "modelId": upstream_model_id,
            "modelVersion": upstream_model_version,
            "prompt": prompt,
            "output": {"storeInputs": True},
            "size": size,
            "duration": int(duration),
            "generationMetadata": {
                "module": "image2video" if source_image_ids else "text2video"
            },
            "referenceBlobs": [],
        }
        if engine == "luma":
            payload["n"] = 1
            payload["mode"] = "standard"
            payload["generationType"] = (
                "image2video" if source_image_ids else "text2video"
            )
        elif engine == "runway":
            payload["seeds"] = [seed_val]
        if not upstream_model_id:
            payload.pop("modelId", None)

        if negative_prompt:
            payload["negativePrompt"] = negative_prompt
        if source_image_ids:
            for idx, image_id in enumerate(source_image_ids[:2], start=1):
                payload["referenceBlobs"].append(
                    {"id": str(image_id), "usage": "frame", "order": idx}
                )
        return payload

    def generate_video(
        self,
        token: str,
        video_conf: dict,
        prompt: str,
        arp_session_id: Optional[str] = None,
        aspect_ratio: str = "9:16",
        duration: int = 12,
        source_image_ids: Optional[list[str]] = None,
        entity_refs: Optional[list[dict]] = None,
        timeout: int = 600,
        negative_prompt: str = "",
        generate_audio: bool = True,
        reference_mode: str = "frame",
        out_path: Optional[Path] = None,
        progress_cb: Optional[Callable[[dict], None]] = None,
    ) -> tuple[Optional[bytes], dict]:
        request_started = time.perf_counter()
        payload = self._build_video_payload(
            video_conf=video_conf,
            prompt=prompt,
            aspect_ratio=aspect_ratio,
            duration=duration,
            source_image_ids=source_image_ids,
            entity_refs=entity_refs,
            negative_prompt=negative_prompt,
            generate_audio=generate_audio,
            reference_mode=reference_mode,
        )
        channel = str(video_conf.get("channel") or "3p").lower()
        if channel == "ugs":
            submit_url = self.ugs_video_submit_url
        elif channel == "native":
            submit_url = self.firefly_video_submit_url
        else:
            submit_url = self.video_submit_url
        submit_resp = self._post_json(
            submit_url,
            headers=self._video_submit_headers(token, arp_session_id=arp_session_id),
            payload=payload,
        )

        if submit_resp.status_code in (401, 403):
            access_error = submit_resp.headers.get("x-access-error")
            if access_error == "taste_exhausted":
                raise QuotaExhaustedError("Adobe quota exhausted for this account")
            raise AuthError("Token invalid or expired")

        if submit_resp.status_code != 200:
            logger.error(
                "video submit failed status=%s body=%s",
                submit_resp.status_code,
                submit_resp.text[:500],
            )
            if submit_resp.status_code in (408, 429, 451) or submit_resp.status_code >= 500:
                raise UpstreamTemporaryError(
                    f"video submit failed: {submit_resp.status_code} {submit_resp.text[:300]}",
                    status_code=submit_resp.status_code,
                    error_type="status",
                )
            raise AdobeRequestError(
                f"video submit failed: {submit_resp.status_code} {submit_resp.text[:300]}"
            )

        submit_elapsed = time.perf_counter() - request_started
        submit_data = submit_resp.json()
        poll_url = self._extract_result_link(submit_resp, submit_data)
        if not poll_url:
            raise AdobeRequestError("video submit succeeded but no poll url returned")
        poll_url = self._normalize_video_poll_url(str(poll_url))
        upstream_job_id = self._extract_job_id(poll_url)
        if progress_cb:
            try:
                progress_cb(
                    {
                        "task_status": "IN_PROGRESS",
                        "task_progress": 0.0,
                        "upstream_job_id": upstream_job_id,
                        "retry_after": int(submit_resp.headers.get("retry-after") or 0)
                        or None,
                    }
                )
            except Exception:
                pass

        start = time.time()
        poll_started = time.perf_counter()
        poll_count = 0
        while True:
            poll_count += 1
            poll_resp = self._get(
                poll_url, headers=self._poll_headers(token), timeout=60
            )
            if poll_resp.status_code in (401, 403):
                raise AuthError("Token invalid or expired")
            if poll_resp.status_code != 200:
                if poll_resp.status_code in (408, 429, 451) or poll_resp.status_code >= 500:
                    raise UpstreamTemporaryError(
                        f"video poll failed: {poll_resp.status_code} {poll_resp.text[:300]}",
                        status_code=poll_resp.status_code,
                        error_type="status",
                    )
                raise AdobeRequestError(
                    f"video poll failed: {poll_resp.status_code} {poll_resp.text[:300]}"
                )

            latest = poll_resp.json()
            status_header = str(poll_resp.headers.get("x-task-status") or "").upper()
            status_val = str(latest.get("status") or "").upper() or status_header
            progress_val = self._extract_progress_percent(latest, poll_resp)

            if progress_cb and self._is_in_progress_status(status_val):
                try:
                    progress_cb(
                        {
                            "task_status": "IN_PROGRESS",
                            "task_progress": progress_val
                            if progress_val is not None
                            else 0.0,
                            "upstream_job_id": upstream_job_id,
                            "retry_after": int(
                                poll_resp.headers.get("retry-after") or 0
                            )
                            or None,
                        }
                    )
                except Exception:
                    pass

            outputs = latest.get("outputs") or []
            if outputs:
                first_output = outputs[0] or {}
                video = first_output.get("video") or {}
                video_url = (
                    video.get("presignedUrl")
                    or video.get("url")
                    or first_output.get("presignedUrl")
                    or first_output.get("url")
                )
                if not video_url:
                    raise AdobeRequestError("video job finished without video url")
                download_started = time.perf_counter()
                if out_path is not None:
                    self._download_to_file(
                        video_url,
                        headers={"accept": "*/*"},
                        out_path=out_path,
                        timeout=60,
                    )
                    video_bytes = None
                else:
                    video_resp = self._get(video_url, headers={"accept": "*/*"}, timeout=60)
                    video_resp.raise_for_status()
                    video_bytes = video_resp.content
                download_elapsed = time.perf_counter() - download_started
                logger.info(
                    "video generation timings submit_ms=%d render_ms=%d download_ms=%d total_ms=%d polls=%d",
                    round(submit_elapsed * 1000),
                    round((download_started - poll_started) * 1000),
                    round(download_elapsed * 1000),
                    round((time.perf_counter() - request_started) * 1000),
                    poll_count,
                )
                if progress_cb:
                    try:
                        progress_cb(
                            {
                                "task_status": "COMPLETED",
                                "task_progress": 100.0,
                                "upstream_job_id": upstream_job_id,
                                "retry_after": None,
                            }
                        )
                    except Exception:
                        pass
                return video_bytes, latest

            if status_val in {"FAILED", "CANCELLED", "ERROR"}:
                if progress_cb:
                    try:
                        progress_cb(
                            {
                                "task_status": "FAILED",
                                "task_progress": progress_val
                                if progress_val is not None
                                else 0.0,
                                "upstream_job_id": upstream_job_id,
                                "retry_after": None,
                                "error": f"video job failed: {latest}",
                            }
                        )
                    except Exception:
                        pass
                raise AdobeRequestError(f"video job failed: {latest}")

            if time.time() - start > timeout:
                if progress_cb:
                    try:
                        progress_cb(
                            {
                                "task_status": "FAILED",
                                "task_progress": progress_val
                                if "progress_val" in locals()
                                and progress_val is not None
                                else 0.0,
                                "upstream_job_id": upstream_job_id,
                                "retry_after": None,
                                "error": "video generation timed out",
                            }
                        )
                    except Exception:
                        pass
                raise AdobeRequestError("video generation timed out")
            time.sleep(self._poll_delay(time.time() - start))

    def generate(
        self,
        token: str,
        prompt: str,
        arp_session_id: Optional[str] = None,
        aspect_ratio: str = "16:9",
        output_resolution: str = "2K",
        upstream_model_id: str = "gemini-flash",
        upstream_model_version: str = "nano-banana-2",
        quality_level: Optional[str] = None,
        detail_level: Optional[int] = None,
        source_image_ids: Optional[list[str]] = None,
        size_profile: str = "gemini-3",
        reference_usage: str = "source",
        channel: str = "3p",
        timeout: int = 180,
        out_path: Optional[Path] = None,
        progress_cb: Optional[Callable[[dict], None]] = None,
    ) -> tuple[Optional[bytes], dict]:
        request_started = time.perf_counter()
        submit_resp = None
        last_error = ""
        for payload in self._build_payload_candidates(
            prompt=prompt,
            aspect_ratio=aspect_ratio,
            output_resolution=output_resolution,
            upstream_model_id=upstream_model_id,
            upstream_model_version=upstream_model_version,
            quality_level=quality_level,
            detail_level=detail_level,
            source_image_ids=source_image_ids,
            size_profile=size_profile,
            reference_usage=reference_usage,
        ):
            submit_resp = self._post_json(
                self._image_submit_url(channel),
                headers=self._submit_headers(
                    token,
                    prompt=prompt,
                    arp_session_id=arp_session_id,
                ),
                payload=payload,
            )
            if submit_resp.status_code == 200:
                break

            if submit_resp.status_code in (401, 403):
                break

            last_error = submit_resp.text[:300]

        if submit_resp is None:
            raise AdobeRequestError("submit failed: no response")

        if submit_resp.status_code in (401, 403):
            access_error = submit_resp.headers.get("x-access-error")
            logger.warning(
                "submit auth failed status=%s access_error=%s body=%s",
                submit_resp.status_code,
                access_error,
                submit_resp.text[:300],
            )
            if access_error == "taste_exhausted":
                raise QuotaExhaustedError("Adobe quota exhausted for this account")
            raise AuthError("Token invalid or expired")

        if submit_resp.status_code != 200:
            logger.error(
                "submit failed status=%s body=%s",
                submit_resp.status_code,
                submit_resp.text[:500],
            )
            if submit_resp.status_code in (408, 429, 451) or submit_resp.status_code >= 500:
                raise UpstreamTemporaryError(
                    f"submit failed: {submit_resp.status_code} {submit_resp.text[:300]}",
                    status_code=submit_resp.status_code,
                    error_type="status",
                )
            if last_error:
                raise AdobeRequestError(
                    f"submit failed: {submit_resp.status_code} {last_error}"
                )
            raise AdobeRequestError(
                f"submit failed: {submit_resp.status_code} {submit_resp.text[:300]}"
            )

        submit_elapsed = time.perf_counter() - request_started
        submit_data = submit_resp.json()
        poll_url = self._extract_result_link(submit_resp, submit_data)
        if not poll_url:
            raise AdobeRequestError("submit succeeded but no poll url returned")

        upstream_job_id = self._extract_job_id(poll_url)
        if progress_cb:
            try:
                progress_cb(
                    {
                        "task_status": "IN_PROGRESS",
                        "task_progress": 0.0,
                        "upstream_job_id": upstream_job_id,
                        "retry_after": int(submit_resp.headers.get("retry-after") or 0)
                        or None,
                    }
                )
            except Exception:
                pass

        start = time.time()
        poll_started = time.perf_counter()
        poll_count = 0
        latest = {}
        while True:
            poll_count += 1
            poll_resp = self._get(
                poll_url, headers=self._poll_headers(token), timeout=60
            )
            if poll_resp.status_code != 200:
                logger.error(
                    "poll failed status=%s body=%s",
                    poll_resp.status_code,
                    poll_resp.text[:500],
                )
                if poll_resp.status_code in (408, 429, 451) or poll_resp.status_code >= 500:
                    raise UpstreamTemporaryError(
                        f"poll failed: {poll_resp.status_code} {poll_resp.text[:300]}",
                        status_code=poll_resp.status_code,
                        error_type="status",
                    )
                raise AdobeRequestError(
                    f"poll failed: {poll_resp.status_code} {poll_resp.text[:300]}"
                )

            latest = poll_resp.json()
            status_header = str(poll_resp.headers.get("x-task-status") or "").upper()
            status_val = str(latest.get("status") or "").upper() or status_header
            progress_val = self._extract_progress_percent(latest, poll_resp)

            if progress_cb and self._is_in_progress_status(status_val):
                try:
                    progress_cb(
                        {
                            "task_status": "IN_PROGRESS",
                            "task_progress": progress_val
                            if progress_val is not None
                            else 0.0,
                            "upstream_job_id": upstream_job_id,
                            "retry_after": int(
                                poll_resp.headers.get("retry-after") or 0
                            )
                            or None,
                        }
                    )
                except Exception:
                    pass

            outputs = latest.get("outputs") or []
            if outputs:
                image_url = ((outputs[0] or {}).get("image") or {}).get("presignedUrl")
                if not image_url:
                    raise AdobeRequestError("job finished without image url")
                download_started = time.perf_counter()
                if out_path is not None:
                    self._download_to_file(
                        image_url,
                        headers={"accept": "*/*"},
                        out_path=out_path,
                        timeout=30,
                    )
                    image_bytes = None
                else:
                    img_resp = self._get(image_url, headers={"accept": "*/*"}, timeout=30)
                    img_resp.raise_for_status()
                    image_bytes = img_resp.content
                download_elapsed = time.perf_counter() - download_started
                logger.info(
                    "image generation timings submit_ms=%d render_ms=%d download_ms=%d total_ms=%d polls=%d model=%s version=%s resolution=%s ratio=%s",
                    round(submit_elapsed * 1000),
                    round((download_started - poll_started) * 1000),
                    round(download_elapsed * 1000),
                    round((time.perf_counter() - request_started) * 1000),
                    poll_count,
                    upstream_model_id,
                    upstream_model_version,
                    output_resolution,
                    aspect_ratio,
                )
                if progress_cb:
                    try:
                        progress_cb(
                            {
                                "task_status": "COMPLETED",
                                "task_progress": 100.0,
                                "upstream_job_id": upstream_job_id,
                                "retry_after": None,
                            }
                        )
                    except Exception:
                        pass
                return image_bytes, latest

            if status_val in {"FAILED", "CANCELLED", "ERROR"}:
                if progress_cb:
                    try:
                        progress_cb(
                            {
                                "task_status": "FAILED",
                                "task_progress": progress_val
                                if progress_val is not None
                                else 0.0,
                                "upstream_job_id": upstream_job_id,
                                "retry_after": None,
                                "error": f"image job failed: {latest}",
                            }
                        )
                    except Exception:
                        pass
                raise AdobeRequestError(f"image job failed: {latest}")

            if time.time() - start > timeout:
                if progress_cb:
                    try:
                        progress_cb(
                            {
                                "task_status": "FAILED",
                                "task_progress": progress_val
                                if progress_val is not None
                                else 0.0,
                                "upstream_job_id": upstream_job_id,
                                "retry_after": None,
                                "error": "image generation timed out",
                            }
                        )
                    except Exception:
                        pass
                raise AdobeRequestError("generation timed out")
            time.sleep(self._poll_delay(time.time() - start))

EXIT 0
