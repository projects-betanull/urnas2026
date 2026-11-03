#!/usr/bin/env bash
# Roda uma vez na VM (sudo): instala o timer que mantém o site em dia com o GitHub.
set -euo pipefail
apt-get install -y -q git >/dev/null
cat > /etc/systemd/system/eleicoes-atualizar.service <<UNIT
[Unit]
Description=Atualiza o site a partir do GitHub
After=network-online.target
[Service]
Type=oneshot
ExecStart=/bin/bash -c 'cp /srv/eleicoes/repo/deploy/atualizar.sh /run/eleicoes-atualizar.sh && exec bash /run/eleicoes-atualizar.sh'
UNIT
cat > /etc/systemd/system/eleicoes-atualizar.timer <<UNIT
[Unit]
Description=Atualiza o site a cada 15 minutos
[Timer]
OnBootSec=2min
OnUnitActiveSec=15min
[Install]
WantedBy=timers.target
UNIT
[ -d /srv/eleicoes/repo/.git ] || git clone --depth 1 https://github.com/projects-betanull/urnas2026 /srv/eleicoes/repo
systemctl daemon-reload && systemctl enable --now eleicoes-atualizar.timer && systemctl start eleicoes-atualizar.service
systemctl is-active eleicoes-atualizar.timer; tail -2 /srv/eleicoes/status.txt
