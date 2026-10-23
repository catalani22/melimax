import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

dotenv.config();

import authRoutes from './auth.js';
import productsRoutes from './products.js';
import suppliersRoutes from './suppliers.js';
import listingsRoutes from './listings.js';
import ordersRoutes from './orders.js';
import labelsRoutes from './labels.js';
import scrapingRoutes from './scraping.js';
import healthRoutes from './health.js';
import { errorHandler } from './error.js';

const app = express();

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

export default (req, res) => app(req, res);
