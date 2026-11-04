#!/usr/bin/env bash
# Baixa votacao_secao_2026_<UF>.zip de cada UF, carrega em /srv/eleicoes/secao/<UF>_secao.db e apaga o zip.
# BR traz os votos de presidente de todas as UFs (os arquivos por UF trazem governador e senador).
# Pula UFs já carregadas; retoma downloads; segue para a próxima UF se uma falhar. Execução avulsa (não é serviço).
set -uo pipefail
BASE=/srv/eleicoes; T=$BASE/secao_tmp; OUT=$BASE/secao; mkdir -p $T $OUT
st(){ echo "$(date -u +%FT%TZ) $*" >> $BASE/status.txt; }
for uf in AC AL AM AP BA CE DF ES GO MA MG MS MT PA PB PE PI PR RJ RN RO RR RS SC SE SP TO ZZ BR; do
  [ -f $OUT/${uf}_secao.db ] && continue
  livre=$(df --output=avail -BG $BASE | tail -1 | tr -dc 0-9)
  if [ "${livre:-0}" -lt 15 ]; then st "secao pausada: só ${livre} GB livres"; exit 1; fi
  st "secao ${uf}: baixando"
  if ! curl -fsSL --retry 8 --retry-delay 30 --retry-all-errors -C - -o $T/$uf.zip \
       "https://cdn.tse.jus.br/estatistica/sead/odsele/votacao_secao/votacao_secao_2026_${uf}.zip"; then
    st "secao ${uf}: falha no download"; continue
  fi
  if nice -n 10 python3 $BASE/app/etl/secao.py $T/$uf.zip $OUT/${uf}_secao.db >> $BASE/secao_processamento.txt 2>&1; then
    st "secao ${uf} carregada"
  else
    st "secao ${uf}: falha no processamento"
  fi
  rm -f $T/$uf.zip
done
st "secao: fim da passada"
