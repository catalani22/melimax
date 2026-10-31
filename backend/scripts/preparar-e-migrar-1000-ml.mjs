import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { query } from '../src/lib/db.js';
import { mlFetch } from '../src/lib/ml.js';
import { PREMIUM_LISTING_TYPE, OUTROS_OUTROS_LEAF_ID } from '../src/lib/aliexpress-scraper.js';
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
const LIMIT = Number(args.limit || 0);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function saveCatalogToDbAndLocal(products) {
  await query(
    `INSERT INTO app_state (key, value, updated_at)
     VALUES ('aliexpress_catalog', $1::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [JSON.stringify(products)]
  );
  for (const rel of ['backend/data/aliexpress_produtos.json', 'dados/aliexpress_produtos.json']) {
    const target = path.join(REPO_ROOT, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(products, null, 2), 'utf8');
  }
}

async function postItemSafe(payload) {
  try {
    return await mlFetch('/items', { method: 'POST', body: payload });
  } catch (err) {
    const txt = `${err.message || ''} ${JSON.stringify(err.data || {})}`;
    if (/family_name|item\.title|title\.missing|title\.invalid|body\.invalid_fields/i.test(txt)) {
      const alt = { ...payload };
      if (alt.family_name && !alt.title) {
        alt.title = alt.family_name;
        delete alt.family_name;
      } else if (alt.title && !alt.family_name) {
        alt.family_name = alt.title;
        delete alt.title;
      }
      return await mlFetch('/items', { method: 'POST', body: alt });
    }
    throw err;
  }
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
  `=== MeLi Max Anti-ME2 CLI (${APPLY ? 'APPLY REAL' : 'DRY-RUN'}) | modo=${MODO} | estrategia=${ESTRATEGIA} ===`
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

// STEP 1: Migrate already-uploaded ME2 items
if (MODO === 'tudo' || MODO === 'migrar') {
  const { rows: dbListings } = await query(
    `SELECT id, ml_item_id, title, price, status, source_item_id
     FROM listings
     WHERE ml_item_id IS NOT NULL AND COALESCE(status, '') != 'closed'
     ORDER BY created_at ASC`
  );
  const targets = LIMIT > 0 ? dbListings.slice(0, LIMIT) : dbListings;
  let migrated = 0;

  for (const row of targets) {
    try {
      const live = await mlFetch(`/items/${encodeURIComponent(row.ml_item_id)}`);
      if (live.status === 'closed' || isItemShippingFreeOfMe2(live.shipping || {})) {
        console.log(`[OK SEM ME2] ${row.ml_item_id} (${live.shipping?.mode || live.status})`);
        continue;
      }
      console.log(`[EM ME2] ${row.ml_item_id} | cat=${live.category_id} | titulo="${live.title}"`);
      if (!APPLY) continue;

      const prodIdx = products.findIndex(
        (p) =>
          String(p.ml_item_id) === String(row.ml_item_id) ||
          (row.source_item_id && String(p.aliexpress_item_id) === String(row.source_item_id))
      );
      const baseProd =
        prodIdx >= 0
          ? products[prodIdx]
          : {
              sku: `MLMIG-${row.ml_item_id}`,
              codigo_interno: row.ml_item_id,
              aliexpress_item_id: row.source_item_id || row.ml_item_id,
              titulo_ml: live.title || 'Produto Pronta Entrega',
              descricao_ml_otimizada: `${live.title}. Frete grátis para todo o Brasil com prazo de 5 a 10 dias corridos.`,
              preco_venda_ml_sugerido: Math.max(Number(live.price) || 79.9, 79.9),
              imagens: (live.pictures || []).map((pic) => pic.secure_url || pic.url).filter(Boolean),
              estoque_disponivel: 3,
            };

      const { prepared, report } = await runMlPreflight(baseProd, {
        ignore_existing_ml_item: true,
        fast_batch: true,
        estrategia: ESTRATEGIA,
      });
      if (!report.ok || !report.payload) {
        console.warn(`  -> Bloqueado na validação substituta: ${(report.blockers || []).join('; ')}`);
        continue;
      }

      await closeOldMe2(row.ml_item_id);
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

        await query('UPDATE listings SET ml_item_id=$1, status=$2, permalink=$3 WHERE id=$4', [
          created.id,
          'paused',
          created.permalink || null,
          row.id,
        ]);

        if (prodIdx >= 0) {
          const fp = buildMlReviewFingerprint(prepared, created.category_id || report.categoria_ml_id);
          products[prodIdx] = {
            ...products[prodIdx],
            ...prepared,
            ml_item_id: created.id,
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
        migrated += 1;
        console.log(
          `  -> MIGRADO: ${row.ml_item_id} (fechado) => ${created.id} (${created.category_id} | ${created.shipping?.mode})`
        );
      }
      await sleep(450);
    } catch (err) {
      console.error(`  -> Erro em ${row.ml_item_id}: ${err.message}`);
    }
  }
  if (APPLY && migrated > 0) {
    await saveCatalogToDbAndLocal(products);
  }
  console.log(`Resumo Migração Já Subidos: ${migrated} migrado(s).`);
}

// STEP 2: Prepare all 1,000+ un-uploaded products with Anti-ME2 validation
if (MODO === 'tudo' || MODO === 'preparar') {
  const pendingIndices = [];
  for (let i = 0; i < products.length; i += 1) {
    const p = products[i];
    if (p.ml_item_id) continue;
    if (getMlReviewGate(p).ok && p.ml_preflight?.anti_me2_verified) continue;
    pendingIndices.push(i);
  }
  const slice = LIMIT > 0 ? pendingIndices.slice(0, LIMIT) : pendingIndices;
  console.log(`Produtos pendentes de preparo Anti-ME2: ${slice.length}/${pendingIndices.length}`);

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
    await sleep(180);
  }
  if (APPLY && prepCount > 0) {
    await saveCatalogToDbAndLocal(products);
  }
  console.log(`Resumo Preparação Base 1000+: ${prepCount} aprovado(s) sem ME2.`);
}

// STEP 3: Optional paused upload (--modo=subir --apply)
if (MODO === 'subir' && APPLY) {
  const readyIndices = [];
  for (let i = 0; i < products.length; i += 1) {
    if (!products[i].ml_item_id && getMlReviewGate(products[i]).ok) readyIndices.push(i);
  }
  const slice = LIMIT > 0 ? readyIndices.slice(0, LIMIT) : readyIndices;
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
      await sleep(450);
    } catch (err) {
      console.error(`[ERRO SUBIDA] ${p.sku}: ${err.message}`);
    }
  }
  if (uploaded > 0) await saveCatalogToDbAndLocal(products);
  console.log(`Total subidos pausados sem ME2: ${uploaded}`);
}

process.exit(0);
