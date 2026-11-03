// Página /urnas: horários das urnas (logs oficiais), renderizada no servidor.
import { resumoUrnas, curvaUrnas, municipiosUrnas } from "./urnas.js";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const n = v => Number(v || 0).toLocaleString("pt-BR");
const pct = v => Number(v || 0).toFixed(1).replace(".", ",") + "%";

// Barras finas, uma cor, base no zero, grade discreta; <title> em cada barra dá o valor ao passar o mouse.
function grafico(pontos) {
  if (!pontos.length) return "";
  const W = 900, H = 260, E = 52, B = 30, T = 12, D = 8;
  const max = Math.max(...pontos.map(p => p.votos)), passo = Math.pow(10, Math.floor(Math.log10(max || 1)));
  const topo = Math.ceil(max / passo) * passo || 1, ticks = [0, .25, .5, .75, 1].map(f => f * topo);
  const iw = (W - E - D) / pontos.length, bw = Math.max(1, iw - 2), y = v => T + (H - T - B) * (1 - v / topo);
  const grade = ticks.map(t => `<line x1="${E}" x2="${W - D}" y1="${y(t)}" y2="${y(t)}" class="g"/><text x="${E - 6}" y="${y(t) + 4}" text-anchor="end" class="t">${n(t)}</text>`).join("");
  const barras = pontos.map((p, i) => { const x = E + i * iw + 1, h = Math.max(0, y(0) - y(p.votos));
    return `<path class="b" d="M${x},${y(0)}v${-Math.max(0, h - Math.min(4, h, bw / 2))}q0,-${Math.min(4, h, bw / 2)} ${Math.min(4, h, bw / 2)},-${Math.min(4, h, bw / 2)}h${Math.max(0, bw - 2 * Math.min(4, h, bw / 2))}q${Math.min(4, h, bw / 2)},0 ${Math.min(4, h, bw / 2)},${Math.min(4, h, bw / 2)}v${Math.max(0, h - Math.min(4, h, bw / 2))}z"><title>${p.inicio}: ${n(p.votos)} votos</title></path>`; }).join("");
  const rot = pontos.map((p, i) => p.inicio.endsWith(":00") && Number(p.inicio.slice(0, 2)) % 2 === 0 ? `<text x="${E + i * iw}" y="${H - 10}" class="t">${p.inicio.slice(0, 2)}h</text>` : "").join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Votos registrados a cada intervalo do dia" style="width:100%;min-width:640px;height:auto">${grade}${barras}${rot}<line x1="${E}" x2="${W - D}" y1="${y(0)}" y2="${y(0)}" class="a"/></svg>`;
}

