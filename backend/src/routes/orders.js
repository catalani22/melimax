import express from 'express';
import { query } from '../lib/db.js';
import { getAccount, getUserId, mlFetch } from '../lib/ml.js';
import { findAliExpressByIdentifier } from './aliexpress.js';

const router = express.Router();

function formatAddressObject(addr) {
  if (!addr) return null;
  const street = [addr.street_name, addr.street_number].filter(Boolean).join(', ');
  const complement = addr.comment || addr.apartment || '';
  const neighborhood = addr.neighborhood?.name || addr.neighborhood || '';
  const city = addr.city?.name || addr.city || '';
  const state = addr.state?.id?.replace(/^BR-/, '') || addr.state?.name || '';
  const zip = addr.zip_code || '';
  const receiverName = addr.receiver_name || '';
  const receiverPhone = addr.receiver_phone || '';

  const formattedLines = [
    receiverName ? `Destinatário: ${receiverName}` : null,
    receiverPhone ? `Telefone: ${receiverPhone}` : null,
    street ? `Endereço: ${street}${complement ? ` - ${complement}` : ''}` : null,
    neighborhood ? `Bairro: ${neighborhood}` : null,
    city || state ? `Cidade/UF: ${[city, state].filter(Boolean).join(' - ')}` : null,
    zip ? `CEP: ${zip}` : null,
    'País: Brasil',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    receiver_name: receiverName,
    receiver_phone: receiverPhone,
    street_name: addr.street_name || '',
    street_number: addr.street_number || '',
    complement,
    neighborhood,
    city,
    state,
    zip_code: zip,
    formatted: formattedLines,
  };
}

