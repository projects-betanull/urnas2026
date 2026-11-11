#!/usr/bin/env bash
# Baixa e processa os logs de todas as UFs, uma de cada vez (apaga cada zip depois de processar).
# Robusto a falhas: retoma downloads interrompidos (-C -), tenta de novo e, se uma UF falhar, segue para a próxima
# (ela é tentada de novo na próxima execução). Feito para rodar como serviço systemd (eleicoes-logs).
set -uo pipefail
BASE=/srv/eleicoes; T=$BASE/logs_tmp; OUT=$BASE/logs; mkdir -p $T $OUT
st(){ echo "$(date -u +%FT%TZ) $*" >> $BASE/status.txt; }
falhas=0
# Bases das UFs com fuso diferente de Brasília processadas antes da correção (sem meta apos_17h=brasilia) são refeitas
# numa segunda passada, depois de todas as que faltam.
fuso_antigo(){ case $2 in AC|AM|RO|RR|MT|MS) python3 -c "import sqlite3,sys;d=sqlite3.connect('file:$OUT/$1_$2_tempos.db?mode=ro',uri=True)
try: v=d.execute(\"select valor from meta where chave='apos_17h'\").fetchone()
except Exception: v=None
sys.exit(0 if not v or v[0]!='brasilia' else 1)";; *) return 1;; esac; }
# Terceira passada: bases sem o extrato de eventos (_eventos.csv.gz) são refeitas uma vez a partir dos arquivos do TSE.
# Com o extrato, mudanças futuras no cálculo dos horários não precisam baixar nada: python3 etl/logs.py --refazer PREFIXO.
# O 2º turno vem primeiro. Enquanto refaz, o site segue com a base anterior (os arquivos só são trocados no fim).
# Quarta passada (09/11): bases feitas antes de a seção vir do nome do arquivo (meta identificacao=nome_2026). Nelas as
# urnas de contingência caíam na "seção 0000" e se apagavam (~360 mil votos a menos por seção no 2º turno), e o oeste do
# AM ficava 1 h adiantado. Precisa dos arquivos do TSE: o extrato antigo já tem as seções erradas.
ident_antiga(){ python3 -c "import sqlite3,sys;d=sqlite3.connect('file:$OUT/$1_$2_tempos.db?mode=ro',uri=True)
try: v=d.execute(\"select valor from meta where chave='identificacao'\").fetchone()
except Exception: v=None
sys.exit(0 if not v or v[0]!='nome_2026' else 1)"; }
# Base com logs de outra UF (11/11): um zip de SP que sobrou em logs_tmp entrou na base 2t_TO e SP saía em dobro nos
# totais do país. Essas bases são refeitas junto com a passada "identificacao"; antes de cada download a pasta temporária
# é limpa dos zips de outras UFs, e etl/logs.py só lê o pacote da UF pedida.
misturada(){ python3 -c "import sqlite3,sys;d=sqlite3.connect('file:$OUT/$1_$2_tempos.db?mode=ro',uri=True)
try: v=d.execute(\"select 1 from secao_tempo where uf<>'$2' limit 1\").fetchone()
except Exception: v=None
sys.exit(0 if v else 1)"; }
# A passada "identificacao" vem antes da "extrato": o 2º turno fica certo primeiro (quem é refeito já sai com o extrato).
for passada in faltando refazer identificacao extrato; do
turnos="1t 2t"; [ $passada = extrato ] || [ $passada = identificacao ] && turnos="2t 1t"
for turno in $turnos; do for uf in AC AL AM AP BA CE DF ES GO MA MG MS MT PA PB PE PI PR RJ RN RO RR RS SC SE SP TO ZZ; do
  if [ $passada = faltando ]; then [ -f $OUT/${turno}_${uf}_tempos.db ] && continue
  elif [ $passada = refazer ]; then [ -f $OUT/${turno}_${uf}_tempos.db ] && fuso_antigo $turno $uf || continue; st "logs ${turno} ${uf}: refazendo com o fuso corrigido"
  elif [ $passada = extrato ]; then [ -f $OUT/${turno}_${uf}_tempos.db ] && [ ! -f $OUT/${turno}_${uf}_eventos.csv.gz ] || continue; st "logs ${turno} ${uf}: refazendo para guardar o extrato de eventos (encerramento pela confirmação do mesário)"
  else [ -f $OUT/${turno}_${uf}_tempos.db ] && { ident_antiga $turno $uf || misturada $turno $uf; } || continue; st "logs ${turno} ${uf}: refazendo (seção pelo nome do arquivo, fuso do oeste do AM ou base com logs de outra UF)"; fi
  livre=$(df --output=avail -BG $BASE | tail -1 | tr -dc 0-9)
  if [ "${livre:-0}" -lt 15 ]; then st "logs pausados: só ${livre} GB livres no disco"; exit 1; fi
  # Sobras de execução interrompida: zips já renomeados e downloads parciais de outra UF ou de outro turno.
  find $T -maxdepth 1 \( -name '*.zip' -o -name '*.part' \) ! -name "${turno}_${uf}.part" -delete
  st "logs ${turno} ${uf}: baixando"
  if ! curl -fsSL --retry 8 --retry-delay 30 --retry-all-errors -C - -o $T/${turno}_${uf}.part \
       "https://cdn.tse.jus.br/estatistica/sead/eleicoes/eleicoes2026/arqurnatot/bu_imgbu_logjez_rdv_vscmr_2026_${turno}_${uf}.zip"; then
    st "logs ${turno} ${uf}: falha no download (tenta de novo na próxima execução)"; falhas=$((falhas+1)); continue
  fi
  mv $T/${turno}_${uf}.part $T/arquivos_$uf.zip
  if python3 $BASE/app/etl/logs.py $T $OUT/${turno}_${uf} >> $BASE/logs_processamento.txt 2>&1; then
    st "logs ${turno} ${uf} processados"
  else
    st "logs ${turno} ${uf}: falha no processamento (a base anterior, se havia, continua no ar)"; rm -f $OUT/${turno}_${uf}_*.tmp; falhas=$((falhas+1))
  fi
  rm -f $T/*.zip
done; done; done
[ $falhas -eq 0 ] && st "logs: todas as UFs processadas" || exit 1
