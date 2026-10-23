import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

dotenv.config();

import authRoutes from './routes/auth.js';
import productsRoutes from './routes/products.js';
import suppliersRoutes from './routes/suppliers.js';
import listingsRoutes from './routes/listings.js';
import ordersRoutes from './routes/orders.js';
import labelsRoutes from './routes/labels.js';
import scrapingRoutes from './routes/scraping.js';
import healthRoutes from './routes/health.js';
import { errorHandler } from './middleware/error.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });
app.use('/api', limiter);

app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'ml-dropshipping' }));
app.use('/api', healthRoutes);

app.use('/api/auth', authRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/suppliers', suppliersRoutes);
app.use('/api/listings', listingsRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/labels', labelsRoutes);
app.use('/api/scraping', scrapingRoutes);

app.use(errorHandler);

app.listen(PORT, () => console.log(`Backend rodando na porta ${PORT}`));
