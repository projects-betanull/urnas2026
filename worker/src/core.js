// Núcleo da API: explorador (filtros, pivot, drill-down), candidatos, créditos e cota.
// Sem dependências. Roda em Cloudflare Workers (D1) e em Node (testes, via adaptador).

// Nome de urna + partido/UF: evita juntar homônimos de estados diferentes
const ROT_CAND = "c.nome_urna || ' (' || COALESCE(c.partido,'?') || '/' || COALESCE(c.uf,'?') || ')'";
export const DIMENSOES = {
  turno:      { rotulo: "Turno",          votos: "v.turno",      cand: "c.turno" },
  uf:         { rotulo: "UF",             votos: "v.uf",         cand: "c.uf" },
  municipio:  { rotulo: "Município",      votos: "v.municipio",  cand: null },
  cargo:      { rotulo: "Cargo",          votos: "c.cargo",      cand: "c.cargo" },
  partido:    { rotulo: "Partido",        votos: "c.partido",    cand: "c.partido" },
  candidato:  { rotulo: "Candidato",      votos: ROT_CAND,       cand: ROT_CAND },
  situacao:   { rotulo: "Situação",       votos: "c.situacao",   cand: "c.situacao" },
  genero:     { rotulo: "Gênero",         votos: "c.genero",     cand: "c.genero" },
  instrucao:  { rotulo: "Instrução",      votos: "c.instrucao",  cand: "c.instrucao" },
  ocupacao:   { rotulo: "Ocupação",       votos: "c.ocupacao",   cand: "c.ocupacao" },
  cor_raca:   { rotulo: "Cor/raça",       votos: "c.cor_raca",   cand: "c.cor_raca" },
};

const ELEITO = "(c.situacao LIKE 'ELEITO%')";
export const MEDIDAS = {
  votos:            { rotulo: "Votos",                  votos: "SUM(v.votos)", cand: null },
  candidatos:       { rotulo: "Candidatos",             votos: "COUNT(DISTINCT c.sq_candidato)", cand: "COUNT(DISTINCT c.sq_candidato)" },
  eleitos:          { rotulo: "Eleitos",                votos: `COUNT(DISTINCT CASE WHEN ${ELEITO} THEN c.sq_candidato END)`, cand: `COUNT(DISTINCT CASE WHEN ${ELEITO} THEN c.sq_candidato END)` },
  patrimonio:       { rotulo: "Patrimônio declarado (R$)", votos: null, cand: "SUM(COALESCE(b.total,0))" },
  patrimonio_medio: { rotulo: "Patrimônio médio (R$)",  votos: null, cand: "AVG(COALESCE(b.total,0))" },
};

export const HIERARQUIAS = [["uf", "municipio"], ["cargo", "partido", "candidato"], ["partido", "candidato"]];

export class ErroApi extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

function lista(v) {
  if (v == null || v === "") return [];
  return (Array.isArray(v) ? v : String(v).split(",")).map(x => String(x).trim()).filter(Boolean).slice(0, 200);
}

