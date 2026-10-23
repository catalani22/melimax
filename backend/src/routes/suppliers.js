import express from 'express';

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

router.get('/nichos', (req, res) => res.json(NICHOS));

router.get('/fornecedores', (req, res) => res.json(FORNECEDORES));

router.get('/produtos-reais', async (req, res) => {
  const { nicho, limite = 20, minPreco = 80 } = req.query;
  try {
    const resp = await fetch(
      `https://api.mercadolibre.com/sites/MLB/search?category=${nicho}&limit=${limite}&sort=relevance`
    );
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

export default router;