export async function paginaUrnas(env, origem, q) {
  const turno = q.get("turno") === "1" ? 1 : 2, uf = /^[A-Za-z]{2}$/.test(q.get("uf") || "") ? q.get("uf").toUpperCase() : null;
  let resumo = { disponiveis: [], linhas: [] }, curva = { pontos: [] }, munis = null, erro = "";
  try { resumo = resumoUrnas(env, {}); curva = curvaUrnas(env, { turno, uf, intervalo: 10 }); if (uf) munis = await municipiosUrnas(env, { turno, uf }); }
  catch (e) { erro = e.message; }
  const disp = resumo.disponiveis, ufsT = disp.filter(d => d.turno === turno).map(d => d.uf).sort();
  const linhasT = resumo.linhas.filter(l => l.turno === turno);
  const tot = linhasT.reduce((a, l) => ({ s: a.s + l.secoes, v: a.v + l.votos, a17: a.a17 + l.votos_apos_17h, e18: a.e18 + l.secoes_encerradas_apos_18h }), { s: 0, v: 0, a17: 0, e18: 0 });
  const link = (t, u) => `/urnas?turno=${t}${u ? "&uf=" + u : ""}`;
  const corpo = `<h1>Horários das urnas nas eleições 2026</h1>
<p>Quando as urnas abriram, como os votos se distribuíram ao longo do dia e a que horas cada seção encerrou, segundo os logs oficiais publicados pelo TSE. O log registra o horário de cada voto, mas não em quem se votou.</p>
<p class="muted">Turno: ${[1, 2].map(t => t === turno ? `<b>${t}º</b>` : `<a href="${link(t, uf)}">${t}º</a>`).join(" · ")} · Estado: ${uf ? `<b>${esc(uf)}</b> · <a href="${link(turno)}">todos</a>` : "<b>todos os disponíveis</b>"}</p>
${erro ? `<div class="card">${esc(erro)}</div>` : ""}
${!ufsT.length && !erro ? `<div class="card">Os logs deste turno ainda estão sendo processados. Volte em breve.</div>` : ""}
${ufsT.length ? `<div class="card k"><div><b>${n(tot.s)}</b>seções</div><div><b>${n(tot.v)}</b>votos registrados</div><div><b>${pct(tot.v ? 100 * tot.a17 / tot.v : 0)}</b>dos votos depois das 17h</div><div><b>${n(tot.e18)}</b>seções encerradas depois das 18h</div></div>
<p class="muted">Estados já processados neste turno (${ufsT.length} de 28): ${ufsT.map(u => u === uf ? `<b>${u}</b>` : `<a href="${link(turno, u)}">${u}</a>`).join(" · ")}. Os demais entram conforme o processamento avança.</p>
<h2>Votos ao longo do dia${uf ? ` em ${esc(uf)}` : ""}, a cada 10 minutos</h2><div class="tw">${grafico(curva.pontos)}</div>
<p class="muted">Horário de Brasília${uf === "ZZ" ? " (exterior: horário local de cada país)" : uf ? "" : ", sem os votos do exterior"}. Passe o mouse sobre uma barra para ver o número.</p>` : ""}
${munis ? `<h2>Municípios de ${esc(uf)}: os que encerraram mais tarde</h2><div class="tw"><table><tr><th>Município</th><th class="r">Seções</th><th class="r">Encerramento médio</th><th class="r">Último encerramento</th><th class="r">Votos após 17h</th></tr>
${munis.linhas.filter(l => l.turno === turno).slice(0, 50).map(l => `<tr><td>${esc(l.municipio)}</td><td class="r">${n(l.secoes)}</td><td class="r">${l.encerramento_medio || "–"}</td><td class="r">${l.ultimo_encerramento || "–"}</td><td class="r">${l.pct_votos_apos_17h == null ? "–" : pct(l.pct_votos_apos_17h)}</td></tr>`).join("")}</table></div>
${munis.linhas.some(l => l.pct_votos_apos_17h == null) ? `<p class="muted">“–”: este estado foi processado antes da correção de fuso; o percentual por município volta quando os logs forem reprocessados.</p>` : ""}
<p class="muted">Lista completa de municípios e os horários seção por seção: pela API (<code>/api/urnas/municipios?uf=${esc(uf)}</code>, <code>/api/urnas/secoes?uf=${esc(uf)}&amp;exportar=1</code>) ou pela ferramenta <code>horarios_urnas</code> do servidor MCP, na cobrança normal de créditos.</p>` : ""}
${linhasT.length ? `<h2>Por estado</h2><div class="tw"><table><tr><th>UF</th><th class="r">Seções</th><th class="r">Primeira abertura</th><th class="r">Encerramento médio</th><th class="r">Após 18h</th><th class="r">Último encerramento</th><th class="r">Votos após 17h</th></tr>
${linhasT.map(l => `<tr><td><a href="${link(turno, l.uf)}">${l.uf}</a></td><td class="r">${n(l.secoes)}</td><td class="r">${l.primeira_abertura || "–"}</td><td class="r">${l.encerramento_medio || "–"}</td><td class="r">${n(l.secoes_encerradas_apos_18h)}</td><td class="r">${l.ultimo_encerramento || "–"}</td><td class="r">${pct(l.pct_votos_apos_17h)}</td></tr>`).join("")}</table></div>` : ""}
<h2>Como ler</h2><p class="muted">Todos os horários estão no horário de Brasília: a votação vai das 8h às 17h de Brasília no país inteiro, o que no Acre, por exemplo, corresponde a 6h e 15h locais. No exterior vale o horário local de cada país. As urnas fecham às 17h, mas quem já está na fila vota depois, por isso há seções que encerram mais tarde. Encerramento tardio indica fila longa na hora do fechamento; sozinho, não diz nada sobre o resultado. Para comparar resultados por horário de encerramento, compare seções dentro do mesmo município, onde o perfil do eleitorado é parecido.</p>`;
  const css = `<style>.b{fill:var(--acc)}.g{stroke:var(--line);stroke-width:1}.a{stroke:var(--muted);stroke-width:1}.t{fill:var(--muted);font-size:11px}</style>`;
  const { paginaBase } = await import("./paginas.js");
  return paginaBase({ titulo: `Horários das urnas nas eleições 2026${uf ? " em " + uf : ""}: abertura, votos por hora e encerramento`, descricao: `Quando as urnas abriram e encerraram nas eleições 2026${uf ? " em " + uf : ""}, e como os votos se distribuíram ao longo do dia, segundo os logs oficiais do TSE.`, canonico: link(turno, uf), corpo: css + corpo, origem });
}
