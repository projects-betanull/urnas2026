#!/usr/bin/env python3
"""Extrai dos logs das urnas (TSE, "arquivos de urna") o horário de cada voto, por seção.

Uso:
  python3 logs.py PASTA SAIDA_PREFIXO [--calibrar N] [--secao-resultados PASTA_VOTACAO_SECAO]

PASTA contém os .zip por UF baixados do TSE (logs/BU/RDV) ou os arquivos .logjez / -log.jez soltos.
Gera:
  SAIDA_PREFIXO_votos.csv.gz   uma linha por voto: turno, uf, municipio, zona, secao, horario
                               (também em .parquet se o pyarrow estiver instalado)
  SAIDA_PREFIXO_tempos.db      SQLite com agregados: secao_tempo e voto_minuto_uf
Privacidade: só guarda horário e tipo de evento. O texto das mensagens (que às vezes traz
o nome de um eleitor, em erros do terminal do mesário) nunca é gravado.
"""
import collections, csv, datetime, gzip, io, lzma, os, re, sqlite3, sys, zipfile

DATAS_TURNO = {datetime.date(2026, 10, 4): 1, datetime.date(2026, 10, 25): 2}
EVENTOS = [  # (tipo, regex sobre a mensagem). Ajustáveis com --calibrar.
    ("voto", re.compile(r"voto do eleitor foi computado", re.I)),
    ("habilitado", re.compile(r"eleitor foi habilitado", re.I)),
    ("abertura", re.compile(r"urna pronta para receber votos", re.I)),
    ("encerramento", re.compile(r"(in[ií]cio|procedimento).{0,20}encerramento|encerramento da vota", re.I)),
]
RE_NOME = re.compile(r"(\d{5})(\d{4})(\d{4})")
RE_MUN = re.compile(r"Munic[ií]pio\D{0,5}(\d{4,5})", re.I)
RE_ZONA = re.compile(r"Zona(?: Eleitoral)?\D{0,5}(\d{1,4})", re.I)
RE_SECAO = re.compile(r"Se[çc][ãa]o(?: Eleitoral)?\D{0,5}(\d{1,4})", re.I)
RE_UF = re.compile(r"_([A-Z]{2})(?:\.zip)?$")


def descompactar(dados):
    """Um .jez pode ser ZIP (2024+) ou 7z/LZMA (anos anteriores). Devolve [(nome, bytes)]."""
    if dados[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(dados)) as z:
            return [(n, z.read(n)) for n in z.namelist()]
    if dados[:6] == b"7z\xbc\xaf\x27\x1c":
        try:
            import py7zr  # pip install py7zr (só necessário para logs em 7z)
        except ImportError:
            raise SystemExit("Logs em formato 7z: instale com  pip install py7zr")
        with py7zr.SevenZipFile(io.BytesIO(dados)) as z:
            return [(n, b.read()) for n, b in z.readall().items()]
    try:
        return [("logd.dat", lzma.decompress(dados))]
    except lzma.LZMAError:
        return [("logd.dat", dados)]


def linhas_de_log(dados, profundidade=0):
    """Texto de todos os logd.dat do pacote, incluindo logs arquivados de urnas de contingência."""
    for nome, conteudo in descompactar(dados):
        base = os.path.basename(nome).lower()
        if base.endswith(".jez") and profundidade < 3:
            yield from linhas_de_log(conteudo, profundidade + 1)
        elif base.endswith(".dat") or base.endswith(".log"):
            yield from conteudo.decode("latin-1", errors="replace").splitlines()


def eventos(linhas):
    """Gera (tipo, datetime) e devolve também identificação da seção achada no conteúdo."""
    ident = {}
    out = []
    for ln in linhas:
        partes = ln.split("\t")
        if len(partes) < 5:
            continue
        msg = partes[4]
        if len(ident) < 3:
            for k, rx in (("mun", RE_MUN), ("zona", RE_ZONA), ("secao", RE_SECAO)):
                if k not in ident:
                    m = rx.search(msg)
                    if m:
                        ident[k] = m.group(1)
        for tipo, rx in EVENTOS:
            if rx.search(msg):
                try:
                    dt = datetime.datetime.strptime(partes[0].strip(), "%d/%m/%Y %H:%M:%S")
                except ValueError:
                    break
                if dt.date() in DATAS_TURNO:
                    out.append((tipo, dt))
                break
    return out, ident


def pacotes(pasta):
    """Gera (uf, nome_arquivo, bytes) para cada log de urna."""
    for raiz, _, arqs in os.walk(pasta):
        for a in sorted(arqs):
            caminho = os.path.join(raiz, a)
            al = a.lower()
            if al.endswith(".zip"):
                m = RE_UF.search(a[:-4] if al.endswith(".zip") else a)
                uf = m.group(1) if m else None
                with zipfile.ZipFile(caminho) as z:
                    for n in z.namelist():
                        nl = n.lower()
                        if nl.endswith(".logjez") or nl.endswith("-log.jez"):
                            yield uf, os.path.basename(n), z.read(n)
            elif al.endswith(".logjez") or al.endswith("-log.jez"):
                yield None, a, open(caminho, "rb").read()


