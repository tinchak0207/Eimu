#!/bin/bash
set -e
sudo docker cp /home/ubuntu/pcp.py adobe2api:/tmp/pcp.py
sudo docker exec adobe2api python3 /tmp/pcp.py
sudo docker exec adobe2api python3 -c "import ast; ast.parse(open('/app/core/adobe_client.py').read()); print('CONTAINER_AST_OK')"
cd /opt/adobe2api
TS=$(date +%Y%m%d-%H%M%S)
if [ -f core/adobe_client.py ]; then
  sudo cp core/adobe_client.py core/adobe_client.py.bak-$TS
  sudo cp /home/ubuntu/host_core_patch.py /tmp/hcp.py
  sudo sed -i "s|'/app/core/adobe_client.py'|'/opt/adobe2api/core/adobe_client.py'|" /tmp/hcp.py
  sudo python3 /tmp/hcp.py
  sudo python3 -c "import ast; ast.parse(open('/opt/adobe2api/core/adobe_client.py').read()); print('HOST_AST_OK')"
else
  echo NO_HOST_CORE_COPY
fi
rm -f /home/ubuntu/pcp.py /home/ubuntu/host_core_patch.py
echo ALL_DONE:$TS