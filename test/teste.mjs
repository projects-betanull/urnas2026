import worker from "../worker/src/index.js";
import { abrirD1 } from "./d1.mjs";
import assert from "node:assert/strict";

const DB = abrirD1(new URL("./exemplo.db", import.meta.url).pathname);
let pago = false;
const FETCH = async url => {
  const u = String(url);
  const r = u.includes("/.well-known/lnurlp/") ? { callback: "https://carteira.test/cb?x=1", minSendable: 1000, maxSendable: 1e11, tag: "payRequest" }
    : u.includes("/cb?") ? { pr: "lnbc20u1testeinvoice", verify: "https://carteira.test/verify/abc" }
    : u.includes("/verify/") ? { status: "OK", settled: pago, preimage: pago ? "00" : null }
    : {};
  return new Response(JSON.stringify(r));
};
const env = { DB, LN_ADDRESS: "dono@carteira.test", FETCH };
const call = (path, opts = {}) => worker.fetch(new Request("https://site.test" + path, opts), env, { waitUntil() {} });
const post = (path, body, h = {}) => call(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "cf-connecting-ip": "1.2.3.4", ...h } });

// Site
let r = await call("/"); assert.equal(r.status, 200); assert.match(await r.text(), /Eleições 2026 em dados/);
// Meta
r = await (await call("/api/meta")).json(); assert.ok(r.dimensoes.uf); console.log("meta ok:", r.meta.total_candidatos, "candidatos");

// Explorar: votos por UF, presidente 1º turno
r = await (await post("/api/explorar", { medida: "votos", linhas: "uf", filtros: { turno: ["1"], cargo: ["PRESIDENTE"] } })).json();
console.log("pres por UF:", r.linhas.map(l => `${l.chave}=${l.total}`).join(" "), "| cota:", r.cobranca);
const soma = (await DB.prepare("SELECT SUM(v.votos) s FROM voto_municipio v JOIN candidato c USING(sq_candidato, turno) WHERE c.cargo='PRESIDENTE' AND v.turno=1").first()).s;
assert.equal(r.total_geral, soma);

// Pivot partido x UF, deputados
r = await (await post("/api/explorar", { medida: "votos", linhas: "partido", colunas: "uf", filtros: { turno: ["1"], cargo: ["DEPUTADO FEDERAL"] } })).json();
console.log("pivot colunas:", r.colunas, "linha1:", r.linhas[0]);
assert.equal(r.linhas.reduce((s, l) => s + l.total, 0), r.total_geral);

// Drill: município dentro de SP
r = await (await post("/api/explorar", { medida: "votos", linhas: "municipio", filtros: { turno: ["2"], uf: ["SP"] }, colunas: "candidato" })).json();
console.log("2º turno SP por município:", r.linhas.map(l => l.chave).join(", "), r.colunas);
assert.equal(r.linhas.length, 3);

// Eleitos por partido (fonte candidato) e patrimônio
r = await (await post("/api/explorar", { medida: "eleitos", linhas: "partido", filtros: { turno: ["1"] } })).json();
console.log("eleitos por partido:", r.linhas.map(l => `${l.chave}=${l.total}`).join(" "));
r = await (await post("/api/explorar", { medida: "patrimonio", linhas: "cargo", colunas: "genero" })).json();
console.log("patrimônio por cargo:", r.linhas.map(l => `${l.chave}=${Math.round(l.total)}`).join(" "));
// Patrimônio x município deve recusar
r = await post("/api/explorar", { medida: "patrimonio", linhas: "municipio" }); assert.equal(r.status, 400);
// Dimensão inválida (injeção) recusada
r = await post("/api/explorar", { linhas: "uf; DROP TABLE candidato" }); assert.equal(r.status, 400);
r = await post("/api/explorar", { linhas: "uf", filtros: { uf: ["SP' OR 1=1 --"] } }); assert.equal((await r.json()).linhas.length, 0);

// Candidatos e detalhe
r = await (await call("/api/candidatos?cargo=PRESIDENTE&turno=2", { headers: { "cf-connecting-ip": "1.2.3.4" } })).json();
const sq = r.candidatos[0].sq_candidato; console.log("presidente eleito:", r.candidatos[0].nome_urna, r.candidatos[0].votos, r.candidatos[0].situacao);
r = await (await call("/api/candidato/" + sq, { headers: { "cf-connecting-ip": "1.2.3.4" } })).json();
assert.equal(r.candidato.length, 2); assert.ok(!JSON.stringify(r).includes("12345678900"), "CPF vazou!");

// Exportar CSV
r = await post("/api/explorar", { linhas: "candidato", filtros: { turno: ["1"] }, exportar: true });
const txt = await r.text(); console.log("csv:", txt.split("\n").length - 1, "linhas; cabeçalho:", txt.split("\n")[0]);

// Cota grátis esgota -> 402
let ultimo;
for (let i = 0; i < 70; i++) { ultimo = await post("/api/explorar", { linhas: "uf" }, { "cf-connecting-ip": "9.9.9.9" }); if (ultimo.status !== 200) break; }
assert.equal(ultimo.status, 402); console.log("cota esgotada:", (await ultimo.json()).erro);

// Compra de créditos
r = await (await post("/api/creditos", { pacote: "p1" })).json();
assert.ok(r.chave.startsWith("tse_")); const chave = r.chave;
let s = await (await call("/api/creditos/" + r.pedido)).json(); assert.equal(s.status, "pendente"); assert.equal(s.creditos_na_chave, 0);
pago = true;
s = await (await call("/api/creditos/" + r.pedido)).json(); assert.equal(s.status, "pago"); assert.equal(s.creditos_na_chave, 500);
s = await (await call("/api/creditos/" + r.pedido)).json(); assert.equal(s.creditos_na_chave, 500, "crédito em dobro!");
console.log("pagamento confirmado, créditos:", s.creditos_na_chave);
// Usa a chave depois da cota esgotada do IP
r = await (await post("/api/explorar", { linhas: "uf" }, { "cf-connecting-ip": "9.9.9.9", "x-chave": chave })).json();
assert.equal(r.cobranca.modo, "creditos"); assert.equal(r.cobranca.restante, 499);
// Chave inválida
r = await post("/api/explorar", { linhas: "uf" }, { "x-chave": "tse_falsa" }); assert.equal(r.status, 401);

// MCP
const rpc = (m, h = {}) => post("/mcp", m, h);
r = await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })).json();
assert.equal(r.result.serverInfo.name, "eleicoes-2026-br");
r = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }); assert.equal(r.status, 202);
r = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json(); console.log("ferramentas MCP:", r.result.tools.map(t => t.name).join(", "));
r = await (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "explorar", arguments: { linhas: "partido", medida: "eleitos", filtros: { cargo: ["DEPUTADO FEDERAL"] } } } }, { authorization: "Bearer " + chave })).json();
const sc = r.result.structuredContent; console.log("MCP explorar:", sc.linhas.map(l => `${l.chave}=${l.total}`).join(" "), "| restante:", sc.cobranca.restante);
r = await (await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "detalhar_candidato", arguments: { sq_candidato: sq } } }, { authorization: "Bearer " + chave })).json();
assert.ok(!r.result.isError);
r = await (await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "saldo", arguments: {} } }, { authorization: "Bearer " + chave })).json();
console.log("MCP saldo:", r.result.structuredContent);
console.log("\nTODOS OS TESTES PASSARAM");
