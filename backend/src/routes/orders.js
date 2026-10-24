import express from 'express';
import { query } from '../lib/db.js';
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

async function attachSuppliers(orders) {
  const itemIds = [
    ...new Set(
      orders
        .flatMap((order) => order.items || [])
        .map((item) => item.item_id)
        .filter(Boolean)
    ),
  ];
  if (!itemIds.length) return orders;

  try {
    const { rows } = await query(
      `SELECT ml_item_id, supplier, supplier_id
       FROM listings
       WHERE ml_item_id = ANY($1)`,
      [itemIds]
    );
    const byItem = new Map(rows.map((row) => [row.ml_item_id, row]));

    return orders.map((order) => {
      const items = (order.items || []).map((item) => {
        const listing = byItem.get(item.item_id);
        return {
          ...item,
          supplier: listing
            ? {
                id: listing.supplier_id || null,
                nome: listing.supplier || listing.supplier_id || null,
              }
            : null,
        };
      });
      const suppliers = new Set(
        items
          .map((item) => item.supplier?.id || item.supplier?.nome)
          .filter(Boolean)
      );
      return {
        ...order,
        items,
        supplier_count: suppliers.size,
        multi_supplier: suppliers.size > 1,
      };
    });
  } catch {
    return orders;
  }
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
    const orders = await attachSuppliers(
      (data?.results || []).map(formatOrder)
    );
    res.json({
      total: data?.paging?.total ?? orders.length,
      orders,
    });
  } catch (err) {
    next(err);
  }
});

const monthlyCache = new Map();
const MONTHLY_CACHE_TTL = 5 * 60 * 1000;

router.get('/resumo-mensal', async (req, res, next) => {
  try {
    const userId = await currentUserId();
    const now = new Date();
    const year = Number(req.query.ano) || now.getFullYear();
    const month = Number(req.query.mes)
      ? Math.min(Math.max(Number(req.query.mes) - 1, 0), 11)
      : now.getMonth();
    const cacheKey = `${userId}:${year}:${month}`;
    const cached = monthlyCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < MONTHLY_CACHE_TTL) {
      return res.json(cached.value);
    }

    const from = new Date(year, month, 1, 0, 0, 0, 0);
    const to = new Date(year, month + 1, 0, 23, 59, 59, 999);
    const limit = Math.min(Math.max(Number(req.query.limite) || 200, 1), 400);
    const collected = [];
    let offset = 0;
    let total = null;

    while (collected.length < limit) {
      const params = new URLSearchParams({
        seller: String(userId),
        'order.date_created.from': from.toISOString(),
        'order.date_created.to': to.toISOString(),
        sort: 'date_desc',
        limit: String(Math.min(50, limit - collected.length)),
        offset: String(offset),
      });
      const data = await mlFetch(`/orders/search?${params.toString()}`);
      const results = data?.results || [];
      total = data?.paging?.total ?? total;
      collected.push(...results);
      if (!results.length || collected.length >= (total || 0)) break;
      offset += results.length;
    }

    const validOrders = collected.filter(
      (order) =>
        !['cancelled', 'invalid', 'pending_cancel'].includes(order.status)
    );
    const faturamento = validOrders.reduce(
      (sum, order) => sum + (Number(order.total_amount) || 0),
      0
    );
    const value = {
      ano: year,
      mes: month + 1,
      from: from.toISOString(),
      to: to.toISOString(),
      total: total ?? collected.length,
      carregados: collected.length,
      pedidos: validOrders.length,
      faturamento,
      ticket_medio: validOrders.length ? faturamento / validOrders.length : 0,
    };
    monthlyCache.set(cacheKey, { value, createdAt: Date.now() });
    if (monthlyCache.size > 50) {
      const oldest = [...monthlyCache.entries()].sort(
        (a, b) => a[1].createdAt - b[1].createdAt
      )[0];
      if (oldest) monthlyCache.delete(oldest[0]);
    }
    res.json(value);
  } catch (err) {
    next(err);
  }
});

router.get('/:orderId', async (req, res, next) => {
  try {
    const data = await mlFetch(`/orders/${encodeURIComponent(req.params.orderId)}`);
    const [order] = await attachSuppliers([formatOrder(data)]);
    res.json(order);
  } catch (err) {
    next(err);
  }
});

export default router;
