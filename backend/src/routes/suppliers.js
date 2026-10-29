import express from 'express';
import { mlFetch } from '../lib/ml.js';
import { query as dbQuery } from '../lib/db.js';
import { findSupplierCost } from '../lib/supplier-costs.js';
import { parse } from 'csv-parse/sync';

const router = express.Router();

const NICHOS = [
  { id: 'eletronicos', nome: 'Eletronicos', query: 'fone bluetooth', queries: ['fone bluetooth', 'echo dot', 'caixa de som'], media_ticket: 450 },
  { id: 'celulares', nome: 'Celulares e Acessorios', query: 'xiaomi redmi', queries: ['xiaomi redmi', 'iphone', 'samsung galaxy'], media_ticket: 320 },
  { id: 'informatica', nome: 'Informatica', query: 'notebook lenovo', queries: ['notebook lenovo', 'mouse gamer', 'teclado mecanico'], media_ticket: 680 },
  { id: 'games', nome: 'Games e Consoles', query: 'videogame', queries: ['videogame', 'controle ps5', 'jogo ps5'], media_ticket: 590 },
  { id: 'casa', nome: 'Casa e Decoracao', query: 'air fryer', queries: ['air fryer', 'cafeteira', 'aspirador'], media_ticket: 280 },
  { id: 'moda', nome: 'Moda e Acessorios', query: 'mochila', queries: ['mochila', 'oculos de sol', 'tenis'], media_ticket: 210 },
  { id: 'beleza', nome: 'Beleza e Perfumaria', query: 'perfume', queries: ['perfume', 'creme facial', 'shampoo'], media_ticket: 180 },
  { id: 'esportes', nome: 'Esportes e Lazer', query: 'halter', queries: ['halter', 'bola futebol', 'bicicleta'], media_ticket: 340 },
  { id: 'automotivo', nome: 'Automotivo', query: 'som automotivo', queries: ['som automotivo', 'tapete carro', 'camara de re'], media_ticket: 420 },
  { id: 'bebe', nome: 'Bebe e Infantil', query: 'carrinho bebe', queries: ['carrinho bebe', 'fralda', 'mamadeira'], media_ticket: 260 },
  { id: 'pet', nome: 'Pet Shop', query: 'racao', queries: ['racao', 'coleira', 'arranhador'], media_ticket: 190 },
  { id: 'ferramentas', nome: 'Ferramentas e Construcao', query: 'furadeira', queries: ['furadeira', 'parafusadeira', 'serra'], media_ticket: 310 },
  { id: 'eletrodomesticos', nome: 'Eletrodomesticos', query: 'air fryer', queries: ['air fryer', 'liquidificador', 'ventilador'], media_ticket: 750 },
  { id: 'relogios', nome: 'Relogios e Joias', query: 'relogio smartwatch', queries: ['relogio smartwatch', 'smartwatch', 'relogio masculino'], media_ticket: 520 },
  { id: 'livros', nome: 'Livros e Papelaria', query: 'livro', queries: ['livro', 'biblia', 'livro infantil'], media_ticket: 90 },
  { id: 'musica', nome: 'Instrumentos Musicais', query: 'violao', queries: ['violao', 'teclado musical', 'microfone'], media_ticket: 400 },
  { id: 'brinquedos', nome: 'Brinquedos e Hobbies', query: 'lego', queries: ['lego', 'boneca', 'carrinho controle remoto'], media_ticket: 200 },
  { id: 'saude', nome: 'Saude e Cuidado Pessoal', query: 'creme facial', queries: ['creme facial', 'suplemento', 'vitamina'], media_ticket: 230 },
  { id: 'alimentos', nome: 'Alimentos e Bebidas', query: 'cafe', queries: ['cafe', 'chocolate', 'whey'], media_ticket: 150 },
  { id: 'cama', nome: 'Cama, Mesa e Banho', query: 'jogo de cama', queries: ['jogo de cama', 'toalha', 'travesseiro'], media_ticket: 240 },
];

const cache = new Map();

function cached(key, ttlMs, producer) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.createdAt < ttlMs) return Promise.resolve(hit.value);
  return producer().then((value) => {
    cache.set(key, { value, createdAt: Date.now() });
    return value;
  });
}

function findNicho(id) {
  return NICHOS.find((item) => item.id === id) || null;
}

function pickOffer(items) {
  const valid = (items || []).filter((item) => Number(item.price) > 0);
  if (!valid.length) return null;
  return [...valid].sort((a, b) => Number(a.price) - Number(b.price))[0];
}

async function catalogSearch(query, limit) {
  const params = new URLSearchParams({
    site_id: 'MLB',
    status: 'active',
    q: query,
    limit: String(limit),
  });
  const data = await mlFetch(`/products/search?${params.toString()}`);
  return data.results || [];
}

async function offersForProduct(productId) {
  const data = await mlFetch(
    `/products/${encodeURIComponent(productId)}/items?limit=10`
  );
  return data.results || [];
}

