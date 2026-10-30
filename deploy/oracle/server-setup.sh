#!/bin/bash
# One-time setup of a fresh Oracle Cloud "Always Free" Ubuntu server (Ampere A1, arm64).
# Run ON THE SERVER, once:   sudo bash server-setup.sh
# (deploy.sh copies this file to the server and runs it for you on the first deploy.)
#
# Installs Docker, opens ports 80/443 in Ubuntu's own firewall (Oracle images block everything but
# SSH by default, in addition to the cloud security list), sets the time zone, and enables automatic
# security updates. Safe to run again.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
APP_USER="${SUDO_USER:-ubuntu}"

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -yq ca-certificates curl rsync openssl iptables-persistent unattended-upgrades

echo "== firewall: allow 80 and 443"
# Oracle's Ubuntu images ship iptables rules that REJECT everything except SSH. Insert ACCEPT rules
# just before that REJECT and save them so they survive reboots. This runs before Docker is
# installed, so Docker's own rules (recreated at every start) are never saved into the file.
for port in 80 443; do
  if ! iptables -C INPUT -p tcp -m state --state NEW --dport "$port" -j ACCEPT 2>/dev/null; then
    n=$(iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" {print $1; exit}')
    if [ -n "$n" ]; then iptables -I INPUT "$n" -p tcp -m state --state NEW --dport "$port" -j ACCEPT; fi
  fi
done
if ! docker info >/dev/null 2>&1; then netfilter-persistent save; fi

echo "== docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
usermod -aG docker "$APP_USER"
systemctl enable --now docker
# Keep container logs bounded even for containers without their own limits.
if [ ! -f /etc/docker/daemon.json ]; then
  echo '{"log-driver":"json-file","log-opts":{"max-size":"20m","max-file":"5"}}' > /etc/docker/daemon.json
  systemctl restart docker
fi

echo "== time zone, updates"
timedatectl set-timezone Asia/Kolkata || true
dpkg-reconfigure -fnoninteractive unattended-upgrades

# A little swap on small shapes, so a build never gets killed for memory.
if [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 4000000 ] && ! swapon --show | grep -q .; then
  echo "== 2 GB swap"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

mkdir -p /opt/marketverse
chown "$APP_USER:$APP_USER" /opt/marketverse

echo
echo "Server ready: $(nproc) CPUs, $(free -h | awk '/Mem:/ {print $2}') RAM, $(uname -m)."
echo "Docker: $(docker --version)"
