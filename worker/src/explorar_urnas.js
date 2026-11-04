// Explorador dos horários das urnas: mesmas ideias do explorador de resultados (medida, linhas, colunas,
// filtros, drill UF → município → zona → seção), sobre as bases dos logs. Agrega em memória, base por base.
import { ErroApi } from "./core.js";
import { FUSO } from "./urnas.js";

const fz = uf => uf === "ZZ" ? 0 : (FUSO[uf] || 0);
const hm = m => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(((m % 60) + 60) % 60).padStart(2, "0")}`;
const dur = m => `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}`;
const minDe = t => { if (!t) return null; const [h, m, s] = t.split(":").map(Number); return h * 60 + m + (s || 0) / 60; };
const lerHM = (v, padrao) => { const m = String(v ?? padrao).trim().match(/^(\d{1,2})[:h](\d{2})$/); if (!m) throw new ErroApi(400, `Limiar inválido: ${v} (use horas:minutos, ex.: 17:00).`); return Number(m[1]) * 60 + Number(m[2]); };

export const DIM_URNAS = {
  turno: "Turno", uf: "UF", municipio: "Município", zona: "Zona", secao: "Seção (zona/seção)",
  faixa_encerramento: "Faixa de encerramento (Brasília)", faixa_duracao: "Faixa de tempo de funcionamento", faixa_abertura: "Faixa de abertura (Brasília)",
  encerrou_apos: "Encerrou a partir do limiar de horário?", funcionou_apos: "Funcionou o limiar de tempo ou mais?",
  candidato: "Candidato (no cargo escolhido)",
};
export const CARGOS_URNAS = { PRESIDENTE: "Presidente", GOVERNADOR: "Governador", SENADOR: "Senador" };
export const MED_URNAS = {
  secoes: { rotulo: "Urnas (seções)", tipo: "soma" },
  votos: { rotulo: "Votos registrados", tipo: "soma" },
  votos_apos_hora: { rotulo: "Votos registrados a partir do limiar de horário", tipo: "soma", cauda: "hora" },
  votos_apos_tempo: { rotulo: "Votos registrados a partir do limiar de tempo de urna aberta", tipo: "soma", cauda: "rel" },
  pct_votos_apos_hora: { rotulo: "% dos votos registrados a partir do limiar de horário", tipo: "razao", formato: "pct", cauda: "hora" },
  secoes_encerradas_apos: { rotulo: "Urnas encerradas a partir do limiar de horário", tipo: "soma" },
  votos_urnas_encerradas_apos: { rotulo: "Votos em urnas encerradas a partir do limiar de horário", tipo: "soma" },
  secoes_longas: { rotulo: "Urnas que funcionaram o limiar de tempo ou mais", tipo: "soma" },
  votos_urnas_longas: { rotulo: "Votos em urnas que funcionaram o limiar de tempo ou mais", tipo: "soma" },
  encerramento_medio: { rotulo: "Encerramento médio (Brasília)", tipo: "media", formato: "hora" },
  duracao_media: { rotulo: "Tempo médio de funcionamento", tipo: "media", formato: "duracao" },
  votos_candidato: { rotulo: "Votos válidos no boletim (cargo escolhido)", tipo: "soma", cand: true },
  pct_votos_candidato: { rotulo: "% dos votos válidos (cargo escolhido)", tipo: "razao", formato: "pct", cand: true },
  // Desconta onde a urna está: compara cada seção com o resultado do próprio município. Se a diferença entre grupos
  // de horário some aqui, ela vinha da geografia (cidades que fecham tarde votam diferente), não do horário.
  desvio_mun_candidato: { rotulo: "Diferença para o resultado do próprio município (p.p., cargo escolhido)", tipo: "razao", formato: "pp", cand: true },
};
export const HIER_URNAS = [["candidato", "faixa_encerramento", "uf"], ["uf", "municipio", "zona", "secao"], ["faixa_encerramento", "uf", "municipio"], ["faixa_duracao", "uf", "municipio"]];

let nomesMun = null;
async function nomes(db) {
  if (!nomesMun) { nomesMun = new Map(); for (const m of (await db.prepare("SELECT cd_municipio, nome FROM municipio").all()).results) nomesMun.set(String(Number(m.cd_municipio)), m.nome); }
  return nomesMun;
}
const lista = v => v == null || v === "" ? [] : (Array.isArray(v) ? v : [v]).map(String);
const cacheR = new Map();

export async function explorarUrnas(env, p) {
  if (!env.URNAS) throw new ErroApi(503, "Horários das urnas ainda não disponíveis neste servidor.");
  const medida = p.medida || "secoes", linhaDim = p.linhas || "uf", colDim = p.colunas || null;
  if (!MED_URNAS[medida]) throw new ErroApi(400, `Medida inválida: ${medida}`);
  if (!DIM_URNAS[linhaDim] || (colDim && !DIM_URNAS[colDim])) throw new ErroApi(400, "Dimensão inválida.");
  if (colDim === linhaDim) throw new ErroApi(400, "Linhas e colunas precisam ser diferentes.");
  const limH = lerHM(p.limiar_hora, "17:00"), limT = lerHM(p.limiar_tempo, "9:00");
  const passo = [5, 10, 15, 30, 60].includes(Number(p.passo)) ? Number(p.passo) : 30;
  const cauda = MED_URNAS[medida].cauda, porCand = !!MED_URNAS[medida].cand;
  const cargo = String(p.cargo || "PRESIDENTE").toUpperCase();
  if (!CARGOS_URNAS[cargo]) throw new ErroApi(400, `Cargo inválido: ${p.cargo} (use ${Object.keys(CARGOS_URNAS).join(", ")}).`);
  const usaCand = linhaDim === "candidato" || colDim === "candidato" || lista(p.filtros?.candidato).length > 0;
  if (usaCand && !porCand) throw new ErroApi(400, "A dimensão Candidato só funciona com as medidas de votos válidos do cargo escolhido.");
  if (cauda === "hora" && limH < 16 * 60) throw new ErroApi(400, "Para votos registrados por seção, o limiar de horário vai de 16:00 em diante.");
  if (cauda === "rel" && limT < 8 * 60) throw new ErroApi(400, "Para votos registrados por seção, o limiar de tempo vai de 8h00 em diante.");
  const filtros = {};
  for (const k of Object.keys(DIM_URNAS)) { const v = lista(p.filtros?.[k]); if (v.length) filtros[k] = new Set(v); }
  const turnos = filtros.turno ? [...filtros.turno].map(Number) : [1, 2];
  const chave = JSON.stringify({ cargo: porCand ? cargo : null, medida, linhaDim, colDim, limH, limT, passo, f: Object.fromEntries(Object.entries(filtros).map(([k, v]) => [k, [...v].sort()])) });
  const hit = cacheR.get(chave); if (hit && Date.now() - hit.t < 600e3) return hit.r;

  const nm = await nomes(env.DB);
  const ufsFiltro = filtros.uf ? [...filtros.uf] : null;
  const cel = new Map(), semCauda = new Set(), semSecao = new Set();
  const dimDe = (d, s, ctx) => {
    switch (d) {
      case "turno": return String(ctx.turno);
      case "uf": return ctx.uf;
      case "municipio": return nm.get(String(Number(s.cd_municipio))) || s.cd_municipio;
      case "zona": return `Zona ${s.zona}`;
      case "secao": return `${s.zona}/${s.secao}`;
      case "faixa_encerramento": { if (s.encBr == null) return "(sem encerramento)"; const a = Math.floor(s.encBr / passo) * passo; return `${hm(a)}–${hm(a + passo - 1)}`; }
      case "faixa_abertura": { if (s.abBr == null) return "(sem abertura)"; const a = Math.floor(s.abBr / passo) * passo; return `${hm(a)}–${hm(a + passo - 1)}`; }
      case "faixa_duracao": { if (s.dur == null) return "(sem dado)"; const a = Math.floor(s.dur / passo) * passo; return `${dur(a)}–${dur(a + passo - 1)}`; }
      case "encerrou_apos": return s.encBr == null ? "(sem encerramento)" : s.encBr >= limH ? `Encerrou a partir de ${hm(limH)}` : `Encerrou antes de ${hm(limH)}`;
      case "candidato": return s.cand;
      case "funcionou_apos": return s.dur == null ? "(sem dado)" : s.dur >= limT ? `Funcionou ${dur(limT)} ou mais` : `Funcionou menos de ${dur(limT)}`;
    }
  };
  const add = (l, c, num, den) => { const k = l + "\u0000" + c; const x = cel.get(k) || [0, 0]; x[0] += num; x[1] += den; cel.set(k, x); };
  for (const t of turnos) {
    env.URNAS.percorrer("SELECT cd_municipio, zona, secao, abertura, encerramento, votos FROM secao_tempo", [], { turno: t, ufs: ufsFiltro }, (s, ctx) => {
      if (!ctx.mapa) {
        ctx.mapa = new Map();
        if (cauda && !ctx.temCauda) semCauda.add(`${ctx.turno}º ${ctx.uf}`);
        if (cauda && ctx.extra) for (const e of ctx.extra) ctx.mapa.set(`${e.cd_municipio}|${e.zona}|${e.secao}`, e.v);
        if (porCand) { ctx.vs = env.URNAS.votosSecao ? env.URNAS.votosSecao(ctx.turno, ctx.uf, cargo) : null; if (!ctx.vs || !ctx.vs.mapa.size) semSecao.add(`${ctx.turno}º ${ctx.uf}`);
          else if (medida === "desvio_mun_candidato") {
            ctx.share = new Map(); const tm = new Map();
            for (const [k, vv] of ctx.vs.mapa) { const m = k.slice(0, k.indexOf("|")); let sm = ctx.share.get(m); if (!sm) ctx.share.set(m, sm = new Map());
              for (const [nr, q] of vv) { sm.set(nr, (sm.get(nr) || 0) + q); tm.set(m, (tm.get(m) || 0) + q); } }
            for (const [m, sm] of ctx.share) { const t = tm.get(m) || 1; for (const [nr, q] of sm) sm.set(nr, q / t); }
          } }
      }
      const ab = minDe(s.abertura), enc = minDe(s.encerramento), f = 60 * fz(ctx.uf);
      s.abBr = ab == null ? null : Math.floor(ab - f); s.encBr = enc == null ? null : Math.floor(enc - f);
      s.dur = ab != null && enc != null && enc > ab ? Math.floor(enc - ab) : null;
      const sk = `${s.cd_municipio}|${s.zona}|${s.secao}`;
      if (porCand) {
        const vv = ctx.vs?.mapa.get(sk); if (!vv) return;
        s.cand = null;
        for (const [k, set] of Object.entries(filtros)) if (k !== "turno" && k !== "candidato" && !set.has(dimDe(k, s, ctx))) return;
        let validos = 0; for (const [, q] of vv) validos += q;
        const fc = filtros.candidato;
        if (linhaDim !== "candidato" && colDim !== "candidato") {
          const sm = ctx.share?.get(s.cd_municipio);
          let n = 0; for (const [nr, q] of vv) if (!fc || fc.has(ctx.vs.nomes.get(nr) || nr)) n += sm ? q - validos * (sm.get(nr) || 0) : q;
          return add(dimDe(linhaDim, s, ctx), colDim ? dimDe(colDim, s, ctx) : null, n, validos);
        }
        for (const [nr, q] of vv) {
          s.cand = ctx.vs.nomes.get(nr) || nr; if (fc && !fc.has(s.cand)) continue;
          const sm = ctx.share?.get(s.cd_municipio);
          add(dimDe(linhaDim, s, ctx), colDim ? dimDe(colDim, s, ctx) : null, sm ? q - validos * (sm.get(nr) || 0) : q, validos);
        }
        return;
      }
      for (const [k, set] of Object.entries(filtros)) if (k !== "turno" && !set.has(dimDe(k, s, ctx))) return;
      const l = dimDe(linhaDim, s, ctx), c = colDim ? dimDe(colDim, s, ctx) : null;
      const encApos = s.encBr != null && s.encBr >= limH, longa = s.dur != null && s.dur >= limT;
      const cv = ctx.mapa.get(sk) || 0;
      switch (medida) {
        case "secoes": return add(l, c, 1, 0);
        case "votos": return add(l, c, s.votos || 0, 0);
        case "votos_apos_hora": case "votos_apos_tempo": return add(l, c, cv, 0);
        case "pct_votos_apos_hora": return add(l, c, cv, ctx.temCauda ? s.votos || 0 : 0);
        case "secoes_encerradas_apos": return add(l, c, encApos ? 1 : 0, 0);
        case "votos_urnas_encerradas_apos": return add(l, c, encApos ? s.votos || 0 : 0, 0);
        case "secoes_longas": return add(l, c, longa ? 1 : 0, 0);
        case "votos_urnas_longas": return add(l, c, longa ? s.votos || 0 : 0, 0);
        case "encerramento_medio": return s.encBr == null ? null : add(l, c, s.encBr, 1);
        case "duracao_media": return s.dur == null ? null : add(l, c, s.dur, 1);
      }
    }, cauda === "hora" ? "SELECT cd_municipio, zona, secao, SUM(votos) v FROM cauda_hora WHERE minuto >= ? GROUP BY 1, 2, 3"
      : cauda === "rel" ? "SELECT cd_municipio, zona, secao, SUM(votos) v FROM cauda_rel WHERE minutos >= ? GROUP BY 1, 2, 3" : null,
      b => cauda === "hora" ? [limH + 60 * fz(b.uf)] : [limT]);
  }
  const tipo = MED_URNAS[medida].tipo, val = ([a, b]) => tipo === "soma" ? a : b ? (tipo === "razao" ? 100 * a / b : a / b) : null;
  const linhas = [], totL = new Map(), tot = [0, 0];
  for (const [k, x] of cel) {
    const [l, c] = k.split("\u0000"); linhas.push({ linha: l, coluna: c === "null" ? null : c, valor: val(x) });
    const t = totL.get(l) || [0, 0]; t[0] += x[0]; t[1] += x[1]; totL.set(l, t); tot[0] += x[0]; tot[1] += x[1];
  }
  const r = { linhas, medida, linhaDim, colDim, filtros: Object.fromEntries(Object.entries(filtros).map(([k, v]) => [k, [...v]])),
    totLinha: tipo === "soma" ? null : Object.fromEntries([...totL].map(([l, x]) => [l, val(x)])), valorGeral: val(tot), tipo,
    limiar_hora: hm(limH), limiar_tempo: dur(limT), passo, sem_dado_por_secao: [...semCauda],
    ...(porCand ? { cargo, sem_votos_por_secao: [...semSecao] } : {}) };
  cacheR.set(chave, { t: Date.now(), r }); if (cacheR.size > 200) cacheR.delete(cacheR.keys().next().value);
  return r;
}

// Valores possíveis de uma dimensão (para os filtros), respeitando UF e município escolhidos.
export async function valoresUrnas(env, dim, p = {}) {
  const r = await explorarUrnas(env, { medida: dim === "candidato" ? "votos_candidato" : "secoes", cargo: p.cargo, linhas: dim, filtros: { uf: p.uf || undefined, municipio: p.municipio || undefined, turno: p.turno || undefined }, limiar_hora: p.limiar_hora, limiar_tempo: p.limiar_tempo, passo: p.passo });
  return [...new Set(r.linhas.map(l => l.linha))].sort((a, b) => String(a).localeCompare(String(b), "pt-BR"));
}
