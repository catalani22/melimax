import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import { ensureSchema } from './lib/db.js';
import { CORS_ORIGINS } from './lib/config.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import productsRoutes from './routes/products.js';
import suppliersRoutes from './routes/suppliers.js';
import listingsRoutes from './routes/listings.js';
import trendsRoutes from './routes/trends.js';
import ordersRoutes from './routes/orders.js';
import scrapingRoutes from './routes/scraping.js';
import aliexpressRoutes, {
  ensureAliExpressCatalog,
  getAliExpressCatalog,
  refreshAliExpressCatalog,
} from './routes/aliexpress.js';
import {
  buildCompleteCsv,
  buildMercadoLivreBulkCsv,
} from './lib/aliexpress-scraper.js';
import healthRoutes from './routes/health.js';
import { dashboardAuth } from './middleware/dashboard-auth.js';
import { errorHandler } from './middleware/error.js';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDist = path.resolve(__dirname, '../../frontend/dist');

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: false,
    crossOriginOpenerPolicy: false,
    frameguard: false,
  })
);

const allowedOrigins = new Set(CORS_ORIGINS);
const vercelPreview = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.vercel\.app$/i;
const runAppPreview = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.run\.app$/i;

app.use(
  cors({
    credentials: true,
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (
        allowedOrigins.has(origin) ||
        vercelPreview.test(origin) ||
        runAppPreview.test(origin)
      ) {
        return callback(null, true);
      }
      return callback(null, false);
    },
  })
);

app.use(express.json({ limit: '4mb' }));

// Built-in gzip compression for large JSON payloads (keeps 1,050-item catalog fast & well under serverless limits)
app.use('/api', (req, res, next) => {
  const acceptEncoding = String(req.headers['accept-encoding'] || '');
  if (!/\bgzip\b/i.test(acceptEncoding)) return next();
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    try {
      const jsonStr = JSON.stringify(body);
      if (jsonStr && jsonStr.length > 2048 && !res.headersSent) {
        const compressed = zlib.gzipSync(Buffer.from(jsonStr, 'utf8'));
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Vary', 'Accept-Encoding');
        res.setHeader('Content-Length', String(compressed.length));
        return res.end(compressed);
      }
    } catch {
      // Fall back to standard res.json
    }
    return originalJson(body);
  };
  next();
});

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 800,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisicoes. Tente novamente em alguns minutos.' },
});
app.use('/api', limiter);

app.use('/api', async (req, res, next) => {
  if (req.path === '/health') return next();
  try {
    await ensureSchema();
    next();
  } catch (err) {
    next(err);
  }
});

app.use('/api', dashboardAuth);
app.use('/api', async (req, res, next) => {
  if (!/^\/(aliexpress|orders)(\/|$)/.test(req.path)) return next();
  try {
    await refreshAliExpressCatalog();
    next();
  } catch (err) {
    next(err);
  }
});
app.use('/api', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/aliexpress', aliexpressRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/suppliers', suppliersRoutes);
app.use('/api/listings', listingsRoutes);
app.use('/api/trends', trendsRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/scraping', scrapingRoutes);

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Endpoint nao encontrado.', path: req.originalUrl });
});

// Direct CSV downloads generated from the current catalog (works on Vercel)
app.get('/mercadolivre_aliexpress_completo.csv', async (req, res, next) => {
  try {
    await ensureAliExpressCatalog();
    const csv = buildCompleteCsv(getAliExpressCatalog());
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="mercadolivre_aliexpress_completo.csv"'
    );
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

app.get('/mercadolivre_planilha_publicacao.csv', async (req, res, next) => {
  try {
    await ensureAliExpressCatalog();
    const csv = buildMercadoLivreBulkCsv(getAliExpressCatalog());
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="mercadolivre_planilha_publicacao.csv"'
    );
    res.send(csv);
  } catch (err) {
    next(err);
  }
});

app.use(express.static(frontendDist));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  const indexHtml = path.join(frontendDist, 'index.html');
  if (fs.existsSync(indexHtml)) {
    return res.sendFile(indexHtml);
  }
  if (process.env.VERCEL) return next();
  res
    .status(200)
    .setHeader('Content-Type', 'text/html; charset=utf-8')
    .send(
      '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta http-equiv="refresh" content="2"><title>MeLi Max Shop</title></head><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#F4F5F7;color:#1e293b">Preparando painel MeLi Max Shop...</body></html>'
    );
});

app.use(errorHandler);

export default app;
