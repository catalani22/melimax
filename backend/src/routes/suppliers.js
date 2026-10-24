import express from 'express';
import { mlFetch } from '../lib/ml.js';

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
  return cached(key, 2 * 60 * 1000, async () => {
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

export default router;
