import express from 'express';
import { mlFetch, mlFetchRaw } from '../lib/ml.js';

const router = express.Router();

async function shipmentFromOrder(orderId) {
  const order = await mlFetch(`/orders/${encodeURIComponent(orderId)}`);
  const shipmentId = order?.shipping?.id;
  if (!shipmentId) {
    const err = new Error('Este pedido nao possui envio Mercado Envios.');
    err.status = 404;
    throw err;
  }
  return { order, shipmentId: String(shipmentId) };
}

router.get('/order/:orderId/info', async (req, res, next) => {
  try {
    const { order, shipmentId } = await shipmentFromOrder(req.params.orderId);
    const shipment = await mlFetch(`/shipments/${shipmentId}`);
    res.json({
      order_id: String(order.id),
      shipment_id: shipmentId,
      status: shipment.status,
      substatus: shipment.substatus,
      tracking_number: shipment.tracking_number || null,
      tracking_method: shipment.tracking_method || null,
      receiver_address: shipment.receiver_address || null,
      shipping_items: shipment.shipping_items || null,
      label_available: shipment.status === 'ready_to_ship' || shipment.status === 'handling',
    });
  } catch (err) {
    next(err);
  }
});

router.get('/order/:orderId', async (req, res, next) => {
  try {
    const { order, shipmentId } = await shipmentFromOrder(req.params.orderId);
    const label = await mlFetchRaw(
      `/shipment_labels?shipment_ids=${encodeURIComponent(shipmentId)}&response_type=pdf`
    );

    res.set('Content-Type', label.contentType || 'application/pdf');
    res.set(
      'Content-Disposition',
      label.disposition || `attachment; filename="etiqueta-${order.id}.pdf"`
    );
    res.set('Cache-Control', 'no-store');
    res.send(label.buffer);
  } catch (err) {
    next(err);
  }
});

router.get('/shipment/:shipmentId', async (req, res, next) => {
  try {
    const shipment = await mlFetch(
      `/shipments/${encodeURIComponent(req.params.shipmentId)}`
    );
    res.json(shipment);
  } catch (err) {
    next(err);
  }
});

router.post('/gerar', (req, res) => {
  res.status(410).json({
    error:
      'Etiquetas sao geradas pelo Mercado Livre. Use GET /api/labels/order/:orderId para baixar o PDF.',
  });
});

export default router;
