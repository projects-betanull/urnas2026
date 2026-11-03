import { registrar, registrarErro, resumo, htmlPainel, chaveDoPainelOk } from "./uso.js";
// Cloudflare Worker: site, API REST, servidor MCP (HTTP) e créditos em Lightning.
import { conferirPendentes, recuperarComComprovante } from "./core.js";
import {
  DIMENSOES, MEDIDAS, HIERARQUIAS, PACOTES, COTA_GRATIS, ErroApi,
  explorar, pivotar, buscarCandidatos, detalharCandidato, valoresDimensao,
  cobrar, criarPedido, verificarPedido, saldo, custoConsulta, confirmarComComprovante, cotacaoBRL, LIMITE_SITE,
} from "./core.js";
import { SITE_HTML } from "./site.js";
import { paginaEstados, paginaUF, paginaCandidato, sitemap } from "./paginas.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, x-chave, mcp-session-id, mcp-protocol-version",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};
const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...extra } });

function chaveDe(req, url) {
  const a = req.headers.get("authorization") || "";
  if (a.toLowerCase().startsWith("bearer ")) return a.slice(7).trim();
  return req.headers.get("x-chave") || url.searchParams.get("chave") || null;
}
// Pedido feito pelo próprio site (navegação livre). Exportações e MCP nunca contam como site.
const doSite = req => req.headers.get("x-origem") === "site" && (req.headers.get("sec-fetch-site") || "same-origin") === "same-origin";
const ipDe = req => req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "local";

