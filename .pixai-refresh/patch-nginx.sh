#!/bin/bash
set -e
sudo docker cp imagesite-nginx:/etc/nginx/conf.d/default.conf /tmp/def.conf
sudo python3 << 'PYEOF'
p = '/tmp/def.conf'
s = open(p).read()
block = '''    location = /ssh {
        proxy_pass http://127.0.0.1:18083;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
'''
idx = s.find('location = /px {')
assert idx >= 0, 'px location not found'
end = s.find('\n    }', idx)
assert end >= 0
end += 4
s = s[:end] + '\n' + block + s[end:]
open(p, 'w').write(s)
print('patched OK')
PYEOF
sudo docker cp /tmp/def.conf imagesite-nginx:/etc/nginx/conf.d/default.conf
sudo docker exec imagesite-nginx nginx -t
sudo docker exec imagesite-nginx nginx -s reload
echo NGINX_SSH_ROUTE_OK
