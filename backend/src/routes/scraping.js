import express from 'express';
import fetch from 'node-fetch';

const router = express.Router();

router.post('/fornecedor', async (req, res) => {
  const { url } = req.body;
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ml-dropshipping/1.0)' },
    });
    const html = await resp.text();

    const tituloMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const precoMatch = html.match(/R\$\s*[\d.,]+/);
    const imagemMatch = html.match(/<img[^>]+src=["']([^"']+)["']/gi);
    const imagens = (imagemMatch || [])
      .map(m => { const s = m.match(/src=["']([^"']+)["']/); return s ? s[1] : null; })
      .filter(Boolean).slice(0, 10);

    const produto = {
      titulo: tituloMatch ? tituloMatch[1].trim() : '',
      preco: precoMatch ? precoMatch[0] : '',
      descricao: '',
      imagens,
      url,
      raspado_em: new Date().toISOString(),
      nota: 'Scraping real da pagina do fornecedor (sem cheerio, regex leve)',
    };

    res.json({ sucesso: true, produto });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

export default router;
