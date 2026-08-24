#!/bin/bash
set -e
DST=/opt/image-control-plane/app
TS=$(date +%Y%m%d-%H%M%S)
sudo cp $DST/src/lib/generation-core/failure-classifier.ts /tmp/fc.bak-$TS
sudo cp /home/ubuntu/fc.ts.new $DST/src/lib/generation-core/failure-classifier.ts
sudo cp /home/ubuntu/wc.ts.new $DST/src/components/pro-workstation/workstation-constants.ts
rm -f /home/ubuntu/fc.ts.new /home/ubuntu/wc.ts.new
echo SYNCED:$TS