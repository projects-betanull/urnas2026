// Páginas renderizadas no servidor (para o Google e para links compartilháveis): estados e candidatos.
const UFS = { BR: "Brasil (Presidente)", AC: "Acre", AL: "Alagoas", AM: "Amazonas", AP: "Amapá", BA: "Bahia", CE: "Ceará", DF: "Distrito Federal",
  ES: "Espírito Santo", GO: "Goiás", MA: "Maranhão", MG: "Minas Gerais", MS: "Mato Grosso do Sul", MT: "Mato Grosso", PA: "Pará", PB: "Paraíba",
  PE: "Pernambuco", PI: "Piauí", PR: "Paraná", RJ: "Rio de Janeiro", RN: "Rio Grande do Norte", RO: "Rondônia", RR: "Roraima", RS: "Rio Grande do Sul",
  SC: "Santa Catarina", SE: "Sergipe", SP: "São Paulo", TO: "Tocantins" };
export const LISTA_UFS = Object.keys(UFS);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const n = v => Number(v || 0).toLocaleString("pt-BR");
const reais = v => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const slug = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const titulo = s => String(s || "").toLowerCase().replace(/(^|\s|-)\S/g, m => m.toUpperCase()).replace(/ (Por|De|Da|Do|Dos|Das|E) /g, m => m.toLowerCase()).replace(/\bQp\b/g, "QP");
// Botão "i": a explicação fica escondida numa caixa e só aparece quando a pessoa clica.
export const botaoInfo = (id, rotulo = "Mais informações") => `<button type="button" class="ib" aria-expanded="false" aria-controls="${id}" title="${esc(rotulo)}" aria-label="${esc(rotulo)}">i</button>`;
export const caixaInfo = (id, html) => `<div class="ibox" id="${id}" hidden>${html}</div>`;
export const linkCandidato = c => `/candidato/${c.sq_candidato}-${slug(c.nome_urna)}`;

