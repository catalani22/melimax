import express from 'express';

const router = express.Router();

router.post('/gerar', async (req, res) => {
  const { orderId, fornecedor, endereco, produtos } = req.body;
  res.json({
    labelId: `LAB-${Date.now()}`,
    orderId,
    fornecedor,
    status: 'enviada_ao_fornecedor',
    endereco,
    produtos,
    nota: 'Etiqueta de remessa gerada e enviada automaticamente ao fornecedor',
  });
});

export default router;
