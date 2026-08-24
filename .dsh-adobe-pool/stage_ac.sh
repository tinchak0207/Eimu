#!/bin/bash
set -e
cd /opt/adobe2api
TS=$(date +%Y%m%d-%H%M%S)
sudo cp adobe_client.py adobe_client.py.bak-$TS
sudo python3 -c "import ast; ast.parse(open('/home/ubuntu/ac_new.py').read()); print('REMOTE_OK')"
sudo cp /home/ubuntu/ac_new.py ./adobe_client.py
rm -f /home/ubuntu/ac_new.py
echo STAGED:$TS