// Monta e executa uma consulta agregada. Retorna { linhas: [{ linha, coluna, valor }] , fonte }
export async function explorar(db, p) {
  const medida = p.medida || "votos";
  const linhaDim = p.linhas || "uf";
  const colDim = p.colunas || null;
  if (!MEDIDAS[medida]) throw new ErroApi(400, `Medida inválida: ${medida}`);
  if (!DIMENSOES[linhaDim]) throw new ErroApi(400, `Dimensão inválida: ${linhaDim}`);
  if (colDim && !DIMENSOES[colDim]) throw new ErroApi(400, `Dimensão inválida: ${colDim}`);
  if (colDim === linhaDim) throw new ErroApi(400, "Linhas e colunas precisam ser diferentes.");

  const filtros = {};
  for (const k of Object.keys(DIMENSOES)) {
    const v = lista(p.filtros?.[k]);
    if (v.length) filtros[k] = v;
  }
  const usados = [linhaDim, colDim, ...Object.keys(filtros)].filter(Boolean);
  const precisaVotos = medida === "votos" || usados.includes("municipio");
  if (precisaVotos && !MEDIDAS[medida].votos)
    throw new ErroApi(400, "Patrimônio não pode ser cruzado com votos ou município. Use outra dimensão.");
  const fonte = precisaVotos ? "votos" : "cand";

  const expr = d => DIMENSOES[d][fonte];
  const where = [], args = [];
  for (const [k, vals] of Object.entries(filtros)) {
    where.push(`${expr(k)} IN (${vals.map(() => "?").join(",")})`);
    args.push(...vals.map(x => (k === "turno" ? Number(x) : x)));
  }
  if (p.busca) { where.push("c.nome_urna LIKE ?"); args.push(`%${String(p.busca).toUpperCase().slice(0, 60)}%`); }

  const tabelaVotos = usados.includes("municipio") ? "voto_municipio" : "voto_uf";
  const from = fonte === "votos"
    ? `${tabelaVotos} v JOIN candidato c ON c.sq_candidato = v.sq_candidato AND c.turno = v.turno`
    : "candidato c LEFT JOIN (SELECT sq_candidato, SUM(valor) AS total FROM bem GROUP BY sq_candidato) b ON b.sq_candidato = c.sq_candidato";
  const sel = [`${expr(linhaDim)} AS linha`, colDim ? `${expr(colDim)} AS coluna` : "NULL AS coluna", `${MEDIDAS[medida][fonte]} AS valor`];
  const sql = `SELECT ${sel.join(", ")} FROM ${from}${where.length ? " WHERE " + where.join(" AND ") : ""} GROUP BY 1, 2`;
  const { results } = await db.prepare(sql).bind(...args).all();
  return { linhas: results, fonte, filtros, medida, linhaDim, colDim };
}

// Transforma o resultado agregado em tabela dinâmica (pivot) com totais, ordenada e limitada.
export function pivotar(r, { limite = 50, maxColunas = 12, ordem = "desc" } = {}) {
  const tot = new Map(), totCol = new Map(), cel = new Map();
  for (const x of r.linhas) {
    const l = x.linha ?? "(sem informação)", c = x.coluna ?? "Total", v = Number(x.valor) || 0;
    tot.set(l, (tot.get(l) || 0) + v);
    totCol.set(c, (totCol.get(c) || 0) + v);
    cel.set(l + "\u0000" + c, v);
  }
  let colunas = [...totCol.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]);
  const outras = colunas.slice(maxColunas);
  colunas = colunas.slice(0, maxColunas);
  let linhas = [...tot.entries()];
  linhas.sort((a, b) => ordem === "asc" ? a[1] - b[1] : ordem === "nome" ? String(a[0]).localeCompare(String(b[0]), "pt-BR") : b[1] - a[1]);
  const totalLinhas = linhas.length;
  linhas = linhas.slice(0, limite).map(([l, t]) => {
    const valores = {};
    for (const c of colunas) valores[c] = cel.get(l + "\u0000" + c) || 0;
    if (outras.length) valores["Outros"] = outras.reduce((s, c) => s + (cel.get(l + "\u0000" + c) || 0), 0);
    return { chave: l, valores, total: t };
  });
  if (outras.length) colunas.push("Outros");
  const media = r.medida === "patrimonio_medio";
  return {
    medida: r.medida, linhas_dim: r.linhaDim, colunas_dim: r.colDim, filtros: r.filtros,
    colunas, linhas, total_linhas: totalLinhas,
    total_geral: media ? null : [...tot.values()].reduce((s, v) => s + v, 0),
  };
}

export async function buscarCandidatos(db, p) {
  const where = [], args = [];
  if (p.nome) { where.push("(nome_urna LIKE ? OR nome LIKE ?)"); const n = `%${String(p.nome).toUpperCase().slice(0, 60)}%`; args.push(n, n); }
  for (const k of ["uf", "cargo", "partido", "situacao"]) {
    const v = lista(p[k]); if (v.length) { where.push(`${k} IN (${v.map(() => "?").join(",")})`); args.push(...v); }
  }
  if (p.turno) { where.push("c.turno = ?"); args.push(Number(p.turno)); }
  const sql = `SELECT c.sq_candidato, c.turno, c.uf, c.cargo, c.numero, c.nome_urna, c.partido, c.situacao, COALESCE(t.votos,0) AS votos
    FROM candidato c LEFT JOIN voto_total t ON t.sq_candidato = c.sq_candidato AND t.turno = c.turno
    ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY votos DESC LIMIT ?`;
  args.push(Math.min(Number(p.limite) || 50, 200));
  return (await db.prepare(sql).bind(...args).all()).results;
}

