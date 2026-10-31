import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { query } from '../src/lib/db.js';
import { mlFetch } from '../src/lib/ml.js';
import {
  PREMIUM_LISTING_TYPE,
  OUTROS_OUTROS_LEAF_ID,
  detectFamousBrand,
  detectMlPolicyRisk,
  resolveNonMe2DepartmentCategory,
} from '../src/lib/aliexpress-scraper.js';
import {
  ensureAliExpressCatalog,
  getAliExpressCatalog,
  getMlAccountShippingProfile,
  runMlPreflight,
  resolveAntiMe2Payload,
  isItemShippingFreeOfMe2,
  getMlReviewGate,
  buildMlReviewFingerprint,
  ensureFreeShippingNoticeInDescription,
  getProductImages,
  collectAllAccountListingIds,
  fetchMultiItemsFast,
  isLiveItemModerationLocked,
  detectLiveModerationAlert,
  tryConvertExistingItemInPlace,
  ensureItemStrictlyPaused,
} from '../src/routes/aliexpress.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');

for (const envCandidate of [
  '/home/netuno/ml-dropshipping/backend/.env.local',
  path.join(BACKEND_ROOT, '.env.local'),
  path.join(BACKEND_ROOT, '.env'),
  path.join(REPO_ROOT, '.env.local'),
  path.join(REPO_ROOT, '.env'),
]) {
  if (fs.existsSync(envCandidate)) {
    dotenv.config({ path: envCandidate, override: false });
  }
}

const args = {};
for (const arg of process.argv.slice(2)) {
  const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
  if (match) args[match[1]] = match[2] === undefined ? true : match[2];
}

