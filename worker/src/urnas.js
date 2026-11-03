// Horários das urnas a partir dos logs oficiais (abertura, votos por minuto, encerramento por seção).
// env.URNAS vem do servidor (deploy/servidor.mjs): consultar(sql, params, {turno, uf}) junta as linhas de todas as bases.
// Os logs trazem o horário LOCAL da urna. A votação vai das 8h às 17h de Brasília no país todo; no exterior (ZZ),
// das 8h às 17h locais. Aqui tudo é mostrado no horário de Brasília (exterior: horário local).
import { ErroApi } from "./core.js";

export const FUSO = { AC: -2, AM: -1, RO: -1, RR: -1, MT: -1, MS: -1 }; // horas do local em relação a Brasília
const fz = uf => uf === "ZZ" ? 0 : (FUSO[uf] || 0);
const UF_OK = /^[A-Z]{2}$/;
const paraMin = t => t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null;
const hhmm = m => m == null ? null : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.round(m % 60)).padStart(2, "0")}`;
const hhmmss = m => m == null ? null : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.floor(m % 60)).padStart(2, "0")}:${String(Math.round((m % 1) * 60)).padStart(2, "0")}`;
// hora local "HH:MM:SS" -> Brasília (exterior fica como está)
const br = (t, uf) => { if (!t) return null; const s = t.split(":").map(Number), m = s[0] * 60 + s[1] + (s[2] || 0) / 60 - 60 * fz(uf); return hhmmss(m); };
const local = (hBr, uf) => `${String(hBr + fz(uf)).padStart(2, "0")}:00:00`; // 17h de Brasília no horário local da UF
const NOTA = "Fonte: logs oficiais das urnas (TSE). Horários convertidos para o de Brasília (no exterior, horário local do país). No Amazonas, alguns municípios do oeste têm uma hora a menos que o resto do estado; aqui todo o AM usa o mesmo fuso. O log não registra o candidato votado.";

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

// Resumo por UF e turno: seções, votos, encerramento médio e quanto aconteceu depois das 17h de Brasília.
export function resumoUrnas(env, p = {}) {
  const U = exigir(env), { turno, uf } = parametros(p);
  const sec = U.consultar(`SELECT turno, uf, COUNT(*) secoes, SUM(votos) votos, MIN(abertura) primeira_abertura, MAX(encerramento) ultimo,
      AVG(CASE WHEN encerramento IS NOT NULL THEN CAST(substr(encerramento,1,2) AS INT)*60 + CAST(substr(encerramento,4,2) AS INT) END) enc_medio,
      SUM(encerramento >= ?) e1730, SUM(encerramento >= ?) e18, SUM(encerramento >= ?) e19
    FROM secao_tempo GROUP BY turno, uf`, b => [`${String(17 + fz(b.uf)).padStart(2, "0")}:30:00`, local(18, b.uf), local(19, b.uf)], { turno, uf });
  const min = U.consultar(`SELECT turno, uf, SUM(votos) total, SUM(CASE WHEN minuto >= ? THEN votos ELSE 0 END) a17, SUM(CASE WHEN minuto >= ? THEN votos ELSE 0 END) a19
    FROM voto_minuto_uf GROUP BY turno, uf`, b => [local(17, b.uf).slice(0, 5), local(19, b.uf).slice(0, 5)], { turno, uf });
  const linhas = sec.map(l => { const m = min.find(x => x.turno === l.turno && x.uf === l.uf) || {};
    return { turno: l.turno, uf: l.uf, secoes: l.secoes, votos: l.votos, votos_apos_17h: m.a17 || 0, votos_apos_19h: m.a19 || 0,
      pct_votos_apos_17h: m.total ? +(100 * m.a17 / m.total).toFixed(2) : 0, encerramento_medio: l.enc_medio == null ? null : hhmm(l.enc_medio - 60 * fz(l.uf)),
      ultimo_encerramento: br(l.ultimo, l.uf), primeira_abertura: br(l.primeira_abertura, l.uf),
      secoes_encerradas_apos_17h30: l.e1730, secoes_encerradas_apos_18h: l.e18, secoes_encerradas_apos_19h: l.e19 }; })
    .sort((a, b) => a.turno - b.turno || a.uf.localeCompare(b.uf));
  return { disponiveis: U.disponiveis(), linhas, nota: NOTA };
}