export async function detalharCandidato(db, sq) {
  const turnos = (await db.prepare(
    `SELECT c.*, COALESCE(t.votos,0) AS votos FROM candidato c LEFT JOIN voto_total t ON t.sq_candidato=c.sq_candidato AND t.turno=c.turno WHERE c.sq_candidato = ? ORDER BY c.turno`
  ).bind(String(sq)).all()).results;
  if (!turnos.length) throw new ErroApi(404, "Candidato não encontrado.");
  const municipios = (await db.prepare(
    `SELECT turno, uf, municipio, votos FROM voto_municipio WHERE sq_candidato = ? ORDER BY turno, votos DESC LIMIT 500`
  ).bind(String(sq)).all()).results;
  const bens = (await db.prepare(`SELECT tipo, descricao, valor FROM bem WHERE sq_candidato = ? ORDER BY valor DESC`).bind(String(sq)).all()).results;
  return { candidato: turnos, votos_por_municipio: municipios, bens, patrimonio_total: bens.reduce((s, b) => s + (b.valor || 0), 0) };
}

export async function valoresDimensao(db, dim, filtroUf) {
  if (!DIMENSOES[dim]) throw new ErroApi(400, "Dimensão inválida.");
  if (dim === "municipio") {
    const r = await db.prepare(`SELECT nome AS v FROM municipio ${filtroUf ? "WHERE uf = ?" : ""} ORDER BY nome LIMIT 6000`).bind(...(filtroUf ? [filtroUf] : [])).all();
    return r.results.map(x => x.v);
  }
  const col = DIMENSOES[dim].cand;
  const r = await db.prepare(`SELECT DISTINCT ${col} AS v FROM candidato c WHERE ${col} IS NOT NULL ORDER BY 1 LIMIT 3000`).all();
  return r.results.map(x => x.v);
}

