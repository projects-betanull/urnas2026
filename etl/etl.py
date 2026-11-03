#!/usr/bin/env python3
"""ETL dos dados abertos do TSE (eleições 2026) para SQLite / Cloudflare D1.

Uso:
  python3 etl.py PASTA_COM_ARQUIVOS SAIDA.db [--sql PASTA_SQL]

A pasta pode conter os .zip baixados de dadosabertos.tse.jus.br ou os .csv extraídos:
  consulta_cand_2026*.csv                (candidatos)
  votacao_candidato_munzona_2026*.csv    (votos por município e zona)
  bem_candidato_2026*.csv                (bens declarados)
Só lê os arquivos *_BRASIL quando existem, para não duplicar dados por UF.
Colunas pessoais (CPF, e-mail, título, data de nascimento) nunca são carregadas.
Sem dependências além da biblioteca padrão.
"""
import csv, glob, io, os, re, sqlite3, sys, zipfile, datetime

csv.field_size_limit(10**8)
AQUI = os.path.dirname(os.path.abspath(__file__))
SCHEMA = os.path.join(AQUI, "..", "schema.sql")
NULOS = {"#NULO#", "#NULO", "#NE#", "#NE", "NÃO DIVULGÁVEL", ""}


def limpo(v):
    v = (v or "").strip()
    return None if v.upper() in NULOS else v


def num(v):
    v = limpo(v)
    if v is None:
        return None
    v = v.replace(".", "").replace(",", ".") if "," in v else v
    try:
        return float(v)
    except ValueError:
        return None


def pega(row, *nomes):
    for n in nomes:
        if n in row:
            return limpo(row[n])
    return None


def abrir_csvs(pasta, prefixo):
    """Gera (nome, linhas) para cada CSV que começa com prefixo, dentro de zips ou soltos."""
    achados = []
    for z in sorted(glob.glob(os.path.join(pasta, "*.zip"))):
        with zipfile.ZipFile(z) as zf:
            for n in zf.namelist():
                b = os.path.basename(n).lower()
                if b.startswith(prefixo) and b.endswith(".csv"):
                    achados.append(("zip", z, n, b))
    for c in sorted(glob.glob(os.path.join(pasta, "*.csv"))):
        b = os.path.basename(c).lower()
        if b.startswith(prefixo):
            achados.append(("csv", c, None, b))
    if any("_brasil" in a[3] for a in achados):
        achados = [a for a in achados if "_brasil" in a[3]]
    vistos = set()
    for tipo, caminho, interno, base in achados:
        if base in vistos:
            continue
        vistos.add(base)
        if tipo == "zip":
            zf = zipfile.ZipFile(caminho)
            fh = io.TextIOWrapper(zf.open(interno), encoding="latin-1", newline="")
        else:
            fh = open(caminho, encoding="latin-1", newline="")
        yield base, csv.DictReader(fh, delimiter=";", quotechar='"')


