#!/usr/bin/env python3
import sys
path = sys.argv[1]
src = open(path).read()
old = "        if submit_resp.status_code != 200:\n            logger.error(\n                \"video submit failed status=%s body=%s\",\n                submit_resp.status_code,\n                submit_resp.text[:500],\n            )\n            if submit_resp.status_code in (408, 429, 451) or submit_resp.status_code >= 500:"
new = "        if submit_resp.status_code != 200:\n            logger.error(\n                \"video submit failed status=%s body=%s\",\n                submit_resp.status_code,\n                submit_resp.text[:500],\n            )\n            _submit_body_lower = submit_resp.text[:300].lower()\n            if submit_resp.status_code == 451 and any(\n                marker in _submit_body_lower\n                for marker in (\"legal_error\", \"prompt_unsafe\", \"nsfw\", \"content policy\")\n            ):\n                raise AdobeRequestError(\n                    f\"Video generation rejected by upstream compliance filter at submit ({submit_resp.status_code}). Permanent rejection: prompt failed content review. Detail: {submit_resp.text[:300]}\",\n                    status_code=451,\n                )\n            if submit_resp.status_code in (408, 429, 451) or submit_resp.status_code >= 500:"
count = src.count(old)
assert count == 1, f'expected 1 match, got {count}'
open(path, 'w').write(src.replace(old, new))
print('SUBMIT_PATCH_OK:', path)