import { useCallback, useEffect, useMemo, useState } from 'react';

const rawApiUrl = (import.meta.env.VITE_API_URL || '').trim();
const API = (rawApiUrl || '/api').replace(/\/+$/, '');
const SESSION_KEY = 'melimax_dashboard_token';

function getSessionToken() {
  try {
    return window.localStorage.getItem(SESSION_KEY) || '';
  } catch {
    return '';
  }
}

function saveSessionToken(token) {
  try {
    if (token) window.localStorage.setItem(SESSION_KEY, token);
    else window.localStorage.removeItem(SESSION_KEY);
  } catch {}
}

function authHeaders() {
  const token = getSessionToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request(path, options = {}) {
  const { body, headers, ...rest } = options;
  const res = await fetch(`${API}${path}`, {
    ...rest,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...authHeaders(),
      ...(headers || {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await res.json().catch(() => null)
    : await res.text().catch(() => null);

  if (!res.ok) {
    if (res.status === 401 && data && data.code === 'DASHBOARD_LOCKED') {
      saveSessionToken('');
      window.dispatchEvent(new Event('melimax:locked'));
    }
    const error = new Error(
      (data && (data.error || data.message)) || `Erro ${res.status} ao comunicar com o servidor`
    );
    error.status = res.status;
    error.data = data;
    throw error;
  }

  return data;
}

const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

function brl(value) {
  return money.format(Number(value) || 0);
}

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function copyText(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(String(text));
    return true;
  } catch {
    const el = document.createElement('textarea');
    el.value = String(text);
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    document.body.removeChild(el);
    return true;
  }
}

const NAV_ITEMS = [
  { id: 'catalogo', label: 'Base Pronta & CSV ML', icon: 'table' },
  { id: 'custos', label: 'Custos & Lucro Real', icon: 'chart' },
  { id: 'fornecedores', label: '6 Fornecedores Brasil', icon: 'store' },
  { id: 'execucao', label: 'Execução & Rastreio', icon: 'truck' },
  { id: 'frete', label: 'Frete & Precificação', icon: 'globe' },
  { id: 'anuncios', label: 'Subir em Lote & Conta ML', icon: 'upload' },
];

const EXECUTION_STEPS = [
  { step: 1, title: 'Venda Confirmada', desc: 'Pedido pago no ML com frete grátis' },
  { step: 2, title: 'Dados de Envio', desc: 'Endereço completo do comprador copiado' },
  { step: 3, title: 'Compra AliExpress', desc: 'Comprado via CNPJ MeLi Max Shop com endereço do cliente' },
  { step: 4, title: 'Envio Brasil', desc: 'Despacho imediato do estoque nacional (até 10 dias)' },
  { step: 5, title: 'Rastreamento no ML', desc: 'Código de rastreio inserido manualmente na venda' },
];

const REGIONS_TABLE = [
  { regiao: 'Sudeste (SP, RJ, MG, ES)', modalidade: 'Vou enviar por minha conta', custo: 0, prazo: '5 a 10 dias' },
  { regiao: 'Sul (PR, SC, RS)', modalidade: 'Vou enviar por minha conta', custo: 0, prazo: '5 a 10 dias' },
  { regiao: 'Nordeste (Todos os estados)', modalidade: 'Vou enviar por minha conta', custo: 0, prazo: '5 a 10 dias' },
  { regiao: 'Centro-Oeste (DF, GO, MT, MS)', modalidade: 'Vou enviar por minha conta', custo: 0, prazo: '5 a 10 dias' },
  { regiao: 'Norte (Todos os estados)', modalidade: 'Vou enviar por minha conta', custo: 0, prazo: '5 a 10 dias' },
];

function Icon({ name, className = 'h-4 w-4' }) {
  const icons = {
    table: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M3 9h18M9 21V9" />
      </>
    ),
    store: (
      <>
        <path d="M3 9l2-5h14l2 5" />
        <path d="M21 9v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9" />
        <path d="M9 21V13h6v8" />
      </>
    ),
    truck: (
      <>
        <path d="M1 3h15v13H1z" />
        <path d="M16 8h4l3 3v5h-7V8z" />
        <circle cx="5.5" cy="18.5" r="2.5" />
        <circle cx="18.5" cy="18.5" r="2.5" />
      </>
    ),
    globe: (
      <>
        <circle cx="12" cy="12" r="10" />
        <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </>
    ),
    upload: (
      <>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="17 8 12 3 7 8" />
        <line x1="12" y1="3" x2="12" y2="15" />
      </>
    ),
    download: (
      <>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </>
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </>
    ),
    external: (
      <>
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
      </>
    ),
    copy: (
      <>
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </>
    ),
    plus: (
      <>
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </>
    ),
    check: <polyline points="20 6 9 17 4 12" />,
    close: (
      <>
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </>
    ),
    refresh: (
      <>
        <polyline points="23 4 23 10 17 10" />
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
      </>
    ),
    chart: (
      <>
        <line x1="18" y1="20" x2="18" y2="10" />
        <line x1="12" y1="20" x2="12" y2="4" />
        <line x1="6" y1="20" x2="6" y2="14" />
        <line x1="3" y1="20" x2="21" y2="20" />
      </>
    ),
    pause: (
      <>
        <rect x="6" y="4" width="4" height="16" rx="1" />
        <rect x="14" y="4" width="4" height="16" rx="1" />
      </>
    ),
    play: <polygon points="6 4 20 12 6 20 6 4" />,
  };

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {icons[name] || null}
    </svg>
  );
}

function ProductDetailModal({ product, onClose, onSaved, onPublished, notify, accountConnected }) {
  const [tituloMl, setTituloMl] = useState(product.titulo_ml || '');
  const [descricaoMl, setDescricaoMl] = useState(product.descricao_ml_otimizada || '');
  const [custoBrl, setCustoBrl] = useState(String(product.preco_custo_aliexpress_brl || ''));
  const [multiplicador, setMultiplicador] = useState(String(product.multiplicador_venda || 2.8));
  const [marca, setMarca] = useState(product.marca || 'Genérica');
  const [modelo, setModelo] = useState(product.modelo || 'Padrão');
  const [activeImage, setActiveImage] = useState(product.imagens?.[0] || product.imagem_1 || '');
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [descTab, setDescTab] = useState('otimizada');
  const [preflightBusy, setPreflightBusy] = useState(false);
  const [preflight, setPreflight] = useState(product.ml_preflight || null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [approved, setApproved] = useState(Boolean(product.ml_revisao?.aprovado));
  const [reviewCategory, setReviewCategory] = useState(
    product.ml_preflight?.categoria_ml_id || product.ml_revisao?.categoria_ml_id || product.categoria_ml_id || ''
  );
  const [anchorItemId, setAnchorItemId] = useState(product.ml_item_id || '');
  const [reviewNotes, setReviewNotes] = useState(product.ml_revisao?.observacoes || '');
  const [reviewChecks, setReviewChecks] = useState(() => ({
    categoria: Boolean(product.ml_revisao?.checks?.categoria),
    fotos: Boolean(product.ml_revisao?.checks?.fotos),
    titulo_fotos: Boolean(product.ml_revisao?.checks?.titulo_fotos),
    preco_frete: Boolean(product.ml_revisao?.checks?.preco_frete),
  }));

  useEffect(() => {
    setPreflight(product.ml_preflight || null);
    setApproved(Boolean(product.ml_revisao?.aprovado));
    setReviewCategory(
      product.ml_preflight?.categoria_ml_id || product.ml_revisao?.categoria_ml_id || product.categoria_ml_id || ''
    );
    setAnchorItemId(product.ml_item_id || '');
    setReviewNotes(product.ml_revisao?.observacoes || '');
    setReviewChecks({
      categoria: Boolean(product.ml_revisao?.checks?.categoria),
      fotos: Boolean(product.ml_revisao?.checks?.fotos),
      titulo_fotos: Boolean(product.ml_revisao?.checks?.titulo_fotos),
      preco_frete: Boolean(product.ml_revisao?.checks?.preco_frete),
    });
  }, [product.sku, product.ml_preflight, product.ml_revisao]);
  const [feeInfo, setFeeInfo] = useState(() => ({
    percentage: Number(product.taxa_ml_pct ?? 19) / 100,
    fixedFee: Number(product.taxa_ml_fixa_brl || 0),
    source: product.taxa_ml_fonte || 'stored',
    listingTypeName: product.taxa_ml_listing_type_name || 'Premium',
  }));

  const previewCalc = useMemo(() => {
    const cost = Math.max(Number(custoBrl) || 0, 0);
    const mult = Math.max(Number(multiplicador) || 2.8, 1);
    const raw = Number((cost * mult).toFixed(2));
    const finalPrice = Math.max(raw, 79.9);
    const fee = Number(
      (finalPrice * (Number(feeInfo.percentage) || 0) + Number(feeInfo.fixedFee || 0)).toFixed(2)
    );
    const taxPct = Number(product.imposto_pct ?? 6);
    const tax = Number((finalPrice * (taxPct / 100)).toFixed(2));
    const totalCost = Number((cost + fee + tax).toFixed(2));
    const net = Number((finalPrice - totalCost).toFixed(2));
    const margin = finalPrice > 0 ? Number(((net / finalPrice) * 100).toFixed(1)) : 0;
    const roi = cost > 0 ? Number(((net / cost) * 100).toFixed(1)) : 0;
    return {
      cost,
      raw,
      finalPrice,
      fee,
      tax,
      taxPct,
      totalCost,
      net,
      margin,
      roi,
      feePct: Number((Number(feeInfo.percentage) * 100).toFixed(2)),
      feeFixed: Number(feeInfo.fixedFee || 0),
      feeSource: feeInfo.source,
      piso: finalPrice > raw,
    };
  }, [custoBrl, multiplicador, feeInfo, product.imposto_pct]);

  useEffect(() => {
    if (!product.categoria_ml_id) return undefined;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const data = await request(
          `/aliexpress/taxa-ml?categoria_id=${encodeURIComponent(
            product.categoria_ml_id
          )}&preco=${encodeURIComponent(previewCalc.finalPrice)}&custo=${encodeURIComponent(
            previewCalc.cost
          )}`
        );
        if (cancelled || !data?.fee) return;
        setFeeInfo({
          percentage: Number(data.fee.percentage) || 0.19,
          fixedFee: Number(data.fee.fixed_fee || 0),
          source: data.fee.source || 'mercadolivre_api',
          listingTypeName: data.fee.listing_type_name || 'Premium',
        });
      } catch {
        // mantém a última taxa conhecida
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [product.categoria_ml_id, previewCalc.finalPrice, previewCalc.cost]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await request(`/aliexpress/produtos/${encodeURIComponent(product.sku)}`, {
        method: 'PATCH',
        body: {
          titulo_ml: tituloMl,
          descricao_ml_otimizada: descricaoMl,
          preco_custo_aliexpress_brl: Number(custoBrl),
          multiplicador_venda: Number(multiplicador),
          marca,
          modelo,
        },
      });
      notify('Produto atualizado e todos os CSVs regenerados.', 'success');
      onSaved(res.produto);
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handlePreflight = async () => {
    setPreflightBusy(true);
    try {
      const res = await request(`/aliexpress/preflight/${encodeURIComponent(product.sku)}`, {
        method: 'POST',
        body: {
          category_id: reviewCategory.trim() || undefined,
          anchor_item_id: anchorItemId.trim() || undefined,
        },
      });
      setPreflight(res.preflight);
      setApproved(false);
      setReviewChecks({ categoria: false, fotos: false, titulo_fotos: false, preco_frete: false });
      notify(
        res.ok
          ? 'Pré-publicação aprovada. Nada foi enviado ao ML; confira o relatório e faça a revisão manual.'
          : 'Pré-publicação bloqueada. Corrija os itens apontados; nada foi enviado ao ML.',
        res.ok ? 'success' : 'error'
      );
      onSaved?.(res.produto);
    } catch (err) {
      if (err?.data?.preflight) setPreflight(err.data.preflight);
      notify(err.message, 'error');
    } finally {
      setPreflightBusy(false);
    }
  };

  const handleReview = async (aprovado) => {
    setReviewBusy(true);
    try {
      const res = await request(`/aliexpress/revisao-ml/${encodeURIComponent(product.sku)}`, {
        method: 'POST',
        body: {
          aprovado,
          checks: reviewChecks,
          observacoes: reviewNotes,
        },
      });
      setApproved(Boolean(res.produto?.ml_revisao?.aprovado));
      notify(
        aprovado
          ? 'Revisão manual aprovada. O anúncio está liberado para envio pausado.'
          : 'Aprovação revogada. O anúncio voltou a ficar bloqueado.',
        'success'
      );
      onSaved?.(res.produto);
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setReviewBusy(false);
    }
  };

  const handlePublishMl = async () => {
    setPublishing(true);
    try {
      const res = await request('/aliexpress/publicar-ml', {
        method: 'POST',
        body: { sku: product.sku },
      });
      notify(`Anúncio enviado PAUSADO ao Mercado Livre: ${res.ml_item_id}.`, 'success');
      onPublished?.(res);
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setPublishing(false);
    }
  };

  const allReviewChecks = Object.values(reviewChecks).every(Boolean);
  const canPublish = Boolean(preflight?.ok && approved && !product.ml_item_id);

  const images = product.imagens?.length
    ? product.imagens
    : [product.imagem_1, product.imagem_2, product.imagem_3, product.imagem_4].filter(Boolean);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
      <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span className="font-mono font-semibold text-slate-900">{product.sku}</span>
              <span>·</span>
              <span>
                {product.fornecedor_nome} ({product.fornecedor_aprovacao_pct || '92.6%'} aprovação)
              </span>
              <span>·</span>
              <span>{images.length} imagens HD</span>
              <span>·</span>
              <span className="font-mono font-semibold text-emerald-700">
                Score interno {product.qualidade_score || 0}%
              </span>
            </div>
            <h2 className="mt-0.5 truncate text-base font-bold text-slate-900">{product.titulo_ml}</h2>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={product.url_aliexpress}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-ghost text-xs"
            >
              <Icon name="external" className="h-3.5 w-3.5" />
              Abrir no AliExpress
            </a>
            <button type="button" onClick={onClose} className="btn-ghost px-2.5 py-2" aria-label="Fechar">
              <Icon name="close" />
            </button>
          </div>
        </div>

        <div className="grid flex-1 gap-6 overflow-y-auto p-6 lg:grid-cols-12">
          <div className="space-y-5 lg:col-span-5">
            <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-50">
              {activeImage ? (
                <img
                  src={activeImage}
                  alt={product.titulo_ml}
                  className="aspect-square w-full bg-white object-contain"
                />
              ) : null}
            </div>
            <div className="grid grid-cols-5 gap-2">
              {images.map((imgUrl, i) => (
                <button
                  key={`${imgUrl}-${i}`}
                  type="button"
                  onClick={() => setActiveImage(imgUrl)}
                  className={`overflow-hidden rounded-lg border bg-white p-0.5 transition ${
                    activeImage === imgUrl
                      ? 'border-meli-blue ring-2 ring-brand-200'
                      : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <img src={imgUrl} alt={`Foto ${i + 1}`} className="aspect-square w-full object-cover" />
                </button>
              ))}
            </div>

            <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="text-xs font-semibold text-slate-700">
                Composição do Preço (Anúncio Premium · Piso R$ 79,90 · Frete Grátis Brasil)
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Custo AliExpress (R$)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={custoBrl}
                    onChange={(e) => setCustoBrl(e.target.value)}
                    className="input mt-1 font-mono"
                  />
                </div>
                <div>
                  <label className="label">Multiplicador</label>
                  <input
                    type="number"
                    step="0.1"
                    value={multiplicador}
                    onChange={(e) => setMultiplicador(e.target.value)}
                    className="input mt-1 font-mono"
                  />
                </div>
              </div>
              <div className="space-y-1.5 border-t border-slate-200 pt-3 text-xs tabular-nums">
                <div className="flex justify-between text-slate-600">
                  <span>Preço Calculado ({multiplicador}x):</span>
                  <span className="font-mono">{brl(previewCalc.raw)}</span>
                </div>
                <div className="flex justify-between font-semibold text-slate-900">
                  <span>Preço Final ML {previewCalc.piso ? '(Piso R$ 79,90)' : ''}:</span>
                  <span className="font-mono text-sm text-meli-blue">{brl(previewCalc.finalPrice)}</span>
                </div>
                <div className="flex justify-between text-slate-600">
                  <span>Custo do Produto (AliExpress):</span>
                  <span className="font-mono">- {brl(previewCalc.cost)}</span>
                </div>
                <div className="flex justify-between text-slate-600">
                  <span>
                    Comissão {feeInfo.listingTypeName} ML ({previewCalc.feePct}%
                    {previewCalc.feeFixed > 0 ? ` + ${brl(previewCalc.feeFixed)}` : ''}):
                  </span>
                  <span className="font-mono">- {brl(previewCalc.fee)}</span>
                </div>
                <div className="flex justify-between text-[11px] text-slate-500">
                  <span>Fonte da taxa</span>
                  <span>
                    {previewCalc.feeSource === 'mercadolivre_api'
                      ? 'Taxa real Mercado Livre'
                      : 'Estimativa/armazenada'}
                  </span>
                </div>
                <div className="flex justify-between text-slate-600">
                  <span>Impostos EI ({previewCalc.taxPct}%):</span>
                  <span className="font-mono">- {brl(previewCalc.tax)}</span>
                </div>
                <div className="flex justify-between text-slate-600">
                  <span>Frete Vendedor (AliExpress Brasil):</span>
                  <span className="font-mono text-emerald-700">R$ 0,00 (Grátis)</span>
                </div>
                <div className="flex justify-between border-t border-slate-200 pt-1.5 text-slate-700">
                  <span>Custo Total da Operação:</span>
                  <span className="font-mono">- {brl(previewCalc.totalCost)}</span>
                </div>
                <div className="flex justify-between font-semibold text-emerald-700">
                  <span>Lucro Líquido Real:</span>
                  <span className="font-mono">{brl(previewCalc.net)}</span>
                </div>
                <div className="flex justify-between text-[11px] text-slate-500">
                  <span>
                    Margem {previewCalc.margin}% · ROI {previewCalc.roi}% sobre o custo
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-4 lg:col-span-7">
            <div>
              <div className="flex items-center justify-between">
                <label className="label">Título para o Mercado Livre (máx. 60 caracteres)</label>
                <span
                  className={`font-mono text-xs ${
                    tituloMl.length > 60 ? 'font-semibold text-red-600' : 'text-slate-500'
                  }`}
                >
                  {tituloMl.length}/60 caracteres
                </span>
              </div>
              <div className="mt-1 flex gap-2">
                <input
                  type="text"
                  maxLength={60}
                  value={tituloMl}
                  onChange={(e) => setTituloMl(e.target.value)}
                  className="input font-medium"
                />
                <button
                  type="button"
                  onClick={async () => {
                    await copyText(tituloMl);
                    notify('Título copiado para a área de transferência.', 'success');
                  }}
                  className="btn-ghost shrink-0 px-3"
                >
                  <Icon name="copy" />
                  Copiar
                </button>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                Original AliExpress: {product.titulo_aliexpress_original}
              </p>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="label">Marca</label>
                <input
                  type="text"
                  value={marca}
                  onChange={(e) => setMarca(e.target.value)}
                  className="input mt-1"
                />
              </div>
              <div>
                <label className="label">Modelo</label>
                <input
                  type="text"
                  value={modelo}
                  onChange={(e) => setModelo(e.target.value)}
                  className="input mt-1"
                />
              </div>
              <div>
                <label className="label">SKU Vendedor (ML)</label>
                <div className="mt-1 flex items-center gap-1.5">
                  <input
                    type="text"
                    readOnly
                    value={product.sku}
                    className="input bg-slate-50 font-mono text-xs"
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      await copyText(product.sku);
                      notify('SKU copiado.', 'success');
                    }}
                    className="btn-ghost px-2.5 py-2"
                    title="Copiar SKU"
                  >
                    <Icon name="copy" className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs text-slate-600">
              <span className="font-semibold text-slate-800">Categoria ML:</span> {product.categoria_ml}
              {' · '}
              <span className="font-semibold text-slate-800">Medida/Peso:</span>{' '}
              {product.comprimento_cm}x{product.largura_cm}x{product.altura_cm} cm · {product.peso_kg} kg
              {' · '}
              <span className="font-semibold text-slate-800">Modalidade:</span> Vou enviar por minha conta (R$ 0,00 · 5 a 10 dias · Sem etiquetas)
            </div>

            <div>
              <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                <div className="flex gap-4 text-xs font-semibold">
                  <button
                    type="button"
                    onClick={() => setDescTab('otimizada')}
                    className={`pb-1 transition ${
                      descTab === 'otimizada'
                        ? 'border-b-2 border-meli-blue text-meli-blue'
                        : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    Descrição Reescrita para Mercado Livre
                  </button>
                  <button
                    type="button"
                    onClick={() => setDescTab('original')}
                    className={`pb-1 transition ${
                      descTab === 'original'
                        ? 'border-b-2 border-meli-blue text-meli-blue'
                        : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    Descrição Original Extraída
                  </button>
                  <button
                    type="button"
                    onClick={() => setDescTab('imagens')}
                    className={`pb-1 transition ${
                      descTab === 'imagens'
                        ? 'border-b-2 border-meli-blue text-meli-blue'
                        : 'text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    Links das Imagens ({images.length})
                  </button>
                </div>
                {descTab === 'otimizada' ? (
                  <button
                    type="button"
                    onClick={async () => {
                      await copyText(descricaoMl);
                      notify('Descrição completa copiada.', 'success');
                    }}
                    className="text-xs font-semibold text-meli-blue hover:underline"
                  >
                    Copiar Descrição
                  </button>
                ) : null}
              </div>

              {descTab === 'otimizada' && (
                <textarea
                  rows={12}
                  value={descricaoMl}
                  onChange={(e) => setDescricaoMl(e.target.value)}
                  className="input mt-2 font-mono text-xs leading-relaxed"
                />
              )}
              {descTab === 'original' && (
                <textarea
                  rows={12}
                  readOnly
                  value={product.descricao_aliexpress_original || ''}
                  className="input mt-2 bg-slate-50 font-mono text-xs leading-relaxed text-slate-600"
                />
              )}
              {descTab === 'imagens' && (
                <div className="mt-2 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                  {images.map((url, idx) => (
                    <div key={`${url}-${idx}`} className="flex items-center gap-2 text-xs">
                      <span className="w-16 shrink-0 font-mono font-semibold text-slate-500">
                        Imagem {idx + 1}
                      </span>
                      <input type="text" readOnly value={url} className="input py-1.5 font-mono text-xs" />
                      <button
                        type="button"
                        onClick={async () => {
                          await copyText(url);
                          notify(`URL da Imagem ${idx + 1} copiada.`, 'success');
                        }}
                        className="btn-ghost px-2.5 py-1.5 text-xs"
                      >
                        Copiar
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-3 rounded-xl border border-amber-300 bg-amber-50/70 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-bold text-slate-900">Pré-publicação obrigatória</div>
                  <p className="mt-1 max-w-xl text-[11px] leading-relaxed text-slate-700">
                    Nada é enviado ao Mercado Livre nesta etapa. O sistema baixa e inspeciona as fotos,
                    limpa título/descrição, aplica o piso de preço, valida categoria, atributos, frete
                    grátis sem etiqueta e a payload oficial do ML. Só depois da revisão manual o envio
                    pausado é liberado.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={preflightBusy}
                  onClick={handlePreflight}
                  className="btn-primary text-xs"
                >
                  {preflightBusy ? 'Verificando sem publicar...' : '1. Preparar e verificar'}
                </button>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <label className="label text-[11px]">Categoria folha MLB</label>
                  <input
                    type="text"
                    value={reviewCategory}
                    onChange={(e) => setReviewCategory(e.target.value.toUpperCase())}
                    placeholder="MLB1234"
                    className="input mt-1 font-mono text-xs"
                  />
                </div>
                <div>
                  <label className="label text-[11px]">Anúncio âncora p/ diagnóstico de fotos</label>
                  <input
                    type="text"
                    value={anchorItemId}
                    onChange={(e) => setAnchorItemId(e.target.value.toUpperCase())}
                    placeholder="MLB1234567890"
                    className="input mt-1 font-mono text-xs"
                  />
                </div>
              </div>

              {Array.isArray(preflight?.categoria_candidatas) && preflight.categoria_candidatas.length > 0 ? (
                <div className="space-y-1.5 rounded-lg border border-slate-200 bg-white p-2.5">
                  <div className="text-[11px] font-semibold text-slate-700">Candidatas de categoria:</div>
                  {preflight.categoria_candidatas.map((candidate) => (
                    <button
                      key={candidate.category_id}
                      type="button"
                      onClick={() => {
                        setReviewCategory(candidate.category_id);
                        notify('Categoria selecionada. Clique em "Preparar e verificar" novamente.', 'info');
                      }}
                      className={`block w-full rounded border px-2 py-1.5 text-left text-[11px] ${
                        reviewCategory === candidate.category_id
                          ? 'border-meli-blue bg-blue-50 text-meli-blue'
                          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      <span className="font-mono font-semibold">{candidate.category_id}</span>
                      <span className="mx-1.5">·</span>
                      {candidate.category_name}
                    </button>
                  ))}
                </div>
              ) : null}

              {preflight ? (
                <div className="space-y-2 text-[11px]">
                  <div
                    className={`rounded-lg border px-2.5 py-2 font-semibold ${
                      preflight.ok
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                        : 'border-red-200 bg-red-50 text-red-800'
                    }`}
                  >
                    {preflight.ok
                      ? 'Pré-publicação aprovada: nenhum bloqueio automático encontrado.'
                      : 'Pré-publicação bloqueada: corrija os itens abaixo e verifique novamente.'}
                  </div>

                  {Array.isArray(preflight.blockers) && preflight.blockers.length > 0 ? (
                    <div className="rounded-lg border border-red-200 bg-white p-2.5">
                      <div className="font-semibold text-red-700">Bloqueios</div>
                      <ul className="mt-1 list-disc space-y-1 pl-4 text-red-700">
                        {preflight.blockers.map((item, idx) => (
                          <li key={`${item}-${idx}`}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {Array.isArray(preflight.adjustments) && preflight.adjustments.length > 0 ? (
                    <div className="rounded-lg border border-blue-200 bg-white p-2.5">
                      <div className="font-semibold text-blue-700">Ajustes seguros aplicados</div>
                      <ul className="mt-1 list-disc space-y-1 pl-4 text-blue-700">
                        {preflight.adjustments.map((item, idx) => (
                          <li key={`${item}-${idx}`}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {Array.isArray(preflight.warnings) && preflight.warnings.length > 0 ? (
                    <div className="rounded-lg border border-amber-200 bg-white p-2.5">
                      <div className="font-semibold text-amber-700">Avisos</div>
                      <ul className="mt-1 list-disc space-y-1 pl-4 text-amber-700">
                        {preflight.warnings.map((item, idx) => (
                          <li key={`${item}-${idx}`}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  <div className="grid grid-cols-2 gap-1.5 text-[11px] sm:grid-cols-3">
                    {[
                      ['Título', preflight.checks?.titulo],
                      ['Descrição', preflight.checks?.descricao],
                      ['Preço', preflight.checks?.preco],
                      ['Imagens', preflight.checks?.imagens],
                      ['Fotos sem texto', preflight.checks?.fotos],
                      ['Categoria', preflight.checks?.categoria],
                      ['Frete grátis', preflight.checks?.frete],
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        className={`rounded border px-2 py-1 ${
                          value
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                            : 'border-red-200 bg-red-50 text-red-700'
                        }`}
                      >
                        {label}: {value ? 'OK' : 'Pendente'}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-slate-200 bg-white p-2.5 text-[11px] text-slate-600">
                  Rode a pré-publicação para ver os bloqueios reais. Nenhuma chamada de criação é feita.
                </div>
              )}

              <div className="space-y-2 border-t border-amber-200 pt-3">
                <div className="text-xs font-bold text-slate-900">2. Revisão manual obrigatória</div>
                {[
                  ['categoria', 'Categoria folha conferida no Mercado Livre.'],
                  ['fotos', 'Fotos conferidas: sem texto, marca d’água, logo ou faixa promocional.'],
                  ['titulo_fotos', 'Título corresponde exatamente ao produto e às fotos.'],
                  ['preco_frete', 'Preço, custo, frete grátis sem etiqueta e estoque conferidos.'],
                ].map(([key, label]) => (
                  <label key={key} className="flex items-start gap-2 text-[11px] text-slate-700">
                    <input
                      type="checkbox"
                      checked={Boolean(reviewChecks[key])}
                      onChange={(e) =>
                        setReviewChecks((prev) => ({ ...prev, [key]: e.target.checked }))
                      }
                      className="mt-0.5 h-3.5 w-3.5 rounded border-slate-300 text-meli-blue"
                    />
                    <span>{label}</span>
                  </label>
                ))}
                <textarea
                  rows={2}
                  value={reviewNotes}
                  onChange={(e) => setReviewNotes(e.target.value)}
                  placeholder="Observações da conferência (opcional)"
                  className="input text-[11px]"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={!preflight?.ok || !allReviewChecks || reviewBusy}
                    onClick={() => handleReview(true)}
                    className="btn-accent text-xs"
                  >
                    {reviewBusy ? 'Salvando revisão...' : approved ? 'Revisão aprovada' : 'Aprovar revisão'}
                  </button>
                  {approved ? (
                    <button
                      type="button"
                      disabled={reviewBusy}
                      onClick={() => handleReview(false)}
                      className="btn-ghost text-xs"
                    >
                      Revogar aprovação
                    </button>
                  ) : null}
                  <span className="text-[11px] text-slate-600">
                    {canPublish
                      ? 'Liberado apenas para envio PAUSADO.'
                      : 'Envio bloqueado até pré-publicação + revisão.'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-6 py-3.5">
          <div className="text-xs text-slate-600">
            Score interno:{' '}
            <strong className="font-mono text-emerald-700">{product.qualidade_score || 0}%</strong> ·
            mínimo 85% · frete e etiquetas precisam ser confirmados no ML
          </div>
          <div className="flex items-center gap-2.5">
            {accountConnected ? (
              <button
                type="button"
                disabled={publishing || !canPublish}
                onClick={handlePublishMl}
                className="btn-accent text-xs"
                title={canPublish ? 'Enviar pausado ao ML' : 'Aprove a pré-publicação e a revisão manual primeiro'}
              >
                {publishing ? 'Enviando...' : '3. Enviar PAUSADO ao ML'}
              </button>
            ) : null}
            <button type="button" disabled={saving} onClick={handleSave} className="btn-primary text-xs">
              {saving ? 'Salvando...' : 'Salvar Alterações & Atualizar CSV'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [activeNav, setActiveNav] = useState('catalogo');
  const [toast, setToast] = useState(null);

  const [sessionUser, setSessionUser] = useState(null);
  const [authState, setAuthState] = useState('loading');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const authReady = authState === 'ready' || authState === 'open';

  const [account, setAccount] = useState(null);
  const [authConfig, setAuthConfig] = useState(null);

  const [catalogData, setCatalogData] = useState({
    resumo: null,
    auditoria_lote2: null,
    produtos: [],
    total_filtrado: 0,
  });
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSupplier, setSelectedSupplier] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [pisoFilter, setPisoFilter] = useState('');
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedSkus, setSelectedSkus] = useState([]);

  const [scrapeUrl, setScrapeUrl] = useState('');
  const [scrapeCost, setScrapeCost] = useState('');
  const [scraping, setScraping] = useState(false);

  const [batchMultiplier, setBatchMultiplier] = useState('2.8');
  const [recalculating, setRecalculating] = useState(false);

  // 6 Approved Brazilian Suppliers
  const [approvedStores, setApprovedStores] = useState([]);
  const [miningStoreId, setMiningStoreId] = useState('');
  const [mineLimit, setMineLimit] = useState('25');
  const [lastMineReport, setLastMineReport] = useState(null);

  // Automated ML Batch Upload
  const [uploadBatchSize, setUploadBatchSize] = useState('20');
  const [uploadSupplierFilter, setUploadSupplierFilter] = useState('');
  const [uploadingBatch, setUploadingBatch] = useState(false);
  const [lastUploadReport, setLastUploadReport] = useState(null);
  const [statusBusy, setStatusBusy] = useState(null);
  const [lastStatusReport, setLastStatusReport] = useState(null);

  // Order Execution & Manual Tracking
  const [ordersState, setOrdersState] = useState({
    connected: false,
    orders: [],
    execucoes_manuais: [],
  });
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [skuLookupInput, setSkuLookupInput] = useState('');
  const [manualForm, setManualForm] = useState({
    order_id: '',
    sku: '',
    buyer_name: '',
    shipping_address: '',
    aliexpress_order_id: '',
    tracking_number: '',
    carrier: 'J&T Express / Cainiao Brasil',
    step: 1,
    enviar_ml: true,
  });
  const [savingTracking, setSavingTracking] = useState(false);

  // Pricing Simulator
  const [simCost, setSimCost] = useState('28.00');
  const [simMult, setSimMult] = useState('2.8');

  const [listings, setListings] = useState([]);

  const notify = useCallback((message, type = 'info') => {
    setToast({ message, type });
    setTimeout(() => {
      setToast((prev) => (prev?.message === message ? null : prev));
    }, 4500);
  }, []);

  const loadAccount = useCallback(async () => {
    try {
      const [me, cfg] = await Promise.all([
        request('/auth/me').catch(() => ({ connected: false })),
        request('/auth/config').catch(() => ({ configured: false })),
      ]);
      setAccount(me?.connected ? me : null);
      setAuthConfig(cfg);
    } catch {}
  }, []);

  const loadCatalog = useCallback(async () => {
    setLoadingCatalog(true);
    try {
      const params = new URLSearchParams();
      if (searchQuery.trim()) params.set('q', searchQuery.trim());
      if (selectedSupplier) params.set('fornecedor', selectedSupplier);
      if (selectedCategory) params.set('categoria', selectedCategory);
      if (pisoFilter) params.set('piso', pisoFilter);
      const data = await request(`/aliexpress/produtos?${params.toString()}`);
      setCatalogData(data);
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setLoadingCatalog(false);
    }
  }, [searchQuery, selectedSupplier, selectedCategory, pisoFilter, notify]);

  const loadApprovedStores = useCallback(async () => {
    try {
      const data = await request('/aliexpress/fornecedores-homologados');
      setApprovedStores(data?.fornecedores || []);
    } catch {}
  }, []);

  const loadOrders = useCallback(async () => {
    setLoadingOrders(true);
    try {
      const data = await request('/orders');
      setOrdersState({
        connected: Boolean(data?.connected),
        orders: data?.orders || [],
        execucoes_manuais: data?.execucoes_manuais || [],
      });
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setLoadingOrders(false);
    }
  }, [notify]);

  const loadListings = useCallback(async () => {
    try {
      const data = await request('/listings');
      setListings(Array.isArray(data) ? data : []);
    } catch {}
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const status = await request('/auth/painel');
        if (!alive) return;
        if (!status?.protected) {
          setAuthState('open');
          return;
        }
        if (!getSessionToken()) {
          setAuthState('locked');
          return;
        }
        try {
          const me = await request('/auth/sessao');
          if (!alive) return;
          if (me?.user?.id) {
            setSessionUser(me.user);
            setAuthState('ready');
          } else {
            saveSessionToken('');
            setAuthState('locked');
          }
        } catch {
          saveSessionToken('');
          if (alive) setAuthState('locked');
        }
      } catch {
        if (alive) setAuthState('locked');
      }
    })();
    const onLocked = () => {
      saveSessionToken('');
      setSessionUser(null);
      setAuthState('locked');
    };
    window.addEventListener('melimax:locked', onLocked);
    return () => {
      alive = false;
      window.removeEventListener('melimax:locked', onLocked);
    };
  }, []);

  useEffect(() => {
    if (!authReady) return;
    loadAccount();
    loadApprovedStores();
  }, [authReady, loadAccount, loadApprovedStores]);

  useEffect(() => {
    if (!authReady) return;
    loadCatalog();
  }, [authReady, loadCatalog]);

  useEffect(() => {
    if (!authReady) return;
    if (activeNav === 'fornecedores') loadApprovedStores();
    if (activeNav === 'execucao') loadOrders();
    if (activeNav === 'anuncios') loadListings();
  }, [authReady, activeNav, loadApprovedStores, loadOrders, loadListings]);

  const handleScrapeNew = async (e) => {
    e.preventDefault();
    if (!scrapeUrl.trim()) return;
    setScraping(true);
    try {
      const res = await request('/aliexpress/scrape', {
        method: 'POST',
        body: {
          url: scrapeUrl.trim(),
          custo_brl: scrapeCost ? Number(scrapeCost) : null,
          multiplicador: Number(batchMultiplier) || 2.8,
          salvar: true,
        },
      });
      setScrapeUrl('');
      setScrapeCost('');
      notify(
        `Produto ${res.produto.sku} extraído (${res.produto.qtd_imagens} fotos, Qualidade ${res.produto.qualidade_score}%) e incluído na base!`,
        'success'
      );
      await Promise.all([loadCatalog(), loadApprovedStores()]);
      setSelectedProduct(res.produto);
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setScraping(false);
    }
  };

  const handleMineStore = async (storeId) => {
    setMiningStoreId(storeId);
    try {
      const res = await request('/aliexpress/importar-loja', {
        method: 'POST',
        body: {
          storeId,
          limite: Number(mineLimit) || 25,
          multiplicador: Number(batchMultiplier) || 2.8,
        },
      });
      setLastMineReport(res);
      notify(
        `${res.loja}: +${res.adicionados} novos produtos prontos adicionados (${res.descartados_frete_pago} sem frete grátis e ${res.descartados_duplicados} repetidos bloqueados).`,
        'success'
      );
      await Promise.all([loadCatalog(), loadApprovedStores()]);
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setMiningStoreId('');
    }
  };

  const handleBatchRecalculate = async () => {
    setRecalculating(true);
    try {
      const res = await request('/aliexpress/recalcular-lote', {
        method: 'POST',
        body: {
          multiplicador: Number(batchMultiplier) || 2.8,
          preco_minimo: 79.9,
        },
      });
      notify(`${res.total_atualizados} produtos recalculados e todos os CSVs atualizados.`, 'success');
      await loadCatalog();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setRecalculating(false);
    }
  };

  const handleSyncMlStatus = async () => {
    setStatusBusy('sync');
    try {
      const res = await request('/aliexpress/sincronizar-status', {
        method: 'POST',
        body: { limite: 200 },
      });
      setLastStatusReport({ tipo: 'sincronizacao', ...res });
      notify(
        `Status real sincronizado: ${res.atualizados} anúncio(s) atualizado(s), ${res.falhas} falha(s).`,
        res.falhas ? 'error' : 'success'
      );
      await Promise.all([loadCatalog(), loadListings()]);
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setStatusBusy(null);
    }
  };

  const handleStatusLote = async (acao) => {
    if (acao === 'ativar' && !window.confirm('Ativar em massa SOMENTE os anúncios com pré-publicação e revisão aprovadas. Continuar?')) {
      return;
    }
    if (acao === 'pausar' && !window.confirm('Desativar todos os anúncios no Mercado Livre agora? Continuar?')) {
      return;
    }
    setStatusBusy(acao);
    try {
      const res = await request('/aliexpress/status-lote', {
        method: 'POST',
        body: { acao, limite: 100 },
      });
      setLastStatusReport({ tipo: acao, ...res });
      const extra =
        acao === 'ativar'
          ? `${res.atualizados} ativado(s), ${res.bloqueados?.length || 0} bloqueado(s) sem gate.`
          : `${res.atualizados} desativado(s)/oculto(s), ${res.falhas} falha(s).`;
      notify(extra, res.falhas || (res.bloqueados?.length && acao === 'ativar') ? 'error' : 'success');
      await Promise.all([loadCatalog(), loadListings()]);
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setStatusBusy(null);
    }
  };

  const handleBatchUploadMl = async (customSkus = null) => {
    setUploadingBatch(true);
    try {
      const payload =
        Array.isArray(customSkus) && customSkus.length > 0
          ? {
              skus: customSkus,
              limite: customSkus.length,
            }
          : {
              limite: Number(uploadBatchSize) || 20,
              fornecedor: uploadSupplierFilter,
            };

      const res = await request('/aliexpress/publicar-lote', {
        method: 'POST',
        body: payload,
      });
      setLastUploadReport(res);
      if (res.enviados > 0) {
        setSelectedSkus([]);
        const bloqueados = Array.isArray(res.bloqueados) ? res.bloqueados.length : 0;
        if (res.falhas > 0 || bloqueados > 0) {
          notify(
            `${res.enviados} enviado(s) pausado(s), ${res.falhas} falha(s) e ${bloqueados} bloqueado(s) sem pré-publicação/revisão. Veja o relatório.`,
            'error'
          );
        } else {
          notify(`${res.enviados} anúncio(s) aprovado(s) enviados PAUSADOS ao Mercado Livre.`, 'success');
        }
      } else {
        const firstErr =
          res.bloqueados?.[0]?.missing?.join('; ') ||
          res.resultados?.[0]?.error ||
          'Nenhum item passou pela pré-publicação e revisão. Nada foi enviado.';
        notify(firstErr, 'error');
      }
      await Promise.all([loadCatalog(), loadListings()]);
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setUploadingBatch(false);
    }
  };

  const toggleSkuSelection = (sku) => {
    setSelectedSkus((prev) =>
      prev.includes(sku) ? prev.filter((item) => item !== sku) : [...prev, sku]
    );
  };

  const toggleSelectAllVisible = () => {
    const visibleSkus = (catalogData.produtos || []).map((p) => p.sku);
    if (!visibleSkus.length) return;
    const allSelected = visibleSkus.every((sku) => selectedSkus.includes(sku));
    if (allSelected) {
      setSelectedSkus((prev) => prev.filter((sku) => !visibleSkus.includes(sku)));
    } else {
      setSelectedSkus((prev) => [...new Set([...prev, ...visibleSkus])]);
    }
  };

  const matchedLookupProduct = useMemo(() => {
    const q = skuLookupInput.trim().toUpperCase();
    if (!q) return null;
    return (
      (catalogData.produtos || []).find(
        (p) =>
          p.sku.toUpperCase().includes(q) ||
          p.codigo_interno.toUpperCase() === q ||
          p.aliexpress_item_id.includes(q)
      ) || null
    );
  }, [skuLookupInput, catalogData.produtos]);

  const handleSaveManualExecution = async (e) => {
    e.preventDefault();
    if (!manualForm.order_id.trim()) {
      notify('Informe o número do pedido do Mercado Livre.', 'error');
      return;
    }
    setSavingTracking(true);
    try {
      await request(`/orders/${encodeURIComponent(manualForm.order_id.trim())}/rastreio`, {
        method: 'POST',
        body: manualForm,
      });
      notify('Fluxo de execução e código de rastreamento salvos com sucesso.', 'success');
      setManualForm((prev) => ({
        ...prev,
        order_id: '',
        aliexpress_order_id: '',
        tracking_number: '',
      }));
      await loadOrders();
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setSavingTracking(false);
    }
  };

  const handleLogin = async (event) => {
    event.preventDefault();
    const password = loginPassword.trim();
    if (!password) return;
    setLoginBusy(true);
    setLoginError('');
    try {
      const data = await request('/auth/painel', {
        method: 'POST',
        body: { password },
      });
      if (data?.token) {
        saveSessionToken(data.token);
        setSessionUser(data.user || { username: 'admin' });
        setLoginPassword('');
        setAuthState('ready');
      } else {
        setAuthState('open');
      }
    } catch (err) {
      setLoginError(err.message || 'Senha inválida.');
    } finally {
      setLoginBusy(false);
    }
  };

  const handleSessionLogout = () => {
    saveSessionToken('');
    setSessionUser(null);
    setAuthState('locked');
    setLoginPassword('');
    setLoginError('');
  };

  const handleDownloadCsv = async (path, filename) => {
    try {
      const res = await fetch(`${API}${path}`, { headers: authHeaders() });
      if (!res.ok) {
        let message = `Erro ${res.status} ao baixar CSV`;
        try {
          const data = await res.json();
          message = data?.error || message;
        } catch {}
        throw new Error(message);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      notify(err.message, 'error');
    }
  };

  const handleConnectMl = async () => {
    try {
      const data = await request('/auth/ml/url');
      if (data?.url) {
        window.location.href = data.url;
      }
    } catch (err) {
      notify(err.message, 'error');
    }
  };

  const handleDisconnectMl = async () => {
    try {
      await request('/auth/logout', { method: 'POST' });
      setAccount(null);
      notify('Conta Mercado Livre desconectada.', 'info');
    } catch (err) {
      notify(err.message, 'error');
    }
  };

  const simResult = useMemo(() => {
    const c = Math.max(Number(simCost) || 0, 0);
    const m = Math.max(Number(simMult) || 2.8, 1);
    const calc = Number((c * m).toFixed(2));
    const finalPrice = Math.max(calc, 79.9);
    const fee = Number((finalPrice * 0.19).toFixed(2));
    const tax = Number((finalPrice * 0.06).toFixed(2));
    const net = Number((finalPrice - c - fee - tax).toFixed(2));
    const roi = c > 0 ? Number(((net / c) * 100).toFixed(1)) : 0;
    return { c, calc, finalPrice, fee, tax, net, roi, piso: finalPrice > calc };
  }, [simCost, simMult]);

  const resumo = catalogData.resumo || {
    total: 0,
    com_4_imagens: 0,
    acima_85_qualidade: 0,
    qualidade_media_pct: 0,
    prontos_para_subir: 0,
    publicados_ml: 0,
    piso_79_90_count: 0,
    custo_medio: 0,
    custo_produto_medio: 0,
    custo_total_medio: 0,
    comissao_media: 0,
    imposto_medio: 0,
    frete_medio: 0,
    venda_media: 0,
    lucro_liquido_medio: 0,
    margem_liquida_pct: 0,
    roi_medio_pct: 0,
    roi_medio_simples_pct: 0,
    venda_total: 0,
    custo_produto_total: 0,
    comissao_total: 0,
    imposto_total: 0,
    frete_total: 0,
    custo_total_operacao: 0,
    lucro_liquido_total: 0,
    categorias: [],
    fornecedores: [],
  };

  const costAudit = useMemo(() => {
    const products = catalogData.produtos || [];
    const r2 = (value) => Number((Number(value) || 0).toFixed(2));
    const r1 = (value) => Number((Number(value) || 0).toFixed(1));
    const totalSale = r2(products.reduce((acc, p) => acc + Number(p.preco_venda_ml_sugerido || 0), 0));
    const totalProductCost = r2(
      products.reduce(
        (acc, p) => acc + Number(p.custo_produto_brl ?? p.preco_custo_aliexpress_brl ?? 0),
        0
      )
    );
    const totalFees = r2(
      products.reduce(
        (acc, p) => acc + Number(p.taxa_ml_estimada_brl || 0) + Number(p.custo_listagem_ml_brl || 0),
        0
      )
    );
    const totalTaxes = r2(
      products.reduce((acc, p) => acc + Number(p.imposto_estimado_brl || 0), 0)
    );
    const totalShipping = r2(
      products.reduce((acc, p) => acc + Number(p.custo_frete_vendedor_brl || 0), 0)
    );
    const totalOperational = r2(
      products.reduce((acc, p) => acc + Number(p.custo_total_operacao_brl || 0), 0)
    );
    const totalNet = r2(
      products.reduce((acc, p) => acc + Number(p.lucro_liquido_estimado_brl || 0), 0)
    );

    const feeMap = new Map();
    const categoryMap = new Map();
    for (const product of products) {
      const feePct = Number(product.taxa_ml_pct ?? 19);
      const fixed = Number(product.taxa_ml_fixa_brl || 0);
      const feeKey = `${feePct}|${fixed.toFixed(2)}`;
      const feeEntry = feeMap.get(feeKey) || {
        taxa_ml_pct: feePct,
        taxa_ml_fixa_brl: fixed,
        produtos: 0,
        total_comissao_brl: 0,
      };
      feeEntry.produtos += 1;
      feeEntry.total_comissao_brl = r2(
        feeEntry.total_comissao_brl + Number(product.taxa_ml_estimada_brl || 0)
      );
      feeMap.set(feeKey, feeEntry);

      const catKey = product.categoria_ml_id || 'SEM_CATEGORIA';
      const catEntry = categoryMap.get(catKey) || {
        categoria_ml_id: catKey,
        categoria_ml: product.categoria_ml || '—',
        produtos: 0,
        taxas: new Set(),
        total_comissao_brl: 0,
        total_impostos_brl: 0,
        total_lucro_brl: 0,
        total_custo_produto_brl: 0,
      };
      catEntry.produtos += 1;
      catEntry.taxas.add(`${feePct}%`);
      catEntry.total_comissao_brl = r2(
        catEntry.total_comissao_brl + Number(product.taxa_ml_estimada_brl || 0)
      );
      catEntry.total_impostos_brl = r2(
        catEntry.total_impostos_brl + Number(product.imposto_estimado_brl || 0)
      );
      catEntry.total_lucro_brl = r2(
        catEntry.total_lucro_brl + Number(product.lucro_liquido_estimado_brl || 0)
      );
      catEntry.total_custo_produto_brl = r2(
        catEntry.total_custo_produto_brl +
          Number(product.custo_produto_brl ?? product.preco_custo_aliexpress_brl ?? 0)
      );
      categoryMap.set(catKey, catEntry);
    }

    return {
      total: products.length,
      totalSale,
      totalProductCost,
      totalFees,
      totalTaxes,
      totalShipping,
      totalOperational,
      totalNet,
      marginPct: r1(totalSale > 0 ? (totalNet / totalSale) * 100 : 0),
      roiPct: r1(totalProductCost > 0 ? (totalNet / totalProductCost) * 100 : 0),
      fallback: products.filter(
        (p) => p.taxa_ml_fonte && p.taxa_ml_fonte !== 'mercadolivre_api'
      ).length,
      negative: products.filter((p) => Number(p.lucro_liquido_estimado_brl) < 0).length,
      withDetail: products.filter((p) => p.detalhamento_custos).length,
      feeDistribution: [...feeMap.values()].sort((a, b) => b.produtos - a.produtos),
      categories: [...categoryMap.values()]
        .map((entry) => ({
          ...entry,
          taxas: [...entry.taxas].sort((a, b) => parseFloat(a) - parseFloat(b)),
          roiPct: r1(
            entry.total_custo_produto_brl > 0
              ? (entry.total_lucro_brl / entry.total_custo_produto_brl) * 100
              : 0
          ),
        }))
        .sort((a, b) => b.produtos - a.produtos),
      products: [...products].sort(
        (a, b) =>
          Number(b.lucro_liquido_estimado_brl || 0) -
          Number(a.lucro_liquido_estimado_brl || 0)
      ),
    };
  }, [catalogData.produtos]);

  const csvQuerySuffix = selectedSupplier
    ? `&fornecedor=${encodeURIComponent(selectedSupplier)}`
    : '';

  if (authState === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F4F5F7] text-slate-900">
        <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4 text-sm font-medium text-slate-600 shadow-sm">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-meli-blue" />
          Verificando acesso ao painel...
        </div>
      </div>
    );
  }

  if (authState === 'locked') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F4F5F7] px-4 text-slate-900">
        <div className="w-full max-w-sm">
          <div className="mb-5 flex items-center justify-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-meli-yellow text-lg font-bold text-meli-ink">
              M
            </div>
            <div>
              <div className="text-base font-bold leading-tight text-slate-900">MeLi Max Shop</div>
              <div className="text-[11px] text-slate-500">AliExpress Brasil · Mercado Livre</div>
            </div>
          </div>

          <form onSubmit={handleLogin} className="surface space-y-4 p-6">
            <div>
              <h1 className="text-lg font-bold tracking-tight text-slate-900">Acesso restrito</h1>
              <p className="mt-1 text-xs text-slate-500">
                Informe a senha do painel para liberar a base, os custos e a operação.
              </p>
            </div>

            <div>
              <label className="label" htmlFor="dashboard-password">
                Senha de acesso
              </label>
              <input
                id="dashboard-password"
                type="password"
                autoFocus
                autoComplete="current-password"
                value={loginPassword}
                onChange={(event) => setLoginPassword(event.target.value)}
                className="input mt-1"
                placeholder="Digite sua senha"
              />
            </div>

            {loginError ? (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-700">
                {loginError}
              </div>
            ) : null}

            <button type="submit" disabled={loginBusy} className="btn-primary w-full py-2">
              {loginBusy ? 'Entrando...' : 'Entrar no painel'}
            </button>

            <p className="text-center text-[10px] leading-4 text-slate-400">
              Sessão protegida por token assinado. Esqueceu a senha? Rode o script
              {' '}<span className="font-mono">definir-senha-painel.mjs</span> no servidor.
            </p>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F4F5F7] text-slate-900">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <div className="flex flex-wrap items-center gap-5">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-meli-yellow font-bold text-meli-ink">
                M
              </div>
              <div>
                <div className="text-sm font-bold leading-tight text-slate-900">MeLi Max Shop</div>
                <div className="text-[11px] text-slate-500">AliExpress Brasil · Mercado Livre</div>
              </div>
            </div>

            <nav className="flex flex-wrap items-center gap-1">
              {NAV_ITEMS.map((item) => {
                const active = activeNav === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActiveNav(item.id)}
                    className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition ${
                      active
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                    }`}
                  >
                    <Icon name={item.icon} className="h-3.5 w-3.5" />
                    {item.label}
                  </button>
                );
              })}
            </nav>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() =>
                handleDownloadCsv(
                  `/aliexpress/export-csv?formato=completo${csvQuerySuffix}`,
                  'mercadolivre_aliexpress_completo.csv'
                )
              }
              className="btn-primary py-1.5 text-xs"
            >
              <Icon name="download" className="h-3.5 w-3.5" />
              {selectedSupplier
                ? `CSV ${selectedSupplier} (${catalogData.total_filtrado})`
                : `CSV Completo (${resumo.total})`}
            </button>
            <button
              type="button"
              onClick={() =>
                handleDownloadCsv(
                  `/aliexpress/export-csv?formato=planilha_ml${csvQuerySuffix}`,
                  'mercadolivre_planilha_publicacao.csv'
                )
              }
              className="btn-ghost py-1.5 text-xs"
            >
              <Icon name="download" className="h-3.5 w-3.5" />
              Planilha ML (;)
            </button>

            <div className="h-5 w-px bg-slate-200" />

            {account ? (
              <span className="text-xs font-semibold text-emerald-700">{account.nickname}</span>
            ) : (
              <button
                type="button"
                onClick={() => setActiveNav('anuncios')}
                className="text-xs font-medium text-slate-500 hover:text-meli-blue"
              >
                Aguardando CNAE / Conexão ML
              </button>
            )}

            {sessionUser ? (
              <>
                <div className="h-5 w-px bg-slate-200" />
                <button
                  type="button"
                  onClick={handleSessionLogout}
                  className="text-xs font-medium text-slate-500 hover:text-red-600"
                >
                  Sair
                </button>
              </>
            ) : null}
          </div>
        </div>
      </header>

      {toast ? (
        <div className="fixed bottom-5 right-5 z-50 max-w-md rounded-xl border border-slate-200 bg-slate-900 px-4 py-3 text-xs font-medium text-white shadow-lg">
          {toast.message}
        </div>
      ) : null}

      <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6">
        {/* VIEW 1: BASE PRONTA 1-CLICK & CSV MERCADO LIVRE */}
        {activeNav === 'catalogo' && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h1 className="text-xl font-bold tracking-tight text-slate-900">
                  Base de Produtos para Pré-Publicação (score interno ≥85 + revisão)
                </h1>
                <p className="mt-0.5 text-sm text-slate-600">
                  Catálogo deduplicado com estoque no Brasil, 4+ fotos, título até 60 caracteres e sobrepreço 2.8x (piso R$ 79,90). Nenhum item vai ao ML sem pré-publicação automática e revisão manual.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    handleDownloadCsv(
                      `/aliexpress/export-csv?formato=completo&fornecedor=${encodeURIComponent('DropFacil Store')}`,
                      'mercadolivre_aliexpress_dropfacil_lote2.csv'
                    )
                  }
                  className="btn-ghost py-1.5 text-xs"
                >
                  <Icon name="download" className="h-3.5 w-3.5" />
                  Baixar CSV Lote 2 · DropFacil Store
                </button>
                <button
                  type="button"
                  onClick={() => setActiveNav('fornecedores')}
                  className="btn-dark py-1.5 text-xs"
                >
                  <Icon name="plus" className="h-3.5 w-3.5" />
                  Minerar das 6 Lojas Brasil
                </button>
              </div>
            </div>

            {/* 4 KPI Cards */}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="surface p-4">
                <div className="label">Base Pronta Sem Repetições</div>
                <div className="mt-1.5 flex items-baseline gap-2">
                  <span className="font-mono text-2xl font-bold text-slate-900 tabular-nums">
                    {resumo.total}
                  </span>
                  <span className="text-xs font-medium text-emerald-700">
                    {resumo.com_4_imagens}/{resumo.total} com 4+ fotos HD
                  </span>
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  {(resumo.fornecedores || []).map((f) => `${f.nome}: ${f.qtd}`).join(' · ')}
                </div>
              </div>

              <div className="surface p-4">
                <div className="label">Score Interno (não é nota do ML)</div>
                <div className="mt-1.5 flex items-baseline gap-2 font-mono tabular-nums">
                  <span className="text-2xl font-bold text-emerald-700">
                    {resumo.qualidade_media_pct || 0}%
                  </span>
                  <span className="text-xs font-semibold text-slate-600">
                    {resumo.acima_85_qualidade}/{resumo.total} com score ≥85
                  </span>
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  {resumo.revisao_aprovada || 0} liberados após revisão · {resumo.revisao_pendente || 0} pendentes
                </div>
              </div>

              <div className="surface p-4">
                <div className="label">Custo Total Médio → Venda Média ML</div>
                <div className="mt-1.5 flex items-baseline gap-2 font-mono tabular-nums">
                  <span className="text-lg font-semibold text-slate-600">
                    {brl(resumo.custo_total_medio ?? resumo.custo_medio)}
                  </span>
                  <span className="text-slate-400">→</span>
                  <span className="text-2xl font-bold text-meli-blue">
                    {brl(resumo.venda_media)}
                  </span>
                </div>
                <div className="mt-1 text-[11px] leading-4 text-slate-500">
                  Produto {brl(resumo.custo_produto_medio ?? resumo.custo_medio)}
                  {' + '}Taxas ML {brl(resumo.comissao_media ?? 0)}
                  {' + '}Impostos {brl(resumo.imposto_medio ?? 0)}
                  {' + '}Frete {brl(resumo.frete_medio ?? 0)}
                </div>
                <div className="mt-1 text-xs font-semibold text-emerald-700">
                  Lucro líquido médio: {brl(resumo.lucro_liquido_medio)} · Margem {resumo.margem_liquida_pct ?? 0}% · ROI {resumo.roi_medio_pct}%
                </div>
              </div>

              <div className="surface flex flex-col justify-between p-4">
                <div className="label">Exportar CSV (Geral ou Filtrado)</div>
                <div className="mt-2 flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      handleDownloadCsv(
                        `/aliexpress/export-csv?formato=completo${csvQuerySuffix}`,
                        'mercadolivre_aliexpress_completo.csv'
                      )
                    }
                    className="btn-primary w-full py-1.5 text-xs"
                  >
                    <Icon name="download" className="h-3.5 w-3.5" />
                    {selectedSupplier ? `CSV Completo · ${selectedSupplier}` : 'CSV Completo Geral (66 Colunas)'}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      handleDownloadCsv(
                        `/aliexpress/export-csv?formato=planilha_ml${csvQuerySuffix}`,
                        'mercadolivre_planilha_publicacao.csv'
                      )
                    }
                    className="btn-ghost w-full py-1.5 text-xs"
                  >
                    <Icon name="download" className="h-3.5 w-3.5" />
                    {selectedSupplier ? `Planilha ML · ${selectedSupplier}` : 'Planilha Publicação ML (;)'}
                  </button>
                </div>
              </div>
            </div>

            {/* Segmented Supplier Selector + Live Link Scraper */}
            <div className="grid gap-4 lg:grid-cols-12">
              <div className="surface flex flex-col justify-between p-4 lg:col-span-6">
                <div className="label">Filtrar Base por Fornecedor Homologado</div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-lg bg-slate-100 p-1">
                  <button
                    type="button"
                    onClick={() => setSelectedSupplier('')}
                    className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                      selectedSupplier === ''
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    Todos ({resumo.total})
                  </button>
                  {(resumo.fornecedores || []).map((f) => (
                    <button
                      key={f.nome}
                      type="button"
                      onClick={() => setSelectedSupplier(f.nome)}
                      className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                        selectedSupplier === f.nome
                          ? 'bg-white text-slate-900 shadow-sm'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {f.nome} ({f.qtd})
                    </button>
                  ))}
                </div>
              </div>

              <form onSubmit={handleScrapeNew} className="surface p-4 lg:col-span-6">
                <div className="flex flex-wrap items-end gap-2.5">
                  <div className="min-w-[200px] flex-1">
                    <label className="label">Adicionar Link Avulso (Com Trava Anti-Repetição)</label>
                    <input
                      type="url"
                      placeholder="https://pt.aliexpress.com/item/1005011724416025.html"
                      value={scrapeUrl}
                      onChange={(e) => setScrapeUrl(e.target.value)}
                      className="input mt-1 font-mono text-xs"
                    />
                  </div>
                  <div className="w-28">
                    <label className="label">Custo R$</label>
                    <input
                      type="number"
                      step="0.01"
                      placeholder="Auto"
                      value={scrapeCost}
                      onChange={(e) => setScrapeCost(e.target.value)}
                      className="input mt-1 font-mono text-xs"
                    />
                  </div>
                  <button type="submit" disabled={scraping || !scrapeUrl.trim()} className="btn-dark text-xs">
                    <Icon name="plus" className="h-3.5 w-3.5" />
                    {scraping ? 'Extraindo...' : 'Extrair'}
                  </button>
                </div>
              </form>
            </div>

            {/* Search, Category, Multiplier & 1-Click Selection Bar */}
            <div className="surface flex flex-wrap items-center justify-between gap-3 p-3.5">
              <div className="flex min-w-[240px] flex-1 flex-wrap items-center gap-2.5">
                <div className="relative min-w-[240px] max-w-md flex-1">
                  <Icon
                    name="search"
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                  />
                  <input
                    type="text"
                    placeholder="Buscar SKU (AE-0116), ID AliExpress, produto ou fornecedor..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="input pl-9 text-xs"
                  />
                </div>

                <select
                  value={selectedCategory}
                  onChange={(e) => setSelectedCategory(e.target.value)}
                  className="input w-auto text-xs"
                >
                  <option value="">Todas as categorias ({resumo.categorias?.length || 0})</option>
                  {(resumo.categorias || []).map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>

                <select
                  value={pisoFilter}
                  onChange={(e) => setPisoFilter(e.target.value)}
                  className="input w-auto text-xs"
                >
                  <option value="">Todas as faixas</option>
                  <option value="piso_79">No piso mínimo (R$ 79,90)</option>
                  <option value="acima_79">Acima de R$ 79,90 (2.8x direto)</option>
                </select>
              </div>

              <div className="flex flex-wrap items-center gap-2 border-l border-slate-200 pl-3">
                {selectedSkus.length > 0 ? (
                  <button
                    type="button"
                    disabled={uploadingBatch || !account}
                    onClick={() => handleBatchUploadMl(selectedSkus)}
                    title={account ? undefined : 'Conecte a conta Mercado Livre para publicar'}
                    className="btn-accent py-1.5 text-xs"
                  >
                    <Icon name="upload" className="h-3.5 w-3.5" />
                    {uploadingBatch
                      ? 'Enviando ao ML...'
                      : account
                        ? `Enviar ${selectedSkus.length} Aprovado(s) (Pausado)`
                        : 'Conecte a conta ML'}
                  </button>
                ) : null}
                <span className="text-xs font-medium text-slate-600">Sobrepreço:</span>
                <select
                  value={batchMultiplier}
                  onChange={(e) => setBatchMultiplier(e.target.value)}
                  className="input w-24 py-1.5 font-mono text-xs"
                >
                  <option value="2.8">2.8x</option>
                  <option value="2.9">2.9x</option>
                  <option value="3.0">3.0x</option>
                </select>
                <button
                  type="button"
                  disabled={recalculating}
                  onClick={handleBatchRecalculate}
                  className="btn-ghost py-1.5 text-xs"
                >
                  <Icon name="refresh" className="h-3.5 w-3.5" />
                  {recalculating ? 'Recalculando...' : 'Aplicar Lote'}
                </button>
              </div>
            </div>

            {/* Products Table */}
            <div className="surface overflow-hidden">
              <div className="overflow-x-auto scrollbar-thin">
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                      <th className="w-9 py-3 pl-4 pr-1">
                        <input
                          type="checkbox"
                          checked={
                            catalogData.produtos.length > 0 &&
                            catalogData.produtos.every((p) => selectedSkus.includes(p.sku))
                          }
                          onChange={toggleSelectAllVisible}
                          aria-label="Selecionar todos visíveis"
                          className="h-4 w-4 rounded border-slate-300 text-meli-blue"
                        />
                      </th>
                      <th className="py-3 pl-2 pr-3">Produto / Fornecedor Brasil</th>
                      <th className="px-3 py-3">SKU Identificador</th>
                      <th className="px-3 py-3 text-right">Custo Ali</th>
                      <th className="px-3 py-3 text-right">Venda ML</th>
                      <th className="px-3 py-3 text-right">Lucro Líquido</th>
                      <th className="px-3 py-3">Qualidade & Frete</th>
                      <th className="py-3 pl-3 pr-4 text-right">Ações</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {loadingCatalog ? (
                      <tr>
                        <td colSpan={8} className="py-12 text-center text-sm text-slate-500">
                          Carregando base de produtos prontos...
                        </td>
                      </tr>
                    ) : catalogData.produtos.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="py-12 text-center text-sm text-slate-500">
                          Nenhum produto encontrado para o filtro selecionado.
                        </td>
                      </tr>
                    ) : (
                      catalogData.produtos.map((item) => (
                        <tr key={item.sku} className="transition hover:bg-slate-50/80">
                          <td className="py-3 pl-4 pr-1">
                            <input
                              type="checkbox"
                              checked={selectedSkus.includes(item.sku)}
                              onChange={() => toggleSkuSelection(item.sku)}
                              aria-label={`Selecionar ${item.sku}`}
                              className="h-4 w-4 rounded border-slate-300 text-meli-blue"
                            />
                          </td>
                          <td className="py-3 pl-2 pr-3">
                            <div className="flex items-center gap-3">
                              <button
                                type="button"
                                onClick={() => setSelectedProduct(item)}
                                className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-white"
                              >
                                <img
                                  src={item.imagem_1}
                                  alt={item.titulo_ml}
                                  loading="lazy"
                                  className="h-full w-full object-cover"
                                />
                                <span className="absolute bottom-0 right-0 rounded-tl bg-slate-900/80 px-1 py-0.5 font-mono text-[10px] font-semibold text-white">
                                  {item.qtd_imagens || item.imagens?.length || 4}f
                                </span>
                              </button>
                              <div className="min-w-0 max-w-md">
                                <button
                                  type="button"
                                  onClick={() => setSelectedProduct(item)}
                                  className="block truncate text-left text-sm font-semibold text-slate-900 hover:text-meli-blue"
                                >
                                  {item.titulo_ml}
                                </button>
                                <div className="mt-0.5 truncate text-[11px] text-slate-500">
                                  {item.fornecedor_nome} · {item.categoria_ml}
                                  {item.ml_item_id ? ` · ML ${item.ml_item_id}` : ''}
                                </div>
                              </div>
                            </div>
                          </td>

                          <td className="px-3 py-3">
                            <div className="flex items-center gap-1.5">
                              <span className="font-mono text-xs font-semibold text-slate-800">
                                {item.codigo_interno}
                              </span>
                              <button
                                type="button"
                                onClick={async () => {
                                  await copyText(item.sku);
                                  notify(`SKU ${item.sku} copiado.`, 'success');
                                }}
                                className="text-slate-400 hover:text-slate-700"
                                title={`Copiar ${item.sku}`}
                              >
                                <Icon name="copy" className="h-3.5 w-3.5" />
                              </button>
                            </div>
                            <div className="font-mono text-[11px] text-slate-500">
                              ID {item.aliexpress_item_id}
                            </div>
                          </td>

                          <td className="px-3 py-3 text-right font-mono tabular-nums text-slate-700">
                            {brl(item.preco_custo_aliexpress_brl)}
                          </td>

                          <td className="px-3 py-3 text-right font-mono tabular-nums">
                            <div className="font-bold text-slate-900">
                              {brl(item.preco_venda_ml_sugerido)}
                            </div>
                            <div className="text-[10px] text-slate-500">
                              {item.piso_79_90_aplicado
                                ? 'Piso R$ 79,90'
                                : `${item.multiplicador_venda}x aplicado`}
                            </div>
                          </td>

                          <td className="px-3 py-3 text-right font-mono tabular-nums">
                            <div className="font-semibold text-emerald-700">
                              {brl(item.lucro_liquido_estimado_brl)}
                            </div>
                            <div className="text-[10px] text-slate-500">
                              ROI {item.roi_sobre_custo_pct}%
                            </div>
                            <div className="text-[10px] text-slate-500">
                              Taxa ML {brl(item.taxa_ml_estimada_brl)} · Imp. {brl(item.imposto_estimado_brl)}
                            </div>
                          </td>

                          <td className="px-3 py-3 text-[11px]">
                            <div className="font-mono font-semibold text-emerald-700">
                              Score {item.qualidade_score || 0}% · Revisão{' '}
                              {item.ml_revisao?.aprovado ? 'aprovada' : 'pendente'}
                            </div>
                            <div className="text-slate-500">
                              {item.ml_preflight?.ok ? 'Pré-publicação OK' : 'Pré-publicação pendente'} · Pausado
                            </div>
                          </td>

                          <td className="py-3 pl-3 pr-4 text-right">
                            <div className="inline-flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => setSelectedProduct(item)}
                                className="btn-ghost px-2.5 py-1.5 text-xs"
                              >
                                Ficha & Fotos
                              </button>
                              <a
                                href={item.url_aliexpress}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="btn-ghost px-2.5 py-1.5 text-xs text-meli-blue"
                                title="Abrir página do produto no AliExpress"
                              >
                                <Icon name="external" className="h-3.5 w-3.5" />
                              </a>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-4 py-2.5 text-xs text-slate-500">
                <span>
                  Exibindo <strong className="text-slate-800">{catalogData.produtos.length}</strong> de{' '}
                  <strong className="text-slate-800">{resumo.total}</strong> produtos únicos prontos
                </span>
                <span>
                  Trava anti-repetição ativa · Somente estoque Brasil com Frete Totalmente Grátis
                </span>
              </div>
            </div>
          </div>
        )}

        {/* VIEW 2: AUDITORIA DE CUSTOS E LUCRO REAL */}
        {activeNav === 'custos' && (
          <div className="space-y-5">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h1 className="text-xl font-bold tracking-tight text-slate-900">
                  Custos & Lucro Real — {costAudit.total} produtos
                </h1>
                <p className="mt-0.5 max-w-3xl text-sm text-slate-600">
                  Comissão Premium ML consultada na API do Mercado Livre por categoria e faixa de preço,
                  impostos EI de 6% e frete R$ 0,00. Cada linha mostra o custo total da operação e o lucro
                  líquido real após todas as taxas.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => loadCatalog()}
                  className="btn-ghost py-1.5 text-xs"
                >
                  <Icon name="refresh" className="h-3.5 w-3.5" />
                  Atualizar custos
                </button>
                <button
                  type="button"
                  onClick={() =>
                    handleDownloadCsv(
                      '/aliexpress/export-csv?formato=completo',
                      'custos_lucro_real_817.csv'
                    )
                  }
                  className="btn-primary py-1.5 text-xs"
                >
                  <Icon name="download" className="h-3.5 w-3.5" />
                  Baixar CSV com custos
                </button>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="surface p-4">
                <div className="label">Vendas totais</div>
                <div className="mt-1 font-mono text-xl font-bold text-slate-900 tabular-nums">
                  {brl(costAudit.totalSale)}
                </div>
                <div className="mt-1 text-[11px] text-slate-500">
                  {costAudit.total} produtos · {costAudit.withDetail} com detalhamento
                </div>
              </div>
              <div className="surface p-4">
                <div className="label">Custo dos produtos</div>
                <div className="mt-1 font-mono text-xl font-bold text-slate-900 tabular-nums">
                  {brl(costAudit.totalProductCost)}
                </div>
                <div className="mt-1 text-[11px] text-slate-500">AliExpress Brasil</div>
              </div>
              <div className="surface p-4">
                <div className="label">Comissões ML Premium</div>
                <div className="mt-1 font-mono text-xl font-bold text-meli-blue tabular-nums">
                  {brl(costAudit.totalFees)}
                </div>
                <div className="mt-1 text-[11px] text-slate-500">
                  Taxa real por categoria · {costAudit.fallback} fallback
                </div>
              </div>
              <div className="surface p-4">
                <div className="label">Impostos EI (6%)</div>
                <div className="mt-1 font-mono text-xl font-bold text-slate-900 tabular-nums">
                  {brl(costAudit.totalTaxes)}
                </div>
                <div className="mt-1 text-[11px] text-slate-500">Sobre o preço de venda</div>
              </div>
              <div className="surface p-4">
                <div className="label">Frete do vendedor</div>
                <div className="mt-1 font-mono text-xl font-bold text-emerald-700 tabular-nums">
                  {brl(costAudit.totalShipping)}
                </div>
                <div className="mt-1 text-[11px] text-slate-500">Frete grátis · por minha conta</div>
              </div>
              <div className="surface p-4">
                <div className="label">Custo total da operação</div>
                <div className="mt-1 font-mono text-xl font-bold text-slate-900 tabular-nums">
                  {brl(costAudit.totalOperational)}
                </div>
                <div className="mt-1 text-[11px] text-slate-500">
                  Produto + comissão + impostos + frete
                </div>
              </div>
              <div className="surface p-4">
                <div className="label">Lucro líquido real</div>
                <div className="mt-1 font-mono text-xl font-bold text-emerald-700 tabular-nums">
                  {brl(costAudit.totalNet)}
                </div>
                <div className="mt-1 text-[11px] text-slate-500">
                  {costAudit.negative} produtos com lucro negativo
                </div>
              </div>
              <div className="surface p-4">
                <div className="label">Margem & ROI</div>
                <div className="mt-1 font-mono text-xl font-bold text-slate-900 tabular-nums">
                  {costAudit.marginPct}% <span className="text-sm text-slate-500">margem</span>
                </div>
                <div className="mt-1 text-[11px] text-slate-500">
                  ROI {costAudit.roiPct}% sobre o custo dos produtos
                </div>
              </div>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <div className="surface overflow-hidden">
                <div className="border-b border-slate-200 p-4">
                  <div className="label">Distribuição das taxas ML Premium</div>
                  <div className="mt-0.5 text-[11px] text-slate-500">
                    Percentual real retornado pela API do Mercado Livre
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-xs">
                    <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
                      <tr>
                        <th className="px-4 py-2.5 text-left">Taxa ML</th>
                        <th className="px-4 py-2.5 text-right">Fixa</th>
                        <th className="px-4 py-2.5 text-right">Produtos</th>
                        <th className="px-4 py-2.5 text-right">Comissão total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {costAudit.feeDistribution.map((fee) => (
                        <tr key={`${fee.taxa_ml_pct}-${fee.taxa_ml_fixa_brl}`}>
                          <td className="px-4 py-2 font-mono font-semibold text-slate-800">
                            {fee.taxa_ml_pct}%
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-slate-600">
                            {brl(fee.taxa_ml_fixa_brl)}
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-slate-700">
                            {fee.produtos}
                          </td>
                          <td className="px-4 py-2 text-right font-mono font-semibold text-slate-900">
                            {brl(fee.total_comissao_brl)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="surface overflow-hidden">
                <div className="border-b border-slate-200 p-4">
                  <div className="label">Custos por categoria</div>
                  <div className="mt-0.5 text-[11px] text-slate-500">
                    Comissão, impostos e lucro real por categoria do Mercado Livre
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-xs">
                    <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
                      <tr>
                        <th className="px-4 py-2.5 text-left">Categoria</th>
                        <th className="px-4 py-2.5 text-right">Prod.</th>
                        <th className="px-4 py-2.5 text-right">Taxas</th>
                        <th className="px-4 py-2.5 text-right">Comissão</th>
                        <th className="px-4 py-2.5 text-right">Lucro</th>
                        <th className="px-4 py-2.5 text-right">ROI</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {costAudit.categories.map((category) => (
                        <tr key={category.categoria_ml_id}>
                          <td className="px-4 py-2">
                            <div className="max-w-[260px] truncate font-medium text-slate-800" title={category.categoria_ml}>
                              {category.categoria_ml}
                            </div>
                            <div className="font-mono text-[10px] text-slate-500">
                              {category.categoria_ml_id}
                            </div>
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-slate-700">
                            {category.produtos}
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-slate-600">
                            {category.taxas.join(' / ')}
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-slate-800">
                            {brl(category.total_comissao_brl)}
                          </td>
                          <td className="px-4 py-2 text-right font-mono font-semibold text-emerald-700">
                            {brl(category.total_lucro_brl)}
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-slate-600">
                            {category.roiPct}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div className="surface overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 p-4">
                <div>
                  <div className="label">Detalhamento por produto</div>
                  <div className="mt-0.5 text-[11px] text-slate-500">
                    Todos os {costAudit.total} produtos com taxa real, impostos, frete, custo total, lucro, margem e ROI.
                  </div>
                </div>
                <div className="text-[11px] text-slate-500">
                  Ordenado pelo maior lucro líquido
                </div>
              </div>
              <div className="overflow-x-auto scrollbar-thin">
                <table className="w-full border-collapse text-left text-xs">
                  <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-4 py-2.5">Produto / SKU</th>
                      <th className="px-3 py-2.5">Categoria</th>
                      <th className="px-3 py-2.5 text-right">Venda</th>
                      <th className="px-3 py-2.5 text-right">Custo produto</th>
                      <th className="px-3 py-2.5 text-right">Taxa ML</th>
                      <th className="px-3 py-2.5 text-right">Comissão ML</th>
                      <th className="px-3 py-2.5 text-right">Impostos</th>
                      <th className="px-3 py-2.5 text-right">Frete</th>
                      <th className="px-3 py-2.5 text-right">Custo total</th>
                      <th className="px-3 py-2.5 text-right">Lucro líquido</th>
                      <th className="px-3 py-2.5 text-right">Margem / ROI</th>
                      <th className="px-3 py-2.5 text-right">Fonte</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {costAudit.products.map((item) => (
                      <tr key={item.sku} className="hover:bg-slate-50/80">
                        <td className="px-4 py-2.5">
                          <div className="max-w-[260px] truncate font-semibold text-slate-900" title={item.titulo_ml}>
                            {item.titulo_ml}
                          </div>
                          <div className="font-mono text-[10px] text-slate-500">{item.sku}</div>
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="max-w-[220px] truncate text-[11px] text-slate-700" title={item.categoria_ml}>
                            {item.categoria_ml}
                          </div>
                          <div className="font-mono text-[10px] text-slate-500">{item.categoria_ml_id}</div>
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-800">
                          {brl(item.preco_venda_ml_sugerido)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-700">
                          {brl(item.custo_produto_brl ?? item.preco_custo_aliexpress_brl)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-700">
                          <div className="font-semibold">{item.taxa_ml_pct ?? 19}%</div>
                          <div className="text-[10px] text-slate-500">fixa {brl(item.taxa_ml_fixa_brl || 0)}</div>
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-800">
                          {brl(item.taxa_ml_estimada_brl)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-700">
                          {brl(item.imposto_estimado_brl)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-600">
                          {brl(item.custo_frete_vendedor_brl || 0)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono font-semibold tabular-nums text-slate-900">
                          {brl(item.custo_total_operacao_brl)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono font-bold tabular-nums text-emerald-700">
                          {brl(item.lucro_liquido_estimado_brl)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-600">
                          <div>{item.margem_liquida_pct}% margem</div>
                          <div className="text-[10px]">ROI {item.roi_sobre_custo_pct}%</div>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                              item.taxa_ml_fonte === 'mercadolivre_api'
                                ? 'bg-emerald-50 text-emerald-700'
                                : 'bg-amber-50 text-amber-700'
                            }`}
                          >
                            {item.taxa_ml_fonte === 'mercadolivre_api' ? 'API ML' : 'Estimada'}
                          </span>
                          <div className="mt-0.5 text-[10px] text-slate-500">
                            {item.tipo_anuncio_ml === 'premium' ? 'Premium' : item.tipo_anuncio || 'Premium'}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* VIEW 3: 6 FORNECEDORES HOMOLOGADOS ALIEXPRESS BRASIL */}
        {activeNav === 'fornecedores' && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h1 className="text-xl font-bold tracking-tight text-slate-900">
                  6 Fornecedores Homologados AliExpress no Brasil (Frete Grátis)
                </h1>
                <p className="mt-0.5 text-sm text-slate-600">
                  Alimente continuamente a base da MeLi Max Shop: o minerador verifica item a item na loja, descarta automaticamente qualquer item com frete pago e bloqueia produtos repetidos.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-xs font-medium text-slate-600">Lote por clique:</label>
                <select
                  value={mineLimit}
                  onChange={(e) => setMineLimit(e.target.value)}
                  className="input w-32 py-1.5 font-mono text-xs"
                >
                  <option value="15">+15 produtos</option>
                  <option value="25">+25 produtos</option>
                  <option value="40">+40 produtos</option>
                </select>
              </div>
            </div>

            {lastMineReport ? (
              <div className="surface p-4 text-xs text-slate-700">
                <div className="font-semibold text-slate-900">
                  Resultado da Mineração — {lastMineReport.loja} (Loja {lastMineReport.storeId})
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-3 font-mono">
                  <span>Varredura na loja: {lastMineReport.encontrados_na_loja} itens</span>
                  <span>·</span>
                  <span className="text-emerald-700">
                    Com Frete Grátis Brasil: {lastMineReport.com_frete_gratis_brasil}
                  </span>
                  <span>·</span>
                  <span className="text-amber-700">
                    Descartados por frete pago: {lastMineReport.descartados_frete_pago}
                  </span>
                  <span>·</span>
                  <span>Repetidos bloqueados: {lastMineReport.descartados_duplicados}</span>
                  <span>·</span>
                  <strong className="text-meli-blue">
                    Novos adicionados à base pronta: +{lastMineReport.adicionados} (Total {lastMineReport.total_catalogo})
                  </strong>
                </div>
              </div>
            ) : null}

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {approvedStores.map((store) => {
                const isMining = miningStoreId === store.storeId;
                return (
                  <div key={store.storeId} className="surface flex flex-col justify-between p-5 space-y-4">
                    <div className="space-y-3">
                      <div className="flex items-center gap-3">
                        <img
                          src={store.logo}
                          alt={store.storeName}
                          className="h-12 w-12 rounded-lg border border-slate-200 bg-slate-50 object-cover"
                        />
                        <div className="min-w-0 flex-1">
                          <h2 className="truncate text-base font-bold text-slate-900">
                            {store.storeName}
                          </h2>
                          <div className="text-xs text-slate-500">
                            ID {store.storeId} · Aprovação {store.positiveRate} · {store.country}
                          </div>
                        </div>
                      </div>

                      <p className="text-xs leading-relaxed text-slate-600">
                        {store.destaque} · Prazo: <strong className="text-slate-800">{store.prazo}</strong>
                      </p>

                      <div className="flex items-center justify-between border-t border-slate-100 pt-2.5 text-xs">
                        <span className="text-slate-500">Produtos já na nossa base pronta:</span>
                        <span className="font-mono text-sm font-bold text-slate-900">
                          {store.produtos_na_base} SKUs
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 pt-1">
                      <button
                        type="button"
                        disabled={Boolean(miningStoreId)}
                        onClick={() => handleMineStore(store.storeId)}
                        className="btn-primary flex-1 py-2 text-xs"
                      >
                        <Icon name="plus" className="h-3.5 w-3.5" />
                        {isMining
                          ? 'Minerando Frete Grátis...'
                          : `Minerar +${mineLimit} Sem Repetir`}
                      </button>
                      <a
                        href={store.storeUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn-ghost px-3 py-2 text-xs"
                        title="Abrir loja no AliExpress"
                      >
                        <Icon name="external" className="h-3.5 w-3.5" />
                      </a>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* VIEW 3: EXECUÇÃO DE VENDAS & RASTREIO MANUAL */}
        {activeNav === 'execucao' && (
          <div className="space-y-6">
            <div>
              <h1 className="text-xl font-bold tracking-tight text-slate-900">
                Fluxo de Execução da Venda & Rastreamento Manual
              </h1>
              <p className="mt-0.5 text-sm text-slate-600">
                Operação sem geração de etiquetas: copie o endereço do comprador no Mercado Livre, compre no AliExpress Brasil com frete grátis e insira o código de rastreio manualmente.
              </p>
            </div>

            <div className="surface p-5">
              <div className="label mb-3">Engrenagem Padrão de Cada Venda</div>
              <div className="grid gap-3 sm:grid-cols-5">
                {EXECUTION_STEPS.map((s) => (
                  <div key={s.step} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <div className="font-mono text-xs font-bold text-meli-blue">0{s.step}. Etapa</div>
                    <div className="mt-1 text-xs font-bold text-slate-900">{s.title}</div>
                    <p className="mt-0.5 text-[11px] leading-snug text-slate-600">{s.desc}</p>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-12">
              <div className="space-y-5 lg:col-span-5">
                <div className="surface space-y-3 p-5">
                  <div className="label">1. Localizar Produto Vendido pelo SKU</div>
                  <input
                    type="text"
                    placeholder="Digite o SKU da venda (ex: AE-0116 ou 1005011724416025)"
                    value={skuLookupInput}
                    onChange={(e) => {
                      setSkuLookupInput(e.target.value);
                      setManualForm((prev) => ({ ...prev, sku: e.target.value }));
                    }}
                    className="input font-mono text-xs"
                  />
                  {matchedLookupProduct ? (
                    <div className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <img
                        src={matchedLookupProduct.imagem_1}
                        alt={matchedLookupProduct.titulo_ml}
                        className="h-14 w-14 rounded-lg border border-slate-200 bg-white object-cover"
                      />
                      <div className="min-w-0 flex-1 text-xs">
                        <div className="font-mono font-bold text-slate-900">
                          {matchedLookupProduct.sku}
                        </div>
                        <div className="truncate font-medium text-slate-700">
                          {matchedLookupProduct.titulo_ml}
                        </div>
                        <div className="mt-1 flex items-center gap-3 font-mono text-[11px] text-slate-600">
                          <span>Custo: {brl(matchedLookupProduct.preco_custo_aliexpress_brl)}</span>
                          <span>·</span>
                          <span>Venda: {brl(matchedLookupProduct.preco_venda_ml_sugerido)}</span>
                        </div>
                      </div>
                      <a
                        href={matchedLookupProduct.url_aliexpress}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn-primary shrink-0 px-3 py-2 text-xs"
                      >
                        Comprar Ali
                        <Icon name="external" className="h-3.5 w-3.5" />
                      </a>
                    </div>
                  ) : null}
                </div>

                <form onSubmit={handleSaveManualExecution} className="surface space-y-3.5 p-5">
                  <div className="label">2. Registrar Compra AliExpress & Código de Rastreio</div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-slate-700">Nº Venda Mercado Livre</label>
                      <input
                        type="text"
                        required
                        placeholder="Ex: 20000098451234"
                        value={manualForm.order_id}
                        onChange={(e) => setManualForm({ ...manualForm, order_id: e.target.value })}
                        className="input mt-1 font-mono text-xs"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-slate-700">SKU Vendido</label>
                      <input
                        type="text"
                        placeholder="AE-0116-10050..."
                        value={manualForm.sku}
                        onChange={(e) => setManualForm({ ...manualForm, sku: e.target.value })}
                        className="input mt-1 font-mono text-xs"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-medium text-slate-700">
                      Nome & Endereço Completo do Comprador (Para colar no AliExpress)
                    </label>
                    <textarea
                      rows={3}
                      placeholder="Cole aqui o endereço completo de entrega do comprador no Mercado Livre..."
                      value={manualForm.shipping_address}
                      onChange={(e) =>
                        setManualForm({ ...manualForm, shipping_address: e.target.value })
                      }
                      className="input mt-1 text-xs"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-slate-700">Nº Pedido AliExpress</label>
                      <input
                        type="text"
                        placeholder="Ex: 8194028491023"
                        value={manualForm.aliexpress_order_id}
                        onChange={(e) =>
                          setManualForm({ ...manualForm, aliexpress_order_id: e.target.value })
                        }
                        className="input mt-1 font-mono text-xs"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-slate-700">Transportadora</label>
                      <input
                        type="text"
                        value={manualForm.carrier}
                        onChange={(e) => setManualForm({ ...manualForm, carrier: e.target.value })}
                        className="input mt-1 text-xs"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs font-medium text-slate-700">
                        Código de Rastreio (AliExpress)
                      </label>
                      <input
                        type="text"
                        placeholder="Ex: BR2491827364BR / JT..."
                        value={manualForm.tracking_number}
                        onChange={(e) =>
                          setManualForm({ ...manualForm, tracking_number: e.target.value })
                        }
                        className="input mt-1 font-mono text-xs"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-slate-700">Etapa Atual</label>
                      <select
                        value={manualForm.step}
                        onChange={(e) => setManualForm({ ...manualForm, step: Number(e.target.value) })}
                        className="input mt-1 text-xs"
                      >
                        {EXECUTION_STEPS.map((s) => (
                          <option key={s.step} value={s.step}>
                            {s.step}. {s.title}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <button type="submit" disabled={savingTracking} className="btn-primary w-full text-xs">
                    {savingTracking ? 'Salvando...' : 'Salvar Execução & Rastreamento'}
                  </button>
                </form>
              </div>

              <div className="space-y-5 lg:col-span-7">
                <div className="surface p-5">
                  <div className="flex items-center justify-between border-b border-slate-200 pb-3">
                    <div>
                      <h2 className="text-sm font-bold text-slate-900">
                        Vendas Mercado Livre & Controle de Rastreamento
                      </h2>
                      <p className="text-xs text-slate-500">
                        Sem geração de etiquetas — acompanhe o pedido AliExpress e o código de rastreio enviado ao cliente.
                      </p>
                    </div>
                    <button type="button" onClick={loadOrders} className="btn-ghost py-1.5 text-xs">
                      <Icon name="refresh" className="h-3.5 w-3.5" />
                      Atualizar
                    </button>
                  </div>

                  {loadingOrders ? (
                    <div className="py-10 text-center text-xs text-slate-500">Carregando vendas...</div>
                  ) : ordersState.orders.length === 0 && ordersState.execucoes_manuais.length === 0 ? (
                    <div className="py-10 text-center text-xs text-slate-500">
                      Nenhuma execução registrada ainda. Utilize o painel ao lado para localizar um SKU vendido e salvar o rastreamento, ou conecte sua conta Mercado Livre após a atualização do CNAE.
                    </div>
                  ) : (
                    <div className="mt-4 space-y-3">
                      {ordersState.orders.map((order) => {
                        const firstItem = order.items?.[0];
                        const ali = firstItem?.aliexpress;
                        const addrText = order.shipping?.receiver_address?.formatted || '';
                        return (
                          <div key={order.id} className="space-y-3 rounded-xl border border-slate-200 p-4">
                            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                              <div>
                                <span className="font-mono font-bold text-slate-900">Venda #{order.id}</span>
                                <span className="text-slate-400"> · </span>
                                <span className="text-slate-600">{formatDate(order.date_created)}</span>
                                <span className="text-slate-400"> · </span>
                                <span className="font-mono font-semibold text-emerald-700">
                                  {brl(order.total_amount)}
                                </span>
                              </div>
                              <div className="flex items-center gap-2">
                                {addrText ? (
                                  <button
                                    type="button"
                                    onClick={async () => {
                                      await copyText(addrText);
                                      notify('Endereço completo do comprador copiado!', 'success');
                                    }}
                                    className="btn-ghost px-2.5 py-1 text-xs"
                                  >
                                    <Icon name="copy" className="h-3.5 w-3.5" />
                                    Copiar Endereço
                                  </button>
                                ) : null}
                                {ali?.url_aliexpress ? (
                                  <a
                                    href={ali.url_aliexpress}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="btn-primary px-2.5 py-1 text-xs"
                                  >
                                    Comprar no AliExpress
                                    <Icon name="external" className="h-3.5 w-3.5" />
                                  </a>
                                ) : null}
                                <button
                                  type="button"
                                  onClick={() =>
                                    setManualForm((prev) => ({
                                      ...prev,
                                      order_id: order.id,
                                      sku: firstItem?.seller_sku || ali?.sku || '',
                                      buyer_name: order.buyer?.full_name || order.buyer?.nickname || '',
                                      shipping_address: addrText,
                                      tracking_number: order.execution?.tracking_number || '',
                                      aliexpress_order_id: order.execution?.aliexpress_order_id || '',
                                    }))
                                  }
                                  className="btn-ghost px-2.5 py-1 text-xs"
                                >
                                  Inserir Rastreio
                                </button>
                              </div>
                            </div>
                            <div className="text-xs text-slate-700">
                              {firstItem?.title} · SKU:{' '}
                              <span className="font-mono font-semibold">
                                {firstItem?.seller_sku || 'Não vinculado'}
                              </span>
                            </div>
                            {order.execution?.tracking_number ? (
                              <div className="rounded-lg bg-emerald-50 px-3 py-2 font-mono text-xs text-emerald-800">
                                Rastreio enviado: {order.execution.tracking_number} ({order.execution.carrier})
                              </div>
                            ) : null}
                          </div>
                        );
                      })}

                      {ordersState.execucoes_manuais.map((exec) => (
                        <div
                          key={exec.order_id}
                          className="space-y-2 rounded-xl border border-slate-200 bg-slate-50/60 p-4"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                            <div>
                              <span className="font-mono font-bold text-slate-900">
                                Pedido ML #{exec.order_id}
                              </span>
                              {exec.sku ? (
                                <>
                                  <span> · </span>
                                  <span className="font-mono text-slate-700">{exec.sku}</span>
                                </>
                              ) : null}
                            </div>
                            <span className="font-mono text-xs font-semibold text-meli-blue">
                              Etapa {exec.step}/5
                            </span>
                          </div>
                          {exec.shipping_address ? (
                            <div className="flex items-start justify-between gap-2 rounded-lg border border-slate-200 bg-white p-2.5 text-xs text-slate-600">
                              <pre className="whitespace-pre-wrap font-sans text-xs">
                                {exec.shipping_address}
                              </pre>
                              <button
                                type="button"
                                onClick={async () => {
                                  await copyText(exec.shipping_address);
                                  notify('Endereço copiado!', 'success');
                                }}
                                className="btn-ghost shrink-0 px-2 py-1 text-[11px]"
                              >
                                Copiar
                              </button>
                            </div>
                          ) : null}
                          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600">
                            <span>
                              Pedido AliExpress:{' '}
                              <strong className="font-mono text-slate-900">
                                {exec.aliexpress_order_id || 'Pendente'}
                              </strong>
                            </span>
                            <span>
                              Código de Rastreio:{' '}
                              <strong className="font-mono text-emerald-700">
                                {exec.tracking_number || 'Aguardando despacho'}
                              </strong>
                            </span>
                            {exec.aliexpress_url ? (
                              <a
                                href={exec.aliexpress_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="font-semibold text-meli-blue hover:underline"
                              >
                                Abrir link AliExpress
                              </a>
                            ) : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* VIEW 4: CONFIGURAÇÃO DE FRETE & SIMULADOR */}
        {activeNav === 'frete' && (
          <div className="space-y-6">
            <div>
              <h1 className="text-xl font-bold tracking-tight text-slate-900">
                Configuração Única de Frete para Todas as Regiões & Regra de Preço
              </h1>
              <p className="mt-0.5 text-sm text-slate-600">
                Parametrização obrigatória no painel do Mercado Livre para vender em todo o Brasil com frete grátis sem gerar etiqueta.
              </p>
            </div>

            <div className="grid gap-6 lg:grid-cols-12">
              <div className="surface space-y-4 p-6 lg:col-span-7">
                <div className="label">Tabela de Frete no Painel do Mercado Livre</div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5">
                    <div className="text-xs text-slate-500">Opção de Entrega</div>
                    <div className="mt-0.5 text-sm font-bold text-slate-900">
                      Vou enviar por minha conta
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5">
                    <div className="text-xs text-slate-500">Área de Cobertura</div>
                    <div className="mt-0.5 text-sm font-bold text-slate-900">Todo o Brasil (5 Regiões)</div>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5">
                    <div className="text-xs text-slate-500">Custo do Envio para o Cliente</div>
                    <div className="mt-0.5 font-mono text-sm font-bold text-emerald-700">
                      R$ 0,00 (Frete Grátis)
                    </div>
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5">
                    <div className="text-xs text-slate-500">Prazo Fixo do Anúncio</div>
                    <div className="mt-0.5 font-mono text-sm font-bold text-slate-900">5 a 10 dias</div>
                  </div>
                </div>

                <div className="overflow-hidden rounded-xl border border-slate-200">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold uppercase text-slate-500">
                      <tr>
                        <th className="px-4 py-2.5">Região do Mapa</th>
                        <th className="px-4 py-2.5">Modalidade</th>
                        <th className="px-4 py-2.5 text-right">Custo</th>
                        <th className="px-4 py-2.5 text-right">Prazo Exibido</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {REGIONS_TABLE.map((row) => (
                        <tr key={row.regiao}>
                          <td className="px-4 py-2.5 font-medium text-slate-900">{row.regiao}</td>
                          <td className="px-4 py-2.5 text-slate-600">{row.modalidade}</td>
                          <td className="px-4 py-2.5 text-right font-mono font-semibold text-emerald-700">
                            R$ 0,00
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-slate-800">{row.prazo}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs leading-relaxed text-slate-700">
                  <strong className="text-slate-900">Regra Operacional MeLi Max Shop:</strong> Somente entram na loja produtos que já estão fisicamente no Brasil e com Frete Totalmente Grátis nos fornecedores homologados. Ao vender no Mercado Livre, compramos no AliExpress com o endereço do cliente e inserimos o rastreio manualmente.
                </div>
              </div>

              <div className="surface space-y-4 p-6 lg:col-span-5">
                <div className="label">Simulador Rápido de Precificação Premium (2.8x a 3.0x + Piso R$ 79,90)</div>
                <div className="text-[11px] text-slate-500">
                  Simulação conservadora. A taxa real por categoria é consultada no Mercado Livre ao abrir/salvar cada produto.
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs font-medium text-slate-700">Custo AliExpress (R$)</label>
                    <input
                      type="number"
                      step="0.01"
                      value={simCost}
                      onChange={(e) => setSimCost(e.target.value)}
                      className="input mt-1 font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-medium text-slate-700">Multiplicador</label>
                    <input
                      type="number"
                      step="0.1"
                      value={simMult}
                      onChange={(e) => setSimMult(e.target.value)}
                      className="input mt-1 font-mono"
                    />
                  </div>
                </div>

                <div className="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs tabular-nums">
                  <div className="flex justify-between text-slate-600">
                    <span>Custo do Produto (1x):</span>
                    <span className="font-mono">{brl(simResult.c)}</span>
                  </div>
                  <div className="flex justify-between text-slate-600">
                    <span>Valor Multiplicado ({simMult}x):</span>
                    <span className="font-mono">{brl(simResult.calc)}</span>
                  </div>
                  <div className="flex justify-between border-t border-slate-200 pt-2 text-sm font-bold text-slate-900">
                    <span>Preço de Venda Mercado Livre:</span>
                    <span className="font-mono text-meli-blue">{brl(simResult.finalPrice)}</span>
                  </div>
                  {simResult.piso ? (
                    <div className="text-[11px] font-medium text-amber-700">
                      Regra aplicada: nenhum produto abaixo de R$ 79,90 (arredondado automaticamente).
                    </div>
                  ) : null}
                  <div className="flex justify-between pt-1 text-slate-600">
                    <span>Comissão Premium ML (estimativa 19%):</span>
                    <span className="font-mono">- {brl(simResult.fee)}</span>
                  </div>
                  <div className="flex justify-between text-slate-600">
                    <span>Impostos EI (6%):</span>
                    <span className="font-mono">- {brl(simResult.tax)}</span>
                  </div>
                  <div className="flex justify-between text-slate-600">
                    <span>Frete Pago pelo Vendedor:</span>
                    <span className="font-mono text-emerald-700">R$ 0,00</span>
                  </div>
                  <div className="flex justify-between border-t border-slate-200 pt-2 text-sm font-bold text-emerald-700">
                    <span>Lucro Líquido Real:</span>
                    <span className="font-mono">
                      {brl(simResult.net)} ({simResult.roi}% sobre custo)
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* VIEW 5: SUBIR EM LOTE AUTOMATIZADO & CONTA MERCADO LIVRE */}
        {activeNav === 'anuncios' && (
          <div className="space-y-6">
            <div className="surface flex flex-wrap items-center justify-between gap-4 p-5">
              <div>
                <h1 className="text-lg font-bold text-slate-900">
                  Carga em Lote — Somente Pré-Publicados e Revisados
                </h1>
                <p className="mt-0.5 text-xs text-slate-600">
                  <strong className="font-mono">{resumo.revisao_aprovada || 0}</strong> liberados para envio pausado ·{' '}
                  <strong className="font-mono">{resumo.revisao_pendente || 0}</strong> pendentes de pré-publicação/revisão.
                </p>
              </div>
              <div>
                {account ? (
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-slate-700">
                      Conectado como <strong>{account.nickname}</strong> (ID {account.user_id})
                    </span>
                    <button type="button" onClick={handleDisconnectMl} className="btn-danger text-xs">
                      Desconectar
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={!authConfig?.configured}
                    onClick={handleConnectMl}
                    className="btn-primary text-xs"
                  >
                    {authConfig?.configured
                      ? 'Conectar Conta Mercado Livre (OAuth)'
                      : 'Aguardando ML_APP_ID e ML_CLIENT_SECRET (Após novo CNAE)'}
                  </button>
                )}
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-12">
              <div className="surface space-y-4 p-5 lg:col-span-6">
                <div className="label">Enviar Lote Pausado Após Verificação</div>
                <p className="text-xs leading-relaxed text-slate-600">
                  O motor só envia itens que passaram pela pré-publicação automática (fotos, título, descrição, preço, categoria, atributos, frete grátis sem etiqueta e validação oficial do ML) e pela revisão manual. Itens sem essa dupla aprovação são bloqueados e não saem daqui.
                </p>

                <div className="grid gap-3 sm:grid-cols-3">
                  <div>
                    <label className="text-xs font-medium text-slate-700">Fornecedor da Base</label>
                    <select
                      value={uploadSupplierFilter}
                      onChange={(e) => setUploadSupplierFilter(e.target.value)}
                      className="input mt-1 text-xs"
                    >
                      <option value="">Todos ({resumo.prontos_para_subir})</option>
                      {(resumo.fornecedores || []).map((f) => (
                        <option key={f.nome} value={f.nome}>
                          {f.nome} ({f.qtd})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-slate-700">Tamanho do Lote</label>
                    <select
                      value={uploadBatchSize}
                      onChange={(e) => setUploadBatchSize(e.target.value)}
                      className="input mt-1 font-mono text-xs"
                    >
                      <option value="10">10 anúncios</option>
                      <option value="20">20 anúncios</option>
                      <option value="30">30 anúncios</option>
                      <option value="50">50 anúncios</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-slate-700">Status Inicial</label>
                    <div className="input mt-1 flex items-center bg-slate-50 font-mono text-xs text-slate-700">
                      Pausado (obrigatório)
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={uploadingBatch || !account}
                  onClick={() => handleBatchUploadMl(null)}
                  className="btn-accent w-full text-xs"
                >
                  <Icon name="upload" className="h-4 w-4" />
                  {uploadingBatch
                    ? 'Subindo Lote Automatizado para o Mercado Livre...'
                    : account
                      ? `Enviar até ${uploadBatchSize} Aprovados (Pausado)`
                      : 'Conecte a Conta Mercado Livre da MeLi Max Shop para Disparar Lote'}
                </button>

                {lastUploadReport ? (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
                    <div className="font-mono font-semibold text-slate-800">
                      Enviados com sucesso: {lastUploadReport.enviados} · Falhas: {lastUploadReport.falhas}
                    </div>
                    {Array.isArray(lastUploadReport.resultados) && lastUploadReport.falhas > 0 ? (
                      <div className="mt-2 space-y-1.5">
                        {(lastUploadReport.resultados || [])
                          .filter((r) => !r.ok)
                          .slice(0, 8)
                          .map((r) => (
                            <div key={r.sku} className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-800">
                              <span className="font-mono font-semibold">{r.sku}</span>
                              <span className="mx-1.5 text-red-400">·</span>
                              <span className="break-words">{String(r.error || 'Erro desconhecido').slice(0, 220)}</span>
                            </div>
                          ))}
                        {(lastUploadReport.falhas || 0) > 8 ? (
                          <div className="text-[11px] font-medium text-slate-500">
                            + {(lastUploadReport.falhas || 0) - 8} falha(s). Veja os detalhes no log do backend.
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    {Array.isArray(lastUploadReport.bloqueados) && lastUploadReport.bloqueados.length > 0 ? (
                      <div className="mt-2 space-y-1.5">
                        <div className="text-[11px] font-semibold text-amber-800">
                          Bloqueados sem pré-publicação + revisão (não enviados):
                        </div>
                        {lastUploadReport.bloqueados.slice(0, 8).map((item) => (
                          <div
                            key={item.sku}
                            className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900"
                          >
                            <span className="font-mono font-semibold">{item.sku}</span>
                            <span className="mx-1.5">·</span>
                            <span className="break-words">{item.missing?.join('; ') || 'pendente'}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="surface space-y-3 p-5 lg:col-span-12">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="label">Controle de Status Real no Mercado Livre</div>
                    <p className="mt-1 text-xs leading-relaxed text-slate-600">
                      Sincroniza o status real da API, desativa todos os anúncios e ativa em massa somente os que passaram pela pré-publicação automática e revisão manual. Nenhuma ativação ignora o gate.
                    </p>
                  </div>
                  <span className="badge badge-neutral font-mono text-[11px]">
                    ML: {account?.nickname || 'desconectado'}
                  </span>
                </div>
                <div className="grid gap-2 sm:grid-cols-3">
                  <button
                    type="button"
                    disabled={!account || Boolean(statusBusy)}
                    onClick={handleSyncMlStatus}
                    className="btn-secondary text-xs"
                  >
                    <Icon name="refresh" className="h-3.5 w-3.5" />
                    {statusBusy === 'sync' ? 'Sincronizando...' : 'Sincronizar status real do ML'}
                  </button>
                  <button
                    type="button"
                    disabled={!account || Boolean(statusBusy)}
                    onClick={() => handleStatusLote('pausar')}
                    className="btn-danger text-xs"
                  >
                    <Icon name="pause" className="h-3.5 w-3.5" />
                    {statusBusy === 'pausar' ? 'Desativando no ML...' : 'Desativar todos no ML'}
                  </button>
                  <button
                    type="button"
                    disabled={!account || Boolean(statusBusy)}
                    onClick={() => handleStatusLote('ativar')}
                    className="btn-primary text-xs"
                  >
                    <Icon name="play" className="h-3.5 w-3.5" />
                    {statusBusy === 'ativar' ? 'Ativando aprovados...' : 'Ativar aprovados em massa'}
                  </button>
                </div>
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-[11px] leading-relaxed text-amber-900">
                  Regra de envio obrigatória: “Vou enviar por minha conta”, frete grátis R$ 0,00 para todo o Brasil, sem retirada no local, sem retirada em agência e sem etiqueta do Mercado Livre. O código de postagem é inserido manualmente na venda.
                </div>
                {lastStatusReport ? (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
                    <div className="font-mono font-semibold text-slate-800">
                      {lastStatusReport.tipo === 'sincronizacao' ? 'Sincronização' : lastStatusReport.tipo === 'ativar' ? 'Ativação' : 'Desativação'}:
                      {' '}total {lastStatusReport.total} · atualizados {lastStatusReport.atualizados}
                      {' '}· bloqueados {lastStatusReport.bloqueados?.length || 0} · falhas {lastStatusReport.falhas}
                    </div>
                    {lastStatusReport.resumo ? (
                      <div className="mt-1 font-mono text-[11px] text-slate-600">
                        {Object.entries(lastStatusReport.resumo).map(([k, v]) => `${k}: ${v}`).join(' · ')}
                      </div>
                    ) : null}
                    {Array.isArray(lastStatusReport.bloqueados) && lastStatusReport.bloqueados.length > 0 ? (
                      <div className="mt-2 space-y-1">
                        {lastStatusReport.bloqueados.slice(0, 8).map((b) => (
                          <div key={b.ml_item_id} className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-900">
                            <span className="font-mono font-semibold">{b.ml_item_id}</span>
                            {' · '}
                            <span>{b.missing?.join('; ') || 'sem gate'}</span>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="surface space-y-3 p-5 lg:col-span-6">
                <div className="label">Quais Secrets São Estritamente Necessárias?</div>
                <p className="text-xs leading-relaxed text-slate-700">
                  <strong>Nenhuma secret adicional é necessária para alimentar a base</strong>, minerar as 6 lojas brasileiras do AliExpress sem repetição ou baixar os CSVs completos. As credenciais do Mercado Livre já estão configuradas no backend e a conta autorizada aparece acima; o painel é protegido por senha.
                </p>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 text-xs space-y-2">
                  <div className="font-semibold text-slate-900">
                    Credenciais já configuradas (não precisam ser coladas no painel):
                  </div>
                  <div className="text-slate-600">
                    1. <code className="font-mono font-semibold text-slate-900">ML_APP_ID</code> — ID do aplicativo do Mercado Livre.
                  </div>
                  <div className="text-slate-600">
                    2. <code className="font-mono font-semibold text-slate-900">ML_CLIENT_SECRET</code> — Chave secreta usada para renovar a autorização da conta conectada.
                  </div>
                  <div className="text-slate-600">
                    3. <code className="font-mono font-semibold text-slate-900">DASHBOARD_AUTH_ENABLED</code> — Mantém o painel protegido pela senha configurada.
                  </div>
                </div>
              </div>
            </div>

            <div className="surface overflow-hidden">
              <div className="border-b border-slate-200 px-5 py-3.5 text-sm font-bold text-slate-900">
                Anúncios Publicados via API ({listings.length})
              </div>
              {listings.length === 0 ? (
                <div className="p-10 text-center text-xs text-slate-500">
                  Nenhum anúncio enviado via API ainda. Nossa base já conta com{' '}
                  <strong>{resumo.total} produtos únicos prontos (Qualidade 98%–100%)</strong> aguardando a liberação do novo CNAE da MeLi Max Shop.
                </div>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-slate-200 bg-slate-50 text-[11px] font-semibold uppercase text-slate-500">
                    <tr>
                      <th className="px-4 py-3">ID ML</th>
                      <th className="px-4 py-3">Título</th>
                      <th className="px-4 py-3 text-right">Preço</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3 text-right">Link</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {listings.map((l) => (
                      <tr key={l.ml_item_id}>
                        <td className="px-4 py-3 font-mono font-semibold">{l.ml_item_id}</td>
                        <td className="px-4 py-3 font-medium text-slate-900">{l.title}</td>
                        <td className="px-4 py-3 text-right font-mono">{brl(l.price)}</td>
                        <td className="px-4 py-3">{l.status}</td>
                        <td className="px-4 py-3 text-right">
                          {l.permalink ? (
                            <a
                              href={l.permalink}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-semibold text-meli-blue hover:underline"
                            >
                              Ver no ML
                            </a>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </main>

      {selectedProduct ? (
        <ProductDetailModal
          product={selectedProduct}
          accountConnected={Boolean(account)}
          notify={notify}
          onClose={() => setSelectedProduct(null)}
          onSaved={(updated) => {
            setSelectedProduct(updated);
            loadCatalog();
          }}
          onPublished={() => {
            loadCatalog();
            loadListings();
          }}
        />
      ) : null}
    </div>
  );
}