def carregar(pasta, db_path):
    if os.path.exists(db_path):
        os.remove(db_path)
    db = sqlite3.connect(db_path)
    db.execute("PRAGMA temp_store=FILE"); db.execute("PRAGMA cache_size=-65536")
    db.executescript(open(SCHEMA, encoding="utf-8").read())
    stats = {}

    # Candidatos
    n = 0
    for base, rows in abrir_csvs(pasta, "consulta_cand_2026"):
        lote = []
        for r in rows:
            sq = pega(r, "SQ_CANDIDATO")
            turno = pega(r, "NR_TURNO")
            if not sq or not turno:
                continue
            uf = pega(r, "SG_UF")
            lote.append((
                sq, int(turno), int(pega(r, "ANO_ELEICAO") or 2026), uf,
                int(pega(r, "CD_CARGO") or 0), (pega(r, "DS_CARGO") or "").upper(),
                pega(r, "NR_CANDIDATO"), pega(r, "NM_CANDIDATO"), pega(r, "NM_URNA_CANDIDATO"),
                pega(r, "SG_PARTIDO"), pega(r, "NR_PARTIDO"),
                pega(r, "NM_FEDERACAO", "SG_FEDERACAO"),
                pega(r, "NM_COLIGACAO", "DS_COMPOSICAO_COLIGACAO"),
                pega(r, "DS_SIT_TOT_TURNO"), pega(r, "DS_GENERO"), pega(r, "DS_GRAU_INSTRUCAO"),
                pega(r, "DS_OCUPACAO"), pega(r, "DS_COR_RACA"),
            ))
            if len(lote) >= 5000:
                db.executemany("INSERT OR REPLACE INTO candidato VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", lote)
                n += len(lote); lote = []
        db.executemany("INSERT OR REPLACE INTO candidato VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", lote)
        n += len(lote)
    stats["candidatos"] = n

    # Votos: soma as zonas por município
    # Agrega dentro do SQLite (cabe em VMs com pouca memoria).
    muni = {}
    db.execute("CREATE TEMP TABLE stg (sq TEXT, turno INT, cd TEXT, v INT)")
    lote = []
    for base, rows in abrir_csvs(pasta, "votacao_candidato_munzona_2026"):
        for r in rows:
            sq = pega(r, "SQ_CANDIDATO")
            turno = pega(r, "NR_TURNO")
            cd = pega(r, "CD_MUNICIPIO")
            if not sq or not turno or not cd:
                continue
            v = pega(r, "QT_VOTOS_NOMINAIS_VALIDOS", "QT_VOTOS_NOMINAIS")
            lote.append((sq, int(turno), cd, int(float(v)) if v else 0))
            if cd not in muni:
                muni[cd] = (pega(r, "SG_UF"), pega(r, "NM_MUNICIPIO"))
            if len(lote) >= 50000:
                db.executemany("INSERT INTO stg VALUES (?,?,?,?)", lote); lote = []
    db.executemany("INSERT INTO stg VALUES (?,?,?,?)", lote); lote = []
    db.executemany("INSERT INTO municipio VALUES (?,?,?)", [(cd, u, nm) for cd, (u, nm) in muni.items()])
    db.execute("""INSERT INTO voto_municipio
                  SELECT s.sq, s.turno, m.uf, s.cd, m.nome, SUM(s.v)
                  FROM stg s JOIN municipio m ON m.cd_municipio = s.cd GROUP BY s.sq, s.turno, s.cd""")
    db.execute("DROP TABLE stg")
    agg = range(db.execute("SELECT COUNT(*) FROM voto_municipio").fetchone()[0])
    db.execute("INSERT INTO voto_total SELECT sq_candidato, turno, SUM(votos) FROM voto_municipio GROUP BY 1,2")
    db.execute("INSERT INTO voto_uf SELECT sq_candidato, turno, uf, SUM(votos) FROM voto_municipio GROUP BY 1,2,3")
    stats["votos_municipio"] = len(agg)
    stats["municipios"] = len(muni)

    # Bens
    n = 0
    for base, rows in abrir_csvs(pasta, "bem_candidato_2026"):
        lote = []
        for r in rows:
            sq = pega(r, "SQ_CANDIDATO")
            if not sq:
                continue
            ordem = pega(r, "NR_ORDEM_BEM_CANDIDATO", "NR_ORDEM_CANDIDATO")
            lote.append((sq, int(ordem) if ordem and ordem.isdigit() else None,
                         pega(r, "DS_TIPO_BEM_CANDIDATO"), pega(r, "DS_BEM_CANDIDATO"),
                         num(r.get("VR_BEM_CANDIDATO"))))
        db.executemany("INSERT INTO bem VALUES (?,?,?,?,?)", lote)
        n += len(lote)
    stats["bens"] = n

    agora = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    db.executemany("INSERT OR REPLACE INTO meta VALUES (?,?)", [
        ("atualizado_em", agora), ("fonte", "TSE - Portal de Dados Abertos"),
        *[(f"total_{k}", str(v)) for k, v in stats.items()],
    ])
    db.commit()
    return db, stats


def exportar_sql(db, pasta_sql, linhas_por_arquivo=20000):
    """Gera arquivos .sql para importar no D1 (wrangler d1 execute --file)."""
    os.makedirs(pasta_sql, exist_ok=True)
    for f in glob.glob(os.path.join(pasta_sql, "*.sql")):
        os.remove(f)
    tabelas = ["candidato", "voto_municipio", "voto_uf", "voto_total", "bem", "municipio", "meta"]
    idx = 0
    for t in tabelas:
        cur = db.execute(f"SELECT * FROM {t}")
        buf, cont = [], 0
        for row in cur:
            vals = ",".join("NULL" if v is None else str(v) if isinstance(v, (int, float)) else "'" + str(v).replace("'", "''") + "'" for v in row)
            buf.append(f"INSERT OR REPLACE INTO {t} VALUES ({vals});")
            cont += 1
            if cont >= linhas_por_arquivo:
                idx += 1
                open(os.path.join(pasta_sql, f"{idx:04d}_{t}.sql"), "w", encoding="utf-8").write("\n".join(buf))
                buf, cont = [], 0
        if buf:
            idx += 1
            open(os.path.join(pasta_sql, f"{idx:04d}_{t}.sql"), "w", encoding="utf-8").write("\n".join(buf))
    return idx


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    db, stats = carregar(sys.argv[1], sys.argv[2])
    print("Carregado:", stats)
    if "--sql" in sys.argv:
        n = exportar_sql(db, sys.argv[sys.argv.index("--sql") + 1])
        print(f"{n} arquivos SQL gerados")
