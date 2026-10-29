import { useCallback, useEffect, useMemo, useState } from 'react';

const rawApiUrl = (import.meta.env.VITE_API_URL || '').trim();
const API = (rawApiUrl || '/api').replace(/\/+$/, '');

async function request(path, options = {}) {
  const { body, headers, ...rest } = options;
  const res = await fetch(`${API}${path}`, {
    ...rest,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(headers || {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await res.json().catch(() => null)
    : await res.text().catch(() => null);

  if (!res.ok) {
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

  const previewCalc = useMemo(() => {
    const cost = Math.max(Number(custoBrl) || 0, 0);
    const mult = Math.max(Number(multiplicador) || 2.8, 1);
    const raw = Number((cost * mult).toFixed(2));
    const finalPrice = Math.max(raw, 79.9);
    const fee = Number((finalPrice * 0.19).toFixed(2));
    const tax = Number((finalPrice * 0.06).toFixed(2));
    const net = Number((finalPrice - cost - fee - tax).toFixed(2));
    return { cost, raw, finalPrice, fee, tax, net, piso: finalPrice > raw };
  }, [custoBrl, multiplicador]);

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

  const handlePublishMl = async (statusMode = 'paused') => {
    setPublishing(true);
    try {
      const res = await request('/aliexpress/publicar-ml', {
        method: 'POST',
        body: { sku: product.sku, status: statusMode },
      });
      notify(
        `Anúncio publicado (${statusMode === 'active' ? 'Ativo' : 'Pausado'}) no Mercado Livre: ${res.ml_item_id}.`,
        'success'
      );
      onPublished?.(res);
    } catch (err) {
      notify(err.message, 'error');
    } finally {
      setPublishing(false);
    }
  };

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
                Qualidade ML {product.qualidade_score || 98}%
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
                  <span>Comissão Premium ML (19%) + Impostos EI (6%):</span>
                  <span className="font-mono">- {brl(previewCalc.fee + previewCalc.tax)}</span>
                </div>
                <div className="flex justify-between text-slate-600">
                  <span>Frete Vendedor (AliExpress Brasil):</span>
                  <span className="font-mono text-emerald-700">R$ 0,00 (Grátis)</span>
                </div>
                <div className="flex justify-between border-t border-slate-200 pt-1.5 font-semibold text-emerald-700">
                  <span>Lucro Líquido Estimado:</span>
                  <span className="font-mono">{brl(previewCalc.net)}</span>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-4 lg:col-span-7">
            <div>
              <div className="flex items-center justify-between">
                <label className="label">Título Otimizado Mercado Livre (SEO 85%+)</label>
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
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-6 py-3.5">
          <div className="text-xs text-slate-600">
            Qualidade estimada ML:{' '}
            <strong className="font-mono text-emerald-700">{product.qualidade_score || 98}%</strong> (Meta 85%+) · Frete Grátis Brasil Confirmado · Sem etiquetas
          </div>
          <div className="flex items-center gap-2.5">
            {accountConnected ? (
              <>
                <button
                  type="button"
                  disabled={publishing}
                  onClick={() => handlePublishMl('paused')}
                  className="btn-ghost text-xs"
                >
                  {publishing ? 'Enviando...' : 'Subir Pausado (1 Clique)'}
                </button>
                <button
                  type="button"
                  disabled={publishing}
                  onClick={() => handlePublishMl('active')}
                  className="btn-accent text-xs"
                >
                  {publishing ? 'Publicando...' : 'Subir Ativo no ML'}
                </button>
              </>
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
  const [uploadStatusMode, setUploadStatusMode] = useState('paused');
  const [uploadSupplierFilter, setUploadSupplierFilter] = useState('');
  const [uploadingBatch, setUploadingBatch] = useState(false);
  const [lastUploadReport, setLastUploadReport] = useState(null);

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
    loadAccount();
    loadApprovedStores();
  }, [loadAccount, loadApprovedStores]);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    if (activeNav === 'fornecedores') loadApprovedStores();
    if (activeNav === 'execucao') loadOrders();
    if (activeNav === 'anuncios') loadListings();
  }, [activeNav, loadApprovedStores, loadOrders, loadListings]);

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

  const handleBatchUploadMl = async (customSkus = null) => {
    setUploadingBatch(true);
    try {
      const payload =
        Array.isArray(customSkus) && customSkus.length > 0
          ? {
              skus: customSkus,
              limite: customSkus.length,
              status: uploadStatusMode,
            }
          : {
              limite: Number(uploadBatchSize) || 20,
              status: uploadStatusMode,
              fornecedor: uploadSupplierFilter,
            };

      const res = await request('/aliexpress/publicar-lote', {
        method: 'POST',
        body: payload,
      });
      setLastUploadReport(res);
      if (res.enviados > 0) {
        setSelectedSkus([]);
        notify(`${res.enviados} anúncios enviados ao Mercado Livre com qualidade 85%+!`, 'success');
      } else {
        const firstErr = res.resultados?.[0]?.error || 'Conecte a conta Mercado Livre para iniciar a carga.';
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
    venda_media: 0,
    lucro_liquido_medio: 0,
    roi_medio_pct: 0,
    categorias: [],
    fornecedores: [],
  };

  const csvQuerySuffix = selectedSupplier
    ? `&fornecedor=${encodeURIComponent(selectedSupplier)}`
    : '';

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
            <a
              href={`${API}/aliexpress/export-csv?formato=completo${csvQuerySuffix}`}
              className="btn-primary py-1.5 text-xs"
            >
              <Icon name="download" className="h-3.5 w-3.5" />
              {selectedSupplier
                ? `CSV ${selectedSupplier} (${catalogData.total_filtrado})`
                : `CSV Completo (${resumo.total})`}
            </a>
            <a
              href={`${API}/aliexpress/export-csv?formato=planilha_ml${csvQuerySuffix}`}
              className="btn-ghost py-1.5 text-xs"
            >
              <Icon name="download" className="h-3.5 w-3.5" />
              Planilha ML (;)
            </a>

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
                  Base de Produtos Prontos para Subir em 1 Clique (Qualidade ML 85%+)
                </h1>
                <p className="mt-0.5 text-sm text-slate-600">
                  Catálogo deduplicado com estoque no Brasil e Frete Totalmente Grátis confirmado, 4+ fotos HD, título SEO até 60 caracteres e sobrepreço 2.8x (piso R$ 79,90).
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={`${API}/aliexpress/export-csv?formato=completo&fornecedor=${encodeURIComponent('DropFacil Store')}`}
                  className="btn-ghost py-1.5 text-xs"
                >
                  <Icon name="download" className="h-3.5 w-3.5" />
                  Baixar CSV Lote 2 · DropFacil Store
                </a>
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
                <div className="label">Qualidade Interna Mercado Livre</div>
                <div className="mt-1.5 flex items-baseline gap-2 font-mono tabular-nums">
                  <span className="text-2xl font-bold text-emerald-700">
                    {resumo.qualidade_media_pct || 99}%
                  </span>
                  <span className="text-xs font-semibold text-slate-600">
                    {resumo.acima_85_qualidade}/{resumo.total} acima de 85%
                  </span>
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  Título SEO + Ficha Técnica + 4–10 fotos + Frete R$ 0,00
                </div>
              </div>

              <div className="surface p-4">
                <div className="label">Custo Médio → Venda Média ML</div>
                <div className="mt-1.5 flex items-baseline gap-2 font-mono tabular-nums">
                  <span className="text-lg font-semibold text-slate-600">
                    {brl(resumo.custo_medio)}
                  </span>
                  <span className="text-slate-400">→</span>
                  <span className="text-2xl font-bold text-meli-blue">
                    {brl(resumo.venda_media)}
                  </span>
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  Lucro líquido médio: {brl(resumo.lucro_liquido_medio)} (ROI {resumo.roi_medio_pct}%)
                </div>
              </div>

              <div className="surface flex flex-col justify-between p-4">
                <div className="label">Exportar CSV (Geral ou Filtrado)</div>
                <div className="mt-2 flex flex-col gap-2">
                  <a
                    href={`${API}/aliexpress/export-csv?formato=completo${csvQuerySuffix}`}
                    className="btn-primary w-full py-1.5 text-xs"
                  >
                    <Icon name="download" className="h-3.5 w-3.5" />
                    {selectedSupplier ? `CSV Completo · ${selectedSupplier}` : 'CSV Completo Geral (66 Colunas)'}
                  </a>
                  <a
                    href={`${API}/aliexpress/export-csv?formato=planilha_ml${csvQuerySuffix}`}
                    className="btn-ghost w-full py-1.5 text-xs"
                  >
                    <Icon name="download" className="h-3.5 w-3.5" />
                    {selectedSupplier ? `Planilha ML · ${selectedSupplier}` : 'Planilha Publicação ML (;)'}
                  </a>
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
                    disabled={uploadingBatch}
                    onClick={() => handleBatchUploadMl(selectedSkus)}
                    className="btn-accent py-1.5 text-xs"
                  >
                    <Icon name="upload" className="h-3.5 w-3.5" />
                    {uploadingBatch
                      ? 'Enviando ao ML...'
                      : `Subir ${selectedSkus.length} Selecionado(s) no ML`}
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
                          </td>

                          <td className="px-3 py-3 text-[11px]">
                            <div className="font-mono font-semibold text-emerald-700">
                              Qualidade {item.qualidade_score || 98}% · Premium · Frete Grátis BR
                            </div>
                            <div className="text-slate-500">Por minha conta · R$ 0,00 · 5–10d</div>
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

        {/* VIEW 2: 6 FORNECEDORES HOMOLOGADOS ALIEXPRESS BRASIL */}
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
                    <span>Comissão Premium ML (19%):</span>
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
                  Carga Automatizada em Lote (Qualidade 85%+) & Conexão MeLi Max Shop
                </h1>
                <p className="mt-0.5 text-xs text-slate-600">
                  Base atual com <strong className="font-mono">{resumo.prontos_para_subir}</strong> produtos prontos para subir via API assim que o CNPJ concluir a atualização do CNAE.
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
                <div className="label">Subir Produtos em Lote para o Mercado Livre (1 Clique)</div>
                <p className="text-xs leading-relaxed text-slate-600">
                  O motor publica cada anúncio resolvendo automaticamente a categoria folha oficial do ML, preenchendo os atributos obrigatórios da ficha técnica (para atingir 85%+ de qualificação interna), fotos HD, sobrepreço 2.8x e modalidade <strong>Vou enviar por minha conta (R$ 0,00 · Sem etiquetas)</strong>.
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
                    <select
                      value={uploadStatusMode}
                      onChange={(e) => setUploadStatusMode(e.target.value)}
                      className="input mt-1 text-xs"
                    >
                      <option value="paused">Pausado (Conferir)</option>
                      <option value="active">Ativo (Venda Imediata)</option>
                    </select>
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
                      ? `Subir Lote de ${uploadBatchSize} Produtos (Qualidade 85%+)`
                      : 'Conecte a Conta Mercado Livre da MeLi Max Shop para Disparar Lote'}
                </button>

                {lastUploadReport ? (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs font-mono">
                    Enviados com sucesso: {lastUploadReport.enviados} · Falhas: {lastUploadReport.falhas}
                  </div>
                ) : null}
              </div>

              <div className="surface space-y-3 p-5 lg:col-span-6">
                <div className="label">Quais Secrets São Estritamente Necessárias?</div>
                <p className="text-xs leading-relaxed text-slate-700">
                  <strong>Neste momento: NENHUMA secret é necessária</strong> para alimentar a base de produtos, minerar as 6 lojas brasileiras do AliExpress sem repetição ou baixar os CSVs completos. Removemos todas as variáveis antigas desnecessárias e mantivemos o painel sem senha por enquanto.
                </p>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3.5 text-xs space-y-2">
                  <div className="font-semibold text-slate-900">
                    Apenas 2 chaves serão usadas depois que sair o novo CNAE da MeLi Max Shop:
                  </div>
                  <div className="text-slate-600">
                    1. <code className="font-mono font-semibold text-slate-900">ML_APP_ID</code> — ID do seu aplicativo criado gratuitamente em <code className="font-mono">developers.mercadolivre.com.br</code>.
                  </div>
                  <div className="text-slate-600">
                    2. <code className="font-mono font-semibold text-slate-900">ML_CLIENT_SECRET</code> — Chave secreta desse mesmo aplicativo do Mercado Livre para autorizar o envio de anúncios em 1 clique direto na sua conta.
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
