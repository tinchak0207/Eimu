#!/bin/bash
KEY=$(sudo docker exec adobe2api printenv ADOBE2API_API_KEY)
sudo docker cp /home/ubuntu/vp2.json image-control-api:/tmp/vp.json
sudo docker exec -e PROBEKEY=$KEY image-control-api sh -c 'wget -qO- --timeout=140 --server-response --header="Content-Type: application/json" --header="Authorization: Bearer $PROBEKEY" --post-file=/tmp/vp.json http://adobe2api:6001/v1/chat/completions' > /tmp/probe_full.txt 2>&1
grep 'HTTP/' /tmp/probe_full.txt | tail -1
tail -c 400 /tmp/probe_full.txt