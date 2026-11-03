#!/usr/bin/env python3
"""Resultado por grupos de horário de encerramento das urnas, bruto e dentro do mesmo município.

Uso:
  python3 grupos_encerramento.py TEMPOS.db PASTA_VOTACAO_SECAO [--turno 2] [--cargo PRESIDENTE] [--grupos 10] [--por encerramento|ultimo_voto]

Junta secao_tempo (de logs.py) com votacao_secao_2026_*.csv do TSE. Divide as seções em grupos de
tamanho igual pela hora de encerramento e mostra o percentual de cada um dos dois mais votados.

A coluna "dentro do município" compara cada seção com a média do próprio município. Se a diferença
entre grupos some nessa coluna, ela vinha de onde as urnas estão (cidades e regiões diferentes),
não do horário.
"""
import csv, glob, io, os, sqlite3, sys, zipfile, collections


def ler_secoes(pasta, turno, cargo):
    votos = collections.defaultdict(lambda: collections.Counter())
    nomes = {}
    arquivos = []
    for z in glob.glob(os.path.join(pasta, "*.zip")):
        zf = zipfile.ZipFile(z)
        arquivos += [io.TextIOWrapper(zf.open(n), encoding="latin-1") for n in zf.namelist() if n.lower().endswith(".csv")]
    arquivos += [open(c, encoding="latin-1") for c in glob.glob(os.path.join(pasta, "*.csv"))]
    for fh in arquivos:
        for r in csv.DictReader(fh, delimiter=";"):
            if r.get("NR_TURNO") != str(turno) or (r.get("DS_CARGO") or "").upper() != cargo:
                continue
            nv = r["NR_VOTAVEL"]
            if nv in ("95", "96", "97", "98"):  # brancos, nulos e anulados: fora dos válidos
                continue
            k = (r["CD_MUNICIPIO"].zfill(5), r["NR_ZONA"].zfill(4), r["NR_SECAO"].zfill(4))
            votos[k][nv] += int(r["QT_VOTOS"])
            nomes[nv] = r.get("NM_VOTAVEL") or nv
    return votos, nomes


def main(db_path, pasta, turno=2, cargo="PRESIDENTE", grupos=10, por="encerramento"):
    db = sqlite3.connect(db_path)
    tempos = {(m, z, s): (h, uf) for m, z, s, h, uf in db.execute(
        f"SELECT cd_municipio, zona, secao, COALESCE({por}, ultimo_voto), uf FROM secao_tempo WHERE turno = ?", (turno,)) if h}
    votos, nomes = ler_secoes(pasta, turno, cargo)
    total = collections.Counter()
    for c in votos.values():
        total.update(c)
    a, b = [k for k, _ in total.most_common(2)]
    sec = []
    for k, c in votos.items():
        if k in tempos and c[a] + c[b] > 0:
            sec.append((tempos[k][0], k, c[a], c[b]))
    sec.sort()
    # média de A em cada município (ponderada), para a comparação dentro do município
    mun = collections.defaultdict(lambda: [0, 0])
    for _, k, va, vb in sec:
        mun[k[0]][0] += va; mun[k[0]][1] += va + vb
    tam = len(sec) / grupos
    linhas = []
    for g in range(grupos):
        fatia = sec[int(g * tam):int((g + 1) * tam)]
        if not fatia:
            continue
        va = sum(x[2] for x in fatia); vb = sum(x[3] for x in fatia)
        desvio = sum((x[2] / (x[2] + x[3]) - mun[x[1][0]][0] / mun[x[1][0]][1]) * (x[2] + x[3]) for x in fatia) / (va + vb)
        linhas.append((g + 1, fatia[0][0], fatia[-1][0], len(fatia), 100 * va / (va + vb), 100 * vb / (va + vb), 100 * (va - vb) / (va + vb), 200 * desvio))
    na, nb = nomes.get(a, a), nomes.get(b, b)
    print(f"{cargo}, {turno}º turno, {len(sec)} seções em {grupos} grupos por horário de {por}")
    print(f"{'Grupo':>5} {'Horário':>19} {'Urnas':>7} {na[:12]:>12} {nb[:12]:>12} {'Dif. bruta':>11} {'Dif. dentro do município':>25}")
    for g, h0, h1, n, pa, pb, dif, dif_mun in linhas:
        print(f"{g:>5} {h0}–{h1} {n:>7} {pa:>11.2f}% {pb:>11.2f}% {dif:>+9.2f} pp {dif_mun:>+22.2f} pp")
    return linhas


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__); sys.exit(1)
    arg = lambda k, d: type(d)(sys.argv[sys.argv.index(k) + 1]) if k in sys.argv else d
    main(sys.argv[1], sys.argv[2], arg("--turno", 2), arg("--cargo", "PRESIDENTE"), arg("--grupos", 10), arg("--por", "encerramento"))
