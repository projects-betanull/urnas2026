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
import { readdirSync } from "node:fs";
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
      out.push({ nome: f, turno: Number(f[0]), uf: f.slice(3, 5), apos17Brasilia, db: b });
    }
    return out;
  };
  return {
    disponiveis: () => bases().map(b => ({ turno: b.turno, uf: b.uf })),
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