function formatProduct(product, offer) {
  const pictures = (product.pictures || [])
    .map((picture) => picture.url || picture.secure_url)
    .filter(Boolean)
    .slice(0, 6);

  return {
    id: product.id,
    catalogo_id: product.id,
    item_id: offer?.item_id || null,
    title: product.name,
    price: Number(offer?.price) || 0,
    currency_id: offer?.currency_id || 'BRL',
    thumbnail: pictures[0] || null,
    pictures,
    permalink: `https://www.mercadolivre.com.br/p/${product.id}`,
    condition: offer?.condition || 'new',
    category_id: offer?.category_id || null,
    available_quantity: null,
    sold_quantity: null,
    free_shipping: Boolean(offer?.shipping?.free_shipping),
    seller: offer?.seller_id
      ? { id: String(offer.seller_id), nickname: null }
      : null,
    warranty: offer?.warranty || null,
    attributes: product.attributes || [],
    attributes_count: (product.attributes || []).length,
    quality_type: product.quality_type || null,
    listing_strategy: product.settings?.listing_strategy || null,
    catalog_required:
      product.settings?.listing_strategy === 'catalog_required' ||
      product.settings?.listing_strategy === 'catalog_only',
    buy_box_price: Number(product.buy_box_winner?.price) || null,
    source: 'catalog',
  };
}

function reputationLabel(user) {
  const level = user?.seller_reputation?.level_id;
  const map = {
    '5_green': 'A+',
    '4_light_green': 'A',
    '3_yellow': 'B',
    '2_orange': 'C',
    '1_red': 'D',
  };
  return map[level] || 'Novo';
}

function sellerMetrics(user) {
  const reputation = user?.seller_reputation;
  const positive = reputation?.transactions?.ratings?.positive;
  const delayed = reputation?.metrics?.delayed_handling_time?.rate;
  return {
    id: String(user?.id || ''),
    nome: user?.nickname || `Vendedor ${user?.id || ''}`,
    reputacao: reputationLabel(user),
    avaliacao: typeof positive === 'number' ? Math.round(positive * 50) / 10 : null,
    entregas_no_prazo: typeof delayed === 'number' ? Math.round((1 - delayed) * 100) : null,
    vendas: reputation?.transactions?.completed ?? null,
    permalink: user?.permalink || null,
    thumbnail: user?.thumbnail || null,
  };
}

async function searchProducts({ queries, limit, minPrice }) {
  const list = (Array.isArray(queries) ? queries : [queries]).filter(Boolean);
  const key = `catalog:${list.join('|')}:${limit}:${minPrice}`;
  return cached(key, 10 * 60 * 1000, async () => {
    const perQuery = Math.min(
      Math.max(Math.ceil(limit / Math.max(list.length, 1)) + 2, 5),
      10
    );
    const batches = await Promise.all(
      list.map((query) => catalogSearch(query, perQuery))
    );
    const unique = Array.from(
      new Map(batches.flat().map((product) => [product.id, product])).values()
    );
    const enriched = await Promise.all(
      unique.map(async (product) => {
        try {
          const offer = pickOffer(await offersForProduct(product.id));
          if (!offer) return null;
          return formatProduct(product, offer);
        } catch {
          return null;
        }
      })
    );
    return enriched
      .filter(Boolean)
      .filter((product) => product.price >= minPrice && product.thumbnail)
      .slice(0, limit);
  });
}

export function getNichos() {
  return NICHOS;
}

router.get('/nichos', (req, res) => {
  res.json(NICHOS);
});

