# 磁盘容量探针（2026-10-24 盘满事故后加）。
#
# !!! 这是补丁片段，不是完整配置。现网真源是 VPS 上的
# !!! /opt/imagesite/nginx/conf.d/default.conf（repo 副本已分叉 600 行，
# !!! 单向同步回去会冲掉一堆线上 location）。只把下面这段粘进去。
#
# 粘贴位置（两处）：
#  (1) imagesite-nginx 的 store.tinchak0207.xyz 443 server 块内，紧邻既有的
#      `location = /risk/status.json`（下方第一段；供本机/内网经域名访问）。
#  (2) default_server :80 块内、acme-challenge location 之后（下方第二段）。
#      **Gatus 真正走的是这一处**：它按容器名 http://imagesite-nginx/ 直连，
#      Host=imagesite-nginx 不匹配任何 server_name ⇒ 落 default_server，
#      只有 (1) 时会被该块的 `location / { return 444; }` 吞掉——
#      2026-10-24 上线起探针从未成功（H68 发现，nginx 日志 1372/1372 次 444）。
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

# ---- (2) default_server :80 内（H68，2026-11-04）----
# 只放行 docker 内网 imagesite_imagesite（172.19.0.0/16，排除网关 172.19.0.1：
# 宿主/docker-proxy 转发的流量以网关为源）与容器内 127.0.0.1；
# 其余来源与非 GET 一律 444（不是 403），公网所见与改前一致、不暴露路径存在。
# 若 imagesite_imagesite 子网变了，本块会 fail-closed（Gatus 变红），改这里的网段即可。
location = /risk/diskz.json {
    deny 172.19.0.1;
    allow 172.19.0.0/16;
    allow 127.0.0.1;
    deny all;
    error_page 403 405 = @h68_drop;
    # H77：limit_except GET 会连 HEAD 一起放行，契约是只 GET
    if ($request_method != GET) { return 444; }
    alias /var/www/certbot/diskz.json;
    default_type application/json;
    add_header Cache-Control "no-store" always;
}
location @h68_drop { return 444; }
