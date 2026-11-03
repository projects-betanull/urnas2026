#!/usr/bin/env python3
"""Gera CSVs sintéticos no formato do TSE (latin-1, ';') para testar o ETL. Dados fictícios."""
import csv, os, random, sys

random.seed(7)
out = sys.argv[1] if len(sys.argv) > 1 else "exemplo"
os.makedirs(out, exist_ok=True)

UFS = {"SP": [("71072", "SÃO PAULO"), ("62910", "CAMPINAS"), ("70572", "SANTOS")],
       "MG": [("41238", "BELO HORIZONTE"), ("54038", "UBERLÂNDIA")],
       "DF": [("97012", "BRASÍLIA")]}
PARTIDOS = [("PA", "10"), ("PB", "20"), ("PC", "30"), ("PD", "40"), ("PE", "50")]
GEN = ["MASCULINO", "FEMININO"]
INSTR = ["SUPERIOR COMPLETO", "ENSINO MÉDIO COMPLETO", "SUPERIOR INCOMPLETO"]
OCUP = ["EMPRESÁRIO", "ADVOGADO", "PROFESSOR", "MÉDICO", "DEPUTADO"]
RACA = ["BRANCA", "PARDA", "PRETA"]

cand_cols = ["ANO_ELEICAO", "NR_TURNO", "SG_UF", "CD_CARGO", "DS_CARGO", "SQ_CANDIDATO", "NR_CANDIDATO",
             "NM_CANDIDATO", "NM_URNA_CANDIDATO", "NR_CPF_CANDIDATO", "DS_EMAIL", "NR_PARTIDO", "SG_PARTIDO",
             "NM_FEDERACAO", "NM_COLIGACAO", "DS_GENERO", "DS_GRAU_INSTRUCAO", "DS_COR_RACA", "DS_OCUPACAO",
             "DS_SIT_TOT_TURNO"]
voto_cols = ["ANO_ELEICAO", "NR_TURNO", "SG_UF", "CD_MUNICIPIO", "NM_MUNICIPIO", "NR_ZONA", "CD_CARGO", "DS_CARGO",
             "SQ_CANDIDATO", "NR_CANDIDATO", "NM_URNA_CANDIDATO", "SG_PARTIDO", "QT_VOTOS_NOMINAIS_VALIDOS",
             "DS_SIT_TOT_TURNO"]
bem_cols = ["ANO_ELEICAO", "SG_UF", "SQ_CANDIDATO", "NR_ORDEM_BEM_CANDIDATO", "DS_TIPO_BEM_CANDIDATO",
            "DS_BEM_CANDIDATO", "VR_BEM_CANDIDATO"]

cands, votos, bens = [], [], []
sq = 100000


def novo(uf, cd, cargo, turno, idx, partido):
    global sq
    sq += 1
    nome = f"CANDIDATO {cargo[:3]} {uf} {idx}"
    return {"ANO_ELEICAO": "2026", "NR_TURNO": str(turno), "SG_UF": uf, "CD_CARGO": str(cd), "DS_CARGO": cargo,
            "SQ_CANDIDATO": str(sq), "NR_CANDIDATO": partido[1] + str(idx), "NM_CANDIDATO": nome + " DA SILVA",
            "NM_URNA_CANDIDATO": nome, "NR_CPF_CANDIDATO": "12345678900", "DS_EMAIL": "x@y.com",
            "NR_PARTIDO": partido[1], "SG_PARTIDO": partido[0], "NM_FEDERACAO": "#NULO#", "NM_COLIGACAO": "#NULO#",
            "DS_GENERO": random.choice(GEN), "DS_GRAU_INSTRUCAO": random.choice(INSTR),
            "DS_COR_RACA": random.choice(RACA), "DS_OCUPACAO": random.choice(OCUP), "DS_SIT_TOT_TURNO": ""}


