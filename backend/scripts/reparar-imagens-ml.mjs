import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import fetch from 'node-fetch';
import '../src/env.js';
import { query } from '../src/lib/db.js';
import { mlFetch, getAccount } from '../src/lib/ml.js';

const args = {};
for (const arg of process.argv.slice(2)) {
  const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
  if (match) args[match[1]] = match[2] === undefined ? true : match[2];
}

const APPLY = args.apply === true || args.apply === 'true';
const LIMIT = Number(args.limit || 0);
const WAVE = Math.max(Number(args.wave) || 5, 1);
const DELAY_MS = Math.max(Number(args.delay) || 1200, 250);
const ONLY = new Set(
  String(args.only || '')
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean)
);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(REPO_ROOT, 'dados');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const REPORT_PATH = path.join(OUT_DIR, `reparacao_imagens_ml_${STAMP}.json`);
const BACKUP_PATH = path.join(OUT_DIR, `backup_imagens_ml_${STAMP}.json`);

const BLOCKERS = new Set(['text_logo', 'watermark']);
const CROP_PLANS = [
  { top: 0.1, bottom: 0.18 },
  { top: 0.15, bottom: 0.18 },
  { top: 0.18, bottom: 0.18 },
  { top: 0.22, bottom: 0.18 },
  { top: 0.25, bottom: 0.18 },
  { top: 0.28, bottom: 0.16 },
  { top: 0.3, bottom: 0.16 },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let lastRequestAt = 0;
async function throttle() {
  const wait = Math.max(0, lastRequestAt + DELAY_MS - Date.now());
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

async function withRetry(label, fn) {
  let lastError;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    await throttle();
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (err?.status === 429 || err?.status >= 500) {
        await sleep(10000 * attempt);
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

function uniqueUrls(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const url = String(value || '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    result.push(url);
  }
  return result;
}

function isBlocked(detections) {
  return detections.some((name) => BLOCKERS.has(name));
}

function qualityRank(detections) {
  if (detections.length === 0) return 0;
  if (detections.every((name) => name === 'white_background')) return 1;
  return 2;
}

async function diagnose({ pictureId, pictureUrl, elementId, categoryId, title, pictureType = 'thumbnail' }) {
  const body = {
    context: {
      category_id: categoryId,
      title: String(title || '').slice(0, 60),
      picture_type: pictureType,
      language: 'pt',
    },
  };
  if (elementId) body.element_id = elementId;
  if (pictureId) body.picture_id = pictureId;
  else body.picture_url = pictureUrl;

  const response = await withRetry('diagnostic', () =>
    mlFetch('/moderations/pictures/diagnostic', { method: 'POST', body })
  );
  const detections = [
    ...new Set(
      (response.diagnostics || []).flatMap((diagnostic) => diagnostic.detections || []).map((item) => item.name)
    ),
  ];
  return detections;
}

async function downloadImage(url) {
  const response = await withRetry('download', async () => {
    const result = await fetch(url);
    if (!result.ok) {
      const err = new Error(`Falha ao baixar imagem ${result.status}`);
      err.status = result.status;
      throw err;
    }
    return result;
  });
  return Buffer.from(await response.arrayBuffer());
}

async function cropBuffer(buffer, plan) {
  const image = sharp(buffer, { failOn: 'none' });
  const meta = await image.metadata();
  if (!meta.width || !meta.height) throw new Error('Imagem sem dimensoes');
  const top = Math.round(meta.height * plan.top);
  const bottom = Math.round(meta.height * plan.bottom);
  const height = meta.height - top - bottom;
  if (height < 500) throw new Error('Corte resultaria em imagem baixa');
  return sharp(buffer, { failOn: 'none' })
    .extract({ left: 0, top, width: meta.width, height })
    .jpeg({ quality: 92 })
    .toBuffer();
}

async function uploadPicture(buffer, filename) {
  const account = await getAccount();
  if (!account?.access_token) throw new Error('Conta Mercado Livre nao conectada');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'image/jpeg' }), filename);
  const response = await withRetry('upload', async () => {
    const result = await fetch('https://api.mercadolibre.com/pictures/items/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${account.access_token}` },
      body: form,
    });
    if (!result.ok) {
      const text = await result.text();
      const err = new Error(`Upload de imagem falhou (${result.status}): ${text.slice(0, 300)}`);
      err.status = result.status;
      throw err;
    }
    return result;
  });
  const data = await response.json();
  if (!data?.id) throw new Error('Upload de imagem sem ID');
  return data.id;
}

async function loadCatalog() {
  const { rows } = await query("SELECT value FROM app_state WHERE key = 'aliexpress_catalog'");
  const value = rows[0]?.value;
  const products = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(products) ? products : [];
}

async function loadListings() {
  const { rows } = await query(
    'SELECT ml_item_id, title, status, thumbnail FROM listings ORDER BY created_at ASC'
  );
  return rows;
}

