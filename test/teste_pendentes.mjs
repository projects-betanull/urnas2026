// Quem paga e fecha a página antes da confirmação recebe os créditos ao consultar o saldo.
import worker from "../worker/src/index.js";
import { abrirD1 } from "./d1.mjs";
import assert from "node:assert/strict";
const DB = abrirD1(new URL("./exemplo.db", import.meta.url).pathname);
let pago = false;
const FETCH = async url => { const u = String(url);
  const r = u.includes("/.well-known/lnurlp/") ? { callback: "https://carteira.test/cb?x=1", minSendable: 1000, maxSendable: 1e11, tag: "payRequest" }
    : u.includes("/cb?") ? { pr: "lnbc20u1testeinvoice", verify: "https://carteira.test/verify/abc" }
    : u.includes("/verify/") ? { status: "OK", settled: pago } : {};
  return new Response(JSON.stringify(r)); };
const env = { DB, LN_ADDRESS: "dono@carteira.test", FETCH };
const call = (p, o = {}) => worker.fetch(new Request("https://site.test" + p, o), env, { waitUntil() {} });
const ped = await (await call("/api/creditos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pacote: "p1" }) })).json();
assert.ok(ped.chave);
let s = await (await call("/api/saldo", { headers: { authorization: "Bearer " + ped.chave } })).json();
assert.equal(s.creditos, 0);
pago = true; // pagou, mas a página foi fechada
s = await (await call("/api/saldo", { headers: { authorization: "Bearer " + ped.chave } })).json();
assert.equal(s.creditos, 500);
s = await (await call("/api/saldo", { headers: { authorization: "Bearer " + ped.chave } })).json();
assert.equal(s.creditos, 500, "não credita duas vezes");
console.log("pendentes ok: créditos entram ao consultar o saldo, uma vez só");
