import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import { ensureSchema } from './lib/db.js';
import { CORS_ORIGINS } from './lib/config.js';
import authRoutes from './routes/auth.js';
import productsRoutes from './routes/products.js';
import suppliersRoutes from './routes/suppliers.js';
import listingsRoutes from './routes/listings.js';
import ordersRoutes from './routes/orders.js';
import labelsRoutes from './routes/labels.js';
import scrapingRoutes from './routes/scraping.js';
import healthRoutes from './routes/health.js';
import { dashboardAuth } from './middleware/dashboard-auth.js';
import { errorHandler } from './middleware/error.js';

const app = express();

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

const allowedOrigins = new Set(CORS_ORIGINS);
const vercelPreview = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.vercel\.app$/i;

app.use(
  cors({
    credentials: true,
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin) || vercelPreview.test(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
  })
);

app.use(express.json({ limit: '4mb' }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
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
app.use('/api', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/suppliers', suppliersRoutes);
app.use('/api/listings', listingsRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/labels', labelsRoutes);
app.use('/api/scraping', scrapingRoutes);

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Endpoint nao encontrado.', path: req.originalUrl });
});

app.use(errorHandler);

export default app;
