#!/usr/bin/env python3
"""Logs de urna e votação por seção fictícios. Cidade grande (fecha tarde) favorece A; cidades pequenas (fecham cedo) favorecem B.
Dentro de cada município o horário não muda nada: a análise 'dentro do município' deve dar ~0."""
import csv, io, os, random, sys, zipfile, datetime as D
random.seed(3); out = sys.argv[1]; os.makedirs(out, exist_ok=True)
MUN = {"71072": (0.60, 120, 17*60+40), "70572": (0.42, 40, 17*60+5), "62910": (0.40, 40, 17*60+3)}  # pA, nº seções, encerramento médio (min)
dia = D.datetime(2026, 10, 25)
def jez(texto):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z: z.writestr("logd.dat", texto)
    return b.getvalue()
outer = zipfile.ZipFile(os.path.join(out, "bu_imgbu_logjez_rdv_vscmr_2026_2t_SP.zip"), "w")
rows = []
for mun, (pa, nsec, enc_med) in MUN.items():
    for s in range(1, nsec + 1):
        zona, secao = "0001", f"{s:04d}"
        enc = dia + D.timedelta(minutes=max(17*60, int(random.gauss(enc_med, 20))), seconds=random.randint(0, 59))
        nvot = random.randint(150, 300)
        # A mesma urna no 1º turno: o log do 2º turno traz também os eventos de 04/10 (vão para turno 1 na base do 2º).
        d1 = D.datetime(2026, 10, 4)
        L = [f"{d1:%d/%m/%Y} 07:59:40\tINFO\t11111111\tVOTA\tUrna pronta para receber votos\tX"]
        L += [f"{d1 + D.timedelta(minutes=8*60 + 20*k):%d/%m/%Y %H:%M:%S}\tINFO\t11111111\tVOTA\tO voto do eleitor foi computado\tX" for k in range(30)]
        L += [f"{d1:%d/%m/%Y} 18:30:00\tINFO\t11111111\tVOTA\tIniciando procedimento de encerramento\tX"]
        L += [f"20/10/2026 10:00:00\tINFO\t11111111\tVOTA\tO voto do eleitor foi computado\tX",  # teste antes da eleição: ignorar
             f"25/10/2026 07:59:50\tINFO\t11111111\tVOTA\tUrna pronta para receber votos\tX"]
        ts = sorted(dia + D.timedelta(seconds=random.randint(8*3600, int((enc - dia).total_seconds()) - 5)) for _ in range(nvot))
        for i, t in enumerate(ts):
            L.append(f"{t:%d/%m/%Y %H:%M:%S}\tINFO\t11111111\tVOTA\tEleitor foi habilitado\tX")
            if i == 3: L.append(f"{t:%d/%m/%Y %H:%M:%S}\tERRO\t11111111\tVOTA\tErro no terminal: MARIA DAS DORES NOME DE TESTE\tX")
            L.append(f"{t:%d/%m/%Y %H:%M:%S}\tINFO\t11111111\tVOTA\tO voto do eleitor foi computado\tX")
        L.append(f"{enc:%d/%m/%Y %H:%M:%S}\tINFO\t11111111\tVOTA\tIniciando procedimento de encerramento\tX")
        dados = jez("\n".join(L))
        if mun == "70572" and s == 1:  # contingência: log antigo arquivado dentro do pacote
            b = io.BytesIO()
            with zipfile.ZipFile(b, "w") as z:
                z.writestr("0203237925102024090000-01.jez", jez("\n".join(L[:50])))
                z.writestr("logd.dat", "\n".join(L[50:]))
            dados = b.getvalue()
        outer.writestr(f"o00407-{mun}{zona}{secao}.logjez", dados)
        va = sum(1 for _ in range(nvot) if random.random() < pa)
        for nv, nm, q in (("13", "CANDIDATO A", va), ("22", "CANDIDATO B", nvot - va), ("95", "BRANCO", 3)):
            rows.append({"NR_TURNO": "2", "SG_UF": "SP", "CD_MUNICIPIO": mun, "NR_ZONA": zona, "NR_SECAO": secao, "DS_CARGO": "PRESIDENTE", "NR_VOTAVEL": nv, "NM_VOTAVEL": nm, "QT_VOTOS": str(q)})
outer.close()
os.makedirs(os.path.join(out, "secao"), exist_ok=True)
with open(os.path.join(out, "secao", "votacao_secao_2026_SP.csv"), "w", encoding="latin-1", newline="") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0]), delimiter=";"); w.writeheader(); w.writerows(rows)
print("ok")
