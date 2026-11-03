import worker from "../worker/src/index.js";
import { abrirD1 } from "./d1.mjs";
import assert from "node:assert/strict";
const env = { DB: abrirD1(new URL("./exemplo.db", import.meta.url).pathname), LN_ADDRESS: "lizard43@coinos.io",
  FETCH: async u => new Response(JSON.stringify(String(u).includes("coingecko") ? { bitcoin: { brl: 400000 } } : {})) };
const post = (b, h = {}) => worker.fetch(new Request("https://s.test/api/explorar", { method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json", "cf-connecting-ip": "5.5.5.5", ...h } }), env, {});
const site = { "x-origem": "site", "sec-fetch-site": "same-origin" };
// Navegação do site: livre, não consome cota da API
for (let i = 0; i < 80; i++) { const r = await post({ linhas: "uf" }, site); assert.equal(r.status, 200); }
let r = await (await post({ linhas: "uf" }, site)).json(); assert.equal(r.cobranca.modo, "site"); console.log("80+ consultas no site: livres");
// Mesmo IP pela API continua com cota grátis intacta
r = await (await post({ linhas: "uf" })).json(); assert.equal(r.cobranca.modo, "gratis"); assert.equal(r.cobranca.restante, 59); console.log("cota da API intacta:", r.cobranca.restante);
// Exportar a partir do site é cobrado (cota/créditos)
r = await post({ linhas: "candidato", exportar: true }, site); assert.equal(r.status, 200);
r = await (await post({ linhas: "uf" })).json(); assert.ok(r.cobranca.restante < 58); console.log("exportação cobrada; cota restante:", r.cobranca.restante);
// Site de outra origem não ganha navegação livre
r = await (await post({ linhas: "uf" }, { "x-origem": "site", "sec-fetch-site": "cross-site" })).json(); assert.equal(r.cobranca.modo, "gratis");
// Preço em reais
const m = await (await worker.fetch(new Request("https://s.test/api/meta"), env, {})).json();
console.log("pacotes em reais:", Object.values(m.pacotes).map(p => `${p.sats} sats ≈ R$ ${p.reais}`).join(" | "));
assert.equal(m.pacotes.p1.reais, 8);
console.log("OK");
