// Cruza horários das urnas com votos por seção (etl/secao.py) no explorador de horários.
// Prepara: python3 test/gerar_logs.py /tmp/tu && python3 etl/logs.py /tmp/tu /tmp/tu/logs/2t_SP && (zip BR) && python3 etl/secao.py
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { abrirD1, abrirUrnas, derivarTempos } from "./d1.mjs";
import { explorarUrnas, valoresUrnas } from "../worker/src/explorar_urnas.js";
import { resumoUrnas, curvaUrnas, distribuicaoUrnas, municipiosUrnas } from "../worker/src/urnas.js";
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

// O log do 2º turno traz também os eventos da mesma urna no 1º turno (04/10). A base 2t_SP não pode
// responder pelo 1º turno nem misturar os dois dias.
const res = resumoUrnas(env, {});
assert.deepEqual(res.linhas.map(l => `${l.turno} ${l.uf}`), ["2 SP"], "base do 2º turno só responde pelo 2º turno");
const cv = curvaUrnas(env, { turno: 2, intervalo: 10 });
assert.ok(cv.pontos.length && cv.pontos.every(x => x.turno === 2), "curva do 2º turno só tem o 2º turno");
assert.equal(cv.pontos.reduce((a, x) => a + x.votos, 0), res.linhas[0].votos, "curva soma os votos do turno");
assert.equal(curvaUrnas(env, { turno: 1 }).pontos.length, 0);
for (const visao of ["horario_voto", "encerramento", "duracao"]) assert.equal(distribuicaoUrnas(env, { turno: 2, visao }).total_votos, res.linhas[0].votos, visao);
assert.ok((await municipiosUrnas(env, { turno: 2, uf: "SP" })).linhas.every(l => l.turno === 2));
const tot2 = (await explorarUrnas(env, { medida: "votos", linhas: "uf" })).linhas.reduce((a, l) => a + l.valor, 0);
assert.equal(tot2, res.linhas[0].votos, "explorador sem filtro de turno não duplica o 1º turno");
await derivarTempos(P + "/logs", () => {}, nome => env.URNAS.soltar(nome));
assert.equal(distribuicaoUrnas(env, { turno: 2, visao: "tempo_voto" }).total_votos, res.linhas[0].votos, "tempo desde a abertura só com o 2º turno");
// Encerramento = confirmação do mesário, não a tentativa cancelada nem o "Inicio do Encerramento" (depois do registro dos mesários).
const encs = new DatabaseSync(P + "/logs/2t_SP_tempos.db", { readOnly: true }).prepare("SELECT DISTINCT encerramento FROM secao_tempo WHERE turno = 1").all().map(r => r.encerramento);
assert.deepEqual(encs, ["18:30:00"]);
console.log("teste_urnas_cand ok", p.linhas.map(l => `${l.linha} ${l.coluna} ${l.valor.toFixed(1)}`).join(" | "));
