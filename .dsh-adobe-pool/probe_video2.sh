#!/bin/bash
KEY=$(sudo docker exec adobe2api printenv ADOBE2API_API_KEY)
CODE=$(curl -sS -o /tmp/vp_out.json -w '%{http_code}' --max-time 150 --noproxy '*' -X POST http://127.0.0.1:6001/v1/chat/completions -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d @/home/ubuntu/vp2.json)
echo HTTP:$CODE
head -c 400 /tmp/vp_out.json
echo