function formatOrder(order) {
  return {
    id: String(order.id),
    pack_id: order.pack_id ? String(order.pack_id) : null,
    date_created: order.date_created,
    date_closed: order.date_closed,
    status: order.status,
    status_detail: order.status_detail,
    total_amount: order.total_amount,
    paid_amount: order.paid_amount,
    currency_id: order.currency_id || 'BRL',
    buyer: order.buyer
      ? {
          id: String(order.buyer.id),
          nickname: order.buyer.nickname || null,
          full_name: [order.buyer.first_name, order.buyer.last_name].filter(Boolean).join(' ') || null,
          doc_number: order.buyer.billing_info?.doc_number || null,
        }
      : null,
    items: (order.order_items || []).map((entry) => {
      const sellerSku =
        entry.item?.seller_sku || entry.item?.seller_custom_field || '';
      const matchedAli = findAliExpressByIdentifier(sellerSku);
      return {
        item_id: entry.item?.id || null,
        seller_sku: sellerSku || matchedAli?.sku || null,
        title: entry.item?.title || null,
        variation_id: entry.item?.variation_id || null,
        quantity: entry.quantity,
        unit_price: entry.unit_price,
        sale_fee: entry.sale_fee,
        currency_id: entry.currency_id || 'BRL',
        thumbnail: entry.item?.thumbnail || matchedAli?.imagem_1 || null,
        aliexpress: matchedAli
          ? {
              sku: matchedAli.sku,
              codigo_interno: matchedAli.codigo_interno,
              aliexpress_item_id: matchedAli.aliexpress_item_id,
              url_aliexpress: matchedAli.url_aliexpress,
              custo_brl: matchedAli.preco_custo_aliexpress_brl,
              fornecedor_nome: matchedAli.fornecedor_nome,
              imagem: matchedAli.imagem_1,
            }
          : null,
      };
    }),
    shipping: order.shipping
      ? {
          id: order.shipping.id ? String(order.shipping.id) : null,
          mode: order.shipping.mode || 'not_specified',
          receiver_address: formatAddressObject(order.shipping.receiver_address),
        }
      : { id: null, mode: 'not_specified', receiver_address: null },
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

async function attachExecutions(orders) {
  if (!orders.length) return orders;
  try {
    const { rows } = await query('SELECT * FROM order_executions ORDER BY updated_at DESC');
    const byOrder = new Map(rows.map((r) => [String(r.order_id), r]));
    return orders.map((order) => ({
      ...order,
      execution: byOrder.get(String(order.id)) || null,
    }));
  } catch {
    return orders;
  }
}

async function notifyMlAndBuyerWithTracking({ orderId, trackingNumber, carrier }) {
  const details = {
    shipment_updated: false,
    buyer_messaged: false,
    shipping_mode: null,
    notes: [],
  };

  const orderData = await mlFetch(`/orders/${encodeURIComponent(orderId)}`);
  const shipmentId = orderData?.shipping?.id ? String(orderData.shipping.id) : null;
  const packId = orderData?.pack_id ? String(orderData.pack_id) : String(orderId);
  const sellerId = orderData?.seller?.id ? String(orderData.seller.id) : null;
  const buyerId = orderData?.buyer?.id || null;
  const buyerEmail = orderData?.buyer?.email || null;

  // 1. Update shipment status & tracking_number on Mercado Livre (for custom / me1 seller-fulfilled shipments — zero label)
  if (shipmentId) {
    let shipInfo = null;
    try {
      shipInfo = await mlFetch(`/shipments/${encodeURIComponent(shipmentId)}`);
      details.shipping_mode = shipInfo?.mode || null;
    } catch {}

    // Channel 1A: Custom shipping PUT /shipments/{id}
    try {
      await mlFetch(`/shipments/${encodeURIComponent(shipmentId)}`, {
        method: 'PUT',
        body: {
          speed: 120,
          status: 'shipped',
          tracking_number: trackingNumber,
          comments: `Envio nacional (${carrier}) — Rastreio: ${trackingNumber}`,
          ...(buyerId ? { receiver_id: buyerId } : {}),
        },
      });
      details.shipment_updated = true;
      details.notes.push(`Envio #${shipmentId} marcado como enviado no ML com rastreio ${trackingNumber}.`);
    } catch (errPut) {
      // Channel 1B: ME1 custom tracking endpoint fallback
      try {
        await mlFetch(`/marketplace/shipments/${encodeURIComponent(shipmentId)}/tracking`, {
          method: 'POST',
          body: {
            tracking_id: trackingNumber,
            carrier,
          },
        });
        await mlFetch(`/marketplace/shipments/${encodeURIComponent(shipmentId)}/tracking/status`, {
          method: 'POST',
          body: {
            tracking_id: trackingNumber,
            status: 'shipped',
          },
        }).catch(() => null);
        details.shipment_updated = true;
        details.notes.push(`Rastreio ME1 registrado no envio #${shipmentId}.`);
      } catch {
        details.notes.push(`Aviso shipment (${shipInfo?.mode || 'not_specified'}): ${errPut.message}`);
      }
    }
  } else {
    details.shipping_mode = 'not_specified';
    details.notes.push('Venda em modo Entrega por Conta do Vendedor (sem shipment_id de etiqueta).');
  }

  // 2. Send tracking code & carrier directly to Buyer via official Mercado Livre Post-Sale Chat
  // (No external URLs included so ML moderation never blocks delivery of the message)
  if (sellerId && buyerId) {
    const cleanText = [
      'Olá! Seu pedido já foi despachado do nosso estoque no Brasil com Frete Grátis.',
      `Transportadora: ${carrier}`,
      `Código de rastreamento: ${trackingNumber}`,
      'Prazo estimado de entrega: 5 a 10 dias corridos.',
      'Qualquer dúvida estamos à disposição aqui pelo chat da compra!',
    ]
      .join('\n')
      .slice(0, 350);

    try {
      await mlFetch(
        `/messages/packs/${encodeURIComponent(packId)}/sellers/${encodeURIComponent(sellerId)}?tag=post_sale`,
        {
          method: 'POST',
          body: {
            from: { user_id: Number(sellerId) },
            to: {
              user_id: Number(buyerId),
              ...(buyerEmail ? { email: buyerEmail } : {}),
            },
            text: cleanText,
          },
        }
      );
      details.buyer_messaged = true;
      details.notes.push('Código de rastreio enviado no chat pós-venda do comprador.');
    } catch (errMsg1) {
      // Fallback: Action Guide structured post-sale message
      try {
        await mlFetch(
          `/messages/action_guide/packs/${encodeURIComponent(packId)}/option?tag=post_sale`,
          {
            method: 'POST',
            body: {
              option_id: 'OTHER',
              text: cleanText,
            },
          }
        );
        details.buyer_messaged = true;
        details.notes.push('Código de rastreio enviado ao comprador via guia pós-venda ML.');
      } catch (errMsg2) {
        details.notes.push(`Aviso chat pós-venda: ${errMsg2.message || errMsg1.message}`);
      }
    }
  }

  return details;
}

router.get('/execucoes', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM order_executions ORDER BY updated_at DESC');
    res.json({ total: rows.length, execucoes: rows });
  } catch (err) {
    next(err);
  }
});

