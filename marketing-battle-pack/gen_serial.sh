#!/bin/bash
# 串行生成器：逐个提交+轮询+下载，避开并发0/1拥堵
KEY=$(grep -o 'sk-biz-[A-Za-z0-9_-]*' /home/lenovo/Desktop/image-app/.env.biz-key | head -1)
BASE="https://image.tinchak0207.xyz/v1/images"
DIR=/home/lenovo/Desktop/image-app/marketing-battle-pack/assets
cd "$DIR"

submit() { curl -s --max-time 60 -X POST "$BASE/generations" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "$1" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('task_id') or 'ERR:'+json.dumps(d.get('error'),ensure_ascii=False)[:150])"; }

wait_task() {
  local id=$1
  for i in $(seq 1 40); do
    sleep 15
    local resp=$(curl -s --max-time 20 -H "Authorization: Bearer $KEY" "$BASE/$id")
    local st=$(echo "$resp" | python3 -c "import json,sys
try: print(json.load(sys.stdin).get('status'))
except: print('err')" 2>/dev/null)
    if [ "$st" = "succeeded" ]; then echo "$resp" > "$DIR/task_$id.json"; echo "OK $id"; return 0; fi
    if [ "$st" = "failed" ] || [ "$st" = "refunded" ]; then echo "$resp" > "$DIR/task_$id.json"; echo "FAIL $id $st"; return 1; fi
  done
  echo "TIMEOUT $id"; return 1
}

gen() { # $1=outfile  $2=model $3=prompt
  local body="{\"model\":\"$2\",\"prompt\":\"$3\",\"size\":\"1536x1024\"}"
  local tid=$(submit "$body")
  echo "[$1] task=$tid"
  [ "${tid:0:3}" = "ERR" ] && return 1
  if wait_task "$tid"; then
    python3 - "$DIR/task_$tid.json" "$1" <<'PY'
import json,sys,urllib.request,os
d=json.load(open(sys.argv[1]))
urls=[x.get('url') for x in (d.get('data') or []) if x.get('url')]
if urls:
    urllib.request.urlretrieve(urls[0], sys.argv[2])
    print('SAVED', sys.argv[2], os.path.getsize(sys.argv[2]))
else:
    print('NO_URL', json.dumps(d,ensure_ascii=False)[:200])
PY
  fi
}

# 优先级顺序：主帧→翻车帧
gen hero_sunset.jpg "gpt-image-2" "史诗写实电影剧照，宽银幕构图：落日熔金，长城山脊上秦始皇骑在一头巨大北极熊背上的逆光剪影，黑色披风被风吹起，天边一轮红日沉入冰原，人与熊边缘镶着金色轮廓光，北极熊仰头长啸，胶片颗粒质感，史诗电影最后一镜"
gen fail_bear_hand.jpg "gpt-image-2" "极近特写：秦始皇戴着手套的手轻轻搭在北极熊的黑色鼻子上，毛发细节清晰，浅景深，写实摄影"
gen fail_plaque.jpg "gpt-image-2" "长城城楼上挂着一块巨大的木质匾额，上面写着「天下第一关」四个金色大字，秦始皇站在匾额下方仰望，写实电影感"
gen fail_100bears.jpg "gpt-image-2" "航拍视角：一百只北极熊在雪原上整齐列队行军，队列延伸到远方，秦始皇骑在最前面领头的北极熊上，史诗感"
gen epic_cloud_wall.jpg "gpt-image-2" "秦始皇骑着北极熊登上长城，俯瞰云海，清晨金色阳光，史诗写实电影剧照，黑色龙袍猎猎作响，北极熊白色皮毛与灰色城砖对比，航拍视角"
echo "ALL_DONE"
