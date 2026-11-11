// Adaptador mínimo da API do D1 sobre node:sqlite, para testes locais.
import { DatabaseSync } from "node:sqlite";
export function abrirD1(caminho) {
  const db = new DatabaseSync(caminho);
  return {
    _db: db,
    prepare(sql) {
      const st = db.prepare(sql);
      const mk = args => ({
        bind: (...a) => mk(a),
        all: async () => ({ results: st.all(...args) }),
        first: async () => st.get(...args) ?? null,
        run: async () => { const r = st.run(...args); return { meta: { changes: r.changes } }; },
      });
      return mk([]);
    },
  };
}

// Bases de horários das urnas (uma por turno e UF, geradas por etl/logs.py). Só leitura.
// Uma base só entra quando está completa (voto_minuto_uf é gravada no fim do processamento).
import { readdirSync, existsSync, createReadStream, renameSync, rmSync, statSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
// O log de uma urna usada nos dois turnos traz os dois dias: a base 2t_XX tem também linhas do 1º turno
// (etl/logs.py separa o turno pela data de cada evento). Cada base só responde pelo próprio turno: views
// temporárias com o mesmo nome das tabelas (o esquema temp vem antes do main) filtram o turno do arquivo.
// Base derivada (_rel.db): a versão 3 lê só o turno do arquivo; as do 2º turno anteriores a ela misturam os dias.
const REL_MIN = turno => turno === 2 ? 3 : 2;
// Resultados pequenos ficam em memória: as bases só mudam quando um arquivo novo aparece ou é trocado.
const CACHE_MAX_LINHAS = 400_000, CACHE_LINHAS_POR_ITEM = 50_000;
export function abrirUrnas(pasta, pastaSecao = pasta.replace(/\/?[^/]+\/?$/, "") + "/secao") {
  const abertas = new Map(), filtradas = new WeakSet(), misturadas = new WeakSet(), cache = new Map(); let linhasCache = 0;
  const lembrar = (chave, calc) => {
    const h = cache.get(chave); if (h) { cache.delete(chave); cache.set(chave, h); return h; }
    const v = calc(); if (v.length > CACHE_LINHAS_POR_ITEM) return v;
    cache.set(chave, v); linhasCache += v.length + 1;
    for (const [k, x] of cache) { if (linhasCache <= CACHE_MAX_LINHAS) break; cache.delete(k); linhasCache -= x.length + 1; }
    return v;
  };
  const resolver = (params, b) => typeof params === "function" ? params(b) : params;
  // Abre (só leitura) e reabre quando o arquivo é trocado (etl/logs.py grava com nome temporário e renomeia).
  const mtimes = new Map();
  const esquecer = arq => { const pre = arq.endsWith("_rel.db") ? `rel|${arq.replace("_rel.db", "_tempos.db")}|` : `db|${arq}|`;
    for (const [k, x] of cache) if (k.startsWith(pre)) { cache.delete(k); linhasCache -= x.length + 1; } };
  const abrir = arq => {
    let m; try { m = statSync(pasta + "/" + arq).mtimeMs; } catch { return null; }
    const x = abertas.get(arq);
    if (x && mtimes.get(arq) === m) return x;
    if (x) { try { x.close(); } catch {} abertas.delete(arq); esquecer(arq); }
    try { const b = new DatabaseSync(pasta + "/" + arq, { readOnly: true }); abertas.set(arq, b); mtimes.set(arq, m); return b; } catch { return null; }
  };
  // Bases de votos por seção (etl/secao.py): <UF>_secao.db (governador, senador) e BR_secao.db (presidente).
  // Reabre quando etl/secao.py troca o arquivo (carga de uma UF nova ou refeita).
  const mtSecao = new Map();
  const abrirSecao = uf => {
    const f = `${uf}_secao.db`; let m; try { m = statSync(pastaSecao + "/" + f).mtimeMs; } catch { return null; }
    let b = abertas.get(f);
    if (b && mtSecao.get(f) !== m) { try { b.close(); } catch {} abertas.delete(f); b = undefined; }
    if (b === undefined) { b = null; try { b = new DatabaseSync(pastaSecao + "/" + f, { readOnly: true }); } catch {} if (b) { abertas.set(f, b); mtSecao.set(f, m); } }
    return b;
  };

  // ---- Índice compacto para o explorador de horários --------------------------------------------------
  // Antes, cada consulta do explorador relia secao_tempo de todas as bases (≈ 500 mil seções por turno) e,
  // para votos tardios, refazia um GROUP BY na base derivada: 6–8 s por consulta nacional na VM pequena.
  // Agora cada base é lida uma vez para vetores tipados (≈ 20 bytes por seção) e as somas por limiar e os
  // votos por candidato ficam guardados, alinhados à ordem das seções (cd_municipio, zona, secao).
  const IDX = new Map(); // nome da base -> { mt, ix }
  const LRU = new Map(); let bytesLRU = 0; const BYTES_LRU = 64 * 1024 * 1024;
  const guardar = (k, calc) => {
    const h = LRU.get(k); if (h) { LRU.delete(k); LRU.set(k, h); return h.v; }
    const v = calc(); const bytes = v?.bytes || 64; LRU.set(k, { v, bytes }); bytesLRU += bytes;
    for (const [kk, x] of LRU) { if (bytesLRU <= BYTES_LRU || kk === k) break; LRU.delete(kk); bytesLRU -= x.bytes; }
    return v;
  };
  const tabela = () => { const ids = new Map(), vals = []; return { vals, id: s => { let i = ids.get(s); if (i === undefined) { ids.set(s, i = vals.length); vals.push(s); } return i; } }; };
  const seg = t => { if (!t) return -1; const [h, m, s] = t.split(":").map(Number); return h * 3600 + m * 60 + (s || 0); };
  const indice = b => {
    const mt = mtimes.get(b.nome), x = IDX.get(b.nome); if (x && x.mt === mt) return x.ix;
    const n = b.db.prepare("SELECT COUNT(*) n FROM secao_tempo").get().n;
    const mun = new Uint16Array(n), zona = new Uint16Array(n), secao = new Uint16Array(n), ab = new Int32Array(n), enc = new Int32Array(n), votos = new Int32Array(n);
    const tm = tabela(), tz = tabela(), ts = tabela(); let i = 0;
    for (const r of b.db.prepare("SELECT cd_municipio, zona, secao, abertura, encerramento, votos FROM secao_tempo ORDER BY cd_municipio, zona, secao").iterate()) {
      if (i >= n) break;
      mun[i] = tm.id(r.cd_municipio); zona[i] = tz.id(r.zona); secao[i] = ts.id(r.secao); ab[i] = seg(r.abertura); enc[i] = seg(r.encerramento); votos[i] = r.votos || 0; i++;
    }
    const ix = { n: i, mun, zona, secao, ab, enc, votos, muns: tm.vals, zonas: tz.vals, secoes: ts.vals };
    IDX.set(b.nome, { mt, ix }); return ix;
  };
  // Junta linhas ordenadas por (cd_municipio, zona, secao) com as seções do índice, sem montar mapas por chave.
  const casar = (ix, linhas, cb) => {
    let i = 0;
    const cmp = (r, j) => { const a = ix.muns[ix.mun[j]], z = ix.zonas[ix.zona[j]], s = ix.secoes[ix.secao[j]];
      return r.cd_municipio < a ? -1 : r.cd_municipio > a ? 1 : r.zona < z ? -1 : r.zona > z ? 1 : r.secao < s ? -1 : r.secao > s ? 1 : 0; };
    for (const r of linhas) {
      let c; while (i < ix.n && (c = cmp(r, i)) > 0) i++;
      if (i >= ix.n) break;
      if (c === 0) cb(i, r);
    }
  };
  // Votos registrados a partir de um limiar, por seção (Int32Array alinhado ao índice), ou null sem base derivada.
  const cauda = (b, ix, tipo, lim) => {
    if (!b.rel || b.relVersao < 2) return null;
    const fr = b.nome.replace("_tempos.db", "_rel.db");
    return guardar(`cauda|${fr}|${mtimes.get(fr)}|${mtimes.get(b.nome)}|${tipo}|${lim}`, () => {
      const v = new Int32Array(ix.n);
      const sql = tipo === "hora" ? "SELECT cd_municipio, zona, secao, SUM(votos) v FROM cauda_hora WHERE minuto >= ? GROUP BY 1, 2, 3 ORDER BY 1, 2, 3"
        : "SELECT cd_municipio, zona, secao, SUM(votos) v FROM cauda_rel WHERE minutos >= ? GROUP BY 1, 2, 3 ORDER BY 1, 2, 3";
      casar(ix, b.rel.prepare(sql).iterate(lim), (i, r) => { v[i] = r.v; });
      v.bytes = v.byteLength; return v;
    });
  };
  // Votos válidos por seção e candidato num cargo: q[i * k + j], tem[i] = seção presente na base de votos.
  const candidatos = (b, ix, cargo) => {
    const uf = cargo === "PRESIDENTE" ? "BR" : b.uf, sb = abrirSecao(uf); if (!sb) return null;
    return guardar(`cand|${b.nome}|${mtimes.get(b.nome)}|${cargo}|${mtSecao.get(uf + "_secao.db")}`, () => {
      let where = "turno = ? AND cargo = ? AND nr_votavel NOT IN ('95','96','97','98')", par = [b.turno, cargo];
      if (cargo === "PRESIDENTE") { if (!ix.muns.length) return { k: 0, nrs: [], nomes: new Map(), q: new Int32Array(0), tem: new Uint8Array(ix.n), vazio: true, bytes: 64 };
        where += ` AND cd_municipio IN (${ix.muns.map(() => "?").join(",")})`; par = par.concat(ix.muns); }
      const nrs = sb.prepare(`SELECT DISTINCT nr_votavel FROM voto_secao WHERE ${where} ORDER BY 1`).all(...par).map(r => r.nr_votavel);
      const k = nrs.length, pos = new Map(nrs.map((nr, j) => [nr, j])), q = new Int32Array(ix.n * k).fill(-1), tem = new Uint8Array(ix.n); // -1: sem linha
      casar(ix, sb.prepare(`SELECT cd_municipio, zona, secao, nr_votavel, qt FROM voto_secao WHERE ${where} ORDER BY cd_municipio, zona, secao`).iterate(...par),
        (i, r) => { tem[i] = 1; const o = i * k + pos.get(r.nr_votavel); q[o] = Math.max(q[o], 0) + r.qt; });
      const nomes = new Map(); for (const r of sb.prepare("SELECT nr_votavel, nm_votavel FROM votavel WHERE cargo = ?").iterate(cargo)) nomes.set(r.nr_votavel, r.nm_votavel);
      return { k, nrs, nomes, q, tem, vazio: k === 0, bytes: q.byteLength + tem.byteLength + 1024 };
    });
  };
  const bases = () => {
    let nomes = [];
    try { nomes = readdirSync(pasta).filter(f => /^[12]t_[A-Z]{2}_tempos\.db$/.test(f)); } catch {}
    const out = [];
    for (const f of nomes) {
      const b = abrir(f); if (!b) continue;
      try { if (!b.prepare("SELECT 1 FROM main.voto_minuto_uf LIMIT 1").get()) continue; } catch { continue; }
      if (!filtradas.has(b)) {
        // Cada base responde só pelo próprio turno E pela própria UF. Em 11/2026 um zip de SP que sobrou na pasta
        // temporária entrou junto na base 2t_TO, e SP saía duas vezes nos totais do país (27 milhões de votos a mais).
        const t = Number(f[0]), u = f.slice(3, 5);
        b.exec(`CREATE TEMP VIEW IF NOT EXISTS secao_tempo AS SELECT * FROM main.secao_tempo WHERE turno = ${t} AND uf = '${u}';
          CREATE TEMP VIEW IF NOT EXISTS voto_minuto_uf AS SELECT * FROM main.voto_minuto_uf WHERE turno = ${t} AND uf = '${u}';`);
        filtradas.add(b);
        let mista = false; try { mista = !!b.prepare(`SELECT 1 FROM main.secao_tempo WHERE turno = ${t} AND uf <> '${u}' LIMIT 1`).get(); } catch {}
        if (mista) misturadas.add(b);
      }
      let apos17Brasilia = false;
      try { apos17Brasilia = b.prepare("SELECT valor FROM meta WHERE chave = 'apos_17h'").get()?.valor === "brasilia"; } catch {}
      // Base derivada com o tempo de cada voto desde a abertura da urna (gerada por derivarTempos).
      const fr = f.replace("_tempos.db", "_rel.db");
      let rel = existsSync(pasta + "/" + fr) ? abrir(fr) : null;
      if (rel && mtimes.get(fr) < mtimes.get(f)) rel = null; // base de horários refeita depois: espera a derivada nova
      let relVersao = 0;
      if (rel) { try { relVersao = Number(rel.prepare("SELECT valor FROM meta WHERE chave = 'versao'").get()?.valor || 1); } catch { relVersao = 1; } }
      if (rel && relVersao < REL_MIN(Number(f[0]))) { rel = null; relVersao = 0; } // antiga, mistura os turnos: espera a nova
      if (misturadas.has(b)) { rel = null; relVersao = 0; } // base com logs de outra UF: a derivada também veio misturada; espera a base refeita
      out.push({ nome: f, turno: Number(f[0]), uf: f.slice(3, 5), apos17Brasilia, db: b, rel, relVersao });
    }
    return out;
  };
  return {
    // Votos por seção num cargo para uma base (turno, UF): Map "mun|zona|secao" -> [[nr_votavel, qt], ...] e nomes.
    // Brancos, nulos e anulados (95–98) ficam de fora. Devolve null se a base de seções não existe.
    votosSecao(turno, uf, cargo) {
      const b = bases().find(x => x.turno === Number(turno) && x.uf === uf); if (!b) return null;
      const sb = abrirSecao(cargo === "PRESIDENTE" ? "BR" : uf); if (!sb) return null;
      const mapa = new Map(), nomes = new Map();
      let sql = "SELECT cd_municipio, zona, secao, nr_votavel, qt FROM voto_secao WHERE turno = ? AND cargo = ? AND nr_votavel NOT IN ('95','96','97','98')", par = [Number(turno), cargo];
      if (cargo === "PRESIDENTE") {
        const muns = b.db.prepare("SELECT DISTINCT cd_municipio FROM secao_tempo").all().map(r => r.cd_municipio);
        if (!muns.length) return { mapa, nomes };
        sql += ` AND cd_municipio IN (${muns.map(() => "?").join(",")})`; par = par.concat(muns);
      }
      for (const r of sb.prepare(sql).iterate(...par)) {
        const k = `${r.cd_municipio}|${r.zona}|${r.secao}`; let a = mapa.get(k); if (!a) mapa.set(k, a = []); a.push([r.nr_votavel, r.qt]);
      }
      for (const r of sb.prepare("SELECT nr_votavel, nm_votavel FROM votavel WHERE cargo = ?").iterate(cargo)) nomes.set(r.nr_votavel, r.nm_votavel);
      return { mapa, nomes };
    },
    // Bases do turno (e UFs) com o índice compacto; cauda(tipo, limiar) e candidatos(cargo) usam a mesma ordem de seções.
    secoes(turno, ufs = null) {
      return bases().filter(b => b.turno === Number(turno) && (!ufs || ufs.includes(b.uf))).sort((a, c) => a.uf < c.uf ? -1 : 1).map(b => ({
        turno: b.turno, uf: b.uf, temCauda: !!(b.rel && b.relVersao >= 2), indice: () => indice(b),
        cauda: (tipo, lim) => cauda(b, indice(b), tipo, lim), candidatos: cargo => candidatos(b, indice(b), cargo),
      }));
    },
    disponiveis: () =>bases().map(b => ({ turno: b.turno, uf: b.uf, tempo_desde_abertura: !!b.rel, votos_por_secao_apos_limiar: b.relVersao >= 2 })),
    // Fecha a base derivada aberta (para trocar o arquivo por uma versão nova).
    soltar(nome) { const x = abertas.get(nome); if (x) { try { x.close(); } catch {} abertas.delete(nome); } esquecer(nome); },
    // Percorre linha a linha (sem montar listas grandes em memória). cb(linha, base).
    // relSql (opcional) roda antes na base derivada da mesma UF e o resultado vai como base.extra.
    percorrer(sql, params = [], filtro = {}, cb, relSql = null, relParams = []) {
      for (const b of bases()) {
        if ((filtro.turno && b.turno !== Number(filtro.turno)) || (filtro.uf && b.uf !== filtro.uf)) continue;
        if (filtro.ufs && !filtro.ufs.includes(b.uf)) continue;
        let extra = null;
        if (relSql) { extra = null; try { if (b.rel && b.relVersao >= 2) extra = b.rel.prepare(relSql).all(...(typeof relParams === "function" ? relParams(b) : relParams)); } catch {} }
        const ctx = { turno: b.turno, uf: b.uf, apos17Brasilia: b.apos17Brasilia, extra, temCauda: !!(b.rel && b.relVersao >= 2) };
        for (const r of b.db.prepare(sql).iterate(...(typeof params === "function" ? params(b) : params))) cb(r, ctx);
      }
    },
    // Mesma ideia de consultar(), mas na base derivada (tempo de cada voto desde a abertura).
    consultarRel(sql, params = [], filtro = {}) {
      const rows = [];
      for (const b of bases()) {
        if (!b.rel || (filtro.turno && b.turno !== Number(filtro.turno)) || (filtro.uf && b.uf !== filtro.uf)) continue;
        const p = resolver(params, b);
        rows.push(...lembrar(`rel|${b.nome}|${b.relVersao}|${sql}|${JSON.stringify(p)}`, () => b.rel.prepare(sql).all(...p)));
      }
      return rows;
    },
    // params pode ser uma função da base ({turno, uf, apos17Brasilia}) para usar limites por fuso.
    // Roda a mesma consulta em cada base que casar com o filtro e junta as linhas.
    consultar(sql, params = [], filtro = {}) {
      const rows = [];
      for (const b of bases()) {
        if (filtro.turno && b.turno !== Number(filtro.turno)) continue;
        if (filtro.uf && b.uf !== filtro.uf) continue;
        const p = resolver(params, b);
        rows.push(...lembrar(`db|${b.nome}|${sql}|${JSON.stringify(p)}`, () => b.db.prepare(sql).all(...p)));
      }
      return rows;
    },
  };
}

// Gera, para cada base completa que ainda não tem, o arquivo <turno>_<UF>_rel.db com a distribuição
// dos votos por minuto desde a abertura da urna da seção. Lê o CSV por voto (<turno>_<UF>_votos.csv.gz)
// gerado por etl/logs.py. Roda uma base por vez, em segundo plano no servidor.
export const ESTADO = { atual: null, inicio: null, lidas: 0, feitos: [] };
export async function derivarTempos(pasta, log = () => {}, onTroca = null) {
  let nomes = [];
  try { nomes = readdirSync(pasta).filter(f => /^[12]t_[A-Z]{2}_tempos\.db$/.test(f)); } catch { return; }
  for (const f of nomes.sort()) {
    const pre = pasta + "/" + f.replace("_tempos.db", ""), rel = pre + "_rel.db", gz = pre + "_votos.csv.gz";
    if (!existsSync(gz)) continue;
    if (existsSync(rel) && statSync(rel).mtimeMs >= statSync(pasta + "/" + f).mtimeMs) { // já existe: só refaz se for da versão antiga
      let v = 1; try { const x = new DatabaseSync(rel, { readOnly: true }); v = Number(x.prepare("SELECT valor FROM meta WHERE chave = 'versao'").get()?.valor || 1); x.close(); } catch {}
      if (v >= REL_MIN(Number(f[0]))) continue;
    }
    const src = new DatabaseSync(pasta + "/" + f, { readOnly: true });
    try { if (!src.prepare("SELECT 1 FROM voto_minuto_uf LIMIT 1").get()) continue; } catch { continue; } // ainda processando
    // Seções numeradas (índice inteiro) para as contagens caberem em pouca memória: chave = índice*1440 + minuto.
    const turnoBase = Number(f[0]), idx = new Map(), secs = [], ab = [];
    for (const r of src.prepare("SELECT cd_municipio, zona, secao, abertura FROM secao_tempo WHERE turno = ? AND uf = ?").iterate(turnoBase, f.slice(3, 5))) {
      const k = `${r.cd_municipio}|${r.zona}|${r.secao}`; idx.set(k, secs.length); secs.push([r.cd_municipio, r.zona, r.secao]);
      if (r.abertura) { const [h, m, s2] = r.abertura.split(":").map(Number); ab.push(h * 3600 + m * 60 + s2); } else ab.push(null);
    }
    src.close();
    // Também guarda, por seção, a "cauda" do dia: votos por minuto a partir das 14h locais (cobre as 16h de Brasília
    // em qualquer fuso do país) e a partir de 8h de urna aberta, para aplicar limiares por seção com precisão de minuto.
    const cont = new Map(), caudaH = new Map(), caudaR = new Map(); let n = 0, semAbertura = 0, antes = 0, lidas = 0;
    const CORTE_H = 14 * 60, CORTE_R = 8 * 60;
    ESTADO.atual = f; ESTADO.inicio = new Date().toISOString(); ESTADO.lidas = 0;
    const linhas = createInterface({ input: createReadStream(gz).pipe(createGunzip()), crlfDelay: Infinity });
    const turno = turnoBase, uf = f.slice(3, 5); let cab = true;
    for await (const l of linhas) {
      if (cab) { cab = false; continue; }
      if ((++lidas & 0xFFFFF) === 0) ESTADO.lidas = lidas;
      const c = l.split(","); if (c.length < 6) continue;
      if (Number(c[0]) !== turnoBase) continue; // o log do 2º turno traz também o dia do 1º
      if (c[1] !== uf) continue; // só a UF do arquivo (um zip de outra UF esquecido na pasta não entra)
      const i = idx.get(`${c[2]}|${c[3]}|${c[4]}`);
      const [h, m, s2] = c[5].slice(11).split(":").map(Number), mm = h * 60 + m;
      if (i !== undefined && mm >= CORTE_H) { const kk = i * 1440 + mm; caudaH.set(kk, (caudaH.get(kk) || 0) + 1); }
      const a = i === undefined ? null : ab[i];
      if (a == null) { semAbertura++; continue; }
      const d = h * 3600 + m * 60 + s2 - a;
      if (d < 0) { antes++; continue; }
      const k = Math.floor(d / 60); cont.set(k, (cont.get(k) || 0) + 1); n++;
      if (k >= CORTE_R && k < 1440) { const kk = i * 1440 + k; caudaR.set(kk, (caudaR.get(kk) || 0) + 1); }
    }
    ESTADO.lidas = lidas;
    const tmp = rel + ".tmp"; rmSync(tmp, { force: true });
    const db = new DatabaseSync(tmp);
    db.exec(`CREATE TABLE voto_rel (turno INT, uf TEXT, minutos INT, votos INT, PRIMARY KEY (turno, uf, minutos));
      CREATE TABLE meta (chave TEXT PRIMARY KEY, valor TEXT);
      CREATE TABLE cauda_hora (cd_municipio TEXT, zona TEXT, secao TEXT, minuto INT, votos INT); -- minuto do dia, hora LOCAL da urna, a partir das 14h
      CREATE TABLE cauda_rel (cd_municipio TEXT, zona TEXT, secao TEXT, minutos INT, votos INT); -- minutos desde a abertura, a partir de 8h`);
    const ins = db.prepare("INSERT INTO voto_rel VALUES (?,?,?,?)"), iH = db.prepare("INSERT INTO cauda_hora VALUES (?,?,?,?,?)"), iR = db.prepare("INSERT INTO cauda_rel VALUES (?,?,?,?,?)");
    db.exec("BEGIN"); for (const [k, v] of cont) ins.run(turno, uf, k, v);
    for (const [k, v] of caudaH) { const sc = secs[Math.floor(k / 1440)]; iH.run(sc[0], sc[1], sc[2], k % 1440, v); }
    for (const [k, v] of caudaR) { const sc = secs[Math.floor(k / 1440)]; iR.run(sc[0], sc[1], sc[2], k % 1440, v); }
    db.exec("COMMIT"); db.exec("CREATE INDEX ix_ch ON cauda_hora (minuto); CREATE INDEX ix_cr ON cauda_rel (minutos);");
    db.prepare("INSERT INTO meta VALUES ('versao', '3')").run();
    db.prepare("INSERT INTO meta VALUES (?, ?)").run("contagem", JSON.stringify({ votos: n, sem_abertura: semAbertura, antes_da_abertura: antes }));
    db.close(); renameSync(tmp, rel); onTroca?.(f.replace("_tempos.db", "_rel.db"));
    log(`tempos desde a abertura: ${f.slice(0, 5)} ${n} votos`);
    ESTADO.feitos.push(f.slice(0, 5)); ESTADO.atual = null;
  }
}