function csv(p) {
  const esc = v => { const s = v == null ? "" : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const cols = p.colunas_dim ? p.colunas : [];
  const cab = [p.linhas_dim, ...cols, "Total"];
  return [cab.map(esc).join(";"), ...p.linhas.map(l => [l.chave, ...cols.map(c => l.valores[c]), l.total].map(esc).join(";"))].join("\n");
}

// Consulta do explorador com cobrança e cache (consultas iguais não releem o banco)
async function consultaExplorar(env, ctx, params, quem) {
  const exportar = !!params.exportar;
  const limite = Math.min(Number(params.limite) || (exportar ? 50000 : 50), exportar ? 50000 : 500);
  const chaveCache = "https://cache.interno/explorar?" + encodeURIComponent(JSON.stringify({ ...params, chave: undefined, limite }));
  const cache = globalThis.caches?.default;
  let piv = null;
  if (cache) { const hit = await cache.match(chaveCache); if (hit) piv = await hit.json(); }
  if (!piv) {
    const r = await explorar(env.DB, params);
    piv = pivotar(r, { limite, maxColunas: Number(params.max_colunas) || 12, ordem: params.ordem });
    if (cache) ctx?.waitUntil?.(cache.put(chaveCache, new Response(JSON.stringify(piv), { headers: { "cache-control": "max-age=3600" } })));
  }
  const cobranca = await cobrar(env.DB, { chave: quem.chave, ip: quem.ip, site: quem.site && !exportar, custo: custoConsulta(exportar, piv.linhas.length) });
  return { piv, cobranca };
}

// ---------------- MCP (Streamable HTTP, respostas JSON) ----------------
const FERRAMENTAS = [
  {
    name: "explorar",
    description: "Tabela dinâmica sobre as eleições de 2026 (1º e 2º turno): agrega uma medida por uma dimensão nas linhas e, opcionalmente, outra nas colunas, com filtros. Use para rankings, comparações e cruzamentos (ex.: votos por partido em cada UF).",
    inputSchema: {
      type: "object",
      properties: {
        medida: { type: "string", enum: Object.keys(MEDIDAS), description: "O que somar/contar. Padrão: votos." },
        linhas: { type: "string", enum: Object.keys(DIMENSOES), description: "Dimensão das linhas." },
        colunas: { type: "string", enum: Object.keys(DIMENSOES), description: "Dimensão das colunas (opcional)." },
        filtros: { type: "object", description: "Mapa dimensão -> lista de valores. Ex.: {\"turno\":[\"1\"],\"cargo\":[\"DEPUTADO FEDERAL\"],\"uf\":[\"SP\"]}", additionalProperties: { type: "array", items: { type: "string" } } },
        busca: { type: "string", description: "Trecho do nome de urna do candidato." },
        limite: { type: "integer", description: "Máximo de linhas (padrão 50, máx. 500)." },
        ordem: { type: "string", enum: ["desc", "asc", "nome"] },
      },
      required: ["linhas"],
    },
  },
  {
    name: "buscar_candidatos",
    description: "Busca candidatos de 2026 por nome, UF, cargo, partido, situação ou turno. Retorna votos totais e o código (sq_candidato) para detalhar.",
    inputSchema: { type: "object", properties: {
      nome: { type: "string" }, uf: { type: "string" }, cargo: { type: "string" }, partido: { type: "string" },
      situacao: { type: "string" }, turno: { type: "integer" }, limite: { type: "integer" } } },
  },
  {
    name: "detalhar_candidato",
    description: "Ficha de um candidato: dados públicos, votos por município em cada turno e bens declarados.",
    inputSchema: { type: "object", properties: { sq_candidato: { type: "string" } }, required: ["sq_candidato"] },
  },
  {
    name: "valores_dimensao",
    description: "Lista os valores possíveis de uma dimensão (ex.: cargos, partidos, municípios de uma UF) para montar filtros.",
    inputSchema: { type: "object", properties: { dimensao: { type: "string", enum: Object.keys(DIMENSOES) }, uf: { type: "string" } }, required: ["dimensao"] },
  },
  {
    name: "saldo",
    description: "Mostra o saldo de créditos da chave usada e a cota grátis. Sem custo.",
    inputSchema: { type: "object", properties: {} },
  },
];

async function chamarFerramenta(env, ctx, nome, args, quem) {
  switch (nome) {
    case "explorar": {
      const { piv, cobranca } = await consultaExplorar(env, ctx, args, quem);
      return { ...piv, cobranca };
    }
    case "buscar_candidatos": {
      const r = await buscarCandidatos(env.DB, args);
      return { candidatos: r, cobranca: await cobrar(env.DB, { ...quem, custo: 1 }) };
    }
    case "detalhar_candidato": {
      const r = await detalharCandidato(env.DB, args.sq_candidato);
      return { ...r, cobranca: await cobrar(env.DB, { ...quem, custo: 1 }) };
    }
    case "valores_dimensao":
      return { dimensao: args.dimensao, valores: await valoresDimensao(env.DB, args.dimensao, args.uf) };
    case "saldo":
      return quem.chave ? { ...(await saldo(env.DB, quem.chave, env.FETCH || fetch)), cota_gratis_diaria: COTA_GRATIS } : { mensagem: "Sem chave: usando a cota grátis diária.", cota_gratis_diaria: COTA_GRATIS };
    default:
      throw new ErroApi(400, `Ferramenta desconhecida: ${nome}`);
  }
}

async function mcp(req, env, ctx, quem) {
  let msg;
  try { msg = await req.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON inválido" } }, 400); }
  const responder = async m => {
    const { id, method, params } = m;
    if (id === undefined || id === null) return null; // notificação
    try {
      if (method === "initialize") {
        const cli = String(params?.clientInfo?.name || "desconhecido").slice(0, 40).replace(/[^\w .\-]/g, "");
        await registrar(env.DB, "mcp_sessao", quem.ip); await registrar(env.DB, "mcp_cliente:" + cli);
      }
      if (method === "initialize") return { jsonrpc: "2.0", id, result: {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "eleicoes-2026-br", version: "1.0.0" },
        instructions: "Dados oficiais do TSE das eleições 2026 (1º e 2º turnos). Sem chave há uma cota grátis diária; com chave (Authorization: Bearer tse_...) as consultas usam créditos comprados em Lightning no site.",
      } };
      if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
      if (method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: FERRAMENTAS } };
      if (method === "tools/call") {
        await registrar(env.DB, "mcp_consulta", quem.ip);
        await registrar(env.DB, "mcp_ferramenta:" + String(params?.name || "?").slice(0, 40));
        try {
          const r = await chamarFerramenta(env, ctx, params?.name, params?.arguments || {}, quem);
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r } };
        } catch (e) {
          if (e instanceof ErroApi) await registrar(env.DB, "recusa:mcp " + e.status + " " + String(e.message).slice(0, 50));
          else await registrarErro(env.DB, "mcp:" + (params?.name || "?"), e);
          return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: e.message }] } };
        }
      }
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Método não suportado: ${method}` } };
    } catch (e) {
      return { jsonrpc: "2.0", id, error: { code: -32603, message: e.message } };
    }
  };
  if (Array.isArray(msg)) {
    const out = (await Promise.all(msg.map(responder))).filter(Boolean);
    return out.length ? json(out) : new Response(null, { status: 202, headers: CORS });
  }
  const r = await responder(msg);
  return r ? json(r) : new Response(null, { status: 202, headers: CORS });
}


const LLMS_TXT = o => `# Eleições 2026 em dados

