#!/usr/bin/env bash
# Instala e publica o "Eleições 2026 em dados" numa VM Ubuntu (Oracle Cloud Always Free, ARM).
# Uso: sudo bash instalar.sh DOMINIO        (ex.: eleicoes2026.duckdns.org)
set -euo pipefail
DOM="${1:?informe o domínio}"; BASE=/srv/eleicoes; DADOS=$BASE/tse; mkdir -p $DADOS
ST=$BASE/status.txt; st(){ echo "$(date -u +%FT%TZ) $*" >> $ST; }
st "inicio da instalacao"
apt-get update -y && apt-get install -y curl unzip python3-pip debian-keyring debian-archive-keyring apt-transport-https
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -y && apt-get install -y caddy
pip3 install --break-system-packages pyarrow py7zr
[ -d $BASE/app ] || cp -r "$(dirname "$0")/.." $BASE/app
st "pacotes instalados"
python3 $BASE/app/build.py

# 2) Serviço web + HTTPS automático
cat > /etc/systemd/system/eleicoes.service <<UNIT
[Unit]
After=network.target
[Service]
WorkingDirectory=$BASE/app/deploy
Environment=DB_PATH=$BASE/dados.db
ExecStart=/usr/bin/node --no-warnings servidor.mjs
Restart=always
[Install]
WantedBy=multi-user.target
UNIT
printf '%s, :80 {\n  encode zstd gzip\n  handle /status {\n    root * %s\n    rewrite * /status.txt\n    file_server\n  }\n  handle {\n    reverse_proxy 127.0.0.1:8080\n  }\n}\n' "$DOM" "$BASE" > /etc/caddy/Caddyfile
systemctl daemon-reload && systemctl enable eleicoes && systemctl restart caddy
R=$(iptables -L INPUT --line-numbers -n | awk '$2=="REJECT"{print $1; exit}'); R=${R:-1}
for p in 443 80; do iptables -C INPUT -m state --state NEW -p tcp --dport $p -j ACCEPT 2>/dev/null || iptables -I INPUT $R -m state --state NEW -p tcp --dport $p -j ACCEPT; done
netfilter-persistent save || true
st "status publico em http://$DOM/status"

# 1) Dados principais (candidatos, votos por município, bens)
cd $DADOS
for u in consulta_cand/consulta_cand_2026 votacao_candidato_munzona/votacao_candidato_munzona_2026 bem_candidato/bem_candidato_2026; do
  unzip -tqq "$(basename $u).zip" >/dev/null 2>&1 || curl -fSL -o "$(basename $u).zip" "https://cdn.tse.jus.br/estatistica/sead/odsele/$u.zip"
done
st "baixando e processando dados principais"
python3 $BASE/app/etl/etl.py $DADOS $BASE/dados_novo.db >> $ST 2>&1 && mv -f $BASE/dados_novo.db $BASE/dados.db
st "dados principais prontos"

systemctl restart eleicoes
st "site no ar: https://$DOM"
nohup bash $BASE/app/deploy/logs_todos.sh >> $BASE/logs_processamento.txt 2>&1 &
st "processamento dos logs iniciado em segundo plano"