router.post('/:orderId/rastreio', async (req, res, next) => {
  try {
    const orderId = String(req.params.orderId || '').trim();
    if (!orderId) {
      return res.status(400).json({ error: 'Informe o número da venda do Mercado Livre.' });
    }

    const sku = String(req.body?.sku || '').trim();
    const matchedAli = findAliExpressByIdentifier(sku);
    const aliexpressUrl =
      String(req.body?.aliexpress_url || '').trim() || matchedAli?.url_aliexpress || '';
    const aliexpressOrderId = String(req.body?.aliexpress_order_id || '').trim();
    const trackingNumber = String(req.body?.tracking_number || '').trim();
    const carrier = String(req.body?.carrier || 'J&T Express / Correios Brasil').trim();
    const buyerName = String(req.body?.buyer_name || '').trim();
    const shippingAddress = String(req.body?.shipping_address || '').trim();
    const notes = String(req.body?.notes || '').trim();

    let step = Number(req.body?.step) || 1;
    if (trackingNumber) step = 5;
    else if (aliexpressOrderId && step < 3) step = 3;

    const { rows } = await query(
      `INSERT INTO order_executions
        (order_id, sku, aliexpress_url, aliexpress_order_id, tracking_number, carrier, step, buyer_name, shipping_address, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (order_id) DO UPDATE SET
         sku = COALESCE(NULLIF(EXCLUDED.sku, ''), order_executions.sku),
         aliexpress_url = COALESCE(NULLIF(EXCLUDED.aliexpress_url, ''), order_executions.aliexpress_url),
         aliexpress_order_id = EXCLUDED.aliexpress_order_id,
         tracking_number = EXCLUDED.tracking_number,
         carrier = EXCLUDED.carrier,
         step = EXCLUDED.step,
         buyer_name = COALESCE(NULLIF(EXCLUDED.buyer_name, ''), order_executions.buyer_name),
         shipping_address = COALESCE(NULLIF(EXCLUDED.shipping_address, ''), order_executions.shipping_address),
         notes = EXCLUDED.notes,
         updated_at = NOW()
       RETURNING *`,
      [
        orderId,
        sku || matchedAli?.sku || '',
        aliexpressUrl,
        aliexpressOrderId,
        trackingNumber,
        carrier,
        step,
        buyerName,
        shippingAddress,
        notes,
      ]
    );

    let mlNotified = false;
    let mlShipmentUpdated = false;
    let mlBuyerMessaged = false;
    let mlMessage = null;

    if (trackingNumber && req.body?.enviar_ml !== false) {
      const account = await getAccount();
      if (account) {
        try {
          const dispatchRes = await notifyMlAndBuyerWithTracking({
            orderId,
            trackingNumber,
            carrier,
          });
          mlShipmentUpdated = dispatchRes.shipment_updated;
          mlBuyerMessaged = dispatchRes.buyer_messaged;
          mlNotified = mlShipmentUpdated || mlBuyerMessaged;
          mlMessage = dispatchRes.notes.join(' · ');
        } catch (err) {
          mlMessage = err.message;
        }
      }
    }

    res.json({
      ok: true,
      execucao: rows[0],
      ml_notified: mlNotified,
      ml_shipment_updated: mlShipmentUpdated,
      ml_buyer_messaged: mlBuyerMessaged,
      ml_message: mlMessage,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const account = await getAccount();
    if (!account) {
      const { rows } = await query('SELECT * FROM order_executions ORDER BY updated_at DESC');
      return res.json({
        connected: false,
        total: rows.length,
        orders: [],
        execucoes_manuais: rows,
      });
    }

    const userId = await getUserId(account);
    const limit = Math.min(Math.max(Number(req.query.limite) || 50, 1), 50);
    const params = new URLSearchParams({
      seller: String(userId),
      sort: 'date_desc',
      limit: String(limit),
    });
    if (req.query.status) params.set('order.status', String(req.query.status));

    const data = await mlFetch(`/orders/search?${params.toString()}`);
    const formattedList = (data?.results || []).map(formatOrder);

    // Hydrate receiver_address from /shipments/{id} for recent orders when not embedded in /orders/search
    await Promise.all(
      formattedList.slice(0, 15).map(async (ord) => {
        if (ord.shipping?.id && !ord.shipping.receiver_address) {
          try {
            const sh = await mlFetch(`/shipments/${encodeURIComponent(ord.shipping.id)}`);
            if (sh?.receiver_address) {
              ord.shipping.receiver_address = formatAddressObject(sh.receiver_address);
            }
            if (sh?.mode) ord.shipping.mode = sh.mode;
          } catch {}
        }
      })
    );

    const orders = await attachExecutions(formattedList);
    const { rows } = await query('SELECT * FROM order_executions ORDER BY updated_at DESC');

    res.json({
      connected: true,
      total: data?.paging?.total ?? orders.length,
      orders,
      execucoes_manuais: rows,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:orderId', async (req, res, next) => {
  try {
    const data = await mlFetch(`/orders/${encodeURIComponent(req.params.orderId)}`);
    const formatted = formatOrder(data);

    if (formatted.shipping?.id && !formatted.shipping.receiver_address) {
      try {
        const shipment = await mlFetch(`/shipments/${encodeURIComponent(formatted.shipping.id)}`);
        if (shipment?.receiver_address) {
          formatted.shipping.receiver_address = formatAddressObject(shipment.receiver_address);
        }
        if (shipment?.mode) formatted.shipping.mode = shipment.mode;
      } catch {}
    }

    const [order] = await attachExecutions([formatted]);
    res.json(order);
  } catch (err) {
    next(err);
  }
});

export default router;
