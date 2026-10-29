import fs from 'node:fs';
import path from 'node:path';
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

if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

app.use(errorHandler);

export default app;
