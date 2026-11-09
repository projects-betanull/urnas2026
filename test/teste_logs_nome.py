#!/usr/bin/env python3
"""Seção tirada do nome do arquivo (formato 2026) e fuso do oeste do AM em etl/logs.py.
Uso: python3 test/teste_logs_nome.py   (cria e apaga uma pasta temporária)"""
import gzip, io, os, sqlite3, subprocess, sys, tempfile, zipfile, datetime as D

AQUI = os.path.dirname(os.path.abspath(__file__))
dia = D.datetime(2026, 10, 25)


def jez(linhas):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        z.writestr("logd.dat", "\n".join(linhas))
    return b.getvalue()


def log(abertura_local, n, conteudo_secao):
    """Log de uma seção: abertura no horário local dado, n votos a cada 2 min, encerramento 9 h depois."""
    ab = dia + D.timedelta(hours=abertura_local)
    L = [f"{ab:%d/%m/%Y %H:%M:%S}\tINFO\t1\tVOTA\tMunicípio: 02800 Zona: 0001 Seção: {conteudo_secao}\tX",
         f"{ab:%d/%m/%Y %H:%M:%S}\tINFO\t1\tVOTA\tUrna pronta para receber votos\tX"]
    L += [f"{ab + D.timedelta(minutes=5 + 2 * k):%d/%m/%Y %H:%M:%S}\tINFO\t1\tVOTA\tO voto do eleitor foi computado\tX" for k in range(n)]
    L.append(f"{ab + D.timedelta(hours=9, minutes=1):%d/%m/%Y %H:%M:%S}\tINFO\t1\tVOTA\tProcedimento de encerramento confirmado\tX")
    return jez(L)


with tempfile.TemporaryDirectory() as d:
    with zipfile.ZipFile(os.path.join(d, "bu_imgbu_logjez_rdv_vscmr_2026_2t_AM.zip"), "w") as z:
        # Três urnas de contingência: o conteúdo diz "seção 0", só o nome tem a seção certa.
        for s in (1, 2, 3):
            z.writestr(f"o03221am028000001{s:04d}-log.jez", log(7, 10 * s, "0"))
        z.writestr("o03221am0280000010004-bu.dat", b"x")  # outros arquivos do pacote: ignorados
        # Oeste do AM: abre às 6h locais (8h de Brasília) e deve virar 7h (horário de Manaus).
        z.writestr("o03221am0285000010001-log.jez", log(6, 5, "1"))
    pre = os.path.join(d, "2t_AM")
    subprocess.run([sys.executable, os.path.join(AQUI, "..", "etl", "logs.py"), d, pre], check=True, stdout=subprocess.DEVNULL)
    db = sqlite3.connect(pre + "_tempos.db")
    sec = {(m, s): (ab, v) for m, s, ab, v in db.execute("SELECT cd_municipio, secao, abertura, votos FROM secao_tempo WHERE turno = 2")}
    assert sec == {("02800", "0001"): ("07:00:00", 10), ("02800", "0002"): ("07:00:00", 20), ("02800", "0003"): ("07:00:00", 30),
                   ("02850", "0001"): ("07:00:00", 5)}, sec
    por_secao = db.execute("SELECT SUM(votos) FROM secao_tempo WHERE turno = 2").fetchone()[0]
    por_minuto = db.execute("SELECT SUM(votos) FROM voto_minuto_uf WHERE turno = 2").fetchone()[0]
    assert por_secao == por_minuto == 65, (por_secao, por_minuto)
    assert db.execute("SELECT MIN(minuto) FROM voto_minuto_uf").fetchone()[0] == "07:05"
    assert dict(db.execute("SELECT * FROM meta"))["identificacao"] == "nome_2026"
    # O extrato por voto também fica no horário de Manaus, e refazer a partir dele não ajusta de novo.
    votos = gzip.open(pre + "_votos.csv.gz", "rt").read().splitlines()
    assert min(l.split(",")[5][11:] for l in votos[1:]) == "07:05:00"
    db.close()
    subprocess.run([sys.executable, os.path.join(AQUI, "..", "etl", "logs.py"), "--refazer", pre], check=True, stdout=subprocess.DEVNULL)
    db = sqlite3.connect(pre + "_tempos.db")
    assert db.execute("SELECT MIN(abertura), SUM(votos) FROM secao_tempo").fetchone() == ("07:00:00", 65)
    assert db.execute("SELECT SUM(votos), MIN(minuto) FROM voto_minuto_uf").fetchone() == (65, "07:05")
print("teste_logs_nome ok")
