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
export function abrirUrnas(pasta) {
  const abertas = new Map();
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
      try { if (!b.prepare("SELECT 1 FROM voto_minuto_uf LIMIT 1").get()) continue; } catch { continue; }
      let apos17Brasilia = false;
      try { apos17Brasilia = b.prepare("SELECT valor FROM meta WHERE chave = 'apos_17h'").get()?.valor === "brasilia"; } catch {}
      // Base derivada com o tempo de cada voto desde a abertura da urna (gerada por derivarTempos).
      const fr = f.replace("_tempos.db", "_rel.db");
      let rel = abertas.get(fr) || null;
      if (!rel && existsSync(pasta + "/" + fr)) { try { rel = new DatabaseSync(pasta + "/" + fr, { readOnly: true }); abertas.set(fr, rel); } catch {} }
      let relVersao = 0;
      if (rel) { try { relVersao = Number(rel.prepare("SELECT valor FROM meta WHERE chave = 'versao'").get()?.valor || 1); } catch { relVersao = 1; } }
      out.push({ nome: f, turno: Number(f[0]), uf: f.slice(3, 5), apos17Brasilia, db: b, rel, relVersao });
    }
    return out;
  };
  return {
    disponiveis: () => bases().map(b => ({ turno: b.turno, uf: b.uf, tempo_desde_abertura: !!b.rel, votos_por_secao_apos_limiar: b.relVersao >= 2 })),
    // Fecha a base derivada aberta (para trocar o arquivo por uma versão nova).
    soltar(nome) { const x = abertas.get(nome); if (x) { try { x.close(); } catch {} abertas.delete(nome); } },
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
        rows.push(...b.rel.prepare(sql).all(...(typeof params === "function" ? params(b) : params)));
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
        rows.push(...b.db.prepare(sql).all(...(typeof params === "function" ? params(b) : params)));
      }
      return rows;
    },
  };
}

// Gera, para cada base completa que ainda não tem, o arquivo <turno>_<UF>_rel.db com a distribuição
// dos votos por minuto desde a abertura da urna da seção. Lê o CSV por voto (<turno>_<UF>_votos.csv.gz)
// gerado por etl/logs.py. Roda uma base por vez, em segundo plano no servidor.
export async function derivarTempos(pasta, log = () => {}, onTroca = null) {
  let nomes = [];
  try { nomes = readdirSync(pasta).filter(f => /^[12]t_[A-Z]{2}_tempos\.db$/.test(f)); } catch { return; }
  for (const f of nomes.sort()) {
    const pre = pasta + "/" + f.replace("_tempos.db", ""), rel = pre + "_rel.db", gz = pre + "_votos.csv.gz";
    if (!existsSync(gz)) continue;
    if (existsSync(rel)) { // já existe: só refaz se for da versão antiga
      let v = 1; try { const x = new DatabaseSync(rel, { readOnly: true }); v = Number(x.prepare("SELECT valor FROM meta WHERE chave = 'versao'").get()?.valor || 1); x.close(); } catch {}
      if (v >= 2) continue;
    }
    const src = new DatabaseSync(pasta + "/" + f, { readOnly: true });
    try { if (!src.prepare("SELECT 1 FROM voto_minuto_uf LIMIT 1").get()) continue; } catch { continue; } // ainda processando
    const ab = new Map();
    for (const r of src.prepare("SELECT cd_municipio, zona, secao, abertura FROM secao_tempo WHERE abertura IS NOT NULL").iterate()) {
      const [h, m, s] = r.abertura.split(":").map(Number); ab.set(`${r.cd_municipio}|${r.zona}|${r.secao}`, h * 3600 + m * 60 + s);
    }
    src.close();
    // Também guarda, por seção, a "cauda" do dia: votos por minuto a partir das 16h (hora local da urna)
    // e a partir de 8h de urna aberta, para aplicar limiares por seção com precisão de minuto.
    const cont = new Map(), caudaH = new Map(), caudaR = new Map(); let n = 0, semAbertura = 0, antes = 0;
    const CORTE_H = 14 * 60, CORTE_R = 8 * 60; // 14h locais cobrem as 16h de Brasília em qualquer fuso do país (AC = −2h); 8h de funcionamento
    const linhas = createInterface({ input: createReadStream(gz).pipe(createGunzip()), crlfDelay: Infinity });
    let turno = null, uf = null, cab = true;
    for await (const l of linhas) {
      if (cab) { cab = false; continue; }
      const c = l.split(","); if (c.length < 6) continue;
      turno ??= Number(c[0]); uf ??= c[1];
      const sk = `${c[2]}|${c[3]}|${c[4]}`, a = ab.get(sk);
      const [h, m, s] = c[5].slice(11).split(":").map(Number), mm = h * 60 + m;
      if (mm >= CORTE_H) { const kk = sk + "|" + mm; caudaH.set(kk, (caudaH.get(kk) || 0) + 1); }
      if (a === undefined) { semAbertura++; continue; }
      const d = h * 3600 + m * 60 + s - a;
      if (d < 0) { antes++; continue; }
      const k = Math.floor(d / 60); cont.set(k, (cont.get(k) || 0) + 1); n++;
      if (k >= CORTE_R) { const kk = sk + "|" + k; caudaR.set(kk, (caudaR.get(kk) || 0) + 1); }
    }
    const tmp = rel + ".tmp"; rmSync(tmp, { force: true });
    const db = new DatabaseSync(tmp);
    db.exec(`CREATE TABLE voto_rel (turno INT, uf TEXT, minutos INT, votos INT, PRIMARY KEY (turno, uf, minutos));
      CREATE TABLE meta (chave TEXT PRIMARY KEY, valor TEXT);
      CREATE TABLE cauda_hora (cd_municipio TEXT, zona TEXT, secao TEXT, minuto INT, votos INT); -- minuto do dia, hora LOCAL da urna, a partir das 14h
      CREATE TABLE cauda_rel (cd_municipio TEXT, zona TEXT, secao TEXT, minutos INT, votos INT); -- minutos desde a abertura, a partir de 8h`);
    const ins = db.prepare("INSERT INTO voto_rel VALUES (?,?,?,?)"), iH = db.prepare("INSERT INTO cauda_hora VALUES (?,?,?,?,?)"), iR = db.prepare("INSERT INTO cauda_rel VALUES (?,?,?,?,?)");
    db.exec("BEGIN"); for (const [k, v] of cont) ins.run(turno, uf, k, v);
    for (const [k, v] of caudaH) { const [a1, a2, a3, a4] = k.split("|"); iH.run(a1, a2, a3, Number(a4), v); }
    for (const [k, v] of caudaR) { const [a1, a2, a3, a4] = k.split("|"); iR.run(a1, a2, a3, Number(a4), v); }
    db.exec("COMMIT"); db.exec("CREATE INDEX ix_ch ON cauda_hora (minuto); CREATE INDEX ix_cr ON cauda_rel (minutos);");
    db.prepare("INSERT INTO meta VALUES ('versao', '2')").run();
    db.prepare("INSERT INTO meta VALUES (?, ?)").run("contagem", JSON.stringify({ votos: n, sem_abertura: semAbertura, antes_da_abertura: antes }));
    db.close(); renameSync(tmp, rel); onTroca?.(f.replace("_tempos.db", "_rel.db"));
    log(`tempos desde a abertura: ${f.slice(0, 5)} ${n} votos`);
  }
}
