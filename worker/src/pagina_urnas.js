// Página /urnas: horários das urnas (logs oficiais), renderizada no servidor.
import { resumoUrnas, curvaUrnas, municipiosUrnas, conferenciaTse } from "./urnas.js";
import { botaoInfo as bi, caixaInfo as cx } from "./paginas.js";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const n = v => Number(v || 0).toLocaleString("pt-BR");
const pct = v => { const x = Number(v || 0); return x.toFixed(x > 0 && x < 1 ? 2 : 1).replace(".", ",") + "%"; };

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
  const cf = conferenciaTse(resumo.linhas, turno);
  const link = (t, u) => `/urnas?turno=${t}${u ? "&uf=" + u : ""}`;
  const corpo = `<h1>Horários das urnas nas eleições 2026${bi("i-ler", "Como ler estes horários")}</h1>
${cx("i-ler", `<p><b>De onde vêm os dados.</b> Dos logs oficiais das urnas publicados pelo TSE. O log registra o horário de cada voto, mas não em quem se votou.</p>
<p><b>Fuso.</b> Todos os horários estão no horário de Brasília: a votação vai das 8h às 17h de Brasília no país inteiro, o que no Acre, por exemplo, corresponde a 6h e 15h locais. No exterior vale o horário local de cada país.</p>
<p><b>Encerramento.</b> As urnas fecham às 17h, mas quem já está na fila vota depois, por isso há seções que encerram mais tarde. No 1º turno, encerramento tardio indica fila longa na hora do fechamento; no 2º, houve a prorrogação até as 19h (veja o botão i ao lado das seções encerradas depois das 18h). Sozinho, o horário de encerramento não diz nada sobre o resultado.</p>
<p><b>Comparar resultados por horário.</b> Compare seções dentro do mesmo município, onde o perfil do eleitorado é parecido.</p>`)}
<p>Quando as urnas abriram, como os votos se distribuíram ao longo do dia e a que horas cada seção encerrou, segundo os logs oficiais publicados pelo TSE.</p>
<p><a href="/?base=urnas&turno=${turno}${uf ? "&uf=" + uf : ""}"><b>Abrir no explorador</b></a>: filtros, tabela dinâmica, faixas de horário e drill de UF até a seção.</p>
<p class="muted">Turno: ${[1, 2].map(t => t === turno ? `<b>${t}º</b>` : `<a href="${link(t, uf)}">${t}º</a>`).join(" · ")} · Estado: ${uf ? `<b>${esc(uf)}</b> · <a href="${link(turno)}">todos</a>` : "<b>todos os disponíveis</b>"}</p>
${erro ? `<div class="card">${esc(erro)}</div>` : ""}
${!ufsT.length && !erro ? `<div class="card">Os logs deste turno ainda estão sendo processados. Volte em breve.</div>` : ""}
${ufsT.length ? `<div class="card k"><div><b>${n(tot.s)}</b>seções com log de urna${bi("i-tse", "Por que não são as 499.248 seções do TSE?")}</div><div><b>${n(tot.v)}</b>votos registrados</div><div><b>${pct(tot.v ? 100 * tot.a17 / tot.v : 0)}</b>dos votos depois das 17h</div><div><b>${n(tot.e18)}</b>seções encerradas depois das 18h${turno === 2 ? bi("i-19h", "Por que tantas seções encerraram perto das 19h?") : ""}</div></div>
${cx("i-tse", `<p><b>O TSE conta ${n(cf.secoes_tse)} seções com urna em cada turno</b> (Quadro Geral de Quantitativos). Esta página só conta seção com log de urna eletrônica publicado e já carregado: ${n(cf.secoes_com_log)}. Faltam ${n(cf.diferenca)}.</p>
<p>${n(cf.exterior_em_cedula_de_papel + cf.exterior_fora_do_pacote_de_arquivos)} são do exterior e não têm horário de voto: ${n(cf.exterior_em_cedula_de_papel)} foram apuradas em cédula de papel e ${n(cf.exterior_fora_do_pacote_de_arquivos)} constam no quadro do TSE, mas não estão no pacote de arquivos de urna publicado.</p>
${cf.em_reprocessamento ? `<p>As outras ${n(cf.em_reprocessamento)} estão em estados cuja base ainda está sendo refeita e entram quando o reprocessamento terminar.</p>` : ""}`)}
${turno === 2 ? cx("i-19h", `<b>Por que tantas seções encerraram perto das 19h no 2º turno?</b> Já depois das 17h, o STF (ministro Cristiano Zanin) prorrogou a votação até as 19h, só nas seções que ainda estavam abertas; as já encerradas não reabriram. Muitas mesas ficaram abertas esperando, mas quase ninguém chegou: ${n(tot.e18)} seções encerraram depois das 18h, a maioria entre 19h e 19h10, enquanto só ${n(tot.a17)} votos (${pct(tot.v ? 100 * tot.a17 / tot.v : 0)}) foram registrados depois das 17h. Por isso, no 2º turno, encerramento tardio não indica fila: para isso, use o horário dos votos.`) : ""}
<p class="muted">Estados já processados neste turno (${ufsT.length} de 28): ${ufsT.map(u => u === uf ? `<b>${u}</b>` : `<a href="${link(turno, u)}">${u}</a>`).join(" · ")}. Os demais entram conforme o processamento avança.</p>
<h2>Votos ao longo do dia${uf ? ` em ${esc(uf)}` : ""}, a cada 10 minutos${bi("i-curva", "Sobre este gráfico")}</h2>
${cx("i-curva", `Horário de Brasília${uf === "ZZ" ? " (exterior: horário local de cada país)" : uf ? "" : "; os votos do exterior entram pelo horário local, que lá também vai das 8h às 17h (17h local equivale às 17h de Brasília)"}. Cada barra soma os votos registrados naqueles 10 minutos. Passe o mouse sobre uma barra para ver o número.`)}
<div class="tw">${grafico(curva.pontos)}</div>` : ""}
${ufsT.length ? `
<h2 id="limiares">Votos tardios: horário do voto ou horário da urna?${bi("i-lim", "Qual a diferença?")}</h2>
${cx("i-lim", `São medidas diferentes. Um voto <b>registrado</b> depois das 17h é um voto dado na fila depois do horário. Uma urna que <b>encerrou</b> depois das 17h tem todos os seus votos do dia, inclusive os da manhã. O mesmo vale para o tempo: o tempo do voto desde a abertura da urna é diferente do tempo total de funcionamento da urna. Escolha a referência e o limiar, com precisão de minuto. Os totais incluem o exterior, onde a votação vai das 8h às 17h locais: lá vale o horário local (17h local = 9h de votação = 17h de Brasília). Seções cujo log não registra o encerramento ficam fora da contagem de urnas encerradas.${turno === 2 ? " No 2º turno, lembre que muitas urnas ficaram abertas até as 19h pela prorrogação, quase sem votos novos: “votos em urnas que encerraram a partir do limiar” conta o total do dia dessas urnas, não votos tardios." : ""}`)}
<div class="card" id="lim">
  <div class="ctl">
    <label>Referência<br><select id="limRef"><option value="relogio">Horário do relógio (Brasília)</option><option value="tempo">Tempo desde a abertura da urna</option></select></label>
    <label>Limiar<br><input id="limVal" type="text" inputmode="numeric" value="17:00" size="6" pattern="[0-9]{1,2}:[0-5][0-9]" title="horas:minutos"></label>
    <label>Gráfico<br><select id="limVis"><option value="voto">Momento de cada voto</option><option value="urna">Encerramento da urna (todos os votos dela)</option></select></label>
    <label>Agrupar barras<br><select id="limPasso"><option>1</option><option>5</option><option selected>10</option><option>15</option><option>30</option><option>60</option></select> min</label>
  </div>
  <div class="k" id="limCards"><div class="muted">Carregando…</div></div>
  <div class="tw"><svg id="limSvg" viewBox="0 0 900 270" style="width:100%;min-width:640px;height:auto" role="img" aria-label="Distribuição por minuto com o limiar"></svg></div>
  <p class="muted" id="limLeg"></p>
  <div class="tw"><table id="limTab"></table></div>
  <p class="muted" id="limAviso"></p>