async function auditItem(listing, catalogByItem) {
  const item = await withRetry('item', () =>
    mlFetch(`/items/${encodeURIComponent(listing.ml_item_id)}?attributes=id,title,status,sub_status,pictures,category_id,permalink`)
  );

  let moderation = [];
  try {
    moderation = await withRetry('moderation', () =>
      mlFetch(`/moderations/last_moderation/${encodeURIComponent(listing.ml_item_id)}-ITM`)
    );
  } catch (err) {
    if (err?.status !== 404) throw err;
  }

  const moderated =
    item.status === 'under_review' ||
    moderation.length > 0 ||
    (Array.isArray(item.sub_status) && item.sub_status.length > 0);

  const product = catalogByItem.get(listing.ml_item_id);

  if (!moderated) {
    return {
      item_id: listing.ml_item_id,
      sku: product?.sku || null,
      title: item.title,
      status: item.status,
      sub_status: item.sub_status || [],
      category_id: item.category_id,
      moderation: [],
      current_pictures: (item.pictures || []).map((picture) => ({ id: picture.id, source: picture.source || null })),
      existing: [],
      source_diagnostics: [],
      action: 'none',
      reason: 'Sem moderacao ativa; anúncio preservado',
    };
  }

  const pictures = Array.isArray(item.pictures) ? item.pictures.slice(0, 8) : [];
  const existing = [];
  for (const picture of pictures) {
    const detections = await diagnose({
      pictureId: picture.id,
      elementId: listing.ml_item_id,
      categoryId: item.category_id,
      title: item.title,
    });
    existing.push({
      id: picture.id,
      source: picture.source || null,
      detections,
      blocked: isBlocked(detections),
      rank: qualityRank(detections),
    });
  }

  const cleanExisting = existing
    .filter((picture) => !picture.blocked)
    .sort((a, b) => a.rank - b.rank);

  const sourceUrls = uniqueUrls(product?.imagens || []).slice(0, 8);
  const sourceDiagnostics = [];
  if (cleanExisting.length === 0) {
    for (const url of sourceUrls) {
      const detections = await diagnose({
        pictureUrl: url,
        elementId: listing.ml_item_id,
        categoryId: item.category_id,
        title: item.title,
      });
      sourceDiagnostics.push({ url, detections, blocked: isBlocked(detections), rank: qualityRank(detections) });
      const cleanCount = sourceDiagnostics.filter((entry) => !entry.blocked).length;
      if (cleanCount >= 4) break;
    }
  }

  const cleanSources = sourceDiagnostics
    .filter((picture) => !picture.blocked)
    .sort((a, b) => a.rank - b.rank);

  const currentIds = pictures.map((picture) => picture.id);
  const plannedIds = cleanExisting.map((picture) => picture.id);
  const needsUpdate =
    cleanExisting.length > 0 &&
    (currentIds.length !== plannedIds.length || currentIds.some((id, index) => id !== plannedIds[index]));

  let action = 'none';
  let reason = 'Fotos atuais aprovadas';
  let newPictures = null;
  let blockedReason = null;

  if (needsUpdate) {
    action = 'reorder_existing';
    reason = 'Reordenar/remover fotos reprovadas mantendo apenas as aprovadas';
    newPictures = plannedIds.map((id) => ({ id }));
  } else if (cleanExisting.length === 0 && cleanSources.length > 0) {
    action = 'replace_with_catalog';
    reason = 'Substituir capa por foto limpa do catalogo';
    newPictures = cleanSources.slice(0, 8).map((picture) => ({ source: picture.url }));
  } else if (cleanExisting.length === 0 && cleanSources.length === 0) {
    action = 'crop_required';
    reason = 'Nenhuma foto limpa disponivel; testar cortes';
  }

  if (existing.length === 0) {
    action = 'blocked';
    blockedReason = 'Anuncio sem fotos na API do ML';
  }

  return {
    item_id: listing.ml_item_id,
    sku: product?.sku || null,
    title: item.title,
    status: item.status,
    sub_status: item.sub_status || [],
    category_id: item.category_id,
    moderation: moderation.map((entry) => ({
      name: entry.name,
      reason: (entry.wordings || []).find((word) => word.type === 'REASON')?.value || null,
      remedy: (entry.wordings || []).find((word) => word.type === 'REMEDY')?.value || null,
      evidences: entry.evidence || entry.evidences || [],
    })),
    current_pictures: pictures.map((picture) => ({ id: picture.id, source: picture.source || null })),
    existing,
    source_diagnostics: sourceDiagnostics,
    action,
    reason,
    blocked_reason: blockedReason,
    new_pictures: newPictures,
  };
}

