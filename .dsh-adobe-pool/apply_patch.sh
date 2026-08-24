#!/bin/bash
set -e
cd /opt/adobe2api
TS=$(date +%Y%m%d-%H%M%S)
sudo cp adobe_client.py adobe_client.py.bak-$TS
sudo cp /home/ubuntu/patch_poll.py /tmp/patch_poll.py
sudo sed -i "s|'/app/adobe_client.py'|'/opt/adobe2api/adobe_client.py'|g" /tmp/patch_poll.py
sudo python3 /tmp/patch_poll.py
sudo docker exec adobe2api python3 -c "import ast; ast.parse(open('/app/adobe_client.py').read()); print('AST_OK')"
rm -f /home/ubuntu/patch_poll.py
echo STAGED:$TS