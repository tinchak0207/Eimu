#!/bin/bash
set -e
cd /opt/adobe2api
TS=$(date +%Y%m%d-%H%M%S)
sudo cp core/adobe_client.py core/adobe_client.py.bak-$TS
sudo docker cp /home/ubuntu/psub.py adobe2api:/tmp/psub.py
sudo docker exec adobe2api python3 /tmp/psub.py /app/core/adobe_client.py
sudo docker exec adobe2api python3 -c "import ast; ast.parse(open('/app/core/adobe_client.py').read()); print('CONTAINER_AST_OK')"
sudo python3 /home/ubuntu/psub.py /opt/adobe2api/core/adobe_client.py
sudo python3 -c "import ast; ast.parse(open('/opt/adobe2api/core/adobe_client.py').read()); print('HOST_AST_OK')"
rm -f /home/ubuntu/psub.py
echo SUBMIT_ALL_DONE:$TS