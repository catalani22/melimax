import express from 'express';
import { dbStatus } from '../lib/db.js';
import { mlConfigured } from '../lib/ml.js';
import { FRONTEND_URL, REDIRECT_URI } from '../lib/config.js';

const router = express.Router();

router.get('/health', async (req, res) => {
  let db;
  try {
    db = await dbStatus();
  } catch (err) {
    db = { driver: 'postgres', ok: false, error: err.message };
  }

  const strict = req.query.strict === '1' || req.query.strict === 'true';
  const httpCode = db.ok || !strict ? 200 : 503;

  res.status(httpCode).json({
    status: db.ok ? 'ok' : 'degraded',
    service: 'melimax-backend',
    db,
    ml_configured: mlConfigured(),
    redirect_uri: REDIRECT_URI,
    frontend_url: FRONTEND_URL,
    timestamp: new Date().toISOString(),
  });
});

export default router;