// ---------- Créditos e cota ----------
export async function sha256(txt) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(txt));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}
export function novaChave() {
  const b = new Uint8Array(24); crypto.getRandomValues(b);
  return "tse_" + [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}
const agora = () => new Date().toISOString();

export const PACOTES = {
  p1: { sats: 2000, creditos: 500, rotulo: "500 créditos" },
  p2: { sats: 8000, creditos: 2500, rotulo: "2.500 créditos" },
  p3: { sats: 25000, creditos: 10000, rotulo: "10.000 créditos" },
};
export const COTA_GRATIS = 60;   // consultas grátis por dia por IP via API/MCP
export const LIMITE_SITE = 400;  // navegação no site: livre, só com limite anti-abuso por IP

// Cobra `custo` créditos da chave, ou da cota grátis diária do IP. Lança 402 se não houver saldo.
export async function cobrar(db, { chave, ip, custo, site }) {
  if (site) {
    // Navegação no site é livre; o limite diário só impede robôs de copiar a base.
    const dia = agora().slice(0, 10), ih = await sha256("site:" + (ip || "?"));
    await db.prepare("INSERT INTO cota (ip_hash, dia, usados) VALUES (?, ?, 0) ON CONFLICT(ip_hash, dia) DO NOTHING").bind(ih, dia).run();
    const r = await db.prepare("UPDATE cota SET usados = usados + 1 WHERE ip_hash = ? AND dia = ? AND usados < ?").bind(ih, dia, LIMITE_SITE).run();
    if (r.meta?.changes) return { modo: "site", restante: null };
    if (!chave) throw new ErroApi(429, "Muitas consultas hoje a partir deste endereço. Volte amanhã ou use uma chave de créditos.");
  }
  if (chave) {
    const h = await sha256(chave);
    const r = await db.prepare("UPDATE chave SET creditos = creditos - ?, ultimo_uso = ? WHERE hash = ? AND creditos >= ?").bind(custo, agora(), h, custo).run();
    if (!r.meta?.changes) {
      const ex = await db.prepare("SELECT creditos FROM chave WHERE hash = ?").bind(h).first();
      throw new ErroApi(ex ? 402 : 401, ex ? `Saldo insuficiente: esta consulta custa ${custo} crédito(s) e restam ${ex.creditos}.` : "Chave inválida.");
    }
    const s = await db.prepare("SELECT creditos FROM chave WHERE hash = ?").bind(h).first();
    return { modo: "creditos", restante: s.creditos };
  }
  const dia = agora().slice(0, 10), ih = await sha256("ip:" + (ip || "?"));
  await db.prepare("INSERT INTO cota (ip_hash, dia, usados) VALUES (?, ?, 0) ON CONFLICT(ip_hash, dia) DO NOTHING").bind(ih, dia).run();
  const r = await db.prepare("UPDATE cota SET usados = usados + ? WHERE ip_hash = ? AND dia = ? AND usados + ? <= ?").bind(custo, ih, dia, custo, COTA_GRATIS).run();
  if (!r.meta?.changes) throw new ErroApi(402, `A cota grátis de hoje (${COTA_GRATIS} consultas) acabou. Compre créditos em Lightning para continuar.`);
  const s = await db.prepare("SELECT usados FROM cota WHERE ip_hash = ? AND dia = ?").bind(ih, dia).first();
  return { modo: "gratis", restante: COTA_GRATIS - s.usados };
}

// Pede uma cobrança Lightning ao endereço do dono (LNURL-pay, LUD-06/16) com verificação (LUD-21).
export async function criarPedido(db, env, fetcher, { pacote, chaveExistente }) {
  const pk = PACOTES[pacote];
  if (!pk) throw new ErroApi(400, "Pacote inválido.");
  const endereco = env.LN_ADDRESS;
  if (!endereco || !endereco.includes("@")) throw new ErroApi(503, "Pagamentos ainda não configurados.");
  const [usuario, dominio] = endereco.split("@");
  const meta = await (await fetcher(`https://${dominio}/.well-known/lnurlp/${usuario}`)).json();
  if (!meta.callback) throw new ErroApi(502, "Endereço Lightning não respondeu.");
  const msats = pk.sats * 1000;
  const sep = meta.callback.includes("?") ? "&" : "?";
  const inv = await (await fetcher(`${meta.callback}${sep}amount=${msats}`)).json();
  if (!inv.pr) throw new ErroApi(502, "Não foi possível gerar a cobrança.");

  let chave = null, hash;
  if (chaveExistente) {
    hash = await sha256(chaveExistente);
    const ex = await db.prepare("SELECT 1 FROM chave WHERE hash = ?").bind(hash).first();
    if (!ex) throw new ErroApi(401, "Chave inválida.");
  } else {
    chave = novaChave(); hash = await sha256(chave);
    await db.prepare("INSERT INTO chave (hash, creditos, criada_em) VALUES (?, 0, ?)").bind(hash, agora()).run();
  }
  const id = novaChave().slice(4, 20);
  await db.prepare("INSERT INTO pagamento VALUES (?,?,?,?,?,?,?,?,?,NULL)")
    .bind(id, hash, pacote, pk.sats, pk.creditos, inv.pr, inv.verify || null, "pendente", agora()).run();
  return { pedido: id, chave, invoice: inv.pr, sats: pk.sats, creditos: pk.creditos, confirmacao_automatica: !!inv.verify };
}

export async function verificarPedido(db, fetcher, id) {
  const p = await db.prepare("SELECT * FROM pagamento WHERE id = ?").bind(String(id)).first();
  if (!p) throw new ErroApi(404, "Pedido não encontrado.");
  if (p.status === "pendente" && p.verify_url) {
    const v = await (await fetcher(p.verify_url)).json();
    if (v.settled) {
      const r = await db.prepare("UPDATE pagamento SET status = 'pago', pago_em = ? WHERE id = ? AND status = 'pendente'").bind(agora(), p.id).run();
      if (r.meta?.changes) await db.prepare("UPDATE chave SET creditos = creditos + ? WHERE hash = ?").bind(p.creditos, p.chave_hash).run();
      p.status = "pago";
    }
  }
  const s = await db.prepare("SELECT creditos FROM chave WHERE hash = ?").bind(p.chave_hash).first();
  return { pedido: p.id, status: p.status, creditos_na_chave: s?.creditos ?? 0 };
}

// Confere pedidos pendentes (de uma chave ou de todos): quem pagou e fechou a página antes da confirmação recebe os créditos mesmo assim.
// Pedidos com mais de 24 h sem pagamento passam a "expirado" (a fatura Lightning já venceu).
export async function conferirPendentes(db, fetcher, chaveHash) {
  const lim = new Date(Date.now() - 864e5).toISOString();
  await db.prepare("UPDATE pagamento SET status = 'expirado' WHERE status = 'pendente' AND criado_em < ?").bind(lim).run();
  const q = chaveHash ? db.prepare("SELECT id FROM pagamento WHERE status = 'pendente' AND chave_hash = ?").bind(chaveHash)
                      : db.prepare("SELECT id FROM pagamento WHERE status = 'pendente' LIMIT 50");
  for (const { id } of (await q.all()).results) { try { await verificarPedido(db, fetcher, id); } catch {} }
}

export async function saldo(db, chave, fetcher) {
  if (fetcher) await conferirPendentes(db, fetcher, await sha256(chave));
  const s = await db.prepare("SELECT creditos FROM chave WHERE hash = ?").bind(await sha256(chave)).first();
  if (!s) throw new ErroApi(401, "Chave inválida.");
  return { creditos: s.creditos };
}

// Custo: 1 crédito por consulta; exportações custam 1 crédito a cada 500 linhas (mínimo 2).
export const custoConsulta = (exportar, n) => exportar ? Math.max(2, Math.ceil(n / 500)) : 1;

// ---------- Plano B: comprovante (preimage) ----------
// Lê o payment hash de uma fatura BOLT11 (bech32, campo "p"). Sem dependências.
const B32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
export function paymentHashDaFatura(pr) {
  const s = String(pr).trim().toLowerCase().replace(/^lightning:/, "");
  const sep = s.lastIndexOf("1");
  if (sep < 1) throw new ErroApi(400, "Fatura inválida.");
  const w = [...s.slice(sep + 1)].map(c => { const i = B32.indexOf(c); if (i < 0) throw new ErroApi(400, "Fatura inválida."); return i; });
  const dados = w.slice(0, w.length - 6 - 104); // tira checksum e assinatura
  let i = 7; // timestamp
  while (i + 3 <= dados.length) {
    const tipo = dados[i], len = dados[i + 1] * 32 + dados[i + 2];
    const campo = dados.slice(i + 3, i + 3 + len);
    if (tipo === 1 && len === 52) {
      let acc = 0, bits = 0; const out = [];
      for (const v of campo) { acc = (acc << 5) | v; bits += 5; while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); } }
      return out.slice(0, 32).map(b => b.toString(16).padStart(2, "0")).join("");
    }
    i += 3 + len;
  }
  throw new ErroApi(400, "Fatura sem payment hash.");
}

