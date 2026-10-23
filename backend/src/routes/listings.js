import express from 'express';
import fetch from 'node-fetch';
import { query, memPush } from '../lib/db.js';

const router = express.Router();

const NICHOS = [
  { id: 'eletronicos', nome: 'Eletrônicos', media_ticket: 450 },
  { id: 'celulares', nome: 'Celulares e Acessórios', media_ticket: 320 },
  { id: 'informatica', nome: 'Informática', media_ticket: 680 },
  { id: 'games', nome: 'Games e Consoles', media_ticket: 590 },
  { id: 'casa', nome: 'Casa e Decoração', media_ticket: 280 },
  { id: 'moda', nome: 'Moda e Acessórios', media_ticket: 210 },
  { id: 'beleza', nome: 'Beleza e Perfumaria', media_ticket: 180 },
  { id: 'esportes', nome: 'Esportes e Lazer', media_ticket: 340 },
  { id: 'automotivo', nome: 'Automotivo', media_ticket: 420 },
  { id: 'bebe', nome: 'Bebê e Infantil', media_ticket: 260 },
  { id: 'pet', nome: 'Pet Shop', media_ticket: 190 },
  { id: 'ferramentas', nome: 'Ferramentas e Construção', media_ticket: 310 },
  { id: 'eletrodomesticos', nome: 'Eletrodomésticos', media_ticket: 750 },
  { id: 'relogios', nome: 'Relógios e Joias', media_ticket: 520 },
  { id: 'livros', nome: 'Livros e Papelaria', media_ticket: 90 },
  { id: 'musica', nome: 'Instrumentos Musicais', media_ticket: 400 },
  { id: 'brinquedos', nome: 'Brinquedos e Hobbies', media_ticket: 200 },
  { id: 'saude', nome: 'Saúde e Cuidado Pessoal', media_ticket: 230 },
  { id: 'alimentos', nome: 'Alimentos e Bebidas', media_ticket: 150 },
  { id: 'cama', nome: 'Cama, Mesa e Banho', media_ticket: 240 },
];

const FORNECEDORES = [
  { id: 'magalu', nome: 'Magazine Luiza', avaliacao: 4.6, entregas_no_prazo: 92, reputacao: 'A' },
  { id: 'americanas', nome: 'Americanas', avaliacao: 4.4, entregas_no_prazo: 89, reputacao: 'A' },
  { id: 'extra', nome: 'Extra', avaliacao: 4.3, entregas_no_prazo: 88, reputacao: 'B' },
  { id: 'pontofrio', nome: 'Pontofrio', avaliacao: 4.2, entregas_no_prazo: 87, reputacao: 'B' },
  { id: 'submarino', nome: 'Submarino', avaliacao: 4.4, entregas_no_prazo: 90, reputacao: 'A' },
  { id: 'shoptime', nome: 'Shoptime', avaliacao: 4.3, entregas_no_prazo: 89, reputacao: 'A' },
  { id: 'fastshop', nome: 'Fast Shop', avaliacao: 4.5, entregas_no_prazo: 91, reputacao: 'A' },
  { id: 'kabum', nome: 'Kabum', avaliacao: 4.6, entregas_no_prazo: 93, reputacao: 'A' },
  { id: 'pichau', nome: 'Pichau', avaliacao: 4.5, entregas_no_prazo: 92, reputacao: 'A' },
  { id: 'terabyteshop', nome: 'Terabyte Shop', avaliacao: 4.6, entregas_no_prazo: 93, reputacao: 'A' },
];

router.get('/nichos', (_req, res) => res.json(NICHOS));

router.get('/fornecedores', (_req, res) => res.json(FORNECEDORES));

