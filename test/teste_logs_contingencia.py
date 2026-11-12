#!/usr/bin/env python3
"""Pacotes com urnas trocadas (contingência) em etl/logs.py, como os casos reais do 2º turno de 2026:
- MG: dois logs arquivados da mesma urna, um contendo o outro -> cada voto conta uma vez;
- ES: a urna de contingência carrega o log da seção onde foi usada antes -> esse log só conta na seção dele;
- PB/PI: urna reiniciou entre "Voto confirmado para [Presidente]" e "computado" -> o voto conta (o boletim conta);
- RS: log arquivado termina logo depois da confirmação -> o voto conta.
Uso: python3 test/teste_logs_contingencia.py   (cria e apaga uma pasta temporária)"""
import io, os, sqlite3, subprocess, sys, tempfile, zipfile, datetime as D

AQUI = os.path.dirname(os.path.abspath(__file__))
dia = D.datetime(2026, 10, 25)


def jez(arquivos):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w", zipfile.ZIP_DEFLATED) as z:
        for nome, dados in arquivos:
            z.writestr(nome, dados)
    return b.getvalue()


class Urna:
    """Log de uma urna: linhas com hash próprio (como no log real), para repetições serem idênticas."""
    def __init__(self, id_, secao):
        self.id, self.L, self.n = id_, [], 0
        self.ln(dia - D.timedelta(days=30), "GAP", f"Zona Eleitoral: 0009")
        self.ln(dia - D.timedelta(days=30), "GAP", f"Seção Eleitoral: {secao}")

    def ln(self, t, app, msg):
        self.n += 1
        self.L.append(f"{t:%d/%m/%Y %H:%M:%S}\tINFO\t{self.id}\t{app}\t{msg}\t{self.id}{self.n:08X}")

    def abrir(self, t):
        self.ln(t, "VOTA", "Urna pronta para receber votos")

    def votar(self, t, computado=True):
        self.ln(t, "VOTA", "Eleitor foi habilitado")
        self.ln(t + D.timedelta(seconds=30), "VOTA", "Voto confirmado para [Presidente]")
        if computado:
            self.ln(t + D.timedelta(seconds=31), "VOTA", "O voto do eleitor foi computado")

    def texto(self):
        return "\n".join(self.L).encode("latin-1")


h = lambda hh, mm=0: dia + D.timedelta(hours=hh, minutes=mm)

with tempfile.TemporaryDirectory() as d:
    with zipfile.ZipFile(os.path.join(d, "bu_imgbu_logjez_rdv_vscmr_2026_2t_ES.zip"), "w") as z:
        # MG: urna original vota 3, desliga; arquivo A tem esse trecho; o arquivo B tem o mesmo trecho + a 2ª urna (2 votos).
        u1 = Urna("01000001", "0264"); u1.abrir(h(8)); [u1.votar(h(8, 5 + i)) for i in range(3)]
        a = jez([("logd.dat", u1.texto())])
        u2 = Urna("01000002", "0000"); u2.abrir(h(11)); [u2.votar(h(11, 5 + i)) for i in range(2)]
        b = jez([("logd.dat", u1.texto() + b"\n" + u2.texto())])
        u3 = Urna("01000003", "0000"); u3.ln(h(18), "VOTA", "Procedimento de encerramento confirmado")
        z.writestr("o03221es5793200090264-log.jez", jez([("x-01.jez", a), ("y-02ME.jez", b), ("logd.dat", u3.texto())]))
        # ES: urna da 0112 (4 votos) arquivada pela contingência, que depois serviu a 0085 (urna própria com 3 votos).
        u4 = Urna("01000004", "0112"); u4.abrir(h(8)); [u4.votar(h(9, i)) for i in range(4)]
        u5 = Urna("01000005", "0000"); u5.ln(h(19), "RED", "Identificada uma urna de contingência")
        u6 = Urna("01000006", "0085"); u6.abrir(h(8)); [u6.votar(h(10, i)) for i in range(3)]
        arq4 = jez([("logd.dat", u4.texto())])
        z.writestr("o03221es5793200090112-log.jez", jez([("a-01ME.jez", arq4), ("logd.dat", u5.texto())]))
        z.writestr("o03221es5793200090085-log.jez", jez([("a-01ME.jez", arq4), ("b-02.jez", jez([("logd.dat", u6.texto())])), ("logd.dat", u5.texto())]))
        # PB/PI: confirmado sem "computado" e a urna reinicia; depois mais um voto normal.
        u7 = Urna("01000007", "0254"); u7.abrir(h(8)); u7.votar(h(8, 10)); u7.votar(h(12, 36), computado=False)
        u7.ln(h(12, 40), "LOGD", "Início das operações do logd"); u7.abrir(h(12, 45)); u7.votar(h(12, 50))
        z.writestr("o03221es5793200090254-log.jez", jez([("logd.dat", u7.texto())]))
        # RS: log arquivado termina logo depois da confirmação; a contingência continua com 1 voto.
        u8 = Urna("01000008", "0191"); u8.abrir(h(8)); u8.votar(h(9)); u8.votar(h(9, 42), computado=False)
        u9 = Urna("01000009", "0000"); u9.abrir(h(10)); u9.votar(h(10, 3))
        z.writestr("o03221es5793200090191-log.jez", jez([("c-01.jez", jez([("logd.dat", u8.texto())])), ("logd.dat", u9.texto())]))
        # Log principal com cabeçalho de outra seção (urna trocada sem contingência): entra assim mesmo.
        u10 = Urna("01000010", "0445"); u10.abrir(h(8)); u10.votar(h(8, 30))
        z.writestr("o03221es5793200090609-log.jez", jez([("logd.dat", u10.texto())]))
    pre = os.path.join(d, "2t_ES")
    saida = subprocess.run([sys.executable, os.path.join(AQUI, "..", "etl", "logs.py"), d, pre], check=True, capture_output=True, text=True).stdout
    db = sqlite3.connect(pre + "_tempos.db")
    sec = dict(db.execute("SELECT secao, votos FROM secao_tempo WHERE turno = 2"))
    assert sec == {"0264": 5, "0112": 4, "0085": 3, "0254": 3, "0191": 3, "0609": 1}, sec
    por_minuto = db.execute("SELECT SUM(votos) FROM voto_minuto_uf WHERE turno = 2").fetchone()[0]
    assert por_minuto == sum(sec.values()), por_minuto
    # o voto sem "computado" fica no horário da confirmação
    assert db.execute("SELECT ultimo_voto FROM secao_tempo WHERE secao = '0191'").fetchone()[0] == "10:03:31"
    assert "4 votos de logs arquivados de outras seções ignorados" in saida, saida
    assert dict(db.execute("SELECT * FROM meta"))["votos"] == "sem_repeticao_e_confirmacao"
print("teste_logs_contingencia ok")
