// Servidor de produção (VM): o mesmo código do Worker, com SQLite local no lugar do D1.
import http from "node:http";
import { readFileSync } from "node:fs";
const LOGS = process.env.LOGS_DIR || "/srv/eleicoes/logs";
const VERSAO = (() => { try { return readFileSync("/srv/eleicoes/versao", "utf8").trim(); } catch { return ""; } })();
import worker from "../worker/src/index.js";
import { abrirD1, abrirUrnas, derivarTempos, ESTADO } from "../test/d1.mjs";
import os from "node:os";
import { readdirSync, statSync, readFileSync as lerArq } from "node:fs";
import { appendFileSync } from "node:fs";
const env = { DB: abrirD1(process.env.DB_PATH || "/srv/eleicoes/dados.db"), LN_ADDRESS: process.env.LN_ADDRESS || "lizard43@coinos.io", VERSAO, URNAS: abrirUrnas(process.env.LOGS_DIR || "/srv/eleicoes/logs"), SAUDE: saude };
// Saúde do servidor para o painel (só leitura): memória, carga, processamento dos logs e da base derivada.
function saude() {
  const mi = {}; try { for (const l of lerArq("/proc/meminfo", "utf8").split("\n")) { const m = l.match(/^(\w+):\s+(\d+)/); if (m) mi[m[1]] = Number(m[2]) * 1024; } } catch {}
  const procs = [];
  try { for (const pid of readdirSync("/proc").filter(x => /^\d+$/.test(x))) { try { const c = lerArq(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    if (/logs\.py|logs_todos|curl .*arqurnatot/.test(c)) procs.push(c.replace(/^.*\/(etl|deploy)\//, "").slice(0, 120)); } catch {} } } catch {}
  const arq = d => { try { return readdirSync(d).map(f => { const st = statSync(d + "/" + f); return { f, mb: +(st.size / 1048576).toFixed(1), em: st.mtime.toISOString().slice(0, 16).replace("T", " ") }; }).sort((a, b) => b.em.localeCompare(a.em)); } catch { return []; } };
  return { memoria_total_mb: Math.round(os.totalmem() / 1048576), memoria_livre_mb: Math.round((mi.MemAvailable || os.freemem()) / 1048576),
    swap_usado_mb: mi.SwapTotal ? Math.round((mi.SwapTotal - mi.SwapFree) / 1048576) : null, carga: os.loadavg().map(x => +x.toFixed(2)),
    servidor_mb: Math.round(process.memoryUsage().rss / 1048576), no_ar_desde: new Date(Date.now() - process.uptime() * 1000).toISOString().slice(0, 16).replace("T", " "),
    base_derivada: { ...ESTADO }, processos_logs: procs, download_atual: arq("/srv/eleicoes/logs_tmp").slice(0, 3), logs_recentes: arq(LOGS).slice(0, 6) };
}

http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const c of req) chunks.push(c);
    const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    headers.set("cf-connecting-ip", req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress);
    const r = await worker.fetch(new Request("https://" + (req.headers.host || "localhost") + req.url, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) }), env, { waitUntil() {} });
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) { console.error(e); res.writeHead(500); res.end("erro"); }
}).listen(Number(process.env.PORT || 8080), "127.0.0.1", () => console.log("ouvindo"));

// Em segundo plano: gera as bases de "tempo do voto desde a abertura" para os estados já processados.
let derivando = false;
const derivar = async () => {
  if (derivando) return; derivando = true;
  try { await derivarTempos(LOGS, m => { try { appendFileSync("/srv/eleicoes/status.txt", `${new Date().toISOString().slice(0, 19)}Z ${m}\n`); } catch {} }, nome => env.URNAS.soltar(nome)); }
  catch (e) { console.error("derivarTempos", e); } finally { derivando = false; }
};
setTimeout(derivar, 60_000); setInterval(derivar, 3600_000);
