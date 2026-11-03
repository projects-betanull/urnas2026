#!/usr/bin/env bash
# Baixa e processa os logs de todas as UFs, uma de cada vez (apaga cada zip depois de processar).
set -euo pipefail
BASE=/srv/eleicoes; T=$BASE/logs_tmp; OUT=$BASE/logs; mkdir -p $T $OUT
for turno in 1t 2t; do for uf in AC AL AM AP BA CE DF ES GO MA MG MS MT PA PB PE PI PR RJ RN RO RR RS SC SE SP TO ZZ; do
  [ -f $OUT/${turno}_${uf}_tempos.db ] && continue
  curl -fSL -o $T/$uf.zip "https://cdn.tse.jus.br/estatistica/sead/eleicoes/eleicoes2026/arqurnatot/bu_imgbu_logjez_rdv_vscmr_2026_${turno}_${uf}.zip"
  mv $T/$uf.zip $T/arquivos_$uf.zip
  python3 $BASE/app/etl/logs.py $T $OUT/${turno}_${uf}
  rm -f $T/*.zip
  echo "$(date -u +%FT%TZ) logs ${turno} ${uf} processados" >> $BASE/status.txt
done; done
echo "Logs processados em $OUT"
