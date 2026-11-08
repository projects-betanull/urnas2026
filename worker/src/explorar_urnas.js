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
  // Com a dimensão Candidato, cada seção entra uma vez por candidato: os totais de % usam os válidos da seção uma vez só.
  const denL = new Map(), denG = [0]; const candDim = linhaDim === "candidato" || colDim === "candidato";
  const add = (l, c, num, den) => { let m = cel.get(l); if (!m) cel.set(l, m = new Map()); const x = m.get(c); if (x) { x[0] += num; x[1] += den; } else m.set(c, [num, den]); };
  // Rótulos das faixas: um por faixa, reaproveitados por todas as seções.
  const memo = f => { const m = new Map(); return v => { let r = m.get(v); if (r === undefined) m.set(v, r = f(v)); return r; }; };
  const faixaHora = memo(a => `${hm(a)}–${hm(a + passo - 1)}`), faixaDur = memo(a => `${dur(a)}–${dur(a + passo - 1)}`);
  const ROT = { encA: `Encerrou a partir de ${hm(limH)}`, encB: `Encerrou antes de ${hm(limH)}`, funA: `Funcionou ${dur(limT)} ou mais`, funB: `Funcionou menos de ${dur(limT)}` };
  const s = { encBr: null, abBr: null, dur: null, cand: null }, vistas = new Set();
  for (const t of turnos) {
    for (const base of env.URNAS.secoes(t, ufsFiltro)) {
      await new Promise(r => setImmediate(r)); // deixa outras requisições andarem entre uma base e outra
      const ix = base.indice(), uf = base.uf, f = 60 * fz(uf), turnoTxt = String(base.turno);
      const munRot = ix.muns.map(m => nm.get(String(Number(m))) || m), zonaRot = ix.zonas.map(z => `Zona ${z}`);
      const dimDe = (d, i) => {
        switch (d) {
          case "turno": return turnoTxt;
          case "uf": return uf;
          case "municipio": return munRot[ix.mun[i]];
          case "zona": return zonaRot[ix.zona[i]];
          case "secao": return `${ix.zonas[ix.zona[i]]}/${ix.secoes[ix.secao[i]]}`;
          case "faixa_encerramento": return s.encBr == null ? "(sem encerramento)" : faixaHora(Math.floor(s.encBr / passo) * passo);
          case "faixa_abertura": return s.abBr == null ? "(sem abertura)" : faixaHora(Math.floor(s.abBr / passo) * passo);
          case "faixa_duracao": return s.dur == null ? "(sem dado)" : faixaDur(Math.floor(s.dur / passo) * passo);
          case "encerrou_apos": return s.encBr == null ? "(sem encerramento)" : s.encBr >= limH ? ROT.encA : ROT.encB;
          case "funcionou_apos": return s.dur == null ? "(sem dado)" : s.dur >= limT ? ROT.funA : ROT.funB;
          case "candidato": return s.cand;
        }
      };
      const filt = Object.entries(filtros).filter(([k]) => k !== "turno" && k !== "candidato");
      // Filtros que não dependem da seção (turno, UF) resolvem a base inteira de uma vez.
      if (filt.some(([k, set]) => (k === "uf" && !set.has(uf)))) continue;
      const passa = i => { for (const [k, set] of filt) if (!set.has(dimDe(k, i))) return false; return true; };
      let cv = null;
      if (cauda) { if (!base.temCauda) semCauda.add(`${base.turno}º ${uf}`); else cv = base.cauda(cauda, cauda === "hora" ? limH + 60 * fz(uf) : limT); }
      let vs = null, share = null;
      if (porCand) {
        vs = base.candidatos(cargo);
        if (!vs || vs.vazio) { semSecao.add(`${base.turno}º ${uf}`); continue; }
        if (medida === "desvio_mun_candidato") { // participação de cada candidato no próprio município
          const k = vs.k, sm = new Float64Array(ix.muns.length * k), tm = new Float64Array(ix.muns.length);
          for (let i = 0; i < ix.n; i++) if (vs.tem[i]) { const m = ix.mun[i]; for (let j = 0; j < k; j++) { const q = vs.q[i * k + j]; if (q > 0) { sm[m * k + j] += q; tm[m] += q; } } }
          for (let m = 0; m < ix.muns.length; m++) for (let j = 0; j < k; j++) sm[m * k + j] = tm[m] ? sm[m * k + j] / tm[m] : 0;
          share = sm;
        }
      }
      const fc = filtros.candidato, nomeCand = vs ? vs.nrs.map(nr => vs.nomes.get(nr) || nr) : null, candOk = nomeCand ? nomeCand.map(nm => !fc || fc.has(nm)) : null;
      for (let i = 0; i < ix.n; i++) {
        const ab = ix.ab[i] < 0 ? null : ix.ab[i] / 60, enc = ix.enc[i] < 0 ? null : ix.enc[i] / 60;
        s.abBr = ab == null ? null : Math.floor(ab - f); s.encBr = enc == null ? null : Math.floor(enc - f);
        s.dur = ab != null && enc != null && enc > ab ? Math.floor(enc - ab) : null; s.cand = null;
        if (porCand) {
          if (!vs.tem[i] || !passa(i)) continue;
          const k = vs.k, o = i * k, sh = share ? ix.mun[i] * k : -1;
          let validos = 0; for (let j = 0; j < k; j++) { const q = vs.q[o + j]; if (q > 0) validos += q; }
          if (!candDim) {
            let n = 0; for (let j = 0; j < k; j++) { const q = vs.q[o + j]; if (q < 0 || !candOk[j]) continue; n += share ? q - validos * share[sh + j] : q; }
            add(dimDe(linhaDim, i), colDim ? dimDe(colDim, i) : null, n, validos);
            continue;
          }
          let algum = false; vistas.clear();
          for (let j = 0; j < k; j++) {
            const q = vs.q[o + j]; if (q < 0 || !candOk[j]) continue; // q = -1: candidato sem linha nesta seção
            s.cand = nomeCand[j];
            const lr = dimDe(linhaDim, i);
            if (!vistas.has(lr)) { vistas.add(lr); denL.set(lr, (denL.get(lr) || 0) + validos); }
            algum = true;
            add(lr, colDim ? dimDe(colDim, i) : null, share ? q - validos * share[sh + j] : q, validos);
          }
          if (algum) denG[0] += validos;
          continue;
        }
        if (filt.length && !passa(i)) continue;
        const l = dimDe(linhaDim, i), c = colDim ? dimDe(colDim, i) : null;
        const v = ix.votos[i], encApos = s.encBr != null && s.encBr >= limH, longa = s.dur != null && s.dur >= limT;
        switch (medida) {
          case "secoes": add(l, c, 1, 0); break;
          case "votos": add(l, c, v, 0); break;
          case "votos_apos_hora": case "votos_apos_tempo": add(l, c, cv ? cv[i] : 0, 0); break;
          case "pct_votos_apos_hora": add(l, c, cv ? cv[i] : 0, base.temCauda ? v : 0); break;
          case "secoes_encerradas_apos": add(l, c, encApos ? 1 : 0, 0); break;
          case "votos_urnas_encerradas_apos": add(l, c, encApos ? v : 0, 0); break;
          case "secoes_longas": add(l, c, longa ? 1 : 0, 0); break;
          case "votos_urnas_longas": add(l, c, longa ? v : 0, 0); break;
          case "encerramento_medio": if (s.encBr != null) add(l, c, s.encBr, 1); break;
          case "duracao_media": if (s.dur != null) add(l, c, s.dur, 1); break;
        }
      }
    }
  }
  const tipo = MED_URNAS[medida].tipo, val = ([a, b]) => tipo === "soma" ? a : b ? (tipo === "razao" ? 100 * a / b : a / b) : null;
  const linhas = [], totL = new Map(), tot = [0, 0];
  for (const [l, m] of cel) for (const [c, x] of m) {
    linhas.push({ linha: l, coluna: c, valor: val(x) });
    const t = totL.get(l) || [0, 0]; t[0] += x[0]; t[1] += x[1]; totL.set(l, t); tot[0] += x[0]; tot[1] += x[1];
  }
  const r = { linhas, medida, linhaDim, colDim, filtros: Object.fromEntries(Object.entries(filtros).map(([k, v]) => [k, [...v]])),
    totLinha: tipo === "soma" ? null : Object.fromEntries([...totL].map(([l, x]) => [l, val(candDim && porCand ? [x[0], denL.get(l) || 0] : x)])),
    valorGeral: val(candDim && porCand && tipo !== "soma" ? [tot[0], denG[0]] : tot), tipo,
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
