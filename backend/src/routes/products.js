import express from 'express';
import { mlFetch } from '../lib/ml.js';

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const data = await mlFetch('/users/me');
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/categories', async (req, res, next) => {
  try {
    const data = await mlFetch('/sites/MLB/categories');
    res.json((data || []).slice(0, 50));
  } catch (err) {
    next(err);
  }
});

router.get('/items/:id', async (req, res, next) => {
  try {
    const data = await mlFetch(`/items/${encodeURIComponent(req.params.id)}`);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/items/:id/description', async (req, res, next) => {
  try {
    const data = await mlFetch(
      `/items/${encodeURIComponent(req.params.id)}/description`
    );
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/categories/:id/attributes', async (req, res, next) => {
  try {
    const data = await mlFetch(
      `/categories/${encodeURIComponent(req.params.id)}/attributes`
    );
    res.json(data);
  } catch (err) {
    next(err);
  }
});

export default router;
