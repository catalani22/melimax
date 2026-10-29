import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scrapeAliExpressProduct,
  rewriteMercadoLivreTitle,
  computeMlQualityScore,
  hasFreeShippingBrazil,
  findDuplicateInCatalog,
  getApprovedStoreById,
  buildCompleteCsv,
  buildMercadoLivreBulkCsv,
} from '../backend/src/lib/aliexpress-scraper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const PRODUCTS_JSON_PATH = path.join(ROOT, 'dados/aliexpress_produtos.json');
const DROPFACIL_LINKS_PATH = path.join(ROOT, 'dados/lote2_dropfacil_links.json');
const DROPFACIL_STORE_PATH = path.join(ROOT, 'dados/dropfacil_store_catalog.json');
const AUDIT_REPORT_PATH = path.join(ROOT, 'dados/auditoria_lote2_dropfacil.json');

async function runWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function next() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => next()));
  return results;
}

async function main() {
  const rawExisting = JSON.parse(fs.readFileSync(PRODUCTS_JSON_PATH, 'utf8'));
  const cssvMeta = getApprovedStoreById('1105400522');
  const dropfacilMeta = getApprovedStoreById('1104933528');

  // Keep only Lote 1 items first so re-running this script is idempotent
  const lote1Items = rawExisting
    .filter((item) => {
      const num = parseInt(String(item.codigo_interno || '').replace(/\D/g, ''), 10);
      return Number.isFinite(num) && num <= 115;
    })
    .map((item) => {
      const polishedTitle = rewriteMercadoLivreTitle(
        item.titulo_aliexpress_original || item.titulo_ml,
        item.atributos_lista || [],
        item.variacao_modelo || ''
      );
      const updated = {
        ...item,
        titulo_ml: polishedTitle,
        lote_origem: 'Lote 1 - CSSV SHOP Store',
        frete_gratis_confirmado_ali: 'Sim',
        fornecedor_aprovacao_pct: item.fornecedor_aprovacao_pct || cssvMeta?.positiveRate || '92.6%',
        status_anuncio:
          item.status_anuncio === 'verificar_estoque_fornecedor'
            ? 'verificar_estoque_fornecedor'
            : item.ml_item_id
              ? item.status_anuncio
              : 'pronto_para_subir',
      };
      const q = computeMlQualityScore(updated);
      return {
        ...updated,
        qualidade_score: q.score,
        qualidade_pronto_85: q.ready,
        qualidade_anuncio_meta: `${q.score}% (Meta 85%+)`,
      };
    });

  const pdfLinks = JSON.parse(fs.readFileSync(DROPFACIL_LINKS_PATH, 'utf8'));
  const dropCatalogArr = JSON.parse(fs.readFileSync(DROPFACIL_STORE_PATH, 'utf8'));
  const dropStoreMap = new Map(dropCatalogArr.map((it) => [String(it.id), it]));

  // Sort candidates that share exact same subject by lowest cost first so we always keep the cheapest SKU
  const validCandidates = [];
  const skippedInactiveOrNoFreeShip = [];
  const skippedDuplicates = [];

  // Pre-filter active + Free Shipping Brazil, then deduplicate sequentially
  const workingCatalog = [...lote1Items];
  const enrichedPreCandidates = [];

  for (const link of pdfLinks) {
    const storeEntry = dropStoreMap.get(String(link.itemId));
    if (!storeEntry) {
      skippedInactiveOrNoFreeShip.push({
        itemId: link.itemId,
        motivo: 'Anúncio pausado/sem estoque ativo na loja DropFacil Store',
      });
      continue;
    }
    if (!hasFreeShippingBrazil(storeEntry)) {
      skippedInactiveOrNoFreeShip.push({
        itemId: link.itemId,
        titulo: storeEntry.subject,
        motivo: 'Produto sem Frete Grátis confirmado no Brasil (descartado pela regra operacional)',
      });
      continue;
    }
    const previewTitle = rewriteMercadoLivreTitle(storeEntry.subject || storeEntry.seoTitle || '');
    enrichedPreCandidates.push({
      ...link,
      storeEntry,
      previewTitle,
    });
  }

  // Sort so if two items inside DropFacil are near-duplicates, we evaluate the lower-cost one first
  enrichedPreCandidates.sort((a, b) => Number(a.costBrl || 0) - Number(b.costBrl || 0));
  const acceptedById = new Set();

  for (const cand of enrichedPreCandidates) {
    const dup = findDuplicateInCatalog(cand.previewTitle, cand.itemId, workingCatalog, 0.66);
    if (dup) {
      skippedDuplicates.push({
        itemId: cand.itemId,
        titulo: cand.previewTitle,
        costBrl: cand.costBrl,
        motivo: dup.reason,
        similaridade: dup.similarity,
        mantidoSku: dup.match.sku,
        mantidoTitulo: dup.match.titulo_ml,
        mantidoCusto: dup.match.preco_custo_aliexpress_brl,
      });
      continue;
    }
    acceptedById.add(String(cand.itemId));
    workingCatalog.push({
      sku: `TEMP-${cand.itemId}`,
      aliexpress_item_id: String(cand.itemId),
      titulo_ml: cand.previewTitle,
      preco_custo_aliexpress_brl: cand.costBrl,
    });
  }

  // Preserve original PDF order for accepted candidates
  for (const link of pdfLinks) {
    if (acceptedById.has(String(link.itemId))) {
      validCandidates.push({
        ...link,
        storeEntry: dropStoreMap.get(String(link.itemId)),
      });
    }
  }

  console.log(
    `Extraindo Lote 2 (DropFacil Store): ${validCandidates.length} produtos únicos com estoque Brasil + Frete Grátis confirmado...`
  );

  const lote2Items = await runWithConcurrency(validCandidates, 10, async (cand, idx) => {
    const seqNum = lote1Items.length + idx + 1;
    const internalCode = `AE-${String(seqNum).padStart(4, '0')}`;
    const product = await scrapeAliExpressProduct({
      urlOrId: cand.url,
      internalCode,
      knownCostBrl: cand.costBrl,
      knownOrigPriceBrl: cand.origBrl,
      storeEntry: cand.storeEntry,
      storeMeta: dropfacilMeta,
      loteOrigem: 'Lote 2 - DropFacil Store',
      skipLivePdp: true,
    });

    if ((idx + 1) % 20 === 0 || idx === validCandidates.length - 1) {
      console.log(
        `[${idx + 1}/${validCandidates.length}] ${product.sku} | R$ ${product.preco_custo_aliexpress_brl} -> R$ ${product.preco_venda_ml_sugerido} | ${product.qtd_imagens} imgs | Score ${product.qualidade_score}% | ${product.titulo_ml}`
      );
    }
    return product;
  });

  const unifiedCatalog = [...lote1Items, ...lote2Items];

  const dadosDir = path.join(ROOT, 'dados');
  const frontendPublicDir = path.join(ROOT, 'frontend/public');
  const rootPublicDir = path.join(ROOT, 'public');
  for (const dir of [dadosDir, frontendPublicDir, rootPublicDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const unifiedCompleteCsv = buildCompleteCsv(unifiedCatalog);
  const unifiedBulkCsv = buildMercadoLivreBulkCsv(unifiedCatalog);
  const lote2CompleteCsv = buildCompleteCsv(lote2Items);
  const lote2BulkCsv = buildMercadoLivreBulkCsv(lote2Items);

  fs.writeFileSync(PRODUCTS_JSON_PATH, JSON.stringify(unifiedCatalog, null, 2), 'utf8');

  for (const dir of [dadosDir, frontendPublicDir, rootPublicDir]) {
    fs.writeFileSync(path.join(dir, 'mercadolivre_aliexpress_completo.csv'), unifiedCompleteCsv, 'utf8');
    fs.writeFileSync(path.join(dir, 'mercadolivre_planilha_publicacao.csv'), unifiedBulkCsv, 'utf8');
    fs.writeFileSync(path.join(dir, 'mercadolivre_lote2_dropfacil_completo.csv'), lote2CompleteCsv, 'utf8');
    fs.writeFileSync(path.join(dir, 'mercadolivre_lote2_dropfacil_planilha.csv'), lote2BulkCsv, 'utf8');
  }

  const minQuality = Math.min(...unifiedCatalog.map((p) => p.qualidade_score || 0));
  const avgQuality = Number(
    (
      unifiedCatalog.reduce((acc, p) => acc + (p.qualidade_score || 0), 0) / unifiedCatalog.length
    ).toFixed(1)
  );
  const with4Imgs = unifiedCatalog.filter((p) => (p.qtd_imagens || 0) >= 4).length;

  const auditReport = {
    gerado_em: new Date().toISOString(),
    lote1_total: lote1Items.length,
    lote2_links_unicos_pdf: pdfLinks.length,
    lote2_adicionados_prontos: lote2Items.length,
    lote2_descartados_estoque_ou_frete: skippedInactiveOrNoFreeShip,
    lote2_descartados_duplicidade: skippedDuplicates,
    total_base_unificada: unifiedCatalog.length,
    com_4_ou_mais_imagens: with4Imgs,
    qualidade_minima_pct: minQuality,
    qualidade_media_pct: avgQuality,
    acima_85_pct: unifiedCatalog.filter((p) => (p.qualidade_score || 0) >= 85).length,
  };
  fs.writeFileSync(AUDIT_REPORT_PATH, JSON.stringify(auditReport, null, 2), 'utf8');

  console.log('\n=== AUDITORIA FINAL BASE PRONTA MELIMAX ===');
  console.log(JSON.stringify(auditReport, null, 2));
}

main().catch((err) => {
  console.error('Erro ao processar Lote 2 DropFacil:', err);
  process.exit(1);
});
