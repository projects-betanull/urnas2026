// Backup diário só dos saldos (sem nenhuma chave em claro) para um bucket privado do Object Storage da Oracle.
// O destino é uma URL pré-autenticada de SOMENTE ESCRITA guardada em /srv/eleicoes/backup_par (só root lê).
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { abrirD1 } from "../test/d1.mjs";
import { backupSaldos } from "../worker/src/uso.js";
const par = readFileSync("/srv/eleicoes/backup_par", "utf8").trim();
const b = await backupSaldos(abrirD1(process.env.DB_PATH || "/srv/eleicoes/dados.db"));
const nome = `saldos-${b.gerado_em.slice(0, 10)}.json.gz`;
const r = await fetch(par + nome, { method: "PUT", body: gzipSync(JSON.stringify(b)), headers: { "content-type": "application/gzip" } });
if (!r.ok) { console.error("backup falhou", r.status, await r.text()); process.exit(1); }
console.log(`backup ${nome}: ${b.chaves.length} chaves, ${b.pedidos.length} pedidos`);