function pagina({ titulo: t, descricao, canonico, corpo, origem }) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t)}</title><meta name="description" content="${esc(descricao)}"><link rel="canonical" href="${origem}${canonico}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(t)}"><meta property="og:description" content="${esc(descricao)}"><meta property="og:url" content="${origem}${canonico}"><meta property="og:locale" content="pt_BR">
<style>:root{--bg:#f4f5f7;--card:#fff;--ink:#16191d;--muted:#5b6470;--line:#e1e4e8;--acc:#0b6e4f}@media (prefers-color-scheme:dark){:root{--bg:#0f1214;--card:#171b1f;--ink:#e8eaed;--muted:#9aa3ad;--line:#2a3036;--acc:#34c48e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header{background:var(--card);border-bottom:1px solid var(--line)}header div,main{max-width:1000px;margin:0 auto;padding:12px 18px}
header a{color:var(--ink);text-decoration:none;font-weight:700}a{color:var(--acc)}h1{font-size:24px;margin:8px 0 4px}h2{font-size:18px;margin:26px 0 8px}
.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:12px 0}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left}td.r,th.r{text-align:right}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:6px}.k{display:flex;gap:14px;flex-wrap:wrap}.k div b{display:block;font-size:20px}
.ib{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;border:1.5px solid var(--muted);background:transparent;color:var(--muted);font:italic 700 13px Georgia,serif;padding:0;margin-left:6px;cursor:pointer;vertical-align:middle;line-height:1}.ib:hover,.ib[aria-expanded=true]{background:var(--acc);border-color:var(--acc);color:#fff}.ib:focus-visible{outline:2px solid var(--acc);outline-offset:2px}.ibox{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--acc);border-radius:8px;padding:10px 14px;margin:8px 0 12px;font-size:14px;font-weight:400}.ibox p{margin:6px 0}
.tw{overflow-x:auto}footer{max-width:1000px;margin:0 auto;padding:20px 18px 40px;color:var(--muted);font-size:13px}</style></head><body>
<header><div><a href="/">Eleições 2026 em dados</a> · <a href="/estados" style="font-weight:400">Estados</a> · <a href="/urnas" style="font-weight:400">Horários das urnas</a> · <a href="/#mcp" style="font-weight:400">Usar com IA (MCP)</a></div></header>
<main>${corpo}</main>
<script>document.addEventListener("click",e=>{const b=e.target.closest(".ib");if(!b)return;e.preventDefault();const x=document.getElementById(b.getAttribute("aria-controls"));if(!x)return;x.hidden=!x.hidden;b.setAttribute("aria-expanded",String(!x.hidden));});</script>
<footer>Fonte: Tribunal Superior Eleitoral, Portal de Dados Abertos (resultados e candidaturas de 2026). Site independente, sem ligação com o TSE. Para cruzar, filtrar e exportar estes dados, use o <a href="/">explorador</a> ou o servidor MCP em <code>${origem}/mcp</code>.</footer></body></html>`;
}
export const paginaBase = o => new Response(pagina(o), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "max-age=300" } });
const resp = html => new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "max-age=3600" } });
const naoAchou = origem => new Response(pagina({ titulo: "Página não encontrada", descricao: "", canonico: "/", origem, corpo: `<h1>Página não encontrada</h1><p><a href="/estados">Ver estados</a></p>` }), { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });

export async function paginaEstados(db, origem) {
  const corpo = `<h1>Resultados das eleições 2026 por estado</h1><p class="muted">Escolha um estado para ver os candidatos mais votados para cada cargo, no 1º e no 2º turno.</p>
<div class="grid">${LISTA_UFS.map(u => `<a class="card" href="/uf/${u}">${esc(UFS[u])}</a>`).join("")}</div>`;
  return resp(pagina({ titulo: "Eleições 2026 por estado: resultados oficiais do TSE", descricao: "Resultados oficiais das eleições 2026 em cada estado: governador, senador, deputados e presidente, com votos e situação dos candidatos.", canonico: "/estados", corpo, origem }));
}

export async function paginaUF(db, origem, uf) {
  uf = String(uf || "").toUpperCase();
  if (!UFS[uf]) return naoAchou(origem);
  const linhas = (await db.prepare(
    `SELECT c.sq_candidato, c.turno, c.cargo, c.nome_urna, c.partido, c.situacao, COALESCE(v.votos,0) votos
     FROM candidato c LEFT JOIN voto_total v ON v.sq_candidato=c.sq_candidato AND v.turno=c.turno
     WHERE c.uf = ? ORDER BY c.cargo, c.turno, votos DESC`).bind(uf).all()).results;
  if (!linhas.length) return naoAchou(origem);
  const grupos = {};
  for (const l of linhas) if (l.votos > 0 || l.situacao) (grupos[`${l.cargo}|${l.turno}`] ||= []).push(l);
  for (const k of Object.keys(grupos)) if (!grupos[k].some(l => l.votos > 0)) delete grupos[k]; // vices e suplentes não recebem voto próprio
  const ordemCargo = ["PRESIDENTE", "GOVERNADOR", "SENADOR", "DEPUTADO FEDERAL", "DEPUTADO ESTADUAL", "DEPUTADO DISTRITAL"];
  const chaves = Object.keys(grupos).sort((a, b) => { const [ca, ta] = a.split("|"), [cb, tb] = b.split("|");
    return (ordemCargo.indexOf(ca) + 99 * (ordemCargo.indexOf(ca) < 0)) - (ordemCargo.indexOf(cb) + 99 * (ordemCargo.indexOf(cb) < 0)) || ta - tb; });
  const nome = UFS[uf], cargos = [...new Set(Object.keys(grupos).map(k => titulo(k.split("|")[0])))];
  const blocos = chaves.map(k => { const [cargo, turno] = k.split("|"), g = grupos[k], tot = g.reduce((s, x) => s + x.votos, 0), top = g.slice(0, 30);
    return `<h2>${esc(titulo(cargo))}: ${turno}º turno</h2><p class="muted">${n(g.length)} candidatos, ${n(tot)} votos nominais.${g.length > 30 ? " Os 30 mais votados:" : ""}</p>
<div class="tw"><table><tr><th>Candidato</th><th>Partido</th><th>Situação</th><th class="r">Votos</th><th class="r">%</th></tr>${top.map(c => `<tr><td><a href="${linkCandidato(c)}">${esc(c.nome_urna)}</a></td><td>${esc(c.partido)}</td><td>${esc(titulo(c.situacao))}</td><td class="r">${n(c.votos)}</td><td class="r">${tot ? (100 * c.votos / tot).toFixed(1).replace(".", ",") : "0"}</td></tr>`).join("")}</table></div>`; }).join("");
  const eleitos = linhas.filter(l => /^ELEITO/.test(l.situacao || "")).length;
  const corpo = `<h1>Eleições 2026 ${uf === "BR" ? "para presidente" : "em " + esc(nome)}</h1><p class="muted">Resultados oficiais do TSE, 1º e 2º turno.</p>
<div class="card k"><div><b>${n(new Set(linhas.map(l => l.sq_candidato)).size)}</b>candidatos</div><div><b>${n(eleitos)}</b>eleitos</div><div><b>${cargos.length}</b>cargos</div></div>${blocos}
<p><a href="/">Cruzar estes dados por município, partido e perfil no explorador</a></p>`;
  return resp(pagina({ titulo: `Eleições 2026 ${uf === "BR" ? "para presidente" : "em " + nome}: votos e eleitos por cargo`, descricao: `Resultados oficiais das eleições 2026 ${uf === "BR" ? "para presidente" : "em " + nome}: ${cargos.join(", ")}. Votos, percentuais e situação de cada candidato, segundo o TSE.`, canonico: `/uf/${uf}`, corpo, origem }));
}

export async function paginaCandidato(db, origem, sq) {
  const turnos = (await db.prepare(`SELECT c.*, COALESCE(t.votos,0) votos FROM candidato c LEFT JOIN voto_total t ON t.sq_candidato=c.sq_candidato AND t.turno=c.turno WHERE c.sq_candidato = ? ORDER BY c.turno`).bind(String(sq)).all()).results;
  if (!turnos.length) return naoAchou(origem);
  const c = turnos[turnos.length - 1], canon = linkCandidato(c);
  const muni = (await db.prepare(`SELECT turno, municipio, votos FROM voto_municipio WHERE sq_candidato = ? AND turno = ? ORDER BY votos DESC LIMIT 20`).bind(String(sq), c.turno).all()).results;
  const nmun = (await db.prepare(`SELECT COUNT(*) q FROM voto_municipio WHERE sq_candidato = ? AND turno = ? AND votos > 0`).bind(String(sq), c.turno).first())?.q || 0;
  const bens = (await db.prepare(`SELECT tipo, descricao, valor FROM bem WHERE sq_candidato = ? ORDER BY valor DESC`).bind(String(sq)).all()).results;
  const patr = bens.reduce((s, b) => s + (b.valor || 0), 0);
  const local = c.uf === "BR" ? "Brasil" : (UFS[c.uf] || c.uf);
  const res = turnos.map(t => `${t.turno}º turno: ${n(t.votos)} votos (${titulo(t.situacao)})`).join("; ");
  const corpo = `<p class="muted"><a href="/uf/${esc(c.uf)}">${esc(local)}</a> · ${esc(titulo(c.cargo))}</p>
<h1>${esc(c.nome_urna)} (${esc(c.partido)}) ${c.numero ? `· ${esc(c.numero)}` : ""}</h1><p class="muted">${esc(titulo(c.nome))}, candidato(a) a ${esc(titulo(c.cargo).toLowerCase())} ${c.uf === "BR" ? "" : "em " + esc(local)} nas eleições de 2026.</p>
<div class="card k">${turnos.map(t => `<div><b>${n(t.votos)}</b>votos no ${t.turno}º turno · ${esc(titulo(t.situacao))}</div>`).join("")}<div><b>${reais(patr)}</b>patrimônio declarado</div></div>
<h2>Perfil</h2><table><tr><th>Partido</th><td>${esc(c.partido)}${c.federacao ? ` (${esc(c.federacao)})` : ""}</td></tr>${c.coligacao ? `<tr><th>Coligação</th><td>${esc(c.coligacao)}</td></tr>` : ""}<tr><th>Ocupação</th><td>${esc(titulo(c.ocupacao))}</td></tr><tr><th>Instrução</th><td>${esc(titulo(c.instrucao))}</td></tr><tr><th>Gênero</th><td>${esc(titulo(c.genero))}</td></tr><tr><th>Cor/raça</th><td>${esc(titulo(c.cor_raca))}</td></tr></table>
${muni.length ? `<h2>Onde foi mais votado(a) no ${c.turno}º turno</h2><p class="muted">Recebeu votos em ${n(nmun)} municípios. Os 20 com mais votos:</p><div class="tw"><table><tr><th>Município</th><th class="r">Votos</th></tr>${muni.map(m => `<tr><td>${esc(titulo(m.municipio))}</td><td class="r">${n(m.votos)}</td></tr>`).join("")}</table></div>` : ""}
${bens.length ? `<h2>Bens declarados ao TSE</h2><div class="tw"><table><tr><th>Tipo</th><th>Descrição</th><th class="r">Valor</th></tr>${bens.slice(0, 40).map(b => `<tr><td>${esc(titulo(b.tipo))}</td><td>${esc(b.descricao)}</td><td class="r">${reais(b.valor)}</td></tr>`).join("")}</table></div>${bens.length > 40 ? `<p class="muted">Mais ${bens.length - 40} bens no explorador.</p>` : ""}` : `<h2>Bens declarados ao TSE</h2><p class="muted">Nenhum bem declarado.</p>`}
<p><a href="/">Ver votos por município de todos os candidatos no explorador</a></p>`;
  return resp(pagina({ titulo: `${c.nome_urna} (${c.partido}) ${titulo(c.cargo)} ${c.uf === "BR" ? "" : c.uf + " "}2026: votos e bens`, descricao: `${c.nome_urna} (${c.partido}), ${titulo(c.cargo).toLowerCase()} ${c.uf === "BR" ? "" : "em " + local} nas eleições 2026. ${res}. Patrimônio declarado: ${reais(patr)}.`, canonico: canon, corpo, origem }));
}

let cacheMapa = null;
export async function sitemap(db, origem) {
  if (!cacheMapa || Date.now() - cacheMapa.t > 864e5) {
    const cs = (await db.prepare("SELECT sq_candidato, MAX(nome_urna) nome_urna FROM candidato GROUP BY sq_candidato").all()).results;
    cacheMapa = { t: Date.now(), urls: ["/", "/estados", "/urnas", "/urnas?turno=1", "/llms.txt", ...LISTA_UFS.map(u => `/uf/${u}`), ...cs.map(linkCandidato)] };
  }
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${cacheMapa.urls.map(u => `<url><loc>${origem}${u}</loc></url>`).join("")}</urlset>\n`, { headers: { "content-type": "application/xml", "cache-control": "max-age=3600" } });
}