def processar(pasta, prefixo, calibrar=0):
    if calibrar:
        cont = collections.Counter()
        for i, (uf, nome, dados) in enumerate(pacotes(pasta)):
            if i >= calibrar:
                break
            for ln in linhas_de_log(dados):
                p = ln.split("\t")
                if len(p) >= 5:
                    cont[re.sub(r"\d+", "#", p[4])[:90]] += 1
        print("Mensagens mais frequentes (só as que se repetem; ajuste EVENTOS se preciso):")
        for msg, n in cont.most_common(60):
            if n >= 3:
                print(f"{n:8d}  {msg}")
        return

    gz = gzip.open(prefixo + "_votos.csv.gz", "wt", newline="", encoding="utf-8")
    w = csv.writer(gz)
    w.writerow(["turno", "uf", "cd_municipio", "zona", "secao", "horario"])
    db_path = prefixo + "_tempos.db"
    if os.path.exists(db_path):
        os.remove(db_path)
    db = sqlite3.connect(db_path)
    db.executescript("""
      CREATE TABLE secao_tempo (turno INT, uf TEXT, cd_municipio TEXT, zona TEXT, secao TEXT,
        abertura TEXT, primeiro_voto TEXT, ultimo_voto TEXT, encerramento TEXT, votos INT,
        votos_apos_17h INT, votos_apos_19h INT, PRIMARY KEY (turno, cd_municipio, zona, secao));
      CREATE TABLE voto_minuto_uf (turno INT, uf TEXT, minuto TEXT, votos INT, PRIMARY KEY (turno, uf, minuto));
    """)
    minuto = collections.Counter()
    n_sec = n_votos = sem_id = 0
    for uf, nome, dados in pacotes(pasta):
        evs, ident = eventos(linhas_de_log(dados))
        m = RE_NOME.search(nome.split("-")[-1] if "-" in nome else nome)
        if m:
            mun, zona, secao = m.groups()
        elif len(ident) == 3:
            mun, zona, secao = ident["mun"].zfill(5), ident["zona"].zfill(4), ident["secao"].zfill(4)
        else:
            sem_id += 1
            continue
        por_turno = collections.defaultdict(list)
        for tipo, dt in evs:
            por_turno[DATAS_TURNO[dt.date()]].append((tipo, dt))
        for turno, lista in por_turno.items():
            votos = sorted(dt for t, dt in lista if t == "voto")
            ab = min((dt for t, dt in lista if t == "abertura"), default=None)
            enc = max((dt for t, dt in lista if t == "encerramento"), default=None)
            for dt in votos:
                w.writerow([turno, uf, mun, zona, secao, dt.strftime("%Y-%m-%d %H:%M:%S")])
                minuto[(turno, uf, dt.strftime("%H:%M"))] += 1
            dia = votos[0].date() if votos else None
            apos = lambda h: sum(1 for dt in votos if dt.time() >= datetime.time(h, 0))
            db.execute("INSERT OR REPLACE INTO secao_tempo VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (
                turno, uf, mun, zona, secao,
                ab and ab.strftime("%H:%M:%S"), votos and votos[0].strftime("%H:%M:%S"),
                votos and votos[-1].strftime("%H:%M:%S"), enc and enc.strftime("%H:%M:%S"),
                len(votos), apos(17), apos(19)))
            n_votos += len(votos)
        n_sec += 1
        if n_sec % 5000 == 0:
            db.commit(); print(f"{n_sec} seções, {n_votos} votos…", flush=True)
    gz.close()
    db.executemany("INSERT INTO voto_minuto_uf VALUES (?,?,?,?)", [(t, u, mm, v) for (t, u, mm), v in minuto.items()])
    db.commit()
    try:
        import pyarrow.csv as pc, pyarrow.parquet as pq
        pq.write_table(pc.read_csv(prefixo + "_votos.csv.gz"), prefixo + "_votos.parquet", compression="zstd")
        print("Parquet gerado.")
    except ImportError:
        print("pyarrow não instalado: ficou só o CSV compactado (pip install pyarrow para gerar Parquet).")
    print(f"Pronto: {n_sec} seções, {n_votos} votos, {sem_id} pacotes sem identificação de seção.")
    return db


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__); sys.exit(1)
    cal = int(sys.argv[sys.argv.index("--calibrar") + 1]) if "--calibrar" in sys.argv else 0
    processar(sys.argv[1], sys.argv[2], cal)
