// Estatísticas de uso agregadas por dia (sem IP em claro: só um hash para contar visitantes únicos).
import { sha256 } from "./core.js";

// Hash SHA-256 da chave do painel. A chave em si fica só com o dono.
export const PAINEL_HASH = "ccd3b375aafdc2a49435f7f763b5ee1b4230efd50866c533d5de158d3035dac1";

let pronto = false;
async function preparar(db) {
  if (pronto) return;
  await db.prepare("CREATE TABLE IF NOT EXISTS uso (dia TEXT NOT NULL, tipo TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (dia, tipo))").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS uso_unico (dia TEXT NOT NULL, tipo TEXT NOT NULL, ip_hash TEXT NOT NULL, PRIMARY KEY (dia, tipo, ip_hash))").run();
  pronto = true;
}

// tipo: site | api | mcp_sessao | mcp_consulta | mcp_ferramenta:<nome> | mcp_cliente:<nome> | export
export async function registrar(db, tipo, ip) {
  try {
    await preparar(db);
    const dia = new Date().toISOString().slice(0, 10);
    await db.prepare("INSERT INTO uso (dia, tipo, n) VALUES (?, ?, 1) ON CONFLICT (dia, tipo) DO UPDATE SET n = n + 1").bind(dia, tipo).run();
    if (ip !== undefined) await db.prepare("INSERT OR IGNORE INTO uso_unico (dia, tipo, ip_hash) VALUES (?, ?, ?)").bind(dia, tipo, await sha256("uso:" + ip)).run();
  } catch (e) { /* estatística nunca derruba a requisição */ }
}

export async function chaveDoPainelOk(chave) {
  return !!chave && PAINEL_HASH.length === 64 && (await sha256(chave)) === PAINEL_HASH;
}

export async function resumo(db, dias = 30) {
  await preparar(db);
  const desde = new Date(Date.now() - (dias - 1) * 864e5).toISOString().slice(0, 10);
  const linhas = (await db.prepare("SELECT dia, tipo, n FROM uso WHERE dia >= ? ORDER BY dia DESC").bind(desde).all()).results;
  const unicos = (await db.prepare("SELECT dia, tipo, COUNT(*) u FROM uso_unico WHERE dia >= ? GROUP BY dia, tipo").bind(desde).all()).results;
  let pag = [];
  try { pag = (await db.prepare("SELECT substr(criado_em,1,10) dia, status, COUNT(*) q, SUM(sats) sats FROM pagamento GROUP BY 1, 2 ORDER BY 1 DESC LIMIT 60").all()).results; } catch {}
  return { linhas, unicos, pagamentos: pag };
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function htmlPainel(r) {
  const dias = [...new Set(r.linhas.map(l => l.dia))];
  const val = (d, t) => r.linhas.find(l => l.dia === d && l.tipo === t)?.n || 0;
  const uni = (d, t) => r.unicos.find(l => l.dia === d && l.tipo === t)?.u || 0;
  const tot = t => r.linhas.filter(l => l.tipo === t).reduce((a, l) => a + l.n, 0);
  const extras = pref => {
    const m = {}; for (const l of r.linhas) if (l.tipo.startsWith(pref)) m[l.tipo.slice(pref.length)] = (m[l.tipo.slice(pref.length)] || 0) + l.n;
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  };
  const tabela = (cab, rows) => `<table><tr>${cab.map(c => `<th>${esc(c)}</th>`).join("")}</tr>${rows.map(rw => `<tr>${rw.map(c => `<td>${esc(c)}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${cab.length}">Nada ainda.</td></tr>`}</table>`;
  const pagos = r.pagamentos.filter(p => p.status === "pago");
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Painel de uso</title>
<style>body{font:15px/1.4 system-ui,sans-serif;margin:0 auto;max-width:900px;padding:16px;color:#16191d}h1{font-size:20px}h2{font-size:16px;margin-top:28px}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{border-bottom:1px solid #e1e4e8;padding:6px 8px;text-align:right}th:first-child,td:first-child{text-align:left}.k{display:flex;gap:12px;flex-wrap:wrap}.k div{border:1px solid #e1e4e8;border-radius:8px;padding:10px 14px;min-width:140px}.k b{display:block;font-size:22px}small{color:#5b6470}</style></head><body>
<h1>Painel de uso: últimos 30 dias</h1>
<div class="k"><div><b>${tot("site")}</b>visitas ao site</div><div><b>${tot("mcp_consulta")}</b>consultas pelo MCP</div><div><b>${tot("mcp_sessao")}</b>conexões MCP</div><div><b>${tot("api")}</b>chamadas da API</div><div><b>${pagos.reduce((a, p) => a + p.q, 0)}</b>compras pagas</div><div><b>${pagos.reduce((a, p) => a + (p.sats || 0), 0)}</b>sats recebidos</div></div>
<h2>Por dia</h2>
${tabela(["Dia", "Visitas", "Visitantes", "Conexões MCP", "Consultas MCP", "Usuários MCP", "API", "Exportações"], dias.map(d => [d, val(d, "site"), uni(d, "site"), val(d, "mcp_sessao"), val(d, "mcp_consulta"), uni(d, "mcp_consulta"), val(d, "api"), val(d, "export")]))}
<h2>Ferramentas MCP mais usadas</h2>
${tabela(["Ferramenta", "Chamadas"], extras("mcp_ferramenta:"))}
<h2>Programas que conectaram ao MCP</h2>
${tabela(["Cliente", "Conexões"], extras("mcp_cliente:"))}
<h2>Pagamentos</h2>
${tabela(["Dia", "Situação", "Pedidos", "Sats"], r.pagamentos.map(p => [p.dia, p.status, p.q, p.sats || 0]))}
<p><small>Visitantes e usuários contados por hash diário do IP; nenhum IP é guardado. Atualize a página para ver números novos.</small></p></body></html>`;
}
