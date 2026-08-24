#!/usr/bin/env python3
"""Patch video poll path: 451 with moderation/legal markers -> permanent AdobeRequestError."""
import re
path = '/app/adobe_client.py'
src = open(path).read()
old = '''            if poll_resp.status_code != 200:
                if poll_resp.status_code in (408, 429, 451) or poll_resp.status_code >= 500:
                    raise UpstreamTemporaryError(
                        f"video poll failed: {poll_resp.status_code} {poll_resp.text[:300]}",
                        status_code=poll_resp.status_code,
                        error_type="status",
                    )'''
new = '''            if poll_resp.status_code != 200:
                _poll_body_lower = poll_resp.text[:300].lower()
                if poll_resp.status_code == 451 and any(
                    marker in _poll_body_lower
                    for marker in ("legal_error", "prompt_unsafe", "nsfw", "content policy")
                ):
                    raise AdobeRequestError(
                        f"Video generation rejected by upstream compliance filter during polling ({poll_resp.status_code}). Permanent rejection: prompt failed content review. Detail: {poll_resp.text[:300]}",
                        status_code=451,
                    )
                if poll_resp.status_code in (408, 429, 451) or poll_resp.status_code >= 500:
                    raise UpstreamTemporaryError(
                        f"video poll failed: {poll_resp.status_code} {poll_resp.text[:300]}",
                        status_code=poll_resp.status_code,
                        error_type="status",
                    )'''
count = src.count(old)
assert count == 1, f'expected 1 match, got {count}'
open(path, 'w').write(src.replace(old, new))
print('POLL_PATCH_OK')