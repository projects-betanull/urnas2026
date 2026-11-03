// Horários das urnas a partir dos logs oficiais (abertura, votos por minuto, encerramento por seção).
// env.URNAS vem do servidor (deploy/servidor.mjs): consultar(sql, params, {turno, uf}) junta as linhas de todas as bases.
import { ErroApi } from "./core.js";

const UF_OK = /^[A-Z]{2}$/;
const min = "(CAST(substr(encerramento,1,2) AS INT)*60 + CAST(substr(encerramento,4,2) AS INT))";
const hhmm = m => m == null ? null : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.round(m % 60)).padStart(2, "0")}`;

function exigir(env) {
  if (!env.URNAS) throw new ErroApi(503, "Horários das urnas ainda não disponíveis neste servidor.");
  return env.URNAS;
}
function parametros(p) {
  const turno = p.turno ? Number(p.turno) : null;
  if (turno && ![1, 2].includes(turno)) throw new ErroApi(400, "Turno deve ser 1 ou 2.");
  const uf = p.uf ? String(p.uf).toUpperCase() : null;
  if (uf && !UF_OK.test(uf)) throw new ErroApi(400, "UF inválida.");
  return { turno, uf };
}

// Resumo por UF e turno: seções, votos, encerramento médio e quanto aconteceu depois das 17h.
export function resumoUrnas(env, p = {}) {
  const U = exigir(env), { turno, uf } = parametros(p);
  const linhas = U.consultar(`SELECT turno, uf, COUNT(*) secoes, SUM(votos) votos, SUM(votos_apos_17h) apos17, SUM(votos_apos_19h) apos19,
      AVG(CASE WHEN encerramento IS NOT NULL THEN ${min} END) enc_medio, MAX(encerramento) ultimo_encerramento, MIN(abertura) primeira_abertura,
      SUM(CASE WHEN encerramento >= '17:30:00' THEN 1 ELSE 0 END) enc_apos_1730, SUM(CASE WHEN encerramento >= '18:00:00' THEN 1 ELSE 0 END) enc_apos_18,
      SUM(CASE WHEN encerramento >= '19:00:00' THEN 1 ELSE 0 END) enc_apos_19
    FROM secao_tempo GROUP BY turno, uf`, [], { turno, uf })
    .map(l => ({ turno: l.turno, uf: l.uf, secoes: l.secoes, votos: l.votos, votos_apos_17h: l.apos17, votos_apos_19h: l.apos19,
      pct_votos_apos_17h: l.votos ? +(100 * l.apos17 / l.votos).toFixed(2) : 0, encerramento_medio: hhmm(l.enc_medio),
      ultimo_encerramento: l.ultimo_encerramento, primeira_abertura: l.primeira_abertura,
      secoes_encerradas_apos_17h30: l.enc_apos_1730, secoes_encerradas_apos_18h: l.enc_apos_18, secoes_encerradas_apos_19h: l.enc_apos_19 }))
    .sort((a, b) => a.turno - b.turno || a.uf.localeCompare(b.uf));
  return { disponiveis: U.disponiveis(), linhas, nota: "Fonte: logs oficiais das urnas (TSE). Horário local de cada urna. O log não registra o candidato votado." };
}

// Votos por intervalo de tempo (padrão 10 min), somando as UFs escolhidas.
export function curvaUrnas(env, p = {}) {
  const U = exigir(env), { turno, uf } = parametros(p);
  const passo = [1, 5, 10, 15, 30, 60].includes(Number(p.intervalo)) ? Number(p.intervalo) : 10;
  const soma = new Map();
  for (const l of U.consultar("SELECT turno, minuto, votos FROM voto_minuto_uf", [], { turno, uf })) {
    const m = Number(l.minuto.slice(0, 2)) * 60 + Number(l.minuto.slice(3, 5)), k = `${l.turno}|${Math.floor(m / passo) * passo}`;
    soma.set(k, (soma.get(k) || 0) + l.votos);
  }
  const pontos = [...soma].map(([k, v]) => { const [t, m] = k.split("|").map(Number); return { turno: t, inicio: hhmm(m), votos: v }; })
    .sort((a, b) => a.turno - b.turno || a.inicio.localeCompare(b.inicio));
  return { intervalo_minutos: passo, uf: uf || "todas disponíveis", pontos };
}

// Por município (exige UF): seções, encerramento médio e último, votos depois das 17h.
export async function municipiosUrnas(env, p = {}) {
  const U = exigir(env), { turno, uf } = parametros(p);
  if (!uf) throw new ErroApi(400, "Informe a UF.");
  const linhas = U.consultar(`SELECT turno, cd_municipio, COUNT(*) secoes, SUM(votos) votos, SUM(votos_apos_17h) apos17,
      AVG(CASE WHEN encerramento IS NOT NULL THEN ${min} END) enc_medio, MAX(encerramento) ultimo_encerramento
    FROM secao_tempo GROUP BY turno, cd_municipio`, [], { turno, uf });
  const nomes = new Map((await env.DB.prepare("SELECT cd_municipio, nome FROM municipio WHERE uf = ?").bind(uf).all()).results.map(m => [m.cd_municipio, m.nome]));
  return { uf, linhas: linhas.map(l => ({ turno: l.turno, cd_municipio: l.cd_municipio, municipio: nomes.get(l.cd_municipio) || nomes.get(String(Number(l.cd_municipio))) || l.cd_municipio,
    secoes: l.secoes, votos: l.votos, pct_votos_apos_17h: l.votos ? +(100 * l.apos17 / l.votos).toFixed(2) : 0,
    encerramento_medio: hhmm(l.enc_medio), ultimo_encerramento: l.ultimo_encerramento }))
    .sort((a, b) => a.turno - b.turno || (b.ultimo_encerramento || "").localeCompare(a.ultimo_encerramento || "")) };
}

// Seção por seção (exige UF; município opcional). Cobrado como as demais consultas.
export function secoesUrnas(env, p = {}) {
  const U = exigir(env), { turno, uf } = parametros(p);
  if (!uf) throw new ErroApi(400, "Informe a UF.");
  const mun = p.cd_municipio ? String(p.cd_municipio).replace(/\D/g, "").padStart(5, "0") : null;
  const limite = Math.min(Number(p.limite) || 200, p.exportar ? 100000 : 1000);
  const ordem = p.ordem === "votos_apos_17h" ? "votos_apos_17h DESC" : "encerramento DESC";
  const linhas = U.consultar(`SELECT turno, uf, cd_municipio, zona, secao, abertura, primeiro_voto, ultimo_voto, encerramento, votos, votos_apos_17h, votos_apos_19h
    FROM secao_tempo ${mun ? "WHERE cd_municipio = ?" : ""} ORDER BY ${ordem} LIMIT ?`, mun ? [mun, limite] : [limite], { turno, uf });
  linhas.sort((a, b) => p.ordem === "votos_apos_17h" ? b.votos_apos_17h - a.votos_apos_17h : (b.encerramento || "").localeCompare(a.encerramento || ""));
  return { uf, cd_municipio: mun, linhas: linhas.slice(0, limite) };
}
