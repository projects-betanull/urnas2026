#!/usr/bin/env python3
"""Extrai dos logs das urnas (TSE, "arquivos de urna") o horário de cada voto, por seção.

Uso:
  python3 logs.py PASTA SAIDA_PREFIXO [--calibrar N] [--secao-resultados PASTA_VOTACAO_SECAO]
  python3 logs.py --refazer SAIDA_PREFIXO   refaz SAIDA_PREFIXO_tempos.db só a partir dos extratos
                                            (_votos.csv.gz e _eventos.csv.gz), sem os arquivos do TSE

PASTA contém os .zip por UF baixados do TSE (logs/BU/RDV) ou os arquivos .logjez / -log.jez soltos.
Gera:
  SAIDA_PREFIXO_votos.csv.gz   uma linha por voto: turno, uf, municipio, zona, secao, horario
                               (também em .parquet se o pyarrow estiver instalado)
  SAIDA_PREFIXO_eventos.csv.gz extrato dos demais eventos que importam para os horários (abertura, tentativas,
                               cancelamentos e confirmação do encerramento, inspeções, justificativas...),
                               como códigos fixos: turno, uf, municipio, zona, secao, horario, evento
  SAIDA_PREFIXO_tempos.db      SQLite com agregados: secao_tempo e voto_minuto_uf
Os arquivos são escritos com nome temporário e só trocados no fim (o site segue com a versão anterior).
Privacidade: só guarda horário e um código de evento. O texto das mensagens (que às vezes traz
o nome de um eleitor, em erros do terminal do mesário, ou números de título) nunca é gravado.
"""
import collections, csv, datetime, gzip, io, lzma, os, re, sqlite3, sys, zipfile

