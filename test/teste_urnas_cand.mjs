// Cruza horários das urnas com votos por seção (etl/secao.py) no explorador de horários.
// Prepara: python3 test/gerar_logs.py /tmp/tu && python3 etl/logs.py /tmp/tu /tmp/tu/logs/2t_SP && (zip BR) && python3 etl/secao.py
import assert from "node:assert/strict";
import { abrirD1, abrirUrnas } from "./d1.mjs";
import { explorarUrnas, valoresUrnas } from "../worker/src/explorar_urnas.js";
const P = process.argv[2] || "/tmp/tu";
const env = { DB: abrirD1("test/exemplo.db"), URNAS: abrirUrnas(P + "/logs", P + "/secaodb") };
const r = await explorarUrnas(env, { medida: "votos_candidato", linhas: "candidato", filtros: { turno: ["2"] } });
const tot = Object.fromEntries(r.linhas.map(l => [l.linha, l.valor]));
assert.ok(tot["CANDIDATO A"] > 0 && tot["CANDIDATO B"] > 0, JSON.stringify(r.linhas));
assert.ok(!("BRANCO" in tot), "brancos fora dos válidos");
const p = await explorarUrnas(env, { medida: "pct_votos_candidato", linhas: "encerrou_apos", colunas: "candidato", filtros: { turno: ["2"] }, limiar_hora: "17:30" });
const soma = {}; for (const l of p.linhas) soma[l.linha] = (soma[l.linha] || 0) + l.valor;
for (const v of Object.values(p.totLinha)) assert.ok(Math.abs(v - 100) < 1e-6, "total da linha = 100%");
assert.ok(Math.abs(p.valorGeral - 100) < 1e-6);
for (const v of Object.values(soma)) assert.ok(Math.abs(v - 100) < 1e-6, "percentuais somam 100 por linha");
const a = l => p.linhas.find(x => x.linha.startsWith(l) && x.coluna === "CANDIDATO A").valor;
assert.ok(a("Encerrou a partir") > a("Encerrou antes"), "urnas que fecham tarde (cidade grande) favorecem A no exemplo");
const f = await explorarUrnas(env, { medida: "pct_votos_candidato", linhas: "uf", filtros: { turno: ["2"], candidato: ["CANDIDATO A"] } });
assert.ok(f.linhas[0].valor > 40 && f.linhas[0].valor < 60, JSON.stringify(f.linhas));
assert.deepEqual(await valoresUrnas(env, "candidato", { turno: "2" }), ["CANDIDATO A", "CANDIDATO B"]);
await assert.rejects(explorarUrnas(env, { medida: "secoes", linhas: "candidato" }), /Candidato só funciona/);
const g = await explorarUrnas(env, { medida: "votos_candidato", linhas: "uf", cargo: "GOVERNADOR", filtros: { turno: ["2"] } });
assert.deepEqual(g.sem_votos_por_secao, ["2º SP"]);
const d = await explorarUrnas(env, { medida: "desvio_mun_candidato", linhas: "encerrou_apos", colunas: "candidato", filtros: { turno: ["2"] }, limiar_hora: "17:30" });
for (const l of d.linhas) assert.ok(Math.abs(l.valor) < 3, `dentro do município a diferença some: ${l.linha} ${l.coluna} ${l.valor}`);
console.log("teste_urnas_cand ok", p.linhas.map(l => `${l.linha} ${l.coluna} ${l.valor.toFixed(1)}`).join(" | "));