</div>
<script>
(() => {
  const P = new URLSearchParams(location.search), turno = P.get("turno") === "1" ? 1 : 2, uf = P.get("uf") || "";
  const $ = id => document.getElementById(id), n = v => Number(v || 0).toLocaleString("pt-BR"), pc = (a, b) => b ? (100 * a / b).toFixed(1).replace(".", ",") + "%" : "–";
  const hm = m => \`\${String(Math.floor(m / 60)).padStart(2, "0")}:\${String(m % 60).padStart(2, "0")}\`;
  const dur = m => \`\${Math.floor(m / 60)}h\${String(m % 60).padStart(2, "0")}\`;
  const cache = {};
  const dist = async v => cache[v] ??= fetch(\`/api/urnas/distribuicao?visao=\${v}&turno=\${turno}\${uf ? "&uf=" + uf : ""}\`, { headers: { "x-origem": "site" } }).then(r => r.ok ? r.json() : r.json().then(j => Promise.reject(new Error(j.erro || r.status))));
  const acima = (pts, lim, i) => pts.reduce((a, p) => a + (p[0] >= lim ? p[i] : 0), 0);
  let ultRef = "relogio";
  async function desenhar() {
    const ref = $("limRef").value;
    if (ref !== ultRef) { $("limVal").value = ref === "relogio" ? "17:00" : "9:00"; ultRef = ref; }
    const mt = String($("limVal").value).trim().match(/^(\\d{1,2})[:h](\\d{2})$/); if (!mt) return; const lim = Number(mt[1]) * 60 + Number(mt[2]), passo = Number($("limPasso").value);
    const vVoto = ref === "relogio" ? "horario_voto" : "tempo_voto", vUrna = ref === "relogio" ? "encerramento" : "duracao";
    let a, b;
    try { [a, b] = await Promise.all([dist(vVoto), dist(vUrna)]); } catch (e) { $("limCards").innerHTML = \`<div class="muted">\${e.message}</div>\`; return; }
    const fmt = ref === "relogio" ? hm : dur, rotLim = ref === "relogio" ? \`a partir das \${hm(lim)}\` : \`a partir de \${dur(lim)} de urna aberta\`;
    const tv = a.total_votos, va = acima(a.pontos, lim, 1), vb = acima(b.pontos, lim, 1), sb = acima(b.pontos, lim, 2);
    $("limCards").innerHTML = \`<div><b>\${n(va)}</b>votos registrados \${rotLim} (\${pc(va, tv)} dos votos)</div>
      <div><b>\${n(vb)}</b>votos em urnas que \${ref === "relogio" ? \`encerraram a partir das \${hm(lim)}\` : \`funcionaram \${dur(lim)} ou mais\`} (\${pc(vb, b.total_votos)})</div>
      <div><b>\${n(sb)}</b>urnas \${ref === "relogio" ? \`encerradas a partir das \${hm(lim)}\` : \`com \${dur(lim)} ou mais de funcionamento\`} (\${pc(sb, b.total_secoes)} de \${n(b.total_secoes)})</div>\`;
    const offs = [0, 1, 5, 10, 30, 60, 120];
    $("limTab").innerHTML = \`<tr><th>Limiar</th><th class="r">Votos registrados a partir do limiar</th><th class="r">Votos em urnas \${ref === "relogio" ? "encerradas a partir do limiar" : "que funcionaram o limiar ou mais"}</th><th class="r">Urnas</th></tr>\` +
      offs.map(o => \`<tr><td>\${fmt(lim + o)}</td><td class="r">\${n(acima(a.pontos, lim + o, 1))}</td><td class="r">\${n(acima(b.pontos, lim + o, 1))}</td><td class="r">\${n(acima(b.pontos, lim + o, 2))}</td></tr>\`).join("");
    const d = $("limVis").value === "voto" ? a : b, buckets = new Map();
    for (const [mm, v] of d.pontos) { const k = Math.floor(mm / passo) * passo; buckets.set(k, (buckets.get(k) || 0) + v); }
    const ks = [...buckets.keys()].sort((x, y) => x - y);
    if (!ks.length) { $("limSvg").innerHTML = ""; return; }
    const lo = ks[0], hi = ks[ks.length - 1] + passo, W = 900, H = 270, E = 56, B = 30, T = 26, D = 8, max = Math.max(...buckets.values());
    const xs = v => E + (W - E - D) * (v - lo) / (hi - lo), y = v => T + (H - T - B) * (1 - v / max), bw = Math.max(1, (W - E - D) * passo / (hi - lo) - 2);
    const tk = [0, .5, 1].map(f => f * max);
    let svg = tk.map(t => \`<line x1="\${E}" x2="\${W - D}" y1="\${y(t)}" y2="\${y(t)}" class="g"/><text x="\${E - 6}" y="\${y(t) + 4}" text-anchor="end" class="t">\${n(Math.round(t))}</text>\`).join("");
    svg += ks.map(k => { const v = buckets.get(k), h2 = y(0) - y(v), r = Math.min(4, h2, bw / 2);
      return \`<path class="\${k >= lim ? "b" : "bm"}" d="M\${xs(k) + 1},\${y(0)}v\${-(h2 - r)}q0,-\${r} \${r},-\${r}h\${Math.max(0, bw - 2 * r)}q\${r},0 \${r},\${r}v\${h2 - r}z"><title>\${fmt(k)}\${passo > 1 ? "–" + fmt(k + passo - 1) : ""}: \${n(v)} votos</title></path>\`; }).join("");
    const passoRot = (hi - lo) > 600 ? 120 : (hi - lo) > 240 ? 60 : 30;
    for (let t = Math.ceil(lo / passoRot) * passoRot; t <= hi; t += passoRot) svg += \`<text x="\${xs(t)}" y="\${H - 10}" class="t" text-anchor="middle">\${fmt(t)}</text>\`;
    if (lim >= lo && lim <= hi) svg += \`<line x1="\${xs(lim)}" x2="\${xs(lim)}" y1="16" y2="\${y(0)}" class="lim"/><text x="\${xs(lim) + 4}" y="12" class="t">limiar \${fmt(lim)}</text>\`;
    svg += \`<line x1="\${E}" x2="\${W - D}" y1="\${y(0)}" y2="\${y(0)}" class="a"/>\`;
    $("limSvg").innerHTML = svg;
    $("limLeg").textContent = \`\${$("limVis").value === "voto" ? (ref === "relogio" ? "Votos pelo horário em que foram registrados" : "Votos pelo tempo desde a abertura da urna") : (ref === "relogio" ? "Votos agrupados pelo horário de encerramento da urna" : "Votos agrupados pelo tempo de funcionamento da urna")}, a cada \${passo} min. Em destaque, o que fica a partir do limiar. \${ref === "relogio" ? (uf === "ZZ" ? "Horário local de cada país." : "Horário de Brasília.") : "Abertura = urna pronta para receber votos."}\`;
    const falta = (ref === "tempo" ? a.ufs_sem_dado : []) || [];
    $("limAviso").textContent = falta.length ? \`Tempo de cada voto desde a abertura ainda sendo calculado para: \${falta.join(", ")}. Os números acima não incluem esses estados.\` : "";
  }
  for (const id of ["limRef", "limVal", "limVis", "limPasso"]) $(id).addEventListener("change", desenhar);
  $("limVal").addEventListener("input", () => { clearTimeout(window.__lt); window.__lt = setTimeout(desenhar, 250); });
  desenhar();
})();
</script>` : ""}
${munis ? `<h2>Municípios de ${esc(uf)}: os que encerraram mais tarde${bi("i-mun", "Como obter a lista completa")}</h2>
${cx("i-mun", `Aqui aparecem os 50 municípios com encerramento mais tardio. A lista completa e os horários seção por seção estão na API (<code>/api/urnas/municipios?uf=${esc(uf)}</code>, <code>/api/urnas/secoes?uf=${esc(uf)}&amp;exportar=1</code>), na ferramenta <code>horarios_urnas</code> do servidor MCP, na cobrança normal de créditos, e no <a href="/?base=urnas&turno=${turno}&uf=${esc(uf)}">explorador</a>.`)}<div class="tw"><table><tr><th>Município</th><th class="r">Seções</th><th class="r">Encerramento médio</th><th class="r">Último encerramento</th><th class="r">Votos após 17h</th></tr>
${munis.linhas.filter(l => l.turno === turno).slice(0, 50).map(l => `<tr><td>${esc(l.municipio)}</td><td class="r">${n(l.secoes)}</td><td class="r">${l.encerramento_medio || "–"}</td><td class="r">${l.ultimo_encerramento || "–"}</td><td class="r">${l.pct_votos_apos_17h == null ? "–" : pct(l.pct_votos_apos_17h)}</td></tr>`).join("")}</table></div>
${munis.linhas.some(l => l.pct_votos_apos_17h == null) ? `<p class="muted">“–”: este estado foi processado antes da correção de fuso; o percentual por município volta quando os logs forem reprocessados.</p>` : ""}
` : ""}
${linhasT.length ? `<h2>Por estado</h2><div class="tw"><table><tr><th>UF</th><th class="r">Seções</th><th class="r">Primeira abertura</th><th class="r">Encerramento médio</th><th class="r">Após 18h</th><th class="r">Último encerramento</th><th class="r">Votos após 17h</th></tr>
${linhasT.map(l => `<tr><td><a href="${link(turno, l.uf)}">${l.uf}</a></td><td class="r">${n(l.secoes)}</td><td class="r">${l.primeira_abertura || "–"}</td><td class="r">${l.encerramento_medio || "–"}</td><td class="r">${n(l.secoes_encerradas_apos_18h)}</td><td class="r">${l.ultimo_encerramento || "–"}</td><td class="r">${pct(l.pct_votos_apos_17h)}</td></tr>`).join("")}</table></div>` : ""}`;
  const css = `<style>.ctl{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:10px}.ctl select,.ctl input{font:inherit;padding:4px 6px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--ink)}.bm{fill:var(--line)}.lim{stroke:var(--ink);stroke-width:1.5;stroke-dasharray:4 3}.b{fill:var(--acc)}.g{stroke:var(--line);stroke-width:1}.a{stroke:var(--muted);stroke-width:1}.t{fill:var(--muted);font-size:11px}</style>`;
  const { paginaBase } = await import("./paginas.js");
  return paginaBase({ titulo: `Horários das urnas nas eleições 2026${uf ? " em " + uf : ""}: abertura, votos por hora e encerramento`, descricao: `Quando as urnas abriram e encerraram nas eleições 2026${uf ? " em " + uf : ""}, e como os votos se distribuíram ao longo do dia, segundo os logs oficiais do TSE.`, canonico: link(turno, uf), corpo: css + corpo, origem });
}