async function sha256Hex(hex) {
  const b = new Uint8Array(hex.match(/../g).map(x => parseInt(x, 16)));
  const d = await crypto.subtle.digest("SHA-256", b);
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, "0")).join("");
}

// O comprador cola o comprovante (preimage) que a carteira dele mostra após pagar.
// Se sha256(preimage) == payment hash da fatura, o pagamento é prova matemática.
export async function confirmarComComprovante(db, id, preimage) {
  const pre = String(preimage || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pre)) throw new ErroApi(400, "O comprovante deve ter 64 caracteres hexadecimais.");
  const p = await db.prepare("SELECT * FROM pagamento WHERE id = ?").bind(String(id)).first();
  if (!p) throw new ErroApi(404, "Pedido não encontrado.");
  if (p.status !== "pago") {
    if ((await sha256Hex(pre)) !== paymentHashDaFatura(p.invoice)) throw new ErroApi(400, "Comprovante não corresponde a esta cobrança.");
    const r = await db.prepare("UPDATE pagamento SET status = 'pago', pago_em = ? WHERE id = ? AND status = 'pendente'").bind(agora(), p.id).run();
    if (r.meta?.changes) await db.prepare("UPDATE chave SET creditos = creditos + ? WHERE hash = ?").bind(p.creditos, p.chave_hash).run();
  }
  const s = await db.prepare("SELECT creditos FROM chave WHERE hash = ?").bind(p.chave_hash).first();
  return { pedido: p.id, status: "pago", creditos_na_chave: s?.creditos ?? 0 };
}

// Cotação BTC/BRL para mostrar os pacotes em reais (cache de 10 min; sem cotação, o site mostra só sats)
let _cot = { v: null, t: 0 };
export async function cotacaoBRL(fetcher) {
  if (_cot.v && Date.now() - _cot.t < 600000) return _cot.v;
  try {
    const j = await (await fetcher("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=brl")).json();
    const v = Number(j?.bitcoin?.brl);
    if (v > 0) _cot = { v, t: Date.now() };
  } catch {}
  return _cot.v;
}