async function prepareCroppedPictures(audit) {
  if (audit.action !== 'crop_required') return audit;
  const product = catalogByItem.get(audit.item_id);
  const sourceUrls = uniqueUrls(product?.imagens || []).slice(0, 6);
  const approved = [];

  for (const url of sourceUrls) {
    let buffer;
    try {
      buffer = await downloadImage(url);
    } catch (err) {
      audit.crop_errors = [...(audit.crop_errors || []), { url, error: err.message }];
      continue;
    }

    for (const plan of CROP_PLANS) {
      let cropped;
      try {
        cropped = await cropBuffer(buffer, plan);
      } catch (err) {
        continue;
      }
      const base64 = cropped.toString('base64');
      const detections = await diagnose({
        pictureUrl: `data:image/jpeg;base64,${base64}`,
        elementId: audit.item_id,
        categoryId: audit.category_id,
        title: audit.title,
      });
      if (isBlocked(detections)) continue;

      approved.push({
        source_url: url,
        crop: plan,
        detections,
        buffer: cropped,
      });
      break;
    }
    if (approved.length >= 4) break;
  }

  if (approved.length === 0) {
    audit.action = 'blocked';
    audit.blocked_reason = 'Nenhuma foto passou no diagnostico nem apos corte';
    return audit;
  }

  audit.crop_candidates = approved.map((entry) => ({
    source_url: entry.source_url,
    crop: entry.crop,
    detections: entry.detections,
  }));

  if (!APPLY) {
    audit.action = 'crop_preview';
    audit.reason = 'Corte aprovado no diagnostico; upload pendente';
    return audit;
  }

  const uploaded = [];
  for (const entry of approved.slice(0, 8)) {
    const id = await uploadPicture(
      entry.buffer,
      `${audit.sku || audit.item_id}-${Date.now()}-${uploaded.length + 1}.jpg`
    );
    uploaded.push({ id });
  }
  audit.action = 'replace_with_cropped';
  audit.reason = 'Substituir por fotos cortadas e aprovadas';
  audit.new_pictures = uploaded;
  return audit;
}

async function applyAudit(audit, backup) {
  if (!APPLY) return { ...audit, applied: false };
  if (!audit.new_pictures?.length) return { ...audit, applied: false };
  if (audit.action === 'none') return { ...audit, applied: false };

  backup.push({
    item_id: audit.item_id,
    sku: audit.sku,
    status: audit.status,
    pictures: audit.current_pictures,
    new_pictures: audit.new_pictures,
    action: audit.action,
  });

  await withRetry('update', () =>
    mlFetch(`/items/${encodeURIComponent(audit.item_id)}`, {
      method: 'PUT',
      body: { pictures: audit.new_pictures },
    })
  );

  const verified = await withRetry('verify', () =>
    mlFetch(`/items/${encodeURIComponent(audit.item_id)}?attributes=id,status,sub_status,pictures,category_id`)
  );

  return {
    ...audit,
    applied: true,
    verified_status: verified.status,
    verified_sub_status: verified.sub_status || [],
    verified_pictures: (verified.pictures || []).map((picture) => picture.id),
  };
}

const catalog = await loadCatalog();
const catalogByItem = new Map(
  catalog.filter((product) => product?.ml_item_id).map((product) => [product.ml_item_id, product])
);

let listings = await loadListings();
if (ONLY.size > 0) {
  listings = listings.filter((listing) => {
    const product = catalogByItem.get(listing.ml_item_id);
    return ONLY.has(String(listing.ml_item_id).toUpperCase()) || ONLY.has(String(product?.sku || '').toUpperCase());
  });
}
if (LIMIT > 0) listings = listings.slice(0, LIMIT);

if (!listings.length) {
  console.log('Nenhum anuncio encontrado para os filtros informados.');
  process.exit(0);
}

console.log(`Modo: ${APPLY ? 'APLICAR' : 'DRY-RUN'} | anuncios: ${listings.length} | onda: ${WAVE}`);

const audits = [];
const backup = [];
let stopped = false;

for (let index = 0; index < listings.length; index += WAVE) {
  const wave = listings.slice(index, index + WAVE);
  console.log(`\nOnda ${Math.floor(index / WAVE) + 1}: ${wave.length} anuncio(s)`);

  for (const listing of wave) {
    try {
      let audit = await auditItem(listing, catalogByItem);
      audit = await prepareCroppedPictures(audit);
      audit = await applyAudit(audit, backup);
      audits.push(audit);
      console.log(
        `${audit.item_id} | ${audit.action} | ${audit.status} -> ${audit.verified_status || '-'} | ${audit.reason}`
      );
    } catch (err) {
      const failed = {
        item_id: listing.ml_item_id,
        error: err.message,
        status: err.status || null,
      };
      audits.push(failed);
      console.error(`${listing.ml_item_id} | ERRO: ${err.message}`);
      stopped = true;
      break;
    }
  }

  if (stopped) break;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(REPORT_PATH, JSON.stringify({ mode: APPLY ? 'apply' : 'dry-run', generated_at: new Date().toISOString(), audits }, null, 2));
if (APPLY && backup.length > 0) {
  fs.writeFileSync(BACKUP_PATH, JSON.stringify({ generated_at: new Date().toISOString(), backup }, null, 2));
}

const summary = audits.reduce((acc, audit) => {
  const key = audit.error ? 'erro' : audit.action;
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {});

console.log('\nResumo:', summary);
console.log('Relatorio:', REPORT_PATH);
if (APPLY && backup.length > 0) console.log('Backup:', BACKUP_PATH);
if (stopped) process.exitCode = 1;
