#!/bin/bash
echo "=== service logs (biz-keys / blob) ==="
sudo docker logs --since 12m image-data-api 2>&1 | grep -E "biz-keys|GET /api/blob" | tail -40
echo "=== kv biz rows ==="
sudo docker exec sub2api-vps-postgres psql -U image_data -d image_data -tAc "SELECT pathname, size, uploaded_at FROM kv_store WHERE pathname LIKE 'biz-keys%' ORDER BY uploaded_at DESC"
echo "=== all kv rows ==="
sudo docker exec sub2api-vps-postgres psql -U image_data -d image_data -tAc "SELECT pathname, size FROM kv_store ORDER BY uploaded_at DESC LIMIT 15"
