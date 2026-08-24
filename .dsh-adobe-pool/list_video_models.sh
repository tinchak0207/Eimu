#!/bin/bash
KEY=$(sudo docker exec image-control-worker printenv ADOBE2API_API_KEY)
sudo docker exec -e PROBEKEY=$KEY image-control-api sh -c 'wget -qO- --header="Authorization: Bearer $PROBEKEY" http://adobe2api:6001/v1/models' | python3 -c 'import json,sys; d=json.load(sys.stdin); [print(m["id"]) for m in d.get("data",[]) if any(k in m["id"].lower() for k in ["video","seedance","veo"])]'