router.get('/produtos-reais', async (_req, res) => {
  const { nicho, limite = 20, minPreco = 80 } = _req.query;
  try {
    const url = nicho
      ? `https://api.mercadolibre.com/sites/MLB/search?category=${nicho}&limit=${limite}&sort=relevance`
      : `https://api.mercadolibre.com/sites/MLB/search?limit=${limite}&sort=relevance`;
    const resp = await fetch(url);
    const data = await resp.json();
    const produtos = (data.results || [])
      .filter(p => p.price >= minPreco)
      .map(p => ({
        id: p.id,
        title: p.title,
        price: p.price,
        currency_id: p.currency_id,
        thumbnail: p.thumbnail,
        permalink: p.permalink,
        condition: p.condition,
        shipping: p.shipping,
        seller: p.seller,
      }));
    res.json({ total: produtos.length, produtos });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function scoreQualificacao(anuncio) {
  let score = 0;
  if (anuncio.title && anuncio.title.length > 20) score += 20;
  if (anuncio.pictures && anuncio.pictures.length >= 3) score += 20;
  if (anuncio.description && anuncio.description.plain_text && anuncio.description.plain_text.length > 100) score += 20;
  if (anuncio.price >= 80) score += 15;
  if (anuncio.shipping && anuncio.shipping.free_shipping) score += 10;
  if (anuncio.attributes && anuncio.attributes.length > 5) score += 10;
  if (anuncio.accepts_mercadopago) score += 5;
  return Math.min(score, 100);
}

router.post('/', async (req, res) => {
  const rows = (await query('SELECT access_token FROM ml_accounts ORDER BY updated_at DESC LIMIT 1')).rows;
  const t = rows[0];
  if (!t) return res.status(401).json({ error: 'Conta ML nao conectada' });

  const { produto, fornecedor, margem = 0.18 } = req.body;
  const precoVenda = Math.round(produto.price / (1 - margem));
  if (precoVenda < 80) return res.status(400).json({ error: 'Preco minimo de 80 reais necessario' });

  const anuncio = {
    title: `${produto.title} - Envio Rapido | ${fornecedor.nome}`,
    category_id: produto.category_id || 'MLB1055',
    price: precoVenda,
    currency_id: 'BRL',
    available_quantity: 999,
    buying_mode: 'buy_it_now',
    condition: produto.condition || 'new',
    listing_type_id: 'gold_special',
    description: { plain_text: produto.description || `Produto original ${produto.title}. Envio rápido e seguro. Qualidade garantida.` },
    pictures: (produto.pictures || []).slice(0, 6).map(p => ({ url: p.secure_url || p.url })),
    video_id: null,
    accepts_mercadopago: true,
    non_mercado_pago_payment_methods: [],
    shipping: { mode: 'me2', local_pick_up: false, free_shipping: precoVenda >= 200 },
    local_pick_up: false,
    attributes: [
      { id: 'BRAND', value_name: fornecedor.nome },
      { id: 'ITEM_CONDITION', value_name: 'Novo' },
      { id: 'WARRANTY_TYPE', value_name: 'Garantia de fábrica' },
      { id: 'WARRANTY_TIME', value_name: '90 dias' },
    ],
  };

  const score = scoreQualificacao(anuncio);
  if (score < 85) {
    return res.status(400).json({ error: `Qualificacao do anuncio abaixo de 85% (${score}%).` });
  }

  try {
    const resp = await fetch('https://api.mercadolibre.com/items', {
      method: 'POST',
      headers: { Authorization: `Bearer ${t.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(anuncio),
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ error: data });

    const listing = {
      id: Date.now(),
      ml_item_id: data.id,
      title: anuncio.title,
      price: precoVenda,
      supplier: fornecedor.nome,
      status: 'active',
      score,
      created_at: new Date().toISOString(),
    };
    memPush('listings', listing);
    await query(
      `INSERT INTO listings (ml_item_id, title, price, supplier, status, score, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW()) RETURNING *`,
      [data.id, anuncio.title, precoVenda, fornecedor.nome, 'active', score]
    ).catch(() => {});

    res.json({ ...data, score, preco_venda: precoVenda, margem_aplicada: margem });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/', async (_req, res) => {
  const rows = (await query('SELECT * FROM listings ORDER BY created_at DESC LIMIT 50')).rows;
  res.json(rows.length ? rows : mem('listings'));
});

export default router;
