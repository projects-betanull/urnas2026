import worker from "../worker/src/index.js";
import { paymentHashDaFatura } from "../worker/src/core.js";
import { abrirD1 } from "./d1.mjs";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";

const B32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function para5(bytes) { let acc = 0, bits = 0; const out = []; for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31); } } if (bits) out.push((acc << (5 - bits)) & 31); return out; }
function faturaFalsa(hashHex) {
  const h = para5(Buffer.from(hashHex, "hex")); assert.equal(h.length, 52);
  const desc = para5(Buffer.from("teste"));
  const words = [...Array(7).fill(3), 13, Math.floor(desc.length / 32), desc.length % 32, ...desc, 1, 1, 20, ...h, ...Array(104).fill(7), ...Array(6).fill(0)];
  return "lnbc20u1" + words.map(w => B32[w]).join("");
}
const pre = randomBytes(32).toString("hex");
const hash = createHash("sha256").update(Buffer.from(pre, "hex")).digest("hex");
const pr = faturaFalsa(hash);
assert.equal(paymentHashDaFatura(pr), hash); console.log("payment hash extraído corretamente");

const env = { DB: abrirD1(new URL("./exemplo.db", import.meta.url).pathname), LN_ADDRESS: "lizard43@coinos.io",
  FETCH: async u => new Response(JSON.stringify(String(u).includes("lnurlp") ? { callback: "https://coinos.io/cb" } : { pr })) }; // sem "verify"
const post = (p, b) => worker.fetch(new Request("https://s.test" + p, { method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json" } }), env, {});
let r = await (await post("/api/creditos", { pacote: "p2" })).json();
assert.equal(r.confirmacao_automatica, false); const chave = r.chave;
let x = await post(`/api/creditos/${r.pedido}/comprovante`, { preimage: randomBytes(32).toString("hex") }); assert.equal(x.status, 400); console.log("comprovante falso recusado:", (await x.json()).erro);
x = await (await post(`/api/creditos/${r.pedido}/comprovante`, { preimage: pre })).json(); assert.equal(x.creditos_na_chave, 2500);
x = await (await post(`/api/creditos/${r.pedido}/comprovante`, { preimage: pre })).json(); assert.equal(x.creditos_na_chave, 2500);
console.log("comprovante verdadeiro aceito, sem crédito em dobro:", x);
console.log("OK");

// Recuperar a chave perdida com o comprovante: nova chave com o saldo, antiga invalidada, sem crédito em dobro.
const pre2 = randomBytes(32).toString("hex");
const pr2 = faturaFalsa(createHash("sha256").update(Buffer.from(pre2, "hex")).digest("hex"));
env.FETCH = async u => new Response(JSON.stringify(String(u).includes("lnurlp") ? { callback: "https://coinos.io/cb" } : { pr: pr2 }));
r = await (await post("/api/creditos", { pacote: "p1" })).json(); const perdida = r.chave;
x = await post("/api/recuperar", { preimage: randomBytes(32).toString("hex") }); assert.equal(x.status, 404);
x = await (await post("/api/recuperar", { preimage: pre2 })).json();
assert.equal(x.creditos, 500); assert.notEqual(x.chave, perdida);
const saldo = k => worker.fetch(new Request("https://s.test/api/saldo", { headers: { authorization: "Bearer " + k } }), env, {});
assert.equal((await saldo(perdida)).status, 401);
assert.equal((await (await saldo(x.chave)).json()).creditos, 500);
const y = await (await post("/api/recuperar", { preimage: pre2 })).json();
assert.equal(y.creditos, 500); assert.equal((await saldo(x.chave)).status, 401);
console.log("recuperação ok: chave nova com 500 créditos, antiga invalidada, sem crédito em dobro");
