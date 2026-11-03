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
