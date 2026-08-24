#!/bin/bash
KEY=$(sudo docker exec adobe2api printenv ADOBE2API_API_KEY)
sudo cp /home/ubuntu/video_probe.json /tmp/vp.json && sudo chmod 644 /tmp/vp.json
CODE=$(curl -sS -o /tmp/vp_out.json -w '%{http_code}' --max-time 120 -X POST http://localhost:6001/v1/chat/completions -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d @/tmp/vp.json)
echo HTTP:$CODE
head -c 400 /tmp/vp_out.json
echo