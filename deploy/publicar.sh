#!/usr/bin/env bash
# Roda na VM (sudo): atualiza o site e publica o servidor MCP no registro oficial (autenticação por HTTP no próprio domínio).
set -euo pipefail
DOM=urnas2026.duckdns.org; BASE=/srv/eleicoes; R=$BASE/registro; ST=$BASE/status.txt
st(){ echo "$(date -u +%FT%TZ) $*" | tee -a $ST; }
cd $BASE/app && python3 build.py && systemctl restart eleicoes && st "site atualizado (SEO, llms.txt)"
mkdir -p $R/wk && cd $R
[ -f key.pem ] || openssl genpkey -algorithm Ed25519 -out key.pem
chmod 600 key.pem
echo "v=MCPv1; k=ed25519; p=$(openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)" > wk/mcp-registry-auth
chmod 755 $R $R/wk; chmod 644 wk/mcp-registry-auth
printf '%s, :80 {\n  encode zstd gzip\n  handle /status {\n    root * %s\n    rewrite * /status.txt\n    file_server\n  }\n  handle /.well-known/mcp-registry-auth {\n    root * %s/wk\n    rewrite * /mcp-registry-auth\n    file_server\n  }\n  handle {\n    reverse_proxy 127.0.0.1:8080\n  }\n}\n' "$DOM" "$BASE" "$R" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile >/dev/null && systemctl reload caddy; sleep 3
curl -fsS https://$DOM/.well-known/mcp-registry-auth
[ -x mcp-publisher ] || curl -fsSL https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_linux_amd64.tar.gz | tar xz mcp-publisher
cp $BASE/app/deploy/registro/server.json .
./mcp-publisher login http --domain "$DOM" --private-key "$(openssl pkey -in key.pem -noout -text | grep -A3 'priv:' | tail -n +2 | tr -d ' :\n')"
./mcp-publisher publish && st "MCP publicado no registro oficial: org.duckdns.urnas2026/eleicoes-2026"
