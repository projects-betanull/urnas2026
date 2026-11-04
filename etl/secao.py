#!/usr/bin/env python3
"""Carrega votacao_secao_2026_<UF>.zip do TSE numa base SQLite pequena, para cruzar horários das urnas com votos.

Uso: python3 secao.py ARQUIVO.zip SAIDA.db

Guarda só os cargos majoritários (presidente, governador, senador), os dois turnos, por seção.
Lê o CSV em fluxo (pouca memória) e grava em lotes. Escreve em SAIDA.db.tmp e só renomeia no fim.
"""
import csv, io, os, sqlite3, sys, zipfile

CARGOS = {"PRESIDENTE", "GOVERNADOR", "SENADOR"}


def main(zp, saida):
    tmp = saida + ".tmp"
    if os.path.exists(tmp):
        os.remove(tmp)
    db = sqlite3.connect(tmp)
    db.executescript("""
      PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE;
      CREATE TABLE voto_secao(turno INTEGER, cd_municipio TEXT, zona TEXT, secao TEXT, cargo TEXT, nr_votavel TEXT, qt INTEGER);
      CREATE TABLE votavel(cargo TEXT, nr_votavel TEXT, nm_votavel TEXT, PRIMARY KEY(cargo, nr_votavel));
      CREATE TABLE meta(chave TEXT PRIMARY KEY, valor TEXT);
    """)
    lote, nomes, n = [], {}, 0
    zf = zipfile.ZipFile(zp)
    for nome in zf.namelist():
        if not nome.lower().endswith(".csv"):
            continue
        with io.TextIOWrapper(zf.open(nome), encoding="latin-1", newline="") as fh:
            for r in csv.DictReader(fh, delimiter=";"):
                cargo = (r.get("DS_CARGO") or "").upper()
                if cargo not in CARGOS:
                    continue
                nv = r["NR_VOTAVEL"]
                lote.append((int(r["NR_TURNO"]), r["CD_MUNICIPIO"].zfill(5), r["NR_ZONA"].zfill(4),
                             r["NR_SECAO"].zfill(4), cargo, nv, int(r["QT_VOTOS"] or 0)))
                nomes.setdefault((cargo, nv), r.get("NM_VOTAVEL") or nv)
                if len(lote) >= 50000:
                    db.executemany("INSERT INTO voto_secao VALUES (?,?,?,?,?,?,?)", lote); n += len(lote); lote = []
    if lote:
        db.executemany("INSERT INTO voto_secao VALUES (?,?,?,?,?,?,?)", lote); n += len(lote)
    db.executemany("INSERT OR IGNORE INTO votavel VALUES (?,?,?)", [(c, v, m) for (c, v), m in nomes.items()])
    db.execute("CREATE INDEX ix_vs ON voto_secao(turno, cargo, cd_municipio, zona, secao)")
    db.execute("INSERT INTO meta VALUES ('linhas', ?), ('versao', '1')", (str(n),))
    db.commit(); db.close()
    os.replace(tmp, saida)
    print(f"{saida}: {n} linhas")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
