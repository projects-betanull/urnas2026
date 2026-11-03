// Servidor de produção (VM): o mesmo código do Worker, com SQLite local no lugar do D1.
import http from "node:http";
import { readFileSync } from "node:fs";
const VERSAO = (() => { try { return readFileSync("/srv/eleicoes/versao", "utf8").trim(); } catch { return ""; } })();
import worker from "../worker/src/index.js";
import { abrirD1, abrirUrnas } from "../test/d1.mjs";
const env = { DB: abrirD1(process.env.DB_PATH || "/srv/eleicoes/dados.db"), LN_ADDRESS: process.env.LN_ADDRESS || "lizard43@coinos.io", VERSAO, URNAS: abrirUrnas(process.env.LOGS_DIR || "/srv/eleicoes/logs") };
http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const c of req) chunks.push(c);
    const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    headers.set("cf-connecting-ip", req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress);
    const r = await worker.fetch(new Request("https://" + (req.headers.host || "localhost") + req.url, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) }), env, { waitUntil() {} });
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) { console.error(e); res.writeHead(500); res.end("erro"); }
}).listen(Number(process.env.PORT || 8080), "127.0.0.1", () => console.log("ouvindo"));