// Votos por intervalo de tempo (padrão 10 min) no horário de Brasília. Sem UF, soma o Brasil (sem o exterior).
export function curvaUrnas(env, p = {}) {
  const U = exigir(env), { turno, uf } = parametros(p);
  const passo = [1, 5, 10, 15, 30, 60].includes(Number(p.intervalo)) ? Number(p.intervalo) : 10;
  const soma = new Map();
  for (const l of U.consultar("SELECT turno, uf, minuto, votos FROM voto_minuto_uf", [], { turno, uf })) {
    if (!uf && l.uf === "ZZ") continue;
    const m = paraMin(l.minuto) - 60 * fz(l.uf), k = `${l.turno}|${Math.floor(m / passo) * passo}`;
    soma.set(k, (soma.get(k) || 0) + l.votos);
  }
  const pontos = [...soma].map(([k, v]) => { const [t, m] = k.split("|").map(Number); return { turno: t, inicio: hhmm(m), votos: v }; })
    .sort((a, b) => a.turno - b.turno || a.inicio.localeCompare(b.inicio));
  return { intervalo_minutos: passo, uf: uf || "Brasil (sem exterior)", horario: uf === "ZZ" ? "local" : "Brasília", pontos };
}

// Por município (exige UF): seções, encerramento médio e último, votos depois das 17h de Brasília.
export async function municipiosUrnas(env, p = {}) {
  const U = exigir(env), { turno, uf } = parametros(p);
  if (!uf) throw new ErroApi(400, "Informe a UF.");
  const linhas = U.consultar(`SELECT turno, uf, cd_municipio, COUNT(*) secoes, SUM(votos) votos, SUM(votos_apos_17h) apos17, ? confiavel,
      AVG(CASE WHEN encerramento IS NOT NULL THEN CAST(substr(encerramento,1,2) AS INT)*60 + CAST(substr(encerramento,4,2) AS INT) END) enc_medio, MAX(encerramento) ultimo
    FROM secao_tempo GROUP BY turno, cd_municipio`, b => [b.apos17Brasilia || fz(b.uf) === 0 ? 1 : 0], { turno, uf });
  const nomes = new Map((await env.DB.prepare("SELECT cd_municipio, nome FROM municipio WHERE uf = ?").bind(uf).all()).results.map(m => [m.cd_municipio, m.nome]));
  return { uf, nota: NOTA, linhas: linhas.map(l => ({ turno: l.turno, cd_municipio: l.cd_municipio, municipio: nomes.get(l.cd_municipio) || nomes.get(String(Number(l.cd_municipio))) || l.cd_municipio,
    secoes: l.secoes, votos: l.votos, pct_votos_apos_17h: l.confiavel && l.votos ? +(100 * l.apos17 / l.votos).toFixed(2) : null,
    encerramento_medio: l.enc_medio == null ? null : hhmm(l.enc_medio - 60 * fz(uf)), ultimo_encerramento: br(l.ultimo, uf) }))
    .sort((a, b) => a.turno - b.turno || (b.ultimo_encerramento || "").localeCompare(a.ultimo_encerramento || "")) };
}

// Seção por seção (exige UF; município opcional). Cobrado como as demais consultas.
export function secoesUrnas(env, p = {}) {
  const U = exigir(env), { turno, uf } = parametros(p);
  if (!uf) throw new ErroApi(400, "Informe a UF.");
  const mun = p.cd_municipio ? String(p.cd_municipio).replace(/\D/g, "").padStart(5, "0") : null;
  const limite = Math.min(Number(p.limite) || 200, p.exportar ? 100000 : 1000);
  const ordem = p.ordem === "votos_apos_17h" ? "votos_apos_17h DESC" : "encerramento DESC";
  const linhas = U.consultar(`SELECT turno, uf, cd_municipio, zona, secao, abertura, primeiro_voto, ultimo_voto, encerramento, votos, votos_apos_17h, votos_apos_19h, ? confiavel
    FROM secao_tempo ${mun ? "WHERE cd_municipio = ?" : ""} ORDER BY ${ordem} LIMIT ?`,
    b => [b.apos17Brasilia || fz(b.uf) === 0 ? 1 : 0, ...(mun ? [mun, limite] : [limite])], { turno, uf })
    .map(({ confiavel, ...l }) => ({ ...l, abertura: br(l.abertura, uf), primeiro_voto: br(l.primeiro_voto, uf), ultimo_voto: br(l.ultimo_voto, uf), encerramento: br(l.encerramento, uf),
      votos_apos_17h: confiavel ? l.votos_apos_17h : null, votos_apos_19h: confiavel ? l.votos_apos_19h : null }));
  linhas.sort((a, b) => p.ordem === "votos_apos_17h" ? (b.votos_apos_17h ?? -1) - (a.votos_apos_17h ?? -1) : (b.encerramento || "").localeCompare(a.encerramento || ""));
  return { uf, cd_municipio: mun, horario: uf === "ZZ" ? "local" : "Brasília", nota: NOTA, linhas: linhas.slice(0, limite) };
}
