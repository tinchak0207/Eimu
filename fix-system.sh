#!/usr/bin/env bash
# 修复脚本 v2：fstab Ventoy 残留 + zram 扩容（16G）+ 验证
# 执行：su -c "bash /home/lenovo/Desktop/image-app/fix-system.sh"  或  sudo bash /home/lenovo/Desktop/image-app/fix-system.sh
set -euo pipefail

echo "[1/3] 注释 fstab 中 Ventoy 残留的 exfat / 条目"
if grep -q '^UUID=4E21-0000' /etc/fstab; then
  sed -i 's|^UUID=4E21-0000|#UUID=4E21-0000  # disabled: Ventoy leftover|' /etc/fstab
  echo "     done"
else
  echo "     已处理，跳过"
fi

echo "[2/3] zram 扩容到 16G（RAM 的 2/3）"
cat > /etc/systemd/zram-generator.conf <<'EOF'
[zram0]
compression-algorithm = zstd
zram-size = ram * 2 / 3
swap-priority = 100
EOF
swapoff /dev/zram0 2>/dev/null || true
systemctl daemon-reload
systemctl restart systemd-zram-setup@zram0.service
echo "     done"

echo "[3/3] 验证"
echo "--- fstab 有效条目 ---"
grep -n '^UUID' /etc/fstab || echo "(无未注释 UUID 条目)"
echo "--- swap ---"
swapon --show
echo "--- 触发 remount 验证 fstab ---"
systemctl start systemd-remount-fs.service 2>&1 || true
echo "--- sudo ---"
ls -la /etc/sudo.conf
echo
echo "完成。"
