-- Dados eleitorais (somente informações públicas de candidatos; sem CPF, e-mail ou título)
CREATE TABLE IF NOT EXISTS candidato (
  sq_candidato   TEXT NOT NULL,
  turno          INTEGER NOT NULL,
  ano            INTEGER NOT NULL,
  uf             TEXT,            -- BR para presidente
  cd_cargo       INTEGER,
  cargo          TEXT,
  numero         TEXT,
  nome           TEXT,
  nome_urna      TEXT,
  partido        TEXT,
  nr_partido     TEXT,
  federacao      TEXT,
  coligacao      TEXT,
  situacao       TEXT,            -- ELEITO, NÃO ELEITO, 2º TURNO, SUPLENTE...
  genero         TEXT,
  instrucao      TEXT,
  ocupacao       TEXT,
  cor_raca       TEXT,
  PRIMARY KEY (sq_candidato, turno)
);
CREATE INDEX IF NOT EXISTS ix_cand_busca ON candidato (cargo, uf, turno);
CREATE INDEX IF NOT EXISTS ix_cand_nome ON candidato (nome_urna);
CREATE INDEX IF NOT EXISTS ix_cand_partido ON candidato (partido);

-- Votos por candidato e município (zonas somadas)
CREATE TABLE IF NOT EXISTS voto_municipio (
  sq_candidato   TEXT NOT NULL,
  turno          INTEGER NOT NULL,
  uf             TEXT NOT NULL,
  cd_municipio   TEXT NOT NULL,
  municipio      TEXT,
  votos          INTEGER NOT NULL,
  PRIMARY KEY (sq_candidato, turno, cd_municipio)
);
CREATE INDEX IF NOT EXISTS ix_voto_mun ON voto_municipio (cd_municipio, turno);
CREATE INDEX IF NOT EXISTS ix_voto_uf ON voto_municipio (uf, turno);

-- Total de votos por candidato e turno (pré-calculado para ranking rápido)
CREATE TABLE IF NOT EXISTS voto_total (
  sq_candidato   TEXT NOT NULL,
  turno          INTEGER NOT NULL,
  votos          INTEGER NOT NULL,
  PRIMARY KEY (sq_candidato, turno)
);

-- Votos por candidato e UF (pré-somado: consultas sem município leem ~35 mil linhas em vez de milhões)
CREATE TABLE IF NOT EXISTS voto_uf (
  sq_candidato   TEXT NOT NULL,
  turno          INTEGER NOT NULL,
  uf             TEXT NOT NULL,
  votos          INTEGER NOT NULL,
  PRIMARY KEY (sq_candidato, turno, uf)
);

CREATE TABLE IF NOT EXISTS bem (
  sq_candidato   TEXT NOT NULL,
  ordem          INTEGER,
  tipo           TEXT,
  descricao      TEXT,
  valor          REAL
);
CREATE INDEX IF NOT EXISTS ix_bem_cand ON bem (sq_candidato);

CREATE TABLE IF NOT EXISTS municipio (
  cd_municipio   TEXT PRIMARY KEY,
  uf             TEXT,
  nome           TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  chave TEXT PRIMARY KEY,
  valor TEXT
);

-- Créditos: a chave é o saldo. Guardamos só o hash da chave.
CREATE TABLE IF NOT EXISTS chave (
  hash          TEXT PRIMARY KEY,
  creditos      INTEGER NOT NULL DEFAULT 0,
  criada_em     TEXT NOT NULL,
  ultimo_uso    TEXT
);

CREATE TABLE IF NOT EXISTS pagamento (
  id            TEXT PRIMARY KEY,   -- id público do pedido
  chave_hash    TEXT NOT NULL,
  pacote        TEXT NOT NULL,
  sats          INTEGER NOT NULL,
  creditos      INTEGER NOT NULL,
  invoice       TEXT NOT NULL,
  verify_url    TEXT,
  status        TEXT NOT NULL,      -- pendente | pago | expirado
  criado_em     TEXT NOT NULL,
  pago_em       TEXT
);

-- Cota grátis diária por IP (hash do IP, sem guardar o IP)
CREATE TABLE IF NOT EXISTS cota (
  ip_hash TEXT NOT NULL,
  dia     TEXT NOT NULL,
  usados  INTEGER NOT NULL,
  PRIMARY KEY (ip_hash, dia)
);
