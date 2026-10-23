import express from 'express';
import { query } from './db.js';

const router = express.Router();

router.get('/health', async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({ status: 'ok', db: 'postgres' });
  } catch (e) {
    res.json({ status: 'ok', db: 'memory', note: 'PostgreSQL nao disponível, usando memória' });
  }
});

export default router;