const APPLY = args.apply === true || args.apply === 'true';
const MODO = String(args.modo || 'tudo').toLowerCase(); // tudo | migrar | preparar | subir
const ESTRATEGIA = String(args.estrategia || 'cascata').toLowerCase();
const INCLUIR_MARCAS = args['incluir-marcas'] === true || args['incluir-marcas'] === 'true';
const LIMIT = Number(args.limit || 0);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function saveCatalogToDbAndLocal(products) {
  await query(
    `INSERT INTO app_state (key, value, updated_at)
     VALUES ('aliexpress_catalog', $1::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [JSON.stringify(products)]
  ).catch((err) => console.warn('[aviso db app_state]', err.message));
  for (const rel of ['backend/data/aliexpress_produtos.json', 'dados/aliexpress_produtos.json']) {
    const target = path.join(REPO_ROOT, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(products, null, 2), 'utf8');
  }
}

async function postItemSafe(payload) {
  let created = null;
  try {
    created = await mlFetch('/items', { method: 'POST', body: payload });
  } catch (err) {
    if (err?.status !== 401) {
      const alt = { ...payload };
      if (alt.family_name && !alt.title) {
        alt.title = alt.family_name;
        delete alt.family_name;
        created = await mlFetch('/items', { method: 'POST', body: alt });
      } else if (alt.title && !alt.family_name) {
        alt.family_name = alt.title;
        delete alt.title;
        created = await mlFetch('/items', { method: 'POST', body: alt });
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }
  if (created?.id) {
    const paused = await ensureItemStrictlyPaused(created.id);
    if (paused?.status) {
      created = { ...created, status: paused.status };
    }
  }
  return created;
}

async function closeOldMe2(id) {
  await mlFetch(`/items/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: { status: 'paused' },
  }).catch(() => null);
  await mlFetch(`/items/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: { status: 'closed' },
  }).catch(() => null);
}

console.log(
  `=== MeLi Max Anti-ME2 CLI (${APPLY ? 'APPLY REAL' : 'DRY-RUN'}) | modo=${MODO} | estrategia=${ESTRATEGIA} | incluirMarcas=${INCLUIR_MARCAS} ===`
);

await ensureAliExpressCatalog();
const products = getAliExpressCatalog();
const profile = await getMlAccountShippingProfile(true);

if (!profile.connected) {
  throw new Error(`Conta Mercado Livre desconectada ou sem DATABASE_URL válido (${profile.error || ''}).`);
}

console.log(
  `Conta conectada: ${profile.nickname} (${profile.user_id}) | modos=${profile.shipping_modes.join(',')} | Base=${products.length} produtos`
);

// STEP 1: Migrate already-uploaded ME2 items (in-place first, then close & recreate; skip famous brands)
if (MODO === 'tudo' || MODO === 'migrar') {
  const { allIds, dbRowsByMlId } = await collectAllAccountListingIds(profile.user_id);
  const liveItems = await fetchMultiItemsFast(allIds);
  const me2Items = liveItems.filter(
    (it) => it.status !== 'closed' && !isItemShippingFreeOfMe2(it.shipping || {})
  );
  const targets = LIMIT > 0 ? me2Items.slice(0, LIMIT) : me2Items;

  let convertedInPlace = 0;
  let recreated = 0;
  let quarantinedBrands = 0;
  let failed = 0;

  for (const live of targets) {
    const oldId = String(live.id);
    const dbRow = dbRowsByMlId.get(oldId) || null;
    const sellerSkuAttr = (live.attributes || []).find((a) => a.id === 'SELLER_SKU')?.value_name;

    const prodIdx = products.findIndex(
      (p) =>
        String(p.ml_item_id) === oldId ||
        (sellerSkuAttr && String(p.sku).toUpperCase() === String(sellerSkuAttr).toUpperCase()) ||
        (dbRow?.source_item_id && String(p.aliexpress_item_id) === String(dbRow.source_item_id))
    );
    const matchedProd = prodIdx >= 0 ? products[prodIdx] : null;
    const detectedBrand =
      detectFamousBrand(live) || (matchedProd ? detectFamousBrand(matchedProd) : null);
    const policyRisk =
      detectMlPolicyRisk(live) ||
      (matchedProd?.risco_politica_ml
        ? matchedProd.motivo_risco_politica_ml
        : matchedProd
          ? detectMlPolicyRisk(matchedProd)
          : null);
    const liveModAlert = detectLiveModerationAlert(live);
    const modLocked = isLiveItemModerationLocked(live);

    if (policyRisk || (liveModAlert && !detectedBrand)) {
      quarantinedBrands += 1;
      console.log(
        `[FECHADO E ISOLADO RISCO POLÍTICA ML] ${oldId} (${policyRisk || liveModAlert}) — "${live.title}"`
      );
      if (APPLY) {
        await closeOldMe2(oldId);
        await query("UPDATE listings SET status='closed' WHERE ml_item_id=$1", [oldId]).catch(() => null);
        if (prodIdx >= 0) {
          products[prodIdx] = {
            ...products[prodIdx],
            ml_item_id: null,
            ml_permalink: null,
            ml_item_id_risco_fechado: oldId,
            risco_politica_ml: true,
            motivo_risco_politica_ml: policyRisk || liveModAlert,
            ml_revisao: null,
            status_anuncio: 'quarentena_politica_ml',
          };
        }
      }
      continue;
    }

    if (!INCLUIR_MARCAS && (detectedBrand || modLocked)) {
      quarantinedBrands += 1;
      console.log(
        `[RESERVADO MARCA FAMOSA] ${oldId} (${detectedBrand || 'Moderação ML'}) — "${live.title}"`
      );
      if (APPLY) {
        if (live.status === 'active') {
          await mlFetch(`/items/${encodeURIComponent(oldId)}`, {
            method: 'PUT',
            body: { status: 'paused' },
          }).catch(() => null);
        }
        if (prodIdx >= 0) {
          products[prodIdx] = {
            ...products[prodIdx],
            marca_famosa_quarentena: true,
            marca_famosa_detectada: detectedBrand || 'Moderação ML',
            status_anuncio: 'aguardando_procedimento_marca',
          };
        }
      }
      continue;
    }

    console.log(`[EM ME2] ${oldId} | cat=${live.category_id} | titulo="${live.title}"`);
    if (!APPLY) continue;

    try {
      if (live.status === 'active') {
        await mlFetch(`/items/${encodeURIComponent(oldId)}`, {
          method: 'PUT',
          body: { status: 'paused' },
        }).catch(() => null);
      }

      const livePics = (live.pictures || []).map((pic) => pic.secure_url || pic.url).filter(Boolean);
      const baseProd = matchedProd
        ? {
            ...matchedProd,
            imagens: getProductImages(matchedProd).length >= 4 ? getProductImages(matchedProd) : livePics,
          }
        : {
            sku: sellerSkuAttr || `MLMIG-${oldId}`,
            codigo_interno: sellerSkuAttr || oldId,
            aliexpress_item_id: dbRow?.source_item_id || oldId,
            titulo_ml: live.title || 'Produto Pronta Entrega',
            descricao_ml_otimizada: `${live.title || 'Produto'}. Frete grátis para todo o Brasil com prazo de 5 a 10 dias corridos.`,
            preco_venda_ml_sugerido: Math.max(Number(live.price) || 79.9, 79.9),
            imagens: livePics,
            marca: 'Genérica',
            modelo: 'Padrão',
            estoque_disponivel: 3,
          };

      const deptCat = resolveNonMe2DepartmentCategory(baseProd);
      const targetCatId = ESTRATEGIA === 'forcar_mlb3530' ? OUTROS_OUTROS_LEAF_ID : deptCat.id;

      const { converted, lastPutError } = await tryConvertExistingItemInPlace(
        live,
        baseProd,
        targetCatId,
        profile,
        ESTRATEGIA
      );

      if (converted) {
        convertedInPlace += 1;
        await mlFetch(`/items/${encodeURIComponent(converted.id)}/description`, {
          method: 'PUT',
          body: { plain_text: ensureFreeShippingNoticeInDescription(baseProd.descricao_ml_otimizada) },
        }).catch(() => null);

        if (prodIdx >= 0) {
          const finalCat = converted.category_id || targetCatId;
          const fp = buildMlReviewFingerprint(products[prodIdx], finalCat);
          products[prodIdx] = {
            ...products[prodIdx],
            ml_item_id: converted.id,
            status_anuncio: 'paused',
            ml_shipping: converted.shipping,
            ml_preflight: {
              ...(products[prodIdx].ml_preflight || {}),
              ok: true,
              anti_me2_verified: true,
              categoria_ml_id: finalCat,
              fingerprint: fp,
            },
            ml_revisao: {
              aprovado: true,
              aprovado_em: new Date().toISOString(),
              aprovado_por: 'cli_anti_me2',
              categoria_ml_id: finalCat,
              checks: { categoria: true, fotos: true, titulo_fotos: true, preco_frete: true },
              fingerprint: fp,
            },
          };
        }
        console.log(
          `  -> CONVERTIDO IN-PLACE: ${oldId} (${converted.category_id} | ${converted.shipping?.mode})`
        );
        await sleep(250);
        continue;
      }

      if (livePics.length >= 4) {
        baseProd.imagens = livePics;
        baseProd.qtd_imagens = livePics.length;
      }

      const { prepared, report } = await runMlPreflight(baseProd, {
        ignore_existing_ml_item: true,
        fast_batch: true,
        estrategia: ESTRATEGIA,
      });
      if (!report.ok || !report.payload) {
        failed += 1;
        console.warn(
          `  -> Bloqueado (${lastPutError || 'in-place recusado'}): ${(report.blockers || []).join('; ')}`
        );
        continue;
      }

      await closeOldMe2(oldId);
      let created = await postItemSafe({ ...report.payload, status: 'paused' });
      if (created?.id && !isItemShippingFreeOfMe2(created.shipping || {})) {
        await closeOldMe2(created.id);
        const f3530 = await resolveAntiMe2Payload(prepared, { estrategia: 'forcar_mlb3530' });
        created = await postItemSafe({ ...f3530.payload, status: 'paused' });
      }
      if (created?.id) {
        await mlFetch(`/items/${encodeURIComponent(created.id)}/description`, {
          method: 'POST',
          body: { plain_text: ensureFreeShippingNoticeInDescription(prepared.descricao_ml_otimizada) },
        }).catch(() => null);

        if (dbRow?.id) {
          await query('UPDATE listings SET ml_item_id=$1, status=$2, permalink=$3 WHERE id=$4', [
            created.id,
            'paused',
            created.permalink || null,
            dbRow.id,
          ]).catch(() => null);
        }

        if (prodIdx >= 0) {
          const fp = buildMlReviewFingerprint(prepared, created.category_id || report.categoria_ml_id);
          products[prodIdx] = {
            ...products[prodIdx],
            ...prepared,
            ml_item_id: created.id,
            ml_item_id_me2_fechado: oldId,
            ml_permalink: created.permalink || null,
            status_anuncio: 'paused',
            ml_shipping: created.shipping || null,
            ml_preflight: { ...report, categoria_ml_id: created.category_id, fingerprint: fp },
            ml_revisao: {
              aprovado: true,
              aprovado_em: new Date().toISOString(),
              aprovado_por: 'cli_anti_me2',
              categoria_ml_id: created.category_id || OUTROS_OUTROS_LEAF_ID,
              checks: { categoria: true, fotos: true, titulo_fotos: true, preco_frete: true },
              fingerprint: fp,
            },
          };
        }
        recreated += 1;
        console.log(
          `  -> RECRIADO SEM ME2: ${oldId} (fechado) => ${created.id} (${created.category_id} | ${created.shipping?.mode})`
        );
      }
      await sleep(300);
    } catch (err) {
      failed += 1;
      console.error(`  -> Erro em ${oldId}: ${err.message}`);
    }
  }
  if (APPLY && (convertedInPlace > 0 || recreated > 0 || quarantinedBrands > 0)) {
    await saveCatalogToDbAndLocal(products);
  }
  console.log(
    `Resumo Migração Já Subidos: ${convertedInPlace} in-place, ${recreated} recriados, ${quarantinedBrands} marcas famosas reservadas, ${failed} falhas.`
  );
}

// STEP 2: Prepare all un-uploaded non-brand products with Anti-ME2 validation
if (MODO === 'tudo' || MODO === 'preparar') {
  const pendingIndices = [];
  let skippedFamous = 0;
  let skippedPolicy = 0;
  for (let i = 0; i < products.length; i += 1) {
    const p = products[i];
    if (p.ml_item_id) continue;
    if (!INCLUIR_MARCAS && (p.marca_famosa_quarentena || detectFamousBrand(p))) {
      skippedFamous += 1;
      products[i] = {
        ...p,
        marca_famosa_quarentena: true,
        marca_famosa_detectada: p.marca_famosa_detectada || detectFamousBrand(p),
        status_anuncio: 'aguardando_procedimento_marca',
      };
      continue;
    }
    const pRisk = p.risco_politica_ml ? p.motivo_risco_politica_ml : detectMlPolicyRisk(p);
    if (pRisk && p.risco_politica_liberado_manualmente !== true) {
      skippedPolicy += 1;
      products[i] = {
        ...p,
        risco_politica_ml: true,
        motivo_risco_politica_ml: pRisk,
        ml_revisao: null,
        status_anuncio: 'quarentena_politica_ml',
      };
      continue;
    }
    if (getMlReviewGate(p).ok && p.ml_preflight?.anti_me2_verified) continue;
    pendingIndices.push(i);
  }
  const slice = LIMIT > 0 ? pendingIndices.slice(0, LIMIT) : pendingIndices;
  console.log(
    `Produtos elegíveis pendentes de preparo Anti-ME2: ${slice.length}/${pendingIndices.length} (${skippedFamous} marcas famosas reservadas · ${skippedPolicy} quarentena ANVISA/fotos)`
  );

  let prepCount = 0;
  for (const idx of slice) {
    const item = products[idx];
    const { prepared, report } = await runMlPreflight(item, {
      fast_batch: true,
      estrategia: ESTRATEGIA,
    });
    if (report.ok) {
      const fp = buildMlReviewFingerprint(prepared, report.categoria_ml_id);
      report.fingerprint = fp;
      if (APPLY) {
        products[idx] = {
          ...item,
          ...prepared,
          ml_preflight: report,
          ml_revisao: {
            aprovado: true,
            aprovado_em: new Date().toISOString(),
            aprovado_por: 'cli_anti_me2',
            categoria_ml_id: report.categoria_ml_id,
            checks: { categoria: true, fotos: true, titulo_fotos: true, preco_frete: true },
            fingerprint: fp,
          },
        };
      }
      prepCount += 1;
      if (prepCount % 25 === 0 || prepCount === slice.length) {
        console.log(`  Preparados OK: ${prepCount}/${slice.length} (último: ${item.sku} -> ${report.categoria_ml_id})`);
        if (APPLY) await saveCatalogToDbAndLocal(products);
      }
    } else {
      console.warn(`  [BLOQUEIO] ${item.sku}: ${(report.blockers || []).join('; ')}`);
    }
    await sleep(140);
  }
  if (APPLY && (prepCount > 0 || skippedFamous > 0 || skippedPolicy > 0)) {
    await saveCatalogToDbAndLocal(products);
  }
  console.log(`Resumo Preparação Base 1000+: ${prepCount} aprovado(s) sem ME2.`);
}

// STEP 3: Paused upload without ME2 (--modo=tudo --apply or --modo=subir --apply)
if ((MODO === 'tudo' || MODO === 'subir') && APPLY) {
  const readyIndices = [];
  for (let i = 0; i < products.length; i += 1) {
    const p = products[i];
    if (p.ml_item_id) continue;
    if (!INCLUIR_MARCAS && (p.marca_famosa_quarentena || detectFamousBrand(p))) continue;
    if ((p.risco_politica_ml || detectMlPolicyRisk(p)) && p.risco_politica_liberado_manualmente !== true) continue;
    if (getMlReviewGate(p).ok) readyIndices.push(i);
  }
  const slice = LIMIT > 0 ? readyIndices.slice(0, LIMIT) : readyIndices;
  console.log(`Iniciando subida PAUSADA sem ME2 para ${slice.length} produtos elegíveis...`);
  let uploaded = 0;
  for (const idx of slice) {
    const p = products[idx];
    try {
      let created = await postItemSafe({ ...p.ml_preflight.payload, status: 'paused' });
      if (created?.id && !isItemShippingFreeOfMe2(created.shipping || {})) {
        await closeOldMe2(created.id);
        const f3530 = await resolveAntiMe2Payload(p, { estrategia: 'forcar_mlb3530' });
        created = await postItemSafe({ ...f3530.payload, status: 'paused' });
      }
      await mlFetch(`/items/${encodeURIComponent(created.id)}/description`, {
        method: 'POST',
        body: { plain_text: ensureFreeShippingNoticeInDescription(p.descricao_ml_otimizada) },
      }).catch(() => null);
      await query(
        `INSERT INTO listings (ml_item_id, title, price, supplier, status, source_item_id, permalink, listing_type_id)
         VALUES ($1,$2,$3,$4,'paused',$5,$6,$7)
         ON CONFLICT (ml_item_id) DO UPDATE SET status='paused'`,
        [
          created.id,
          created.title || p.titulo_ml,
          created.price || p.preco_venda_ml_sugerido,
          p.fornecedor_nome || 'AliExpress Brasil',
          p.aliexpress_item_id,
          created.permalink || null,
          PREMIUM_LISTING_TYPE,
        ]
      ).catch(() => null);
      products[idx] = {
        ...p,
        ml_item_id: created.id,
        ml_permalink: created.permalink || null,
        status_anuncio: 'paused',
        ml_shipping: created.shipping || null,
      };
      uploaded += 1;
      console.log(`[CRIADO PAUSADO SEM ME2] ${p.sku} -> ${created.id} (${created.category_id})`);
      if (uploaded % 15 === 0) await saveCatalogToDbAndLocal(products);
      await sleep(320);
    } catch (err) {
      console.error(`[ERRO SUBIDA] ${p.sku}: ${err.message}`);
    }
  }
  if (uploaded > 0) await saveCatalogToDbAndLocal(products);
  console.log(`Total subidos pausados sem ME2: ${uploaded}`);
}

process.exit(0);
