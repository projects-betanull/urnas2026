import http from "node:http";
import worker from "../worker/src/index.js";
import { abrirD1 } from "./d1.mjs";
const env = { DB: abrirD1(new URL("./exemplo.db", import.meta.url).pathname), LN_ADDRESS: "dono@carteira.test",
  FETCH: async u => new Response(JSON.stringify(String(u).includes("lnurlp") ? { callback: "https://c.test/cb" } : String(u).includes("/cb") ? { pr: "lnbc20u1exemplo", verify: "https://c.test/v" } : { settled: true })) };
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = await worker.fetch(new Request("http://localhost:8787" + req.url, { method: req.method, headers: req.headers, body: ["GET","HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) }), env, { waitUntil() {} });
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8787, () => console.log("ouvindo 8787"));
