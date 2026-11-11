// Uma base 2t_TO que recebeu por engano também os logs de SP (zip esquecido na pasta temporária) não pode
// contar SP duas vezes: cada base responde só pela própria UF, e a derivada dela fica de fora até a base ser refeita.
// Uso: node test/teste_base_mista.mjs   (cria e apaga uma pasta temporária)
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { abrirUrnas } from "./d1.mjs";
import { resumoUrnas, distribuicaoUrnas } from "../worker/src/urnas.js";

const d = mkdtempSync(tmpdir() + "/mista-");
const base = (nome, linhas) => {
  const db = new DatabaseSync(`${d}/${nome}_tempos.db`);
  db.exec(`CREATE TABLE secao_tempo (turno INT, uf TEXT, cd_municipio TEXT, zona TEXT, secao TEXT, abertura TEXT, primeiro_voto TEXT, ultimo_voto TEXT,
      encerramento TEXT, votos INT, votos_apos_17h INT, votos_apos_19h INT, PRIMARY KEY (turno, cd_municipio, zona, secao));
    CREATE TABLE voto_minuto_uf (turno INT, uf TEXT, minuto TEXT, votos INT, PRIMARY KEY (turno, uf, minuto));
    CREATE TABLE meta (chave TEXT PRIMARY KEY, valor TEXT); INSERT INTO meta VALUES ('apos_17h', 'brasilia');`);
  for (const [uf, mun, votos] of linhas) {
    db.prepare("INSERT INTO secao_tempo VALUES (2,?,?,'0001','0001','08:00:00','08:01:00','16:50:00','17:01:00',?,0,0)").run(uf, mun, votos);
    db.prepare("INSERT INTO voto_minuto_uf VALUES (2,?,'10:00',?)").run(uf, votos);
  }
  db.close();
  const rel = new DatabaseSync(`${d}/${nome}_rel.db`);
  rel.exec(`CREATE TABLE voto_rel (turno INT, uf TEXT, minutos INT, votos INT); CREATE TABLE meta (chave TEXT PRIMARY KEY, valor TEXT);
    CREATE TABLE cauda_hora (cd_municipio TEXT, zona TEXT, secao TEXT, minuto INT, votos INT); CREATE TABLE cauda_rel (cd_municipio TEXT, zona TEXT, secao TEXT, minutos INT, votos INT);
    INSERT INTO meta VALUES ('versao', '3');`);
  rel.prepare("INSERT INTO voto_rel VALUES (2,?,120,?)").run(linhas[0][0], linhas.reduce((a, l) => a + l[2], 0));
  rel.close();
};
try {
  base("2t_SP", [["SP", "71072", 300]]);
  base("2t_TO", [["SP", "71072", 300], ["TO", "73440", 100]]); // SP entrou de carona
  const env = { URNAS: abrirUrnas(d, d) };
  const r = resumoUrnas(env, { turno: 2 }).linhas;
  assert.deepEqual(r.map(l => [l.uf, l.secoes, l.votos]), [["SP", 1, 300], ["TO", 1, 100]]);
  for (const visao of ["horario_voto", "encerramento", "duracao"]) assert.equal(distribuicaoUrnas(env, { turno: 2, visao }).total_votos, 400, visao);
  const t = distribuicaoUrnas(env, { turno: 2, visao: "tempo_voto" });
  assert.equal(t.total_votos, 300); assert.deepEqual(t.ufs_sem_dado, ["TO"]); // derivada de TO misturada: fica de fora, com aviso
  assert.equal(env.URNAS.secoes(2).reduce((a, b) => a + b.indice().n, 0), 2);
  console.log("teste_base_mista ok");
} finally { rmSync(d, { recursive: true, force: true }); }
