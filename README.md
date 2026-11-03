# Eleições 2026 em dados

**Site:** https://urnas2026.duckdns.org · **Servidor MCP:** `https://urnas2026.duckdns.org/mcp` · **Guia para IA:** https://urnas2026.duckdns.org/llms.txt

Resultados oficiais do TSE das eleições gerais de 2026 (1º e 2º turno), prontos para consultar: votos por candidato e município, partidos, cargos, situação, perfil dos candidatos e patrimônio declarado.

## Usar com IA (MCP)
Adicione `https://urnas2026.duckdns.org/mcp` como conector personalizado no Claude, no Cursor ou em qualquer cliente MCP com Streamable HTTP. Sem chave valem 60 consultas grátis por dia; com chave, envie `Authorization: Bearer SUA_CHAVE`.

| Ferramenta | O que faz |
| --- | --- |
| `explorar` | Tabela dinâmica: uma medida (votos, candidatos, eleitos, patrimônio) por dimensão nas linhas e, opcionalmente, nas colunas, com filtros |
| `buscar_candidatos` | Busca por nome, com cargo, partido, UF, situação e votos |
| `detalhar_candidato` | Ficha do candidato: perfil, votos por turno e bens declarados |
| `valores_dimensao` | Valores possíveis de uma dimensão, para montar filtros |
| `saldo` | Créditos restantes e cota grátis do dia |

## Use in English
Remote MCP server with Brazil's 2026 general election results (TSE open data). Add `https://urnas2026.duckdns.org/mcp` to any MCP client. 60 free queries per day; extra credits are paid in bitcoin over Lightning, no sign-up.

---

Site, API e servidor MCP com os resultados oficiais do TSE de 2026 (1º e 2º turno). Inclui explorador com filtros, tabela dinâmica (pivot), navegação por níveis (drill-down e roll-up) e gráficos responsivos. A cota grátis é diária, e há créditos pagos em bitcoin Lightning, em que a chave é o saldo.

## Estrutura
- `schema.sql`: tabelas (candidato, voto_municipio, voto_uf, voto_total, bem, municipio) e créditos (chave, pagamento, cota). Não guarda CPF, e-mail, título nem data de nascimento.
- `etl/etl.py`: lê os .zip/.csv do TSE e gera o SQLite e os arquivos .sql para o D1. Só usa a biblioteca padrão.
- `worker/src/core.js`: consultas (explorar/pivot, candidatos, ficha), cobrança de créditos, cota e pagamentos (LNURL-pay com verificação LUD-21).
- `worker/src/index.js`: rotas (`/`, `/api/*`, `/mcp`) e servidor MCP via HTTP.
- `worker/site/index.html`: site. Rode `python3 build.py` para embuti-lo em `worker/src/site.js`.
- `test/`: gerador de dados fictícios, adaptador D1 sobre node:sqlite, testes ponta a ponta e servidor local.

## Testar localmente
```
python3 test/gerar_exemplo.py test/exemplo
python3 etl/etl.py test/exemplo test/exemplo.db
python3 build.py
node --no-warnings test/teste.mjs        # testes
node --no-warnings test/servidor.mjs     # http://localhost:8787
```

## Dados reais (TSE, Portal de Dados Abertos, conjunto "Resultados 2026" e "Candidatos 2026")
Baixe para uma pasta:
- `consulta_cand_2026.zip`
- `votacao_candidato_munzona_2026.zip`
- `bem_candidato_2026.zip`

Depois rode: `python3 etl/etl.py pasta dados.db --sql sql/`

## Publicar (Cloudflare, plano grátis)
```
npx wrangler d1 create eleicoes2026          # copie o database_id para wrangler.toml
npx wrangler d1 execute eleicoes2026 --remote --file=schema.sql
for f in sql/*.sql; do npx wrangler d1 execute eleicoes2026 --remote --file=$f; done
# em wrangler.toml: LN_ADDRESS = "seu_nome@provedor" (precisa suportar LUD-21/verify, ex.: Alby)
npx wrangler deploy
```

## Custos e limites
- Créditos: 1 por consulta. Exportação custa 1 a cada 500 linhas (mínimo 2). Cota grátis: 60 consultas por dia por IP.
- Pacotes: 2.000 sats = 500 créditos; 8.000 sats = 2.500; 25.000 sats = 10.000.
- O plano grátis do D1 dá 5 GB e 5 milhões de linhas lidas por dia. Consultas sem município usam `voto_uf`, que é pré-somada, e consultas iguais ficam 1 hora em cache.

## Logs das urnas: horário de cada voto
- `etl/logs.py PASTA SAIDA [--calibrar N]` lê os pacotes de log de cada seção (`.logjez` / `-log.jez`, ZIP ou 7z), incluindo os logs arquivados em urnas de contingência. Gera:
  - `SAIDA_votos.csv.gz`: uma linha por voto (turno, UF, município, zona, seção, horário). Também gera `.parquet` se o pyarrow estiver instalado.
  - `SAIDA_tempos.db` com duas tabelas:
    - `secao_tempo`: abertura, primeiro e último voto, encerramento, total de votos e votos depois das 17h e das 19h.
    - `voto_minuto_uf`: votos por minuto em cada UF.
- Só guarda horário e tipo de evento. O texto das mensagens não é gravado, porque erros do terminal do mesário às vezes trazem o nome de um eleitor.
- O log não diz em quem foi o voto, por desenho do TSE: o arquivo de votos (RDV) é embaralhado e não guarda hora nem ordem.
- `--calibrar 50` lista as mensagens mais frequentes dos primeiros 50 logs, para ajustar os padrões de evento antes de rodar tudo.
- `etl/grupos_encerramento.py TEMPOS.db PASTA_VOTACAO_SECAO` monta a tabela "resultado por grupo de horário de encerramento" em duas versões: bruta e comparando cada seção com a média do próprio município.

## Hospedagem (revisada)
O D1 grátis aceita só 100 mil linhas gravadas por dia e no máximo 10 GB por banco, o que não comporta centenas de milhões de votos. Plano: uma VM Always Free da Oracle Cloud (2 OCPU, 12 GB de RAM, 200 GB de disco, 10 TB de tráfego por mês, R$ 0) rodando DuckDB sobre Parquet, com a Cloudflare grátis na frente para HTTPS e cache.

## Hospedagem atual
VM Always Free da Oracle Cloud com Node, SQLite e Caddy (`deploy/instalar.sh`). A VM busca este repositório a cada 15 minutos (`deploy/atualizar.sh`) e reconstrói o site quando há mudança.

## Fonte e licença
Dados: Tribunal Superior Eleitoral, Portal de Dados Abertos. Projeto independente, sem ligação com o TSE. Código sob licença MIT.
