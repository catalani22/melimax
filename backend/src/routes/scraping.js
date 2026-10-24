import express from 'express';
import fetch from 'node-fetch';

const router = express.Router();

const PRIVATE_HOSTS = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0|::1|\[::1\])/i;

function validateUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('URL invalida.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Apenas URLs http/https sao permitidas.');
  }
  if (PRIVATE_HOSTS.test(url.hostname) || url.hostname.endsWith('.local')) {
    throw new Error('Host nao permitido.');
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname)) {
    throw new Error('Host nao permitido.');
  }
  return url;
}

router.post('/fornecedor', async (req, res, next) => {
  try {
    const url = validateUrl(req.body.url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);

    const response = await fetch(url.toString(), {
      signal: controller.signal,
      redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; melimax/2.0)' },
    }).finally(() => clearTimeout(timer));

    if (response.status >= 300 && response.status < 400) {
      return res.status(400).json({ erro: 'Redirecionamento nao permitido.' });
    }
    if (!response.ok) {
      return res.status(response.status).json({ erro: `Fornecedor respondeu ${response.status}.` });
    }

    const html = await response.text();
    const titulo = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const preco = html.match(/R\$\s*[\d.,]+/);
    const imagens = Array.from(html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi))
      .map((match) => match[1])
      .filter(Boolean)
      .slice(0, 10);

    res.json({
      sucesso: true,
      produto: {
        titulo: titulo ? titulo[1].trim() : '',
        preco: preco ? preco[0] : '',
        descricao: '',
        imagens,
        url: url.toString(),
        raspado_em: new Date().toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