DATAS_TURNO = {datetime.date(2026, 10, 4): 1, datetime.date(2026, 10, 25): 2}
# (código, regex sobre a mensagem), na ordem em que são testados; vale o primeiro que casar. Ajustáveis com --calibrar.
# "voto" vai para _votos.csv.gz; os demais, para o extrato _eventos.csv.gz. Mensagens periódicas (bateria,
# memória) e as de cada eleitor (habilitação) ficam de fora para o extrato continuar pequeno.
EVENTOS = [
    ("voto", re.compile(r"voto do eleitor foi computado", re.I)),
    ("abertura", re.compile(r"urna pronta para receber votos", re.I)),
    # O mesário pode escolher "Encerrar votação" e cancelar várias vezes; a urna só fecha com a confirmação.
    # Depois dela vem o registro dos mesários (alguns minutos) e só então "Inicio do Encerramento".
    ("enc_selecionado", re.compile(r"selecionou: encerrar vota", re.I)),
    ("enc_cancelado", re.compile(r"cancelou o encerramento", re.I)),
    ("enc_abortado", re.compile(r"procedimento de encerramento abortado", re.I)),
    ("enc_confirmado", re.compile(r"procedimento de encerramento confirmado", re.I)),
    ("enc_antes_da_hora", re.compile(r"encerramento s[oó] pode ser solicitado", re.I)),
    ("enc_inicio", re.compile(r"in[ií]cio do encerramento|iniciando procedimento de encerramento", re.I)),
    ("mesarios_apos", re.compile(r"registrando mes[aá]rios ap[oó]s", re.I)),
    ("inspecao_inicio", re.compile(r"inspe[cç][aã]o da urna iniciada", re.I)),
    ("inspecao_fim", re.compile(r"inspe[cç][aã]o da urna terminada", re.I)),
    ("justificativa", re.compile(r"justificativa recebida", re.I)),
    ("bu_gerado", re.compile(r"gerando relat[oó]rio \[bu\] \[in", re.I)),
    ("enc_outro", re.compile(r"(in[ií]cio|procedimento).{0,20}encerramento|encerramento da vota", re.I)),
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


# Os logs trazem o horário local da urna. A votação vai das 8h às 17h de Brasília em todo o país
# (no exterior, das 8h às 17h locais). Diferença do horário local para o de Brasília, por UF:
FUSO = {"AC": -2, "AM": -1, "RO": -1, "RR": -1, "MT": -1, "MS": -1}  # demais UFs: 0; ZZ: horário local do país

def tempos_secao(lista, uf):
    """lista: [(código, datetime)] de uma seção num turno -> (abertura, primeiro, último, encerramento, votos, após 17h, após 19h)."""
    votos = sorted(dt for t, dt in lista if t == "voto")
    ab = min((dt for t, dt in lista if t == "abertura"), default=None)
    ult = lambda *cs: max((dt for t, dt in lista if t in cs), default=None)
    # Encerramento = confirmação do mesário (a última, se houve mais de uma). Logs sem ela: o início do
    # encerramento; sem nenhum dos dois, o último outro evento de encerramento (formato antigo).
    enc = ult("enc_confirmado") or ult("enc_inicio") or ult("enc_abortado", "enc_cancelado", "enc_outro")
    fz = FUSO.get(uf, 0)  # votos depois das 17h/19h de Brasília (no exterior, do horário local)
    apos = lambda h: sum(1 for dt in votos if dt.time() >= datetime.time(h + fz, 0))
    hms = lambda dt: dt and dt.strftime("%H:%M:%S")
    return (hms(ab), hms(votos[0]) if votos else None, hms(votos[-1]) if votos else None, hms(enc), len(votos), apos(17), apos(19))


def nova_base(caminho):
    if os.path.exists(caminho):
        os.remove(caminho)
    db = sqlite3.connect(caminho)
    db.executescript("""
      CREATE TABLE secao_tempo (turno INT, uf TEXT, cd_municipio TEXT, zona TEXT, secao TEXT,
        abertura TEXT, primeiro_voto TEXT, ultimo_voto TEXT, encerramento TEXT, votos INT,
        votos_apos_17h INT, votos_apos_19h INT, PRIMARY KEY (turno, cd_municipio, zona, secao));
      CREATE TABLE voto_minuto_uf (turno INT, uf TEXT, minuto TEXT, votos INT, PRIMARY KEY (turno, uf, minuto));
      CREATE TABLE meta (chave TEXT PRIMARY KEY, valor TEXT);
      INSERT INTO meta VALUES ('horarios', 'local'), ('apos_17h', 'brasilia'), ('encerramento', 'confirmacao'), ('extrato', '1');
    """)
    return db


def fechar_base(db, minuto, caminho):
    db.executemany("INSERT INTO voto_minuto_uf VALUES (?,?,?,?)", [(t, u, mm, v) for (t, u, mm), v in minuto.items()])
    db.commit(); db.close()
    os.replace(caminho + ".tmp", caminho)


FMT = "%Y-%m-%d %H:%M:%S"
CAB_VOTOS = ["turno", "uf", "cd_municipio", "zona", "secao", "horario"]
CAB_EVENTOS = CAB_VOTOS + ["evento"]


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

    f_votos, f_ev, f_db = prefixo + "_votos.csv.gz", prefixo + "_eventos.csv.gz", prefixo + "_tempos.db"
    gz = gzip.open(f_votos + ".tmp", "wt", newline="", encoding="utf-8"); w = csv.writer(gz); w.writerow(CAB_VOTOS)
    gze = gzip.open(f_ev + ".tmp", "wt", newline="", encoding="utf-8"); we = csv.writer(gze); we.writerow(CAB_EVENTOS)
    db = nova_base(f_db + ".tmp")
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
            for tipo, dt in sorted(lista, key=lambda x: x[1]):
                if tipo == "voto":
                    w.writerow([turno, uf, mun, zona, secao, dt.strftime(FMT)])
                    minuto[(turno, uf, dt.strftime("%H:%M"))] += 1
                else:
                    we.writerow([turno, uf, mun, zona, secao, dt.strftime(FMT), tipo])
            t = tempos_secao(lista, uf)
            db.execute("INSERT OR REPLACE INTO secao_tempo VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (turno, uf, mun, zona, secao) + t)
            n_votos += t[4]
        n_sec += 1
        if n_sec % 5000 == 0:
            db.commit(); print(f"{n_sec} seções, {n_votos} votos…", flush=True)
    gz.close(); gze.close()
    os.replace(f_votos + ".tmp", f_votos); os.replace(f_ev + ".tmp", f_ev)
    fechar_base(db, minuto, f_db)
    try:
        import pyarrow.csv as pc, pyarrow.parquet as pq
        pq.write_table(pc.read_csv(f_votos), prefixo + "_votos.parquet.tmp", compression="zstd")
        os.replace(prefixo + "_votos.parquet.tmp", prefixo + "_votos.parquet")
        print("Parquet gerado.")
    except ImportError:
        print("pyarrow não instalado: ficou só o CSV compactado (pip install pyarrow para gerar Parquet).")
    print(f"Pronto: {n_sec} seções, {n_votos} votos, {sem_id} pacotes sem identificação de seção.")


def refazer(prefixo):
    """Refaz _tempos.db só com os extratos. Uma seção que veio em mais de um pacote tem os eventos somados."""
    f_votos, f_ev, f_db = prefixo + "_votos.csv.gz", prefixo + "_eventos.csv.gz", prefixo + "_tempos.db"
    if not os.path.exists(f_ev):
        raise SystemExit(f"Sem extrato de eventos ({f_ev}): processe de novo a partir dos arquivos do TSE.")
    ler = lambda f: csv.reader(gzip.open(f, "rt", newline="", encoding="utf-8"))
    evs = collections.defaultdict(list)
    r = ler(f_ev); next(r)
    for turno, uf, mun, zona, secao, h, tipo in r:
        evs[(int(turno), uf, mun, zona, secao)].append((tipo, datetime.datetime.strptime(h, FMT)))
    db = nova_base(f_db + ".tmp")
    minuto = collections.Counter(); n_votos = 0
    def gravar(k, lista):
        t = tempos_secao(lista, k[1])
        db.execute("INSERT OR REPLACE INTO secao_tempo VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", k + t)
        return t[4]
    atual, lista = None, []
    r = ler(f_votos); next(r)
    for turno, uf, mun, zona, secao, h in r:  # os votos de cada seção vêm juntos no arquivo
        k = (int(turno), uf, mun, zona, secao)
        if k != atual:
            if atual: n_votos += gravar(atual, lista + evs.pop(atual, []))
            atual, lista = k, []
        lista.append(("voto", datetime.datetime.strptime(h, FMT)))
        minuto[(k[0], uf, h[11:16])] += 1
    if atual: n_votos += gravar(atual, lista + evs.pop(atual, []))
    for k, l in evs.items():  # seções sem votos
        gravar(k, l)
    fechar_base(db, minuto, f_db)
    print(f"Refeito: {n_votos} votos.")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__); sys.exit(1)
    if sys.argv[1] == "--refazer":
        refazer(sys.argv[2]); sys.exit(0)
    cal = int(sys.argv[sys.argv.index("--calibrar") + 1]) if "--calibrar" in sys.argv else 0
    processar(sys.argv[1], sys.argv[2], cal)