def votar(c, munis, base):
    tot = 0
    for cd, nm in munis:
        for zona in ("1", "2"):
            v = int(base * random.uniform(0.3, 1.7))
            tot += v
            votos.append({"ANO_ELEICAO": "2026", "NR_TURNO": c["NR_TURNO"], "SG_UF": c["SG_UF"] if c["SG_UF"] != "BR" else c["_uf"],
                          "CD_MUNICIPIO": cd, "NM_MUNICIPIO": nm, "NR_ZONA": zona, "CD_CARGO": c["CD_CARGO"],
                          "DS_CARGO": c["DS_CARGO"], "SQ_CANDIDATO": c["SQ_CANDIDATO"], "NR_CANDIDATO": c["NR_CANDIDATO"],
                          "NM_URNA_CANDIDATO": c["NM_URNA_CANDIDATO"], "SG_PARTIDO": c["SG_PARTIDO"],
                          "QT_VOTOS_NOMINAIS_VALIDOS": str(v), "DS_SIT_TOT_TURNO": c["DS_SIT_TOT_TURNO"]})
    return tot


# Presidente: 4 candidatos no 1º turno, 2 vão ao 2º
pres = [novo("BR", 1, "PRESIDENTE", 1, i, PARTIDOS[i]) for i in range(4)]
for i, c in enumerate(pres):
    c["DS_SIT_TOT_TURNO"] = "2º TURNO" if i < 2 else "NÃO ELEITO"
    cands.append(c)
    for uf, munis in UFS.items():
        c["_uf"] = uf
        votar(c, munis, 50000 // (i + 1))
for i, c1 in enumerate(pres[:2]):
    c2 = dict(c1); c2["NR_TURNO"] = "2"; c2["DS_SIT_TOT_TURNO"] = "ELEITO" if i == 0 else "NÃO ELEITO"
    cands.append(c2)
    for uf, munis in UFS.items():
        c2["_uf"] = uf
        votar(c2, munis, 60000 if i == 0 else 52000)

# Governador, senador e deputado federal por UF
for uf, munis in UFS.items():
    for cargo, cd, n, eleitos in (("GOVERNADOR", 3, 3, 1), ("SENADOR", 5, 4, 1), ("DEPUTADO FEDERAL", 6, 10, 3)):
        lista = [novo(uf, cd, cargo, 1, i, random.choice(PARTIDOS)) for i in range(n)]
        tots = [(votar(c, munis, random.randint(2000, 40000)), c) for c in lista]
        tots.sort(key=lambda x: -x[0])
        for j, (_, c) in enumerate(tots):
            c["DS_SIT_TOT_TURNO"] = ("ELEITO POR QP" if cargo.startswith("DEP") else "ELEITO") if j < eleitos else ("SUPLENTE" if cargo.startswith("DEP") else "NÃO ELEITO")
            cands.append(c)

for c in cands:
    if c["NR_TURNO"] != "1":
        continue
    for k in range(random.randint(0, 4)):
        bens.append({"ANO_ELEICAO": "2026", "SG_UF": c["SG_UF"], "SQ_CANDIDATO": c["SQ_CANDIDATO"],
                     "NR_ORDEM_BEM_CANDIDATO": str(k + 1), "DS_TIPO_BEM_CANDIDATO": random.choice(["Casa", "Apartamento", "Veículo automotor terrestre", "Depósito bancário"]),
                     "DS_BEM_CANDIDATO": "BEM DECLARADO", "VR_BEM_CANDIDATO": f"{random.randint(10, 2000) * 1000},00"})


def gravar(nome, cols, linhas):
    with open(os.path.join(out, nome), "w", encoding="latin-1", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, delimiter=";", quoting=csv.QUOTE_ALL, extrasaction="ignore")
        w.writeheader(); w.writerows(linhas)


gravar("consulta_cand_2026_BRASIL.csv", cand_cols, cands)
gravar("votacao_candidato_munzona_2026_BRASIL.csv", voto_cols, votos)
gravar("bem_candidato_2026_BRASIL.csv", bem_cols, bens)
print(len(cands), "candidatos,", len(votos), "linhas de voto,", len(bens), "bens")
