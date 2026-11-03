#!/usr/bin/env bash
# Roda na VM a cada 15 min (timer systemd): baixa o código do GitHub e, se mudou, reconstrói o site e reinicia o serviço.
# Só atualiza o código do site; não roda scripts de instalação nem mexe no sistema.
set -euo pipefail
REPO=https://github.com/projects-betanull/urnas2026; DIR=/srv/eleicoes/repo; APP=/srv/eleicoes/app
[ -d $DIR/.git ] || git clone --depth 1 $REPO $DIR
cd $DIR; git fetch --depth 1 origin main -q; NOVO=$(git rev-parse origin/main); ATUAL=$(cat /srv/eleicoes/versao 2>/dev/null || true)
[ "$NOVO" = "$ATUAL" ] && exit 0
git reset --hard -q origin/main
for d in worker etl test build.py schema.sql deploy; do rm -rf "$APP/$d"; cp -r "$DIR/$d" "$APP/"; done
cd $APP && python3 build.py >/dev/null && echo "$NOVO" > /srv/eleicoes/versao && systemctl restart eleicoes
echo "$(date -u +%FT%TZ) site atualizado para a versao ${NOVO:0:7}" >> /srv/eleicoes/status.txt
