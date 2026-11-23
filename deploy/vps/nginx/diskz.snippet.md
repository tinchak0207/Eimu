# 磁盘容量探针（2026-10-24 盘满事故后加）。
#
# !!! 这是补丁片段，不是完整配置。现网真源是 VPS 上的
# !!! /opt/imagesite/nginx/conf.d/default.conf（repo 副本已分叉 600 行，
# !!! 单向同步回去会冲掉一堆线上 location）。只把下面这段粘进去。
#
# 粘贴位置：imagesite-nginx 的 store.tinchak0207.xyz 443 server 块内，
# 紧邻既有的 `location = /risk/status.json`。
#
# 数据由 /usr/local/bin/disk-metrics.sh 每 5 分钟写入
# /var/www/certbot/diskz.json（该路径在容器内可见，见 docker inspect 的
# /opt/imagesite/certbot/www 挂载），gatus 直接按容器名探它。
# 只对本机与内网开放：容量数字不是对外信息，也不需要外网可达。
location = /risk/diskz.json {
    allow 172.16.0.0/12;
    allow 127.0.0.1;
    allow 43.172.85.76;
    deny all;
    alias /var/www/certbot/diskz.json;
    default_type application/json;
    add_header Cache-Control "no-store" always;
}