> Resultados oficiais do TSE das eleições gerais brasileiras de 2026 (1º e 2º turno), indexados para consulta: votos por candidato e município, partidos, cargos, situação, perfil dos candidatos e patrimônio declarado.

## MCP (Streamable HTTP)
- Endpoint: ${o}/mcp
- Ferramentas: explorar (tabela dinâmica com filtros, linhas e colunas), buscar_candidatos, detalhar_candidato, valores_dimensao, saldo
- 60 consultas grátis por dia. Depois, 1 crédito por consulta. Chave via cabeçalho "Authorization: Bearer CHAVE" ou ?chave=CHAVE
- Créditos: comprados em bitcoin (Lightning) em ${o}/ sem cadastro

## API JSON
- GET ${o}/api/meta: dimensões, medidas e pacotes
- POST ${o}/api/explorar: {"medida":"votos","linhas":"uf","colunas":"partido","filtros":{"turno":["1"],"cargo":["PRESIDENTE"]}}
- GET ${o}/api/candidatos?q=NOME
- GET ${o}/api/candidato/SQ_CANDIDATO

## Fonte
Tribunal Superior Eleitoral, Portal de Dados Abertos. Site independente.
`;

// ---------------- Roteador ----------------
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const quem = { chave: chaveDe(req, url), ip: ipDe(req), site: doSite(req) };
    const fetcher = env.FETCH || fetch;
    try {
      if (p === "/" || p === "/index.html")
        return new Response(SITE_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "max-age=300" } });
      if (p === "/painel") {
        if (!(await chaveDoPainelOk(url.searchParams.get("k")))) return new Response("Não encontrado", { status: 404 });
        await conferirPendentes(env.DB, fetcher);
        return new Response(htmlPainel(await resumo(env.DB), env.VERSAO || ""), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      if (p === "/api/meta" && quem.site) await registrar(env.DB, "site", quem.ip);
      else if (p.startsWith("/api/") && !quem.site) await registrar(env.DB, "api", quem.ip);
      if (p === "/robots.txt")
        return new Response(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${url.origin}/sitemap.xml\n`, { headers: { "content-type": "text/plain; charset=utf-8" } });
      if (p === "/sitemap.xml") return await sitemap(env.DB, url.origin);
      if (p === "/estados") { await registrar(env.DB, "pagina", quem.ip); return await paginaEstados(env.DB, url.origin); }
      let mm;
      if ((mm = p.match(/^\/uf\/([A-Za-z]{2})\/?$/))) { await registrar(env.DB, "pagina", quem.ip); return await paginaUF(env.DB, url.origin, mm[1]); }
      if ((mm = p.match(/^\/candidato\/(\d+)/))) { await registrar(env.DB, "pagina", quem.ip); return await paginaCandidato(env.DB, url.origin, mm[1]); }
      if (p === "/llms.txt")
        return new Response(LLMS_TXT(url.origin), { headers: { "content-type": "text/plain; charset=utf-8" } });
      if (p === "/mcp") {
        if (req.method === "GET") return new Response("Use POST (MCP Streamable HTTP).", { status: 405, headers: { allow: "POST", ...CORS } });
        return await mcp(req, env, ctx, { ...quem, site: false });
      }
      if (p === "/api/meta") {
        const m = (await env.DB.prepare("SELECT chave, valor FROM meta").all()).results;
        return json({ meta: Object.fromEntries(m.map(x => [x.chave, x.valor])), dimensoes: Object.fromEntries(Object.entries(DIMENSOES).map(([k, v]) => [k, v.rotulo])),
          medidas: Object.fromEntries(Object.entries(MEDIDAS).map(([k, v]) => [k, v.rotulo])), hierarquias: HIERARQUIAS, cota_gratis_diaria: COTA_GRATIS,
          pacotes: await (async () => { const c = await cotacaoBRL(fetcher); return Object.fromEntries(Object.entries(PACOTES).map(([k, p]) => [k, { ...p, reais: c ? Math.round(p.sats / 1e8 * c * 100) / 100 : null }])); })(),
          pagamentos_ativos: !!env.LN_ADDRESS });
      }
      if (p === "/api/explorar" && req.method === "POST") {
        const params = await req.json();
        const { piv, cobranca } = await consultaExplorar(env, ctx, params, quem);
        if (params.exportar) await registrar(env.DB, "export", quem.ip);
        if (params.exportar) return new Response(csv(piv), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="eleicoes2026.csv"', ...CORS } });
        return json({ ...piv, cobranca });
      }
      if (p === "/api/valores") return json({ valores: await valoresDimensao(env.DB, url.searchParams.get("dimensao"), url.searchParams.get("uf")) });
      if (p === "/api/candidatos") {
        const r = await buscarCandidatos(env.DB, Object.fromEntries(url.searchParams));
        return json({ candidatos: r, cobranca: await cobrar(env.DB, { ...quem, custo: 1 }) });
      }
      if (p.startsWith("/api/candidato/")) {
        const r = await detalharCandidato(env.DB, decodeURIComponent(p.split("/").pop()));
        return json({ ...r, cobranca: await cobrar(env.DB, { ...quem, custo: 1 }) });
      }
      if (p === "/api/saldo") return json(quem.chave ? await saldo(env.DB, quem.chave, fetcher) : { creditos: null, cota_gratis_diaria: COTA_GRATIS });
      if (p === "/api/creditos" && req.method === "POST") {
        const b = await req.json();
        return json(await criarPedido(env.DB, env, fetcher, { pacote: b.pacote, chaveExistente: quem.chave }));
      }
      if (p === "/api/recuperar" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        return json(await recuperarComComprovante(env.DB, b.preimage));
      }
      if (p.startsWith("/api/creditos/") && p.endsWith("/comprovante") && req.method === "POST")
        return json(await confirmarComComprovante(env.DB, p.split("/")[3], (await req.json()).preimage));
      if (p.startsWith("/api/creditos/")) return json(await verificarPedido(env.DB, fetcher, p.split("/").pop()));
      return json({ erro: "Não encontrado" }, 404);
    } catch (e) {
      const status = e instanceof ErroApi ? e.status : 500;
      if (status === 500) { console.error(e); await registrarErro(env.DB, req.method + " " + p, e); }
      else if (status !== 404) await registrar(env.DB, "recusa:" + p + " " + status + " " + String(e.message).slice(0, 50));
      return json({ erro: status === 500 ? "Erro interno." : e.message }, status);
    }
  },
};
