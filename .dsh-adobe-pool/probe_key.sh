#!/bin/bash
KEY=$(sudo docker exec image-control-worker printenv ADOBE2API_API_KEY)
sudo docker cp /home/ubuntu/vp2.json image-control-api:/tmp/vp.json
START=$(date +%s)
sudo docker exec -e PROBEKEY=$KEY image-control-api sh -c 'wget -qO- --timeout=170 --server-response --header="Content-Type: application/json" --header="Authorization: Bearer $PROBEKEY" --post-file=/tmp/vp.json http://adobe2api:6001/v1/chat/completions' > /tmp/probe_full.txt 2>&1
END=$(date +%s)
echo ELAPSED:$((END-START))s
grep 'HTTP/' /tmp/probe_full.txt | tail -1
tail -c 500 /tmp/probe_full.txt
rm -f /home/ubuntu/pk.sh /home/ubuntu/vp2.json