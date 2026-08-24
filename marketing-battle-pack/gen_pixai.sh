#!/bin/bash
# PixAI 批量产线：提交→轮询→下载→转jpg
KEY=$(grep -o 'sk-biz-[A-Za-z0-9_-]*' /home/lenovo/Desktop/image-app/.env.biz-key | head -1)
BASE="https://image.tinchak0207.xyz/v1/images"
DIR=/home/lenovo/Desktop/image-app/marketing-battle-pack/assets
cd "$DIR"

submit() { curl -s --max-time 60 -X POST "$BASE/generations" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "{\"model\":\"pixai-tsubaki2\",\"prompt\":\"$1\",\"size\":\"1536x1024\"}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('task_id') or 'ERR')"; }

fetch() {
  local id=$1 out=$2
  for i in $(seq 1 25); do
    sleep 12
    RESP=$(curl -s --max-time 20 -H "Authorization: Bearer $KEY" "$BASE/$id")
    RES=$(echo "$RESP" | python3 -c "
import json,sys
d=json.load(sys.stdin)
if d.get('status')=='succeeded':
    urls=[x.get('url') for x in (d.get('data') or []) if x.get('url')]
    print(urls[0] if urls else 'nourl')
elif d.get('status') in ('failed','refunded'):
    print(d.get('status'))
else:
    print('pending')" 2>/dev/null)
    [ "$RES" = "pending" ] && continue
    case "$RES" in
      http*)
        curl -sL --max-time 30 "$RES" -o "$out.webp"
        python3 - "$out" <<'PY'
import sys
from PIL import Image
im=Image.open(sys.argv[1]+'.webp').convert('RGB')
im.save(sys.argv[1]+'.jpg', quality=92)
print('SAVED', sys.argv[1]+'.jpg', im.size)
PY
        return 0 ;;
      *) echo "FAIL $out ($RES)"; return 1 ;;
    esac
  done
  echo "TIMEOUT $out"
}

echo "== epic_wall =="
fetch "$(submit "epic anime movie still, the First Emperor of Qin in black dragon robes riding a giant polar bear along the top of the Great Wall above a sea of clouds, golden sunrise light, banners flying, aerial dynamic angle, masterpiece")" epic_cloud_wall

echo "== fail_hand =="
fetch "$(submit "extreme close-up anime shot, the emperor's hand gently touching a polar bear's nose, detailed fur, shallow depth of field, soft light")" fail_bear_hand

echo "== fail_plaque =="
fetch "$(submit "anime scene, a huge wooden plaque on the Great Wall gate tower with large golden chinese calligraphy characters 天下第一关, the First Emperor standing below looking up at it, cinematic")" fail_plaque

echo "== fail_100bears =="
fetch "$(submit "aerial anime wide shot, one hundred polar bears marching in neat rows across snowy plains toward horizon, the emperor riding the lead bear, epic scale")" fail_100bears

echo "== pair_fail =="
fetch "$(submit "anime movie still, the First Emperor of Qin riding a chubby silly-looking polar bear that is tripping and stumbling on ice, both tumbling, comedic timing, snow flying everywhere")" pair_fail

echo "ALL_DONE"
