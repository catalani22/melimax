import express from 'express';
import { getAccount, getUserId, mlFetch } from '../lib/ml.js';

const router = express.Router();

function formatOrder(order) {
  return {
    id: String(order.id),
    date_created: order.date_created,
    date_closed: order.date_closed,
    status: order.status,
    status_detail: order.status_detail,
    total_amount: order.total_amount,
    paid_amount: order.paid_amount,
    currency_id: order.currency_id,
    buyer: order.buyer
      ? { id: String(order.buyer.id), nickname: order.buyer.nickname || null }
      : null,
    items: (order.order_items || []).map((entry) => ({
      item_id: entry.item?.id || null,
      title: entry.item?.title || null,
      variation_id: entry.item?.variation_id || null,
      quantity: entry.quantity,
      unit_price: entry.unit_price,
      sale_fee: entry.sale_fee,
      currency_id: entry.currency_id,
      thumbnail: entry.item?.thumbnail || null,
    })),
    shipping: order.shipping
      ? { id: String(order.shipping.id), mode: order.shipping.mode || null }
      : null,
    payments: (order.payments || []).map((payment) => ({
      id: String(payment.id),
      status: payment.status,
      status_detail: payment.status_detail,
      total_paid_amount: payment.total_paid_amount,
      payment_method_id: payment.payment_method_id,
    })),
    tags: order.tags || [],
  };
}

async function currentUserId() {
  const account = await getAccount();
  if (!account) {
    const err = new Error('Conta Mercado Livre nao conectada.');
    err.status = 401;
    err.code = 'ML_NOT_CONNECTED';
    throw err;
  }
  return getUserId(account);
}

router.get('/', async (req, res, next) => {
  try {
    const userId = await currentUserId();
    const limit = Math.min(Math.max(Number(req.query.limite) || 50, 1), 50);
    const params = new URLSearchParams({
      seller: String(userId),
      sort: 'date_desc',
      limit: String(limit),
    });
    if (req.query.status) params.set('order.status', String(req.query.status));

    const data = await mlFetch(`/orders/search?${params.toString()}`);
    res.json({
      total: data?.paging?.total ?? (data?.results || []).length,
      orders: (data?.results || []).map(formatOrder),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:orderId', async (req, res, next) => {
  try {
    const data = await mlFetch(`/orders/${encodeURIComponent(req.params.orderId)}`);
    res.json(formatOrder(data));
  } catch (err) {
    next(err);
  }
});

export default router;
