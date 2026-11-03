#!/usr/bin/env python3
"""Restaura saldos de um backup (/painel/backup) num banco do site.
Uso: python3 restaurar_saldos.py saldos-urnas2026-AAAA-MM-DD.json /srv/eleicoes/dados.db
Não apaga nada: só insere chaves e pedidos que ainda não existem no banco.
Os pedidos restaurados guardam o payment hash (prefixo "ph:"), o que basta para recuperar a chave pelo comprovante."""
import json, sqlite3, sys
b = json.load(open(sys.argv[1], encoding="utf-8")); db = sqlite3.connect(sys.argv[2])
nc = np_ = 0
for c in b["chaves"]:
    nc += db.execute("INSERT OR IGNORE INTO chave (hash, creditos, criada_em) VALUES (?,?,?)", (c["hash"], c["creditos"], c["criada_em"])).rowcount
for p in b["pedidos"]:
    if not p.get("payment_hash"): continue
    np_ += db.execute("INSERT OR IGNORE INTO pagamento (id, chave_hash, pacote, sats, creditos, invoice, verify_url, status, criado_em, pago_em) VALUES (?,?,?,?,?,?,NULL,?,?,?)",
        (p["id"], p["chave_hash"], p["pacote"], p["sats"], p["creditos"], "ph:" + p["payment_hash"], p["status"], p["criado_em"], p["pago_em"])).rowcount
db.commit(); print(f"restaurado: {nc} chaves, {np_} pedidos (backup de {b['gerado_em']})")