router.get('/produtos-reais', async (req, res, next) => {
  try {
    const nicho = findNicho(req.query.nicho);
    if (!nicho && !req.query.q) {
      return res.status(400).json({ error: 'Nicho invalido. Informe nicho ou q.' });
    }

    const limit = Math.min(Math.max(Number(req.query.limite) || 12, 1), 18);
    const minPrice = Math.max(Number(req.query.minPreco) || 80, 0);
    const query = req.query.q || nicho.query;
    const queries = req.query.q ? [req.query.q] : nicho.queries || [nicho.query];

    const produtos = await searchProducts({ queries, limit, minPrice });
    res.json({
      nicho: nicho?.id || null,
      query,
      total: produtos.length,
      produtos,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/fornecedores', async (req, res, next) => {
  try {
    const nicho = findNicho(req.query.nicho) || NICHOS[0];
    const produtos = await searchProducts({
      queries: nicho.queries || [nicho.query],
      limit: 12,
      minPrice: 0,
    });

    const sellerIds = Array.from(
      new Set(produtos.map((product) => product.seller?.id).filter(Boolean))
    ).slice(0, 6);

    const detalhados = await Promise.all(
      sellerIds.map(async (sellerId) => {
        try {
          const user = await mlFetch(`/users/${sellerId}`);
          return sellerMetrics(user);
        } catch {
          return {
            id: sellerId,
            nome: `Vendedor ${sellerId}`,
            reputacao: 'Sem dados',
            avaliacao: null,
            entregas_no_prazo: null,
            vendas: null,
            permalink: null,
            thumbnail: null,
          };
        }
      })
    );

    res.json(detalhados);
  } catch (err) {
    next(err);
  }
});


function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeNichos(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

router.get('/registro', async (req, res, next) => {
  try {
    const { rows } = await dbQuery(
      'SELECT * FROM suppliers ORDER BY nome ASC'
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.post('/registro', async (req, res, next) => {
  try {
    const nome = String(req.body.nome || '').trim();
    if (!nome) return res.status(400).json({ error: 'Informe o nome.' });
    const slug = slugify(req.body.slug || nome);
    const nichos = normalizeNichos(req.body.nichos);
    const { rows } = await dbQuery(
      `INSERT INTO suppliers
         (slug, nome, site, descricao, nichos, pedido_minimo, dropshipping, integracao, ativo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (slug) DO UPDATE SET
         nome = EXCLUDED.nome,
         site = EXCLUDED.site,
         descricao = EXCLUDED.descricao,
         nichos = EXCLUDED.nichos,
         pedido_minimo = EXCLUDED.pedido_minimo,
         dropshipping = EXCLUDED.dropshipping,
         integracao = EXCLUDED.integracao,
         ativo = EXCLUDED.ativo
       RETURNING *`,
      [
        slug,
        nome,
        req.body.site ? String(req.body.site) : null,
        req.body.descricao ? String(req.body.descricao) : null,
        nichos,
        numberOrNull(req.body.pedido_minimo),
        Boolean(req.body.dropshipping),
        req.body.integracao ? String(req.body.integracao) : 'manual',
        req.body.ativo !== false,
      ]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.get('/prontidao', async (req, res, next) => {
  try {
    const fornecedorIds = String(req.query.fornecedor_ids || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    const filter = fornecedorIds.length
      ? 'WHERE sp.fornecedor_id = ANY($1::text[])'
      : '';
    const params = fornecedorIds.length ? [fornecedorIds] : [];
    const { rows } = await dbQuery(
      `WITH base AS (
         SELECT
           sp.fornecedor_id,
           sp.ativo,
           sp.estoque,
           sp.custo,
           sp.preco_mercado,
           sp.mercado_ofertas,
           sp.mercado_confianca,
           sp.validado_manual,
           sp.alto_giro_manual,
            COALESCE(s.nome, sp.fornecedor_nome, sp.fornecedor_id) AS fornecedor_nome,
            s.cep, s.cep_distribuicao, s.endereco, s.endereco_distribuicao, s.cidade, s.uf,
           GREATEST(
             COALESCE(sp.peso_kg, 0) + COALESCE(sp.tara_kg, 0),
             COALESCE(sp.altura_cm * sp.largura_cm * sp.comprimento_cm / 6000, 0)
           ) AS peso_total,
           COALESCE(s.custo_embalagem, 0) AS embalagem
         FROM supplier_products sp
         LEFT JOIN suppliers s ON s.slug = sp.fornecedor_id
         ${filter}
       ),
       custos AS (
         SELECT *,
           CASE
             WHEN peso_total <= 0 THEN 25
             WHEN peso_total <= 0.5 THEN 19.5
             WHEN peso_total <= 1 THEN 21
             WHEN peso_total <= 2 THEN 23.5
             WHEN peso_total <= 5 THEN 42.9
             WHEN peso_total <= 10 THEN 58.9
             WHEN peso_total <= 20 THEN 79.9
             ELSE 99.9
           END AS frete
         FROM base
       ),
       precos_base AS (
         SELECT *,
           (2 * custo + 1 + 6.75 + embalagem) / 0.8 AS preco_sem_frete,
           (2 * custo + 1 + frete + embalagem) / 0.8 AS preco_com_frete
         FROM custos
       ),
       precos AS (
         SELECT *,
           CASE
             WHEN preco_sem_frete < 79 THEN preco_sem_frete
             ELSE preco_com_frete
           END AS preco_piso
         FROM precos_base
       ),
       mercado AS (
         SELECT *,
           preco_mercado
             - custo
             - CASE WHEN preco_mercado >= 79 THEN frete ELSE 0 END
             - embalagem
             - 0.2 * preco_mercado
             - CASE WHEN preco_mercado < 79 THEN 6.75 ELSE 0 END AS lucro_mercado
         FROM precos
       ),
       vendas AS (
         SELECT *,
           preco_piso AS preco_venda
         FROM mercado
       ),
       resultado AS (
         SELECT *,
           preco_venda
             - custo
             - CASE WHEN preco_venda >= 79 THEN frete ELSE 0 END
             - embalagem
             - 0.2 * preco_venda AS lucro
         FROM vendas
       )
       SELECT
          fornecedor_id,
          fornecedor_nome,
          cep, cep_distribuicao, endereco, endereco_distribuicao, cidade, uf,
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE ativo AND COALESCE(estoque, 0) > 0)::int AS ativos,
         COUNT(*) FILTER (
           WHERE preco_mercado IS NOT NULL AND mercado_confianca >= 0.8
         )::int AS confiaveis,
         COUNT(*) FILTER (
           WHERE preco_mercado IS NOT NULL AND (mercado_confianca >= 0.8 OR validado_manual) AND lucro_mercado >= custo
         )::int AS fortes,
         COUNT(*) FILTER (
           WHERE custo > 0
             AND ativo
             AND COALESCE(estoque, 0) > 0
             AND preco_mercado BETWEEN 80 AND 100
             AND (mercado_confianca >= 0.8 OR validado_manual)
             AND lucro_mercado >= custo
         )::int AS faixa_80_100,
         COUNT(*) FILTER (
           WHERE custo > 0
             AND ativo
             AND COALESCE(estoque, 0) > 0
             AND (mercado_confianca >= 0.8 OR validado_manual)
             AND lucro_mercado >= custo
         )::int AS validados_mercado,
         COUNT(*) FILTER (
           WHERE custo > 0
             AND ativo
             AND COALESCE(estoque, 0) > 0
             AND lucro > custo
         )::int AS candidatos,
         COUNT(*) FILTER (
           WHERE custo > 0
             AND ativo
             AND COALESCE(estoque, 0) > 0
             AND (mercado_confianca >= 0.8 OR validado_manual)
             AND lucro_mercado >= custo
         )::int AS viaveis,
         COUNT(*) FILTER (
           WHERE custo > 0
             AND ativo
             AND COALESCE(estoque, 0) > 0
             AND preco_mercado IS NOT NULL
             AND (mercado_confianca >= 0.8 OR validado_manual)
             AND lucro_mercado >= custo * 0.8
             AND lucro_mercado < custo
         )::int AS alto_giro,
         COUNT(*) FILTER (
           WHERE custo > 0
             AND ativo
             AND COALESCE(estoque, 0) > 0
             AND preco_mercado IS NULL
         )::int AS potencial_08
       FROM resultado
        GROUP BY fornecedor_id, fornecedor_nome, cep, cep_distribuicao, endereco, endereco_distribuicao, cidade, uf
       ORDER BY total DESC`,
      params
    );
    const total = rows.reduce((sum, row) => sum + Number(row.total || 0), 0);
    const ativos = rows.reduce((sum, row) => sum + Number(row.ativos || 0), 0);
    const confiaveis = rows.reduce((sum, row) => sum + Number(row.confiaveis || 0), 0);
    const fortes = rows.reduce((sum, row) => sum + Number(row.fortes || 0), 0);
    const faixa80100 = rows.reduce((sum, row) => sum + Number(row.faixa_80_100 || 0), 0);
    const candidatos = rows.reduce((sum, row) => sum + Number(row.candidatos || 0), 0);
    const validadosMercado = rows.reduce((sum, row) => sum + Number(row.validados_mercado || 0), 0);
    const viaveis = rows.reduce((sum, row) => sum + Number(row.viaveis || 0), 0);
    const altoGiro = rows.reduce((sum, row) => sum + Number(row.alto_giro || 0), 0);
    const potencial08 = rows.reduce((sum, row) => sum + Number(row.potencial_08 || 0), 0);
    const viaveisAmpliados = viaveis + altoGiro;
    const poolAmpliado = viaveisAmpliados + potencial08;
    const cepMap = new Map();
    for (const row of rows) {
      if (!row.cep_distribuicao) continue;
      const key = String(row.cep_distribuicao);
      if (!cepMap.has(key)) cepMap.set(key, []);
      cepMap.get(key).push(row);
    }
    const gruposCep = [...cepMap.entries()]
      .map(([cep, fornecedores]) => ({
        cep,
        fornecedores: fornecedores.map((item) => item.fornecedor_nome),
        ceps_cadastro: [...new Set(fornecedores.map((item) => item.cep).filter(Boolean))],
        total: fornecedores.reduce((sum, item) => sum + Number(item.total || 0), 0),
      }))
      .filter((grupo) => grupo.fornecedores.length >= 2);
    const semCep = rows
      .filter((row) => !row.cep_distribuicao)
      .map((row) => row.fornecedor_nome);
    const pendencias = [];
    if (poolAmpliado < 350) {
      pendencias.push(
        `Faltam ${350 - poolAmpliado} SKU(s) para a meta de 350; há ${viaveis} com lucro acima de 100%, ${altoGiro} na faixa de 0,8x a 1x com mercado confirmado e ${potencial08} sem preço de mercado para validar.`
      );
    } else if (viaveisAmpliados < 350) {
      pendencias.push(
        `O pool tem ${poolAmpliado} SKUs (${viaveis} acima de 100% + ${altoGiro} na faixa de 0,8x a 1x + ${potencial08} sem preço de mercado). A meta de 350 a 500 pode ser montada com esse pool, mas só ${viaveisAmpliados} estão confirmados; valide demanda de 2 a 3 vendas/mês antes de anunciar.`
      );
    } else if (poolAmpliado > 500) {
      pendencias.push(
        `Há ${poolAmpliado} SKUs no pool (${viaveis} acima de 100%, ${altoGiro} na faixa de 0,8x a 1x e ${potencial08} sem mercado). A meta é operar entre 350 e 500; selecione os de maior demanda e valide 2 a 3 vendas/mês.`
      );
    }
    if (!gruposCep.length) {
      pendencias.push(
        'Nenhum par de fornecedores compartilha o mesmo CEP de distribuicao. O Mercado Livre aceita um endereco de remetente por conta.'
      );
    }
    if (semCep.length) {
      pendencias.push(`Sem CEP de distribuicao informado: ${semCep.join(', ')}.`);
    }
    res.json({
      total,
      ativos,
      confiaveis,
      fortes,
      faixa_80_100: faixa80100,
      candidatos,
      validados_mercado: validadosMercado,
      viaveis,
      alto_giro: altoGiro,
      viaveis_ampliados: viaveisAmpliados,
      potencial_08: potencial08,
      pool_ampliado: poolAmpliado,
      meta: { min: 350, max: 500 },
      fornecedores: rows,
      grupos_cep: gruposCep,
      atende_volume: poolAmpliado >= 350,
      atende_volume_confirmado: viaveisAmpliados >= 350,
      atende_cep: gruposCep.length > 0,
      pendencias,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/custos/resumo', async (req, res, next) => {
  try {
    const hours = Math.min(
      Math.max(Number(req.query.horas) || 24, 1),
      24 * 30
    );
    const { rows } = await dbQuery(
      `SELECT
         fornecedor_id,
         COALESCE(MAX(fornecedor_nome), fornecedor_id) AS fornecedor_nome,
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE ativo)::int AS ativos,
         COUNT(*) FILTER (WHERE NOT ativo)::int AS inativos,
         COUNT(*) FILTER (
           WHERE atualizado_em < NOW() - ($1::numeric * INTERVAL '1 hour')
         )::int AS desatualizados,
         ROUND(AVG(custo)::numeric, 2) AS custo_medio,
         MIN(custo)::numeric AS custo_min,
         MAX(custo)::numeric AS custo_max,
         MAX(atualizado_em) AS ultima_atualizacao
       FROM supplier_products
       GROUP BY fornecedor_id
       ORDER BY total DESC`,
      [hours]
    );
    const resumo = rows.reduce(
      (acc, row) => ({
        total: acc.total + Number(row.total || 0),
        ativos: acc.ativos + Number(row.ativos || 0),
        inativos: acc.inativos + Number(row.inativos || 0),
        desatualizados: acc.desatualizados + Number(row.desatualizados || 0),
      }),
      { total: 0, ativos: 0, inativos: 0, desatualizados: 0 }
    );
    res.json({ horas: hours, ...resumo, fornecedores: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/custos/desatualizados', async (req, res, next) => {
  try {
    const hours = Math.min(
      Math.max(Number(req.query.horas) || 24, 1),
      24 * 30
    );
    const limit = Math.min(Math.max(Number(req.query.limite) || 100, 1), 500);
    const fornecedorIds = String(req.query.fornecedor_ids || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    const supplierFilter = fornecedorIds.length
      ? 'AND fornecedor_id = ANY($2::text[])'
      : '';
    const params = fornecedorIds.length ? [hours, fornecedorIds] : [hours];
    const { rows } = await dbQuery(
      `SELECT
         *,
         ROUND(
           (EXTRACT(EPOCH FROM (NOW() - atualizado_em)) / 3600)::numeric,
           1
         ) AS horas_desatualizado
       FROM supplier_products
       WHERE ativo = TRUE
         AND atualizado_em < NOW() - ($1::numeric * INTERVAL '1 hour')
         ${supplierFilter}
       ORDER BY atualizado_em ASC
       LIMIT ${limit}`,
      params
    );
    const { rows: countRows } = await dbQuery(
      `SELECT COUNT(*)::int AS total
       FROM supplier_products
       WHERE ativo = TRUE
         AND atualizado_em < NOW() - ($1::numeric * INTERVAL '1 hour')
         ${supplierFilter}`,
      params
    );
    res.json({
      horas: hours,
      total: countRows[0]?.total || 0,
      produtos: rows,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/custos', async (req, res, next) => {
  try {
    const filters = [];
    const params = [];
    for (const [field, column] of [
      ['fornecedor_id', 'fornecedor_id'],
      ['catalogo_id', 'catalogo_id'],
      ['item_id', 'item_id'],
      ['gtin', 'gtin'],
    ]) {
      if (req.query[field]) {
        params.push(String(req.query[field]));
        filters.push(`${column} = $${params.length}`);
      }
    }
    if (req.query.fornecedor_ids) {
      const ids = String(req.query.fornecedor_ids)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      if (ids.length) {
        params.push(ids);
        filters.push(`fornecedor_id = ANY($${params.length}::text[])`);
      }
    }
    if (req.query.ativo === 'true') filters.push('ativo = TRUE');
    if (req.query.ativo === 'false') filters.push('ativo = FALSE');
    if (req.query.desatualizado === 'true') {
      filters.push("atualizado_em < NOW() - INTERVAL '24 hours'");
    }
    if (req.query.desatualizado === 'false') {
      filters.push("atualizado_em >= NOW() - INTERVAL '24 hours'");
    }
    if (req.query.q) {
      params.push(`%${String(req.query.q).trim()}%`);
      filters.push(
        `(sku ILIKE $${params.length} OR COALESCE(gtin, '') ILIKE $${params.length} OR COALESCE(titulo, '') ILIKE $${params.length})`
      );
    }

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const limit = Math.min(Math.max(Number(req.query.limite) || 200, 1), 2000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const sort = {
      custo_asc: 'custo ASC',
      custo_desc: 'custo DESC',
      recente: 'atualizado_em DESC',
      antigo: 'atualizado_em ASC',
      titulo: 'titulo ASC NULLS LAST',
    }[req.query.ordem] || 'custo ASC';

    const { rows } = await dbQuery(
      `SELECT
         *,
         (atualizado_em < NOW() - INTERVAL '24 hours') AS desatualizado,
         ROUND(
           (EXTRACT(EPOCH FROM (NOW() - atualizado_em)) / 3600)::numeric,
           1
         ) AS horas_desde_atualizacao
       FROM supplier_products ${where}
       ORDER BY ${sort}
       LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/custos/buscar', async (req, res, next) => {
  try {
    const produto = await findSupplierCost({
      catalogoId: req.query.catalogo_id,
      itemId: req.query.item_id,
      gtin: req.query.gtin,
      fornecedorId: req.query.fornecedor_id,
    });
    res.json({ encontrado: Boolean(produto), produto: produto || null });
  } catch (err) {
    next(err);
  }
});

const FIELD_ALIASES = {
  sku: ['sku', 'codigo', 'cod', 'codigo_produto', 'referencia', 'cod_ref', 'id', 'product_id', 'product_sku', 'id_produto'],
  gtin: ['gtin', 'ean', 'codigo_barras', 'barcode', 'upc'],
  titulo: ['titulo', 'nome', 'produto', 'descricao', 'nome_produto', 'product_name', 'product_title', 'name'],
  custo: ['custo', 'preco_custo', 'valor', 'preco', 'preco_atacado', 'vlr', 'valor_unitario', 'cost', 'product_price', 'sale_price', 'price'],
  estoque: ['estoque', 'qtd', 'quantidade', 'saldo', 'disponivel', 'inventory', 'inventory_quantity', 'stock', 'quantity'],
  catalogo_id: ['catalogo_id', 'catalog_product_id', 'catalog_id', 'mlb', 'id_ml'],
  item_id: ['item_id', 'ml_item_id', 'id_item'],
  peso_kg: ['peso', 'peso_kg', 'weight', 'weight_kg', 'product_weight', 'package_weight'],
  peso_g: ['peso_g', 'peso_gramas', 'weight_g'],
  altura_cm: ['altura', 'altura_cm', 'height', 'package_height'],
  largura_cm: ['largura', 'largura_cm', 'width', 'package_width'],
  comprimento_cm: ['comprimento', 'comprimento_cm', 'length', 'package_length'],
  tara_kg: ['tara_kg', 'tara', 'peso_embalagem', 'packaging_weight_kg'],
  categoria: ['categoria', 'category', 'departamento'],
  url: ['url', 'link', 'permalink', 'product_url'],
  preco_mercado: ['preco_mercado', 'market_price', 'preco_referencia', 'market_price_calc'],
  mercado_min: ['mercado_min', 'market_min', 'price_min'],
  mercado_max: ['mercado_max', 'market_max', 'price_max'],
  mercado_ofertas: ['mercado_ofertas', 'offers', 'ofertas'],
  mercado_vendedores: ['mercado_vendedores', 'sellers', 'vendedores'],
  mercado_confianca: ['mercado_confianca', 'confidence', 'confianca'],
  mercado_multiplo: ['mercado_multiplo', 'market_multiple', 'multiplo'],
  matched_id: ['matched_id', 'mlb_id', 'catalog_product_id'],
  matched_name: ['matched_name', 'nome_mercado'],
  categoria_ml: ['categoria_ml', 'category_path', 'ml_category'],
  ativo: ['ativo', 'status'],
};

function normalizeHeader(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseBrNumber(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let text = String(value).trim().replace(/R\$/gi, '').replace(/\s/g, '');
  if (!text) return null;
  if (text.includes(',') && text.includes('.')) {
    if (text.lastIndexOf(',') > text.lastIndexOf('.')) {
      text = text.replace(/\./g, '').replace(',', '.');
    } else {
      text = text.replace(/,/g, '');
    }
  } else if (text.includes(',')) {
    text = text.replace(',', '.');
  }
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function parseActive(value) {
  if (value === false) return false;
  if (value == null || value === '') return true;
  const text = normalizeHeader(value);
  return !['0', 'false', 'nao', 'inativo', 'esgotado', 'indisponivel', 'off'].includes(
    text
  );
}

function mapCsvRecord(record) {
  const keys = new Map(
    Object.keys(record).map((key) => [normalizeHeader(key), key])
  );
  const mapped = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    for (const alias of aliases) {
      const originalKey = keys.get(alias);
      if (originalKey && String(record[originalKey] ?? '').trim() !== '') {
        mapped[field] = record[originalKey];
        break;
      }
    }
  }
  return mapped;
}

function csvRecords(csv, delimiter) {
  const text = String(csv || '').replace(/^\uFEFF/, '');
  const firstLine = text.split(/\r?\n/).find((line) => line.trim()) || '';
  const autoDelimiter =
    delimiter ||
    ((firstLine.match(/\t/g) || []).length > 0
      ? '\t'
      : (firstLine.match(/;/g) || []).length >=
          (firstLine.match(/,/g) || []).length
        ? ';'
        : ',');
  return parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    delimiter: autoDelimiter,
    relax_column_count: true,
  });
}

function normalizeSupplierItem(item, fornecedorId, fornecedorNome) {
  const owner = String(item.fornecedor_id || fornecedorId || '').trim();
  const custo = parseBrNumber(
    item.custo ?? item.cost ?? item.preco_custo ?? item.preco
  );
  const sku = String(
    item.sku || item.catalogo_id || item.gtin || item.item_id || ''
  ).trim();

  if (!owner || !Number.isFinite(custo) || custo <= 0 || !sku) return null;

  const pesoKg = parseBrNumber(item.peso_kg ?? item.weight_kg);
  const pesoG = parseBrNumber(item.peso_g ?? item.peso_gramas ?? item.weight_g);
  const pesoFinal =
    pesoKg != null ? pesoKg : pesoG != null ? pesoG / 1000 : null;
  const estoqueRaw = item.estoque ?? item.stock;
  const estoque =
    estoqueRaw == null || String(estoqueRaw).trim() === ''
      ? null
      : Math.max(Math.trunc(parseBrNumber(estoqueRaw) || 0), 0);

  return {
    fornecedor_id: owner,
    fornecedor_nome: item.fornecedor_nome || fornecedorNome || null,
    catalogo_id: item.catalogo_id ? String(item.catalogo_id).trim() : null,
    item_id: item.item_id ? String(item.item_id).trim() : null,
    sku,
    gtin: item.gtin
      ? String(item.gtin).replace(/[^0-9]/g, '') || null
      : null,
    titulo: item.titulo || item.title || null,
    custo,
    estoque,
    peso_kg: pesoFinal,
    altura_cm: parseBrNumber(item.altura_cm ?? item.height_cm),
    largura_cm: parseBrNumber(item.largura_cm ?? item.width_cm),
    comprimento_cm: parseBrNumber(item.comprimento_cm ?? item.length_cm),
    tara_kg: parseBrNumber(item.tara_kg ?? item.tara),
    categoria: item.categoria ? String(item.categoria).trim() : null,
    url: item.url ? String(item.url).trim() : null,
    preco_mercado: parseBrNumber(item.preco_mercado),
    mercado_min: parseBrNumber(item.mercado_min),
    mercado_max: parseBrNumber(item.mercado_max),
    mercado_ofertas: parseBrNumber(item.mercado_ofertas),
    mercado_vendedores: parseBrNumber(item.mercado_vendedores),
    mercado_confianca: parseBrNumber(item.mercado_confianca),
    mercado_multiplo: parseBrNumber(item.mercado_multiplo),
    matched_id: item.matched_id ? String(item.matched_id).trim() : null,
    matched_name: item.matched_name ? String(item.matched_name).trim() : null,
    categoria_ml: item.categoria_ml ? String(item.categoria_ml).trim() : null,
    ativo: parseActive(item.ativo),
  };
}

async function batchUpsertSupplierProducts(items) {
  const payload = JSON.stringify(items);
  await dbQuery(
    `INSERT INTO supplier_products
       (fornecedor_id, fornecedor_nome, catalogo_id, item_id, sku, gtin,
        titulo, custo, estoque, peso_kg, altura_cm, largura_cm,
        comprimento_cm, tara_kg, categoria, url, preco_mercado, mercado_min,
        mercado_max, mercado_ofertas, mercado_vendedores, mercado_confianca,
        mercado_multiplo, matched_id, matched_name, categoria_ml, ativo,
        atualizado_em)
     SELECT fornecedor_id, fornecedor_nome, catalogo_id, item_id, sku, gtin,
        titulo, custo, estoque, peso_kg, altura_cm, largura_cm,
        comprimento_cm, tara_kg, categoria, url, preco_mercado, mercado_min,
        mercado_max, mercado_ofertas, mercado_vendedores, mercado_confianca,
        mercado_multiplo, matched_id, matched_name, categoria_ml, ativo, NOW()
     FROM jsonb_to_recordset($1::jsonb) AS x(
        fornecedor_id text, fornecedor_nome text, catalogo_id text,
        item_id text, sku text, gtin text, titulo text, custo numeric,
        estoque integer, peso_kg numeric, altura_cm numeric,
        largura_cm numeric, comprimento_cm numeric, tara_kg numeric,
        categoria text, url text, preco_mercado numeric, mercado_min numeric,
        mercado_max numeric, mercado_ofertas integer,
        mercado_vendedores integer, mercado_confianca numeric,
        mercado_multiplo numeric, matched_id text, matched_name text,
        categoria_ml text, ativo boolean
     )
     ON CONFLICT (fornecedor_id, sku) DO UPDATE SET
       fornecedor_nome = EXCLUDED.fornecedor_nome,
       catalogo_id = EXCLUDED.catalogo_id,
       item_id = EXCLUDED.item_id,
       gtin = EXCLUDED.gtin,
       titulo = EXCLUDED.titulo,
       custo = EXCLUDED.custo,
       estoque = EXCLUDED.estoque,
       peso_kg = EXCLUDED.peso_kg,
       altura_cm = EXCLUDED.altura_cm,
       largura_cm = EXCLUDED.largura_cm,
       comprimento_cm = EXCLUDED.comprimento_cm,
       tara_kg = EXCLUDED.tara_kg,
       categoria = EXCLUDED.categoria,
       url = EXCLUDED.url,
       preco_mercado = EXCLUDED.preco_mercado,
       mercado_min = EXCLUDED.mercado_min,
       mercado_max = EXCLUDED.mercado_max,
       mercado_ofertas = EXCLUDED.mercado_ofertas,
       mercado_vendedores = EXCLUDED.mercado_vendedores,
       mercado_confianca = EXCLUDED.mercado_confianca,
       mercado_multiplo = EXCLUDED.mercado_multiplo,
       matched_id = EXCLUDED.matched_id,
       matched_name = EXCLUDED.matched_name,
       categoria_ml = EXCLUDED.categoria_ml,
       ativo = EXCLUDED.ativo,
       atualizado_em = NOW()`,
    [payload]
  );
}

async function upsertSupplierProduct(item) {
  await batchUpsertSupplierProducts([item]);
}

async function upsertSupplierProducts(produtos, fornecedorId, fornecedorNome) {
  const unicos = new Map();
  const erros = [];

  for (const raw of produtos) {
    const item = normalizeSupplierItem(raw, fornecedorId, fornecedorNome);
    if (!item) {
      if (erros.length < 10) {
        erros.push({
          sku: raw.sku || null,
          erro: 'custo invalido ou sku/catalogo_id/gtin ausente',
        });
      }
      continue;
    }
    unicos.set(`${item.fornecedor_id}\u0000${item.sku}`, item);
  }

  const validos = [...unicos.values()];
  let importados = 0;
  const chunkSize = 500;
  for (let index = 0; index < validos.length; index += chunkSize) {
    const chunk = validos.slice(index, index + chunkSize);
    try {
      await batchUpsertSupplierProducts(chunk);
      importados += chunk.length;
    } catch {
      for (const item of chunk) {
        try {
          await upsertSupplierProduct(item);
          importados += 1;
        } catch (rowError) {
          if (erros.length < 10) {
            erros.push({
              sku: item.sku,
              erro: rowError?.message || 'falha ao gravar produto',
            });
          }
        }
      }
    }
  }

  return { importados, erros };
}

router.post('/custos/importar', async (req, res, next) => {
  try {
    const fornecedorId = String(
      req.body.fornecedor_id || req.body.fornecedor?.id || ''
    ).trim();
    const fornecedorNome =
      req.body.fornecedor_nome || req.body.fornecedor?.nome || null;
    const produtos = Array.isArray(req.body.produtos)
      ? req.body.produtos
      : Array.isArray(req.body)
        ? req.body
        : [];

    if (!fornecedorId) {
      return res.status(400).json({ error: 'Informe fornecedor_id.' });
    }
    if (!produtos.length) {
      return res.status(400).json({ error: 'Envie uma lista em produtos.' });
    }
    if (produtos.length > 2000) {
      return res.status(422).json({ error: 'Limite de 2000 produtos por importacao.' });
    }

    const { importados, erros } = await upsertSupplierProducts(
      produtos,
      fornecedorId,
      fornecedorNome
    );

    res.status(201).json({
      fornecedor_id: fornecedorId,
      recebidos: produtos.length,
      importados,
      ignorados: produtos.length - importados,
      erros,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/custos/importar-csv', async (req, res, next) => {
  try {
    const fornecedorId = String(
      req.body.fornecedor_id || req.query.fornecedor_id || ''
    ).trim();
    const fornecedorNome =
      req.body.fornecedor_nome || req.query.fornecedor_nome || null;
    const csv = req.body.csv || req.body.conteudo || '';
    const delimiter = req.body.delimiter || req.query.delimiter || null;

    if (!fornecedorId) {
      return res.status(400).json({ error: 'Informe fornecedor_id.' });
    }
    if (!String(csv).trim()) {
      return res.status(400).json({ error: 'Envie o conteudo do CSV em csv.' });
    }

    const records = csvRecords(csv, delimiter);
    if (!records.length) {
      return res.status(422).json({ error: 'CSV sem linhas de produto.' });
    }
    if (records.length > 2000) {
      return res.status(422).json({ error: 'Limite de 2000 produtos por importacao.' });
    }

    const produtos = records.map(mapCsvRecord);
    const { importados, erros } = await upsertSupplierProducts(
      produtos,
      fornecedorId,
      fornecedorNome
    );

    res.status(201).json({
      fornecedor_id: fornecedorId,
      recebidos: records.length,
      importados,
      ignorados: records.length - importados,
      colunas: Object.keys(records[0] || {}),
      erros,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
