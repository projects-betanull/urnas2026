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
import { readdirSync, existsSync, createReadStream, renameSync, rmSync } from "node:fs";
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
  const abertas = new Map(), filtradas = new WeakSet(), cache = new Map(); let linhasCache = 0;
  const lembrar = (chave, calc) => {
    const h = cache.get(chave); if (h) { cache.delete(chave); cache.set(chave, h); return h; }
    const v = calc(); if (v.length > CACHE_LINHAS_POR_ITEM) return v;
    cache.set(chave, v); linhasCache += v.length + 1;
    for (const [k, x] of cache) { if (linhasCache <= CACHE_MAX_LINHAS) break; cache.delete(k); linhasCache -= x.length + 1; }
    return v;
  };
  const resolver = (params, b) => typeof params === "function" ? params(b) : params;
  // Bases de votos por seção (etl/secao.py): <UF>_secao.db (governador, senador) e BR_secao.db (presidente).
  const abrirSecao = uf => {
    const f = `${uf}_secao.db`; let b = abertas.get(f);
    if (b === undefined) { b = null; if (existsSync(pastaSecao + "/" + f)) { try { b = new DatabaseSync(pastaSecao + "/" + f, { readOnly: true }); } catch {} } if (b) abertas.set(f, b); }
    return b;
  };
  const bases = () => {
    let nomes = [];
    try { nomes = readdirSync(pasta).filter(f => /^[12]t_[A-Z]{2}_tempos\.db$/.test(f)); } catch {}
    const out = [];
    for (const f of nomes) {
      let b = abertas.get(f);
      if (!b) {
        try { b = new DatabaseSync(pasta + "/" + f, { readOnly: true }); } catch { continue; }
        abertas.set(f, b);
      }
      try { if (!b.prepare("SELECT 1 FROM main.voto_minuto_uf LIMIT 1").get()) continue; } catch { continue; }
      if (!filtradas.has(b)) {
        const t = Number(f[0]);
        b.exec(`CREATE TEMP VIEW IF NOT EXISTS secao_tempo AS SELECT * FROM main.secao_tempo WHERE turno = ${t};
          CREATE TEMP VIEW IF NOT EXISTS voto_minuto_uf AS SELECT * FROM main.voto_minuto_uf WHERE turno = ${t};`);
        filtradas.add(b);
      }
      let apos17Brasilia = false;
      try { apos17Brasilia = b.prepare("SELECT valor FROM meta WHERE chave = 'apos_17h'").get()?.valor === "brasilia"; } catch {}
      // Base derivada com o tempo de cada voto desde a abertura da urna (gerada por derivarTempos).
      const fr = f.replace("_tempos.db", "_rel.db");
      let rel = abertas.get(fr) || null;
      if (!rel && existsSync(pasta + "/" + fr)) { try { rel = new DatabaseSync(pasta + "/" + fr, { readOnly: true }); abertas.set(fr, rel); } catch {} }
      let relVersao = 0;
      if (rel) { try { relVersao = Number(rel.prepare("SELECT valor FROM meta WHERE chave = 'versao'").get()?.valor || 1); } catch { relVersao = 1; } }
      if (rel && relVersao < REL_MIN(Number(f[0]))) { rel = null; relVersao = 0; } // antiga, mistura os turnos: espera a nova
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
    disponiveis: () => bases().map(b => ({ turno: b.turno, uf: b.uf, tempo_desde_abertura: !!b.rel, votos_por_secao_apos_limiar: b.relVersao >= 2 })),
    // Fecha a base derivada aberta (para trocar o arquivo por uma versão nova).
    soltar(nome) { const x = abertas.get(nome); if (x) { try { x.close(); } catch {} abertas.delete(nome); }
      // Só os resultados dessa base derivada saem da memória; os das bases de horários continuam valendo.
      const pre = `rel|${nome.replace("_rel.db", "_tempos.db")}|`;
      for (const [k, x] of cache) if (k.startsWith(pre)) { cache.delete(k); linhasCache -= x.length + 1; } },
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
    if (existsSync(rel)) { // já existe: só refaz se for da versão antiga
      let v = 1; try { const x = new DatabaseSync(rel, { readOnly: true }); v = Number(x.prepare("SELECT valor FROM meta WHERE chave = 'versao'").get()?.valor || 1); x.close(); } catch {}
      if (v >= REL_MIN(Number(f[0]))) continue;
    }
    const src = new DatabaseSync(pasta + "/" + f, { readOnly: true });
    try { if (!src.prepare("SELECT 1 FROM voto_minuto_uf LIMIT 1").get()) continue; } catch { continue; } // ainda processando
    // Seções numeradas (índice inteiro) para as contagens caberem em pouca memória: chave = índice*1440 + minuto.
    const turnoBase = Number(f[0]), idx = new Map(), secs = [], ab = [];
    for (const r of src.prepare("SELECT cd_municipio, zona, secao, abertura FROM secao_tempo WHERE turno = ?").iterate(turnoBase)) {
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
    const turno = turnoBase; let uf = null, cab = true;
    for await (const l of linhas) {
      if (cab) { cab = false; continue; }
      if ((++lidas & 0xFFFFF) === 0) ESTADO.lidas = lidas;
      const c = l.split(","); if (c.length < 6) continue;
      if (Number(c[0]) !== turnoBase) continue; // o log do 2º turno traz também o dia do 1º
      uf ??= c[1];
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
