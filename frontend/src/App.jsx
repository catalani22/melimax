import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const API = (import.meta.env.VITE_API_URL || 'https://melimax-backend.vercel.app/api').replace(/\/+$/, '');
const DASHBOARD_TOKEN_STORAGE = 'melimax_dashboard_token';
const LEGACY_DASHBOARD_KEY_STORAGE = 'melimax_dashboard_key';

async function request(path, options = {}) {
  const { body, headers, ...rest } = options;
  const dashboardKey = sessionStorage.getItem(DASHBOARD_TOKEN_STORAGE) || '';
  const res = await fetch(`${API}${path}`, {
    ...rest,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(dashboardKey ? { 'x-dashboard-key': dashboardKey } : {}),
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
      (data && (data.error || data.message)) || `Erro ${res.status} ao chamar a API`
    );
    error.status = res.status;
    error.data = data;
    throw error;
  }

  return data;
}

const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const number = new Intl.NumberFormat('pt-BR');

function brl(value) {
  return money.format(Number(value) || 0);
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function imageUrl(url) {
  if (!url) return '';
  return String(url).replace(/^http:/, 'https:');
}

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Visão geral', icon: 'grid' },
  { id: 'radar', label: 'Radar viral', icon: 'trending' },
  { id: 'catalogo', label: 'Catálogo', icon: 'layers' },
  { id: 'produtos', label: 'Produtos', icon: 'box' },
  { id: 'fornecedores', label: 'Fornecedores', icon: 'store' },
  { id: 'anuncios', label: 'Anúncios', icon: 'tag' },
  { id: 'pedidos', label: 'Pedidos', icon: 'cart' },
  { id: 'admin', label: 'Administração', icon: 'shield' },
];

const VIEW_TITLES = {
  dashboard: { title: 'Visão geral', subtitle: 'Resumo da sua operação no Mercado Livre.' },
  radar: { title: 'Radar viral', subtitle: 'Acompanhe tendências, ofertas e produtos com espaço para preço melhor.' },
  catalogo: { title: 'Catálogo de fornecedores', subtitle: 'Importe custos, estoque, peso e acompanhe a atualização.' },
  produtos: { title: 'Produtos', subtitle: 'Encontre produtos reais por nicho e crie anúncios.' },
  fornecedores: { title: 'Fornecedores', subtitle: 'Vendedores reais encontrados no Mercado Livre.' },
  anuncios: { title: 'Anúncios', subtitle: 'Seus anúncios publicados e qualificação.' },
  pedidos: { title: 'Pedidos', subtitle: 'Vendas, envios e etiquetas do Mercado Envios.' },
  admin: { title: 'Administração', subtitle: 'Usuários, permissões e senha de acesso ao painel.' },
};

function Icon({ name, className = 'h-5 w-5' }) {
  const paths = {
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    box: (
      <>
        <path d="M21 8l-9-5-9 5 9 5 9-5z" />
        <path d="M3 8v8l9 5 9-5V8" />
        <path d="M12 13v8" />
      </>
    ),
    layers: (
      <>
        <path d="M12 2l9 5-9 5-9-5 9-5z" />
        <path d="M3 12l9 5 9-5" />
        <path d="M3 17l9 5 9-5" />
      </>
    ),
    store: (
      <>
        <path d="M3 9l1.5-5h15L21 9" />
        <path d="M4 9v11h16V9" />
        <path d="M9 20v-6h6v6" />
      </>
    ),
    tag: (
      <>
        <path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" />
        <circle cx="7.5" cy="7.5" r="1.5" />
      </>
    ),
    cart: (
      <>
        <circle cx="9" cy="20" r="1.5" />
        <circle cx="18" cy="20" r="1.5" />
        <path d="M2 3h2l2.4 12.2a2 2 0 0 0 2 1.8h8.8a2 2 0 0 0 2-1.6L21 7H5" />
      </>
    ),
    trending: (
      <>
        <path d="M3 17l6-6 4 4 8-8" />
        <path d="M15 7h6v6" />
      </>
    ),
    refresh: (
      <>
        <path d="M21 12a9 9 0 1 1-2.6-6.4" />
        <path d="M21 3v6h-6" />
      </>
    ),
    external: (
      <>
        <path d="M14 3h7v7" />
        <path d="M10 14L21 3" />
        <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
      </>
    ),
    logout: (
      <>
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        <path d="M16 17l5-5-5-5" />
        <path d="M21 12H9" />
      </>
    ),
    menu: (
      <>
        <path d="M4 6h16" />
        <path d="M4 12h16" />
        <path d="M4 18h16" />
      </>
    ),
    close: (
      <>
        <path d="M6 6l12 12" />
        <path d="M18 6L6 18" />
      </>
    ),
    check: <path d="M20 6L9 17l-5-5" />,
    alert: (
      <>
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
        <path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      </>
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="M21 21l-4.3-4.3" />
      </>
    ),
    download: (
      <>
        <path d="M12 3v12" />
        <path d="M7 10l5 5 5-5" />
        <path d="M5 21h14" />
      </>
    ),
    shield: (
      <>
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <path d="M9 12l2 2 4-4" />
      </>
    ),
  };

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {paths[name] || null}
    </svg>
  );
}

function Spinner({ className = 'h-5 w-5' }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-90" fill="currentColor" d="M12 2a10 10 0 0 1 10 10h-3a7 7 0 0 0-7-7V2z" />
    </svg>
  );
}

function Toast({ toast, onClose }) {
  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(onClose, 5500);
    return () => clearTimeout(timer);
  }, [toast, onClose]);

  if (!toast) return null;

  const styles = {
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    error: 'border-red-200 bg-red-50 text-red-800',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
    info: 'border-slate-200 bg-white text-slate-800',
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 w-[calc(100%-2rem)] max-w-md">
      <div className={`flex items-start gap-3 rounded-xl border p-4 shadow-card ${styles[toast.type] || styles.info}`}>
        <Icon
          name={toast.type === 'success' ? 'check' : toast.type === 'error' ? 'alert' : 'alert'}
          className="mt-0.5 h-5 w-5 shrink-0"
        />
        <div className="min-w-0 flex-1 text-sm font-medium">{toast.message}</div>
        <button type="button" onClick={onClose} className="rounded p-1 hover:bg-black/5" aria-label="Fechar">
          <Icon name="close" className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function PasswordScreen({ onSubmit, error, loading }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className="relative min-h-screen overflow-hidden bg-slate-950 text-white">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-32 top-0 h-96 w-96 rounded-full bg-brand-500/20 blur-3xl" />
        <div className="absolute -right-24 bottom-0 h-96 w-96 rounded-full bg-emerald-500/10 blur-3xl" />
      </div>

      <div className="relative mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-6 py-14">
        <div className="w-full rounded-2xl border border-white/10 bg-white/5 p-6 shadow-2xl backdrop-blur sm:p-8">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-400 font-black text-slate-950">
              ML
            </div>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-brand-300">Melimax</p>
              <h1 className="text-lg font-bold">Acesso restrito</h1>
            </div>
          </div>

          <div className="mt-6 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
            <Icon name="shield" className="h-4 w-4" />
            Painel protegido
          </div>
          <p className="mt-2 text-sm text-slate-300">
            Informe usuário e senha para liberar anúncios, pedidos, integrações e a administração.
          </p>

          <form
            className="mt-5 space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!loading && password) onSubmit(username.trim() || 'admin', password);
            }}
          >
            <input
              type="text"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="Usuário"
              className="w-full rounded-lg border border-white/10 bg-white/10 px-3 py-2.5 text-sm text-white placeholder-slate-500 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-400/20"
            />
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                autoFocus
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Senha do painel"
                className="w-full rounded-lg border border-white/10 bg-white/10 px-3 py-2.5 pr-16 text-sm text-white placeholder-slate-500 outline-none transition focus:border-brand-400 focus:ring-2 focus:ring-brand-400/20"
              />
              <button
                type="button"
                onClick={() => setShowPassword((current) => !current)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-2 py-1 text-[11px] font-semibold text-slate-300 hover:bg-white/10"
              >
                {showPassword ? 'Ocultar' : 'Mostrar'}
              </button>
            </div>
            {error ? (
              <div className="rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200">
                {error}
              </div>
            ) : null}
            <button
              type="submit"
              disabled={loading || !password}
              className="btn-primary w-full py-3 text-base disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? <Spinner className="h-4 w-4" /> : <Icon name="shield" className="h-4 w-4" />}
              Entrar no painel
            </button>
          </form>

          <p className="mt-4 text-center text-xs text-slate-400">
            A sessão fica apenas neste navegador. O usuário padrão é <strong>admin</strong>.
          </p>
        </div>
      </div>
    </div>
  );
}

function LoginScreen({ onLogin, error }) {
  const features = [
    'Produtos reais por nicho direto da API oficial',
    'Criação de anúncios com margem configurável',
    'Pedidos e etiquetas do Mercado Envios',
  ];

  return (
    <div className="relative min-h-screen overflow-hidden bg-slate-950 text-white">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-32 top-0 h-96 w-96 rounded-full bg-brand-500/20 blur-3xl" />
        <div className="absolute -right-24 bottom-0 h-96 w-96 rounded-full bg-emerald-500/10 blur-3xl" />
      </div>

      <div className="relative mx-auto flex min-h-screen max-w-6xl flex-col items-center justify-center gap-12 px-6 py-14 lg:flex-row lg:justify-between">
        <div className="max-w-xl">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-400 text-lg font-black text-slate-950">
              ML
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-300">Melimax</p>
              <h1 className="text-2xl font-bold">Painel Mercado Livre</h1>
            </div>
          </div>

          <h2 className="mt-8 text-3xl font-extrabold leading-tight sm:text-4xl">
            Sua operação de anúncios e vendas em um só lugar.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-slate-300">
            Conecte sua conta do Mercado Livre para pesquisar produtos, publicar anúncios
            com margem e acompanhar pedidos e etiquetas.
          </p>

          <ul className="mt-8 space-y-3">
            {features.map((feature) => (
              <li key={feature} className="flex items-start gap-3 text-sm text-slate-200">
                <span className="mt-0.5 rounded-full bg-emerald-500/15 p-1 text-emerald-400">
                  <Icon name="check" className="h-4 w-4" />
                </span>
                {feature}
              </li>
            ))}
          </ul>
        </div>

        <div className="w-full max-w-md rounded-2xl border border-white/10 bg-white/5 p-6 shadow-2xl backdrop-blur sm:p-8">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
            <Icon name="shield" className="h-4 w-4" />
            Acesso pessoal e seguro
          </div>
          <h3 className="mt-4 text-xl font-bold">Conectar conta</h3>
          <p className="mt-2 text-sm text-slate-300">
            Você será redirecionado para autorizar o acesso no site oficial do Mercado Livre.
          </p>

          {error ? (
            <div className="mt-4 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200">
              {error}
            </div>
          ) : null}

          <button type="button" onClick={onLogin} className="btn-primary mt-6 w-full py-3 text-base">
            Conectar conta Mercado Livre
          </button>

          <p className="mt-4 text-center text-xs text-slate-400">
            Seus tokens ficam no seu banco Postgres. Nenhum dado é compartilhado.
          </p>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, hint, accent = 'slate' }) {
  const accents = {
    slate: 'bg-slate-900 text-white',
    brand: 'bg-brand-400 text-slate-900',
    emerald: 'bg-emerald-500 text-white',
    sky: 'bg-sky-500 text-white',
    amber: 'bg-amber-500 text-white',
  };

  return (
    <div className="card p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="label">{label}</p>
          <p className="mt-2 text-2xl font-extrabold tracking-tight">{value}</p>
        </div>
        <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${accents[accent] || accents.slate}`}>
          <Icon
            name={
              accent === 'emerald'
                ? 'cart'
                : accent === 'brand'
                  ? 'tag'
                  : accent === 'amber'
                    ? 'alert'
                    : 'grid'
            }
            className="h-5 w-5"
          />
        </span>
      </div>
      {hint ? <p className="mt-3 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}

function DashboardView({
  account,
  listings,
  orders,
  monthly,
  monthlyLoading,
  onPauseAll,
  onReactivateAll,
  pausing,
  onNavigate,
}) {
  const activeListings = listings.filter((item) => item.status === 'active').length;
  const pausedListings = listings.filter((item) => item.status === 'paused').length;
  const revenue = orders.reduce((sum, order) => sum + (Number(order.total_amount) || 0), 0);
  const avgMargin = listings.length
    ? listings.reduce((sum, item) => sum + (Number(item.margin) || 0), 0) / listings.length
    : 0;
  const goalRevenue = 100000;
  const goalProfit = 20000;
  const monthRevenue = Number(monthly?.faturamento) || 0;
  const monthOrders = Number(monthly?.pedidos) || 0;
  const monthTicket = Number(monthly?.ticket_medio) || 0;
  const marginBase = avgMargin > 0 ? avgMargin : 0.5;
  const projectedProfit = monthRevenue * marginBase;
  const revenueProgress = Math.min((monthRevenue / goalRevenue) * 100, 100);
  const profitProgress = Math.min((projectedProfit / goalProfit) * 100, 100);
  const today = new Date();
  const todaySales = orders.filter((order) => {
    if (['cancelled', 'invalid', 'pending_cancel'].includes(order.status)) {
      return false;
    }
    const date = new Date(order.date_created);
    return (
      date.getFullYear() === today.getFullYear() &&
      date.getMonth() === today.getMonth() &&
      date.getDate() === today.getDate()
    );
  }).length;
  const dailyTarget = 3;
  const warmupListings = listings.filter(
    (item) =>
      item.status === 'active' &&
      Number(item.price) >= 80 &&
      Number(item.price) <= 100
  ).length;
  const warmupProgress = Math.min((todaySales / dailyTarget) * 100, 100);
  const capitalNeeded = dailyTarget * 45 * 12;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Anúncios" value={number.format(listings.length)} hint={`${activeListings} ativos`} accent="brand" />
        <StatCard label="Pedidos" value={number.format(orders.length)} hint="Últimos 50 pedidos" accent="emerald" />
        <StatCard label="Faturamento" value={brl(revenue)} hint="Soma dos pedidos carregados" accent="sky" />
        <StatCard
          label="Margem média"
          value={`${Math.round(avgMargin * 100)}%`}
          hint="Configurada nos seus anúncios"
        />
      </div>

      <div className="card p-5">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="label">Meta do mês</p>
            <h3 className="mt-1 text-2xl font-extrabold tracking-tight">
              {brl(monthRevenue)}
              <span className="ml-2 text-sm font-semibold text-slate-400">/ {brl(goalRevenue)}</span>
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              {monthlyLoading
                ? 'Carregando resumo do mês...'
                : `${monthOrders} pedido(s) no mês · ticket médio ${brl(monthTicket)} · lucro projetado ${brl(projectedProfit)} / ${brl(goalProfit)}`}
            </p>
          </div>
          <div className="w-full max-w-md space-y-3">
            <div>
              <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
                <span>Faturamento</span>
                <span>{Math.round(revenueProgress)}%</span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
                <div className="h-2 rounded-full bg-brand-400" style={{ width: `${revenueProgress}%` }} />
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
                <span>Lucro projetado ({Math.round(marginBase * 100)}% de margem)</span>
                <span>{Math.round(profitProgress)}%</span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
                <div className="h-2 rounded-full bg-emerald-500" style={{ width: `${profitProgress}%` }} />
              </div>
            </div>
          </div>
        </div>
        <p className="mt-4 text-[11px] text-slate-400">
          Base: pedidos do mês atual carregados da API do Mercado Livre. O lucro projetado usa a margem média dos seus anúncios; para a meta de R$ 20 mil, mantenha margem líquida acima de 45% e multiplicador de pelo menos 3x.
        </p>
      </div>

      <div className="card p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-600">
              <Icon name="shield" className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className="label">Aquecimento · primeiros 5 dias</p>
              <h3 className="mt-1 font-bold">
                Vendas hoje: {todaySales}/{dailyTarget}
                {todaySales >= dailyTarget ? ' · cota batida, pause os anúncios' : ''}
              </h3>
              <p className="mt-1 text-xs text-slate-500">
                Anúncios entre R$ 80 e R$ 100: {warmupListings}/50 · capital de giro recomendado {brl(capitalNeeded)} a {brl(2000)} · exposição clássica · estoque de 1 unidade por anúncio.
              </p>
              <div className="mt-2 h-2 w-full max-w-md overflow-hidden rounded-full bg-slate-100">
                <div
                  className={`h-2 rounded-full ${todaySales >= dailyTarget ? 'bg-rose-500' : 'bg-amber-400'}`}
                  style={{ width: `${warmupProgress}%` }}
                />
              </div>
              <p className="mt-2 text-[11px] text-slate-400">
                Regra: 2 a 3 vendas por dia, 10 vendas em 5 dias, pausar ao bater a cota e reativar só depois de liberar o caixa.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={onPauseAll}
              className="btn-danger"
              disabled={pausing || activeListings === 0}
            >
              {pausing ? <Spinner className="h-4 w-4" /> : <Icon name="alert" className="h-4 w-4" />}
              Freio de mão
            </button>
            {pausedListings > 0 ? (
              <button
                type="button"
                onClick={onReactivateAll}
                className="btn-primary"
                disabled={pausing}
              >
                {pausing ? <Spinner className="h-4 w-4" /> : <Icon name="tag" className="h-4 w-4" />}
                Reativar pausados
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
            <div>
              <h3 className="font-bold">Anúncios recentes</h3>
              <p className="text-xs text-slate-500">Últimos anúncios criados por você.</p>
            </div>
            <button type="button" onClick={() => onNavigate('anuncios')} className="text-sm font-semibold text-brand-700 hover:text-brand-800">
              Ver todos
            </button>
          </div>
          {listings.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-slate-500">
              Nenhum anúncio ainda. Comece escolhendo um produto.
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {listings.slice(0, 5).map((listing) => (
                <li key={listing.id} className="flex items-center gap-3 px-5 py-3">
                  <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-slate-100">
                    {listing.thumbnail ? (
                      <img src={imageUrl(listing.thumbnail)} alt="" className="h-full w-full object-cover" />
                    ) : null}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{listing.title}</p>
                    <p className="text-xs text-slate-500">{brl(listing.price)} · {listing.supplier}</p>
                  </div>
                  <span className="badge bg-slate-100 text-slate-600">{listing.score}%</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
            <div>
              <h3 className="font-bold">Pedidos recentes</h3>
              <p className="text-xs text-slate-500">Acompanhe suas vendas.</p>
            </div>
            <button type="button" onClick={() => onNavigate('pedidos')} className="text-sm font-semibold text-brand-700 hover:text-brand-800">
              Ver todos
            </button>
          </div>
          {orders.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-slate-500">
              Nenhum pedido encontrado na conta {account.nickname}.
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {orders.slice(0, 5).map((order) => (
                <li key={order.id} className="flex items-center gap-3 px-5 py-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
                    <Icon name="cart" className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">Pedido #{order.id}</p>
                    <p className="text-xs text-slate-500">
                      {order.buyer?.nickname || 'Comprador'} · {formatDate(order.date_created)}
                    </p>
                  </div>
                  <span className="text-sm font-bold">{brl(order.total_amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="card flex flex-col items-start justify-between gap-4 p-5 sm:flex-row sm:items-center">
        <div>
          <h3 className="font-bold">Pronto para publicar?</h3>
          <p className="text-sm text-slate-500">Escolha um nicho, selecione um produto real e crie o anúncio.</p>
        </div>
        <button type="button" onClick={() => onNavigate('produtos')} className="btn-primary">
          Buscar produtos
        </button>
      </div>
    </div>
  );
}

function ProductsView({ nichos, selectedNicho, onSelectNicho, produtos, loading, onCreate }) {
  return (
    <div className="space-y-6">
      <div className="card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-bold">Escolha um nicho</h3>
            <p className="text-sm text-slate-500">Os produtos são buscados na API oficial do Mercado Livre.</p>
          </div>
          {selectedNicho ? (
            <span className="badge bg-brand-50 text-brand-800">
              {nichos.find((item) => item.id === selectedNicho)?.nome || selectedNicho}
            </span>
          ) : null}
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5">
          {nichos.map((nicho) => {
            const selected = nicho.id === selectedNicho;
            return (
              <button
                key={nicho.id}
                type="button"
                onClick={() => onSelectNicho(nicho.id)}
                className={`rounded-xl border px-3 py-3 text-left transition ${
                  selected
                    ? 'border-brand-400 bg-brand-50 ring-2 ring-brand-200'
                    : 'border-slate-200 bg-white hover:border-brand-300 hover:bg-brand-50/40'
                }`}
              >
                <p className="text-sm font-semibold">{nicho.nome}</p>
                <p className="mt-1 text-xs text-slate-500">Ticket médio {brl(nicho.media_ticket)}</p>
              </button>
            );
          })}
        </div>
      </div>

      {!selectedNicho ? (
        <div className="card px-6 py-16 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100 text-slate-500">
            <Icon name="search" className="h-6 w-6" />
          </div>
          <h3 className="mt-4 text-lg font-bold">Selecione um nicho para começar</h3>
          <p className="mt-1 text-sm text-slate-500">Vamos buscar produtos acima de R$ 80 com boa relevância.</p>
        </div>
      ) : null}

      {loading ? (
        <div className="flex items-center justify-center gap-3 py-16 text-sm font-medium text-slate-500">
          <Spinner />
          Buscando produtos reais...
        </div>
      ) : null}

      {!loading && selectedNicho && produtos.length === 0 ? (
        <div className="card px-6 py-16 text-center text-sm text-slate-500">
          Nenhum produto encontrado para este nicho.
        </div>
      ) : null}

      {!loading && produtos.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {produtos.map((produto) => (
            <article key={produto.id} className="card flex flex-col overflow-hidden">
              <div className="aspect-[4/3] w-full overflow-hidden bg-slate-100">
                <img
                  src={imageUrl(produto.thumbnail)}
                  alt={produto.title}
                  loading="lazy"
                  className="h-full w-full object-contain p-2"
                />
              </div>
              <div className="flex flex-1 flex-col p-4">
                <p className="line-clamp-2 min-h-[2.5rem] text-sm font-semibold leading-snug">{produto.title}</p>
                <p className="mt-2 text-xl font-extrabold">{brl(produto.price)}</p>
                <p className="mt-1 truncate text-xs text-slate-500">
                  {produto.seller?.nickname || 'Vendedor Mercado Livre'}
                </p>
                <div className="mt-3 flex items-center gap-2">
                  {produto.free_shipping ? (
                    <span className="badge bg-emerald-50 text-emerald-700">Frete grátis</span>
                  ) : null}
                  {produto.condition === 'new' ? (
                    <span className="badge bg-slate-100 text-slate-600">Novo</span>
                  ) : null}
                </div>
                <button type="button" onClick={() => onCreate(produto)} className="btn-primary mt-4 w-full">
                  Criar anúncio
                </button>
              </div>
            </article>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SuppliersView({ fornecedores, loading, selectedNicho }) {
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-3 py-16 text-sm font-medium text-slate-500">
        <Spinner />
        Buscando vendedores do nicho...
      </div>
    );
  }

  if (!fornecedores.length) {
    return (
      <div className="card px-6 py-16 text-center text-sm text-slate-500">
        {selectedNicho
          ? 'Nenhum fornecedor encontrado para este nicho.'
          : 'Selecione um nicho na aba Produtos para carregar fornecedores reais.'}
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {fornecedores.map((fornecedor) => (
        <article key={fornecedor.id} className="card p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-slate-100 font-bold text-slate-500">
                {fornecedor.thumbnail ? (
                  <img src={imageUrl(fornecedor.thumbnail)} alt="" className="h-full w-full object-cover" />
                ) : (
                  (fornecedor.nome || '?').slice(0, 1).toUpperCase()
                )}
              </div>
              <div className="min-w-0">
                <p className="truncate font-bold">{fornecedor.nome}</p>
                <p className="text-xs text-slate-500">ID {fornecedor.id}</p>
              </div>
            </div>
            <span className="badge bg-emerald-50 text-emerald-700">{fornecedor.reputacao}</span>
          </div>

          <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-slate-50 p-2">
              <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Avaliação</dt>
              <dd className="mt-1 text-sm font-bold">{fornecedor.avaliacao ?? '—'}</dd>
            </div>
            <div className="rounded-lg bg-slate-50 p-2">
              <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">No prazo</dt>
              <dd className="mt-1 text-sm font-bold">
                {fornecedor.entregas_no_prazo == null ? '—' : `${fornecedor.entregas_no_prazo}%`}
              </dd>
            </div>
            <div className="rounded-lg bg-slate-50 p-2">
              <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Vendas</dt>
              <dd className="mt-1 text-sm font-bold">
                {fornecedor.vendas == null ? '—' : number.format(fornecedor.vendas)}
              </dd>
            </div>
          </dl>

          {fornecedor.permalink ? (
            <a
              href={fornecedor.permalink}
              target="_blank"
              rel="noreferrer"
              className="btn-ghost mt-4 w-full"
            >
              Ver no Mercado Livre
              <Icon name="external" className="h-4 w-4" />
            </a>
          ) : null}
        </article>
      ))}
    </div>
  );
}


function RadarView({ version = 0, onFindSupplier, onAnalyze, onToast }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [collecting, setCollecting] = useState(false);
  const [windowDays, setWindowDays] = useState(10);
  const [minPrice, setMinPrice] = useState(0);
  const [maxSellers, setMaxSellers] = useState(0);
  const [onlyWithCost, setOnlyWithCost] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await request(`/trends/radar?janela=${windowDays}&limite=80`);
      setData(result || null);
    } catch (requestError) {
      setError(requestError?.message || 'Não foi possível carregar o radar.');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [windowDays]);

  useEffect(() => {
    load();
  }, [load, version]);

  const collect = async () => {
    setCollecting(true);
    try {
      const result = await request('/trends/coletar', {
        method: 'POST',
        body: { limite_keywords: 12, limite_produtos: 6 },
      });
      const failures = result.errors?.length
        ? ` ${result.errors.length} palavra(s) falharam.`
        : '';
      onToast(
        failures ? 'alert' : 'success',
        `Radar atualizado: ${result.keywords} palavras e ${result.products} produtos.${failures}`
      );
      await load();
    } catch (requestError) {
      onToast('error', requestError?.message || 'Não foi possível atualizar o radar.');
    } finally {
      setCollecting(false);
    }
  };

  const keywords = Array.isArray(data?.keywords) ? data.keywords : [];
  const products = Array.isArray(data?.produtos) ? data.produtos : [];
  const hasFilters = minPrice > 0 || maxSellers > 0 || onlyWithCost;
  const visibleProducts = useMemo(
    () =>
      products.filter((item) => {
        if (minPrice > 0 && Number(item.preco || 0) < minPrice) return false;
        if (maxSellers > 0 && Number(item.vendedores || 0) > maxSellers) return false;
        if (onlyWithCost && !item.fornecedor_id) return false;
        return true;
      }),
    [products, minPrice, maxSellers, onlyWithCost]
  );
  const opportunities = visibleProducts.filter((item) => item.score >= 70).length;
  const withSupplier = products.filter((item) => item.fornecedor_id).length;
  const climbing = keywords.filter((item) => (item.posicao_delta || 0) > 0).length;
  const clearFilters = () => {
    setMinPrice(0);
    setMaxSellers(0);
    setOnlyWithCost(false);
  };

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-sky-600">
              <Icon name="trending" className="h-5 w-5" />
            </div>
            <div>
              <p className="label">Radar de demanda</p>
              <h3 className="mt-1 font-bold">O que está subindo nas buscas do Mercado Livre</h3>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-500">
                O radar guarda um retrato diário das palavras em alta, posição dos produtos e
                número de ofertas. O sinal é de demanda e concorrência, não uma promessa de vendas.
                Para achar o lucro real, cruze com o custo e o frete do fornecedor.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {[7, 10, 30].map((days) => (
              <button
                key={days}
                type="button"
                onClick={() => setWindowDays(days)}
                className={`rounded-lg border px-3 py-2 text-xs font-semibold transition ${
                  windowDays === days
                    ? 'border-brand-500 bg-brand-50 text-brand-700'
                    : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
                }`}
              >
                {days} dias
              </button>
            ))}
            <button
              type="button"
              onClick={collect}
              className="btn-primary"
              disabled={collecting || loading}
            >
              {collecting ? <Spinner className="h-4 w-4" /> : <Icon name="refresh" className="h-4 w-4" />}
              {collecting ? 'Coletando...' : 'Atualizar radar'}
            </button>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-100 pt-3 text-[11px] text-slate-400">
          <span>{data?.dias_historico || 0} dia(s) de histórico</span>
          <span>·</span>
          <span>Última coleta: {data?.ultima_coleta ? formatDate(data.ultima_coleta) : 'nunca'}</span>
          <span>·</span>
          <span>Preço menor que a referência ajuda, mas margem líquida manda.</span>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-3 py-16 text-sm font-medium text-slate-500">
          <Spinner />
          Carregando radar...
        </div>
      ) : error ? (
        <div className="card px-6 py-12 text-center">
          <p className="text-sm font-semibold text-rose-600">{error}</p>
          <button type="button" onClick={load} className="btn-primary mt-4">
            <Icon name="refresh" className="h-4 w-4" />
            Tentar novamente
          </button>
        </div>
      ) : !products.length && !keywords.length ? (
        <div className="card px-6 py-14 text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-sky-50 text-sky-600">
            <Icon name="trending" className="h-6 w-6" />
          </div>
          <h3 className="mt-4 font-bold">O radar ainda não tem dados</h3>
          <p className="mx-auto mt-2 max-w-lg text-sm text-slate-500">
            Faça a primeira coleta para capturar as palavras em alta e os produtos com ofertas.
            Em 7 a 10 dias, o painel mostra quem subiu, quem perdeu posição e onde a concorrência
            está aumentando.
          </p>
          <button type="button" onClick={collect} className="btn-primary mt-5" disabled={collecting}>
            {collecting ? <Spinner className="h-4 w-4" /> : <Icon name="refresh" className="h-4 w-4" />}
            {collecting ? 'Coletando...' : 'Fazer primeira coleta'}
          </button>
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Palavras monitoradas"
              value={keywords.length}
              hint={climbing ? `${climbing} subindo na janela` : 'Aguardando histórico'}
              accent="sky"
            />
            <StatCard
              label="Produtos no radar"
              value={products.length}
              hint="Com ao menos uma oferta ativa"
              accent="brand"
            />
            <StatCard
              label="Oportunidades"
              value={opportunities}
              hint="Score 70 ou mais"
              accent="emerald"
            />
            <StatCard
              label="Com custo de fornecedor"
              value={withSupplier}
              hint={withSupplier ? 'Prontos para simular margem' : 'Importe o CSV do fornecedor'}
              accent="amber"
            />
          </div>

          {keywords.length ? (
            <div className="card p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="label">Palavras em alta</p>
                  <p className="mt-1 text-xs text-slate-500">
                    Posição atual no ranking de buscas do Mercado Livre.
                  </p>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {keywords.slice(0, 20).map((item) => (
                  <span
                    key={item.keyword}
                    className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-700"
                  >
                    <span className="text-slate-400">#{item.posicao}</span>
                    {item.keyword}
                    {item.posicao_delta != null ? (
                      <span
                        className={
                          item.posicao_delta > 0
                            ? 'text-emerald-600'
                            : item.posicao_delta < 0
                              ? 'text-rose-600'
                              : 'text-slate-400'
                        }
                      >
                        {item.posicao_delta > 0
                          ? `↑${item.posicao_delta}`
                          : item.posicao_delta < 0
                            ? `↓${Math.abs(item.posicao_delta)}`
                            : '='}
                      </span>
                    ) : null}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div className="card overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
              <div>
                <p className="font-bold">Produtos com sinal de oportunidade</p>
                <p className="text-xs text-slate-500">
                  Quanto menor a concorrência e maior a subida, melhor o score.
                </p>
              </div>
              <span className="badge bg-slate-100 text-slate-500">
                {hasFilters ? `${visibleProducts.length} de ${products.length}` : `${products.length} produto(s)`}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50/60 px-5 py-3">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Faixa
              </span>
              {[0, 80, 100, 120].map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setMinPrice(value)}
                  aria-pressed={minPrice === value}
                  className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition ${
                    minPrice === value
                      ? 'border-brand-500 bg-brand-50 text-brand-700'
                      : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
                  }`}
                >
                  {value === 0 ? 'Todos' : `≥ ${brl(value)}`}
                </button>
              ))}
              <span className="mx-1 hidden h-4 w-px bg-slate-200 sm:block" />
              <button
                type="button"
                onClick={() => setMaxSellers(maxSellers ? 0 : 3)}
                aria-pressed={maxSellers > 0}
                className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition ${
                  maxSellers > 0
                    ? 'border-brand-500 bg-brand-50 text-brand-700'
                    : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
                }`}
              >
                Até 3 vendedores
              </button>
              <button
                type="button"
                onClick={() => setOnlyWithCost((current) => !current)}
                aria-pressed={onlyWithCost}
                className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition ${
                  onlyWithCost
                    ? 'border-brand-500 bg-brand-50 text-brand-700'
                    : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
                }`}
              >
                Só com custo
              </button>
              {hasFilters ? (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="ml-auto text-[11px] font-semibold text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline"
                >
                  Limpar filtros
                </button>
              ) : null}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1080px] text-left">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Produto</th>
                    <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Posição</th>
                    <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Ofertas</th>
                    <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Preço</th>
                    <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Custo</th>
                    <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Margem bruta</th>
                    <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Score</th>
                    <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visibleProducts.length ? (
                    visibleProducts.map((item) => (
                    <tr key={`${item.keyword}-${item.product_id}`} className="hover:bg-slate-50/60">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <div className="h-11 w-11 shrink-0 overflow-hidden rounded-lg bg-slate-100">
                            {item.thumbnail ? (
                              <img src={imageUrl(item.thumbnail)} alt="" className="h-full w-full object-cover" />
                            ) : null}
                          </div>
                          <div className="min-w-0">
                            <p className="line-clamp-2 max-w-xs text-sm font-semibold">{item.nome}</p>
                            <p className="text-xs text-slate-500">
                              {item.keyword}
                              {item.fornecedor_nome ? ` · ${item.fornecedor_nome}` : ''}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3">
                        <p className="text-sm font-bold">#{item.posicao}</p>
                        <p
                          className={`text-[11px] font-semibold ${
                            item.posicao_delta == null
                              ? 'text-slate-400'
                              : item.posicao_delta > 0
                                ? 'text-emerald-600'
                                : item.posicao_delta < 0
                                  ? 'text-rose-600'
                                  : 'text-slate-400'
                          }`}
                        >
                          {item.posicao_delta == null
                            ? 'sem histórico'
                            : item.posicao_delta > 0
                              ? `+${item.posicao_delta} posições`
                              : item.posicao_delta < 0
                                ? `${item.posicao_delta} posições`
                                : 'estável'}
                        </p>
                      </td>
                      <td className="px-5 py-3">
                        <p className="text-sm font-bold">{item.ofertas}</p>
                        <p className="text-[11px] text-slate-500">{item.vendedores} vendedor(es)</p>
                      </td>
                      <td className="px-5 py-3">
                        <p className="text-sm font-bold">{brl(item.preco)}</p>
                        {item.preco_delta_pct != null ? (
                          <p
                            className={`text-[11px] ${
                              item.preco_delta_pct < 0 ? 'text-emerald-600' : 'text-slate-500'
                            }`}
                          >
                            {item.preco_delta_pct > 0 ? '+' : ''}
                            {item.preco_delta_pct}% na janela
                          </p>
                        ) : null}
                      </td>
                      <td className="px-5 py-3">
                        {item.custo ? (
                          <>
                            <p className="text-sm font-bold">{brl(item.custo)}</p>
                            <p className="text-[11px] text-slate-500">{item.fornecedor_sku || 'custo do CSV'}</p>
                          </>
                        ) : (
                          <span className="text-xs text-slate-400">sem custo</span>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        {item.margem_bruta_pct != null ? (
                          <span
                            className={`badge ${
                              item.margem_bruta_pct >= 45
                                ? 'bg-emerald-50 text-emerald-700'
                                : 'bg-amber-50 text-amber-700'
                            }`}
                          >
                            {Math.round(item.margem_bruta_pct)}%
                          </span>
                        ) : (
                          <span className="text-xs text-slate-400">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        <span
                          className={`badge ${
                            item.score >= 80
                              ? 'bg-emerald-50 text-emerald-700'
                              : item.score >= 65
                                ? 'bg-sky-50 text-sky-700'
                                : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {item.score}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => onAnalyze(item)}
                            className="btn-ghost px-2 py-1 text-xs"
                            title="Abrir o simulador de margem líquida"
                          >
                            <Icon name="trending" className="h-3.5 w-3.5" />
                            Simular
                          </button>
                          <button
                            type="button"
                            onClick={() => onFindSupplier(item.nome)}
                            className="btn-ghost px-2 py-1 text-xs"
                            title="Buscar este produto no catálogo de fornecedores"
                          >
                            <Icon name="store" className="h-3.5 w-3.5" />
                            Fornecedor
                          </button>
                          {item.permalink ? (
                            <a
                              href={item.permalink}
                              target="_blank"
                              rel="noreferrer"
                              className="btn-ghost px-2 py-1 text-xs"
                            >
                              <Icon name="external" className="h-3.5 w-3.5" />
                              Ver
                            </a>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={8} className="px-5 py-12 text-center">
                        <p className="text-sm font-semibold">Nenhum produto nesta faixa.</p>
                        <p className="mt-1 text-xs text-slate-500">
                          Limpe os filtros ou atualize o radar para buscar novas oportunidades.
                        </p>
                        <button type="button" onClick={clearFilters} className="btn-ghost mt-3 text-xs">
                          Limpar filtros
                        </button>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="border-t border-slate-100 px-5 py-3 text-[11px] text-slate-400">
              Margem bruta = preço menos custo, antes de taxa do Mercado Livre, frete, impostos e
              devoluções. Clique em Simular para ver a margem líquida real.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function AdminView({ currentUser, onToast, onSession }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({ username: '', name: '', password: '', role: 'operator' });
  const [creating, setCreating] = useState(false);
  const [savingId, setSavingId] = useState(null);
  const [resetUser, setResetUser] = useState(null);
  const [resetPassword, setResetPassword] = useState('');
  const [resetting, setResetting] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changing, setChanging] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await request('/admin/usuarios');
      setUsers(Array.isArray(data) ? data : []);
    } catch (error) {
      onToast('error', error?.message || 'Não foi possível carregar os usuários.');
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  useEffect(() => {
    load();
  }, [load]);

  const applySession = (data) => {
    if (data?.token) sessionStorage.setItem(DASHBOARD_TOKEN_STORAGE, data.token);
    if (data?.user) onSession?.(data.user);
  };

  const createUser = async (event) => {
    event.preventDefault();
    if (creating) return;
    if (!form.username.trim() || form.password.length < 6) {
      onToast('alert', 'Informe usuário e uma senha com pelo menos 6 caracteres.');
      return;
    }
    setCreating(true);
    try {
      const user = await request('/admin/usuarios', {
        method: 'POST',
        body: {
          username: form.username.trim(),
          name: form.name.trim(),
          password: form.password,
          role: form.role,
        },
      });
      setForm({ username: '', name: '', password: '', role: 'operator' });
      onToast('success', `Usuário ${user.username} criado.`);
      await load();
    } catch (error) {
      onToast('error', error?.message || 'Não foi possível criar o usuário.');
    } finally {
      setCreating(false);
    }
  };

  const updateUser = async (user, patch) => {
    if (savingId) return;
    setSavingId(user.id);
    try {
      const updated = await request(`/admin/usuarios/${user.id}`, {
        method: 'PATCH',
        body: patch,
      });
      setUsers((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      if (updated.id === currentUser?.id) onSession?.(updated);
      onToast('success', 'Usuário atualizado.');
    } catch (error) {
      onToast('error', error?.message || 'Não foi possível atualizar o usuário.');
    } finally {
      setSavingId(null);
    }
  };

  const removeUser = async (user) => {
    if (savingId) return;
    if (!window.confirm(`Excluir o usuário ${user.username}?`)) return;
    setSavingId(user.id);
    try {
      await request(`/admin/usuarios/${user.id}`, { method: 'DELETE' });
      setUsers((current) => current.filter((item) => item.id !== user.id));
      onToast('success', 'Usuário excluído.');
    } catch (error) {
      onToast('error', error?.message || 'Não foi possível excluir o usuário.');
    } finally {
      setSavingId(null);
    }
  };

  const submitReset = async (event) => {
    event.preventDefault();
    if (!resetUser || resetting) return;
    if (resetPassword.length < 6) {
      onToast('alert', 'A nova senha precisa ter pelo menos 6 caracteres.');
      return;
    }
    setResetting(true);
    try {
      const data = await request(`/admin/usuarios/${resetUser.id}/senha`, {
        method: 'POST',
        body: { new_password: resetPassword },
      });
      if (data?.token) applySession(data);
      onToast('success', `Senha de ${resetUser.username} alterada.`);
      setResetUser(null);
      setResetPassword('');
    } catch (error) {
      onToast('error', error?.message || 'Não foi possível alterar a senha.');
    } finally {
      setResetting(false);
    }
  };

  const changeOwnPassword = async (event) => {
    event.preventDefault();
    if (changing) return;
    if (newPassword.length < 6) {
      onToast('alert', 'A nova senha precisa ter pelo menos 6 caracteres.');
      return;
    }
    if (newPassword !== confirmPassword) {
      onToast('alert', 'A confirmação da nova senha não confere.');
      return;
    }
    setChanging(true);
    try {
      const data = await request('/admin/senha', {
        method: 'POST',
        body: { current_password: currentPassword, new_password: newPassword },
      });
      applySession(data);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      onToast('success', 'Sua senha foi alterada. Use a nova senha no próximo acesso.');
    } catch (error) {
      onToast('error', error?.message || 'Não foi possível alterar a sua senha.');
    } finally {
      setChanging(false);
    }
  };

  const isSelf = (user) => user.id === currentUser?.id;
  const activeAdmins = users.filter((user) => user.role === 'admin' && user.active).length;

  return (
    <div className="space-y-5">
      <div className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="card p-5">
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-sky-600">
              <Icon name="shield" className="h-5 w-5" />
            </div>
            <div>
              <p className="label">Sua sessão</p>
              <h3 className="mt-1 font-bold">{currentUser?.name || currentUser?.username || 'Administrador'}</h3>
              <p className="mt-1 text-xs text-slate-500">
                Usuário <strong>{currentUser?.username || 'admin'}</strong> · perfil{' '}
                <strong>{currentUser?.role === 'admin' ? 'administrador' : 'operador'}</strong>
              </p>
            </div>
          </div>

          <form className="mt-5 grid gap-3 sm:grid-cols-2" onSubmit={changeOwnPassword}>
            <label className="sm:col-span-2">
              <span className="label">Senha atual</span>
              <input
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                className="input mt-1"
                placeholder="Senha atual"
              />
            </label>
            <label>
              <span className="label">Nova senha</span>
              <input
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                className="input mt-1"
                placeholder="Mínimo 6 caracteres"
              />
            </label>
            <label>
              <span className="label">Confirmar nova senha</span>
              <input
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                className="input mt-1"
                placeholder="Repita a nova senha"
              />
            </label>
            <div className="sm:col-span-2">
              <button type="submit" className="btn-primary" disabled={changing}>
                {changing ? <Spinner className="h-4 w-4" /> : <Icon name="check" className="h-4 w-4" />}
                {changing ? 'Alterando...' : 'Alterar minha senha'}
              </button>
            </div>
          </form>
        </div>

        <div className="card p-5">
          <p className="label">Novo usuário</p>
          <h3 className="mt-1 font-bold">Criar acesso ao painel</h3>
          <p className="mt-1 text-xs text-slate-500">
            Operadores usam anúncios, pedidos e radar. Administradores também gerenciam usuários e senhas.
          </p>
          <form className="mt-4 space-y-3" onSubmit={createUser}>
            <div className="grid gap-3 sm:grid-cols-2">
              <label>
                <span className="label">Usuário</span>
                <input
                  value={form.username}
                  onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))}
                  className="input mt-1"
                  placeholder="ex.: joao"
                  autoComplete="off"
                />
              </label>
              <label>
                <span className="label">Nome</span>
                <input
                  value={form.name}
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                  className="input mt-1"
                  placeholder="Nome de exibição"
                  autoComplete="off"
                />
              </label>
              <label>
                <span className="label">Senha</span>
                <input
                  type="password"
                  value={form.password}
                  onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
                  className="input mt-1"
                  placeholder="Mínimo 6 caracteres"
                  autoComplete="new-password"
                />
              </label>
              <label>
                <span className="label">Perfil</span>
                <select
                  value={form.role}
                  onChange={(event) => setForm((current) => ({ ...current, role: event.target.value }))}
                  className="input mt-1"
                >
                  <option value="operator">Operador</option>
                  <option value="admin">Administrador</option>
                </select>
              </label>
            </div>
            <button type="submit" className="btn-primary" disabled={creating}>
              {creating ? <Spinner className="h-4 w-4" /> : <Icon name="check" className="h-4 w-4" />}
              {creating ? 'Criando...' : 'Criar usuário'}
            </button>
          </form>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div>
            <p className="font-bold">Usuários do painel</p>
            <p className="text-xs text-slate-500">
              {users.length} usuário(s) · {activeAdmins} administrador(es) ativo(s)
            </p>
          </div>
          <button type="button" onClick={load} className="btn-ghost" disabled={loading}>
            {loading ? <Spinner className="h-4 w-4" /> : <Icon name="refresh" className="h-4 w-4" />}
            Atualizar
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500">
            <Spinner /> Carregando usuários...
          </div>
        ) : users.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-slate-500">
            Nenhum usuário cadastrado. Crie o primeiro administrador acima.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Usuário</th>
                  <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Perfil</th>
                  <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Status</th>
                  <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Último acesso</th>
                  <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {users.map((user) => (
                  <tr key={user.id} className="hover:bg-slate-50/60">
                    <td className="px-5 py-3">
                      <p className="text-sm font-semibold">
                        {user.name || user.username}
                        {isSelf(user) ? <span className="ml-2 text-[11px] font-medium text-sky-600">você</span> : null}
                      </p>
                      <p className="text-xs text-slate-500">@{user.username}</p>
                    </td>
                    <td className="px-5 py-3">
                      <select
                        value={user.role}
                        onChange={(event) => updateUser(user, { role: event.target.value })}
                        disabled={savingId === user.id || isSelf(user)}
                        className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-60"
                      >
                        <option value="operator">Operador</option>
                        <option value="admin">Administrador</option>
                      </select>
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={`badge ${
                          user.active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
                        }`}
                      >
                        {user.active ? 'Ativo' : 'Inativo'}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-xs text-slate-500">
                      {user.last_login_at ? formatDate(user.last_login_at) : 'Nunca entrou'}
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setResetUser(user);
                            setResetPassword('');
                          }}
                          className="btn-ghost px-2 py-1 text-xs"
                        >
                          Redefinir senha
                        </button>
                        <button
                          type="button"
                          onClick={() => updateUser(user, { active: !user.active })}
                          disabled={savingId === user.id || isSelf(user)}
                          className="btn-ghost px-2 py-1 text-xs disabled:opacity-50"
                        >
                          {user.active ? 'Desativar' : 'Ativar'}
                        </button>
                        <button
                          type="button"
                          onClick={() => removeUser(user)}
                          disabled={savingId === user.id || isSelf(user)}
                          className="btn-ghost px-2 py-1 text-xs text-rose-600 disabled:opacity-50"
                        >
                          Excluir
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-slate-100 px-5 py-3 text-[11px] text-slate-400">
          Ao redefinir uma senha, as sessões antigas daquele usuário são encerradas. Você não pode
          desativar, rebaixar ou excluir o seu próprio acesso.
        </p>
      </div>

      {resetUser ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="label">Redefinir senha</p>
                <h3 className="mt-1 font-bold">@{resetUser.username}</h3>
              </div>
              <button
                type="button"
                onClick={() => setResetUser(null)}
                className="rounded-lg p-2 text-slate-400 hover:bg-slate-100"
                aria-label="Fechar"
              >
                <Icon name="close" className="h-4 w-4" />
              </button>
            </div>
            <form className="mt-4 space-y-3" onSubmit={submitReset}>
              <label>
                <span className="label">Nova senha</span>
                <input
                  type="password"
                  autoFocus
                  value={resetPassword}
                  onChange={(event) => setResetPassword(event.target.value)}
                  className="input mt-1"
                  placeholder="Mínimo 6 caracteres"
                  autoComplete="new-password"
                />
              </label>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setResetUser(null)} className="btn-ghost">
                  Cancelar
                </button>
                <button type="submit" className="btn-primary" disabled={resetting}>
                  {resetting ? <Spinner className="h-4 w-4" /> : <Icon name="check" className="h-4 w-4" />}
                  {resetting ? 'Salvando...' : 'Salvar senha'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ListingsView({
  listings,
  loading,
  onRefresh,
  onClose,
  onPauseAll,
  onReactivateAll,
  pausing,
}) {
  const activeCount = listings.filter((item) => item.status === 'active').length;
  const pausedCount = listings.filter((item) => item.status === 'paused').length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          {listings.length} anúncio{listings.length === 1 ? '' : 's'} no total · {activeCount} ativo(s) · {pausedCount} pausado(s).
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={onRefresh} className="btn-ghost" disabled={loading || pausing}>
            {loading ? <Spinner className="h-4 w-4" /> : <Icon name="refresh" className="h-4 w-4" />}
            Atualizar
          </button>
          {activeCount > 0 ? (
            <button type="button" onClick={onPauseAll} className="btn-danger" disabled={pausing}>
              {pausing ? <Spinner className="h-4 w-4" /> : <Icon name="alert" className="h-4 w-4" />}
              Pausar todos
            </button>
          ) : null}
          {pausedCount > 0 ? (
            <button type="button" onClick={onReactivateAll} className="btn-primary" disabled={pausing}>
              {pausing ? <Spinner className="h-4 w-4" /> : <Icon name="tag" className="h-4 w-4" />}
              Reativar pausados
            </button>
          ) : null}
        </div>
      </div>

      {listings.length === 0 ? (
        <div className="card px-6 py-16 text-center text-sm text-slate-500">
          Nenhum anúncio criado ainda.
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left">
              <thead className="bg-slate-50">
                <tr>
                  <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Produto</th>
                  <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Preço</th>
                  <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Margem</th>
                  <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Fornecedor</th>
                  <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Score</th>
                  <th className="px-5 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {listings.map((listing) => (
                  <tr key={listing.id} className="hover:bg-slate-50/60">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-slate-100">
                          {listing.thumbnail ? (
                            <img src={imageUrl(listing.thumbnail)} alt="" className="h-full w-full object-cover" />
                          ) : null}
                        </div>
                        <div className="min-w-0">
                          <p className="max-w-xs truncate text-sm font-semibold">{listing.title}</p>
                          <p className="text-xs text-slate-500">{formatDate(listing.created_at)}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3 text-sm font-bold">{brl(listing.price)}</td>
                    <td className="px-5 py-3 text-sm">{Math.round((Number(listing.margin) || 0) * 100)}%</td>
                    <td className="px-5 py-3 text-sm">{listing.supplier}</td>
                    <td className="px-5 py-3">
                      <span
                        className={`badge ${
                          listing.score >= 85 ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
                        }`}
                      >
                        {listing.score}%
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-2">
                        {listing.permalink ? (
                          <a
                            href={listing.permalink}
                            target="_blank"
                            rel="noreferrer"
                            className="btn-ghost px-2 py-1 text-xs"
                            title="Abrir no Mercado Livre"
                          >
                            <Icon name="external" className="h-3.5 w-3.5" />
                            Abrir
                          </a>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => onClose(listing)}
                          className="btn-danger px-2 py-1 text-xs"
                        >
                          Encerrar
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

const ORDER_STATUS = {
  confirmed: { label: 'Confirmado', className: 'bg-sky-50 text-sky-700' },
  payment_required: { label: 'Pagamento pendente', className: 'bg-amber-50 text-amber-700' },
  payment_in_process: { label: 'Pagamento em análise', className: 'bg-amber-50 text-amber-700' },
  paid: { label: 'Pago', className: 'bg-emerald-50 text-emerald-700' },
  partially_refunded: { label: 'Reembolso parcial', className: 'bg-orange-50 text-orange-700' },
  cancelled: { label: 'Cancelado', className: 'bg-red-50 text-red-700' },
  invalid: { label: 'Inválido', className: 'bg-red-50 text-red-700' },
};

function OrdersView({ orders, loading, onRefresh, onLabel }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          {orders.length} pedido{orders.length === 1 ? '' : 's'} carregado{orders.length === 1 ? '' : 's'}.
        </p>
        <button type="button" onClick={onRefresh} className="btn-ghost" disabled={loading}>
          {loading ? <Spinner className="h-4 w-4" /> : <Icon name="refresh" className="h-4 w-4" />}
          Atualizar
        </button>
      </div>

      {loading && orders.length === 0 ? (
        <div className="flex items-center justify-center gap-3 py-16 text-sm font-medium text-slate-500">
          <Spinner />
          Carregando pedidos...
        </div>
      ) : null}

      {!loading && orders.length === 0 ? (
        <div className="card px-6 py-16 text-center text-sm text-slate-500">
          Nenhum pedido encontrado.
        </div>
      ) : null}

      <div className="space-y-3">
        {orders.map((order) => {
          const status = ORDER_STATUS[order.status] || {
            label: order.status || 'Desconhecido',
            className: 'bg-slate-100 text-slate-600',
          };
          const itemCount = order.items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);

          return (
            <article key={order.id} className="card p-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex min-w-0 items-start gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
                    <Icon name="cart" className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-bold">Pedido #{order.id}</p>
                      <span className={`badge ${status.className}`}>{status.label}</span>
                      {order.multi_supplier ? (
                        <span className="badge bg-amber-50 text-amber-800">
                          Multi-fornecedor · {order.supplier_count} envios
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      {formatDate(order.date_created)} · {order.buyer?.nickname || 'Comprador'} · {itemCount} item(ns)
                    </p>
                    <p className="mt-2 line-clamp-1 text-sm text-slate-600">
                      {order.items.map((item) => item.title).filter(Boolean).join(' · ') || 'Sem itens'}
                    </p>
                    {order.multi_supplier ? (
                      <p className="mt-1 text-xs font-medium text-amber-700">
                        Itens de fornecedores diferentes: confirme se serão necessários dois envios/etiquetas.
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <div className="text-right">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Total</p>
                    <p className="text-lg font-extrabold">{brl(order.total_amount)}</p>
                  </div>
                  <a
                    href={`https://www.mercadolivre.com.br/vendas/${order.id}/detalhe`}
                    target="_blank"
                    rel="noreferrer"
                    className="btn-ghost"
                  >
                    Abrir venda
                    <Icon name="external" className="h-4 w-4" />
                  </a>
                  <button
                    type="button"
                    onClick={() => onLabel(order)}
                    className="btn-dark"
                    disabled={!order.shipping}
                  >
                    <Icon name="download" className="h-4 w-4" />
                    Etiqueta
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

function CatalogoView({ onToast, externalSearch = '' }) {
  const [registry, setRegistry] = useState([]);
  const [summary, setSummary] = useState(null);
  const [stale, setStale] = useState({ total: 0, produtos: [] });
  const [produtos, setProdutos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [csvSupplier, setCsvSupplier] = useState('');
  const [csvText, setCsvText] = useState('');
  const [csvFileName, setCsvFileName] = useState('');
  const [importing, setImporting] = useState(false);
  const [lastImport, setLastImport] = useState(null);

  const loadBase = useCallback(async () => {
    const [registryResult, summaryResult, staleResult] = await Promise.allSettled([
      request('/suppliers/registro'),
      request('/suppliers/custos/resumo'),
      request('/suppliers/custos/desatualizados?horas=24&limite=8'),
    ]);

    if (registryResult.status === 'fulfilled') {
      const list = Array.isArray(registryResult.value) ? registryResult.value : [];
      setRegistry(list);
      setCsvSupplier((current) => current || list[0]?.slug || '');
    }
    if (summaryResult.status === 'fulfilled') {
      setSummary(summaryResult.value || null);
    }
    if (staleResult.status === 'fulfilled') {
      setStale({
        total: staleResult.value?.total || 0,
        produtos: Array.isArray(staleResult.value?.produtos)
          ? staleResult.value.produtos
          : [],
      });
    }
  }, []);

  const loadProducts = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limite: '100' });
      if (search.trim()) params.set('q', search.trim());
      if (supplierFilter) params.set('fornecedor_id', supplierFilter);
      const data = await request(`/suppliers/custos?${params.toString()}`);
      setProdutos(Array.isArray(data) ? data : []);
    } catch (error) {
      onToast('error', error?.message || 'Não foi possível carregar o catálogo.');
      setProdutos([]);
    } finally {
      setLoading(false);
    }
  }, [search, supplierFilter, onToast]);

  useEffect(() => {
    loadBase();
  }, [loadBase]);

  useEffect(() => {
    if (externalSearch) setSearch(externalSearch);
  }, [externalSearch]);

  useEffect(() => {
    const timer = setTimeout(loadProducts, 400);
    return () => clearTimeout(timer);
  }, [loadProducts]);

  const refresh = async () => {
    await Promise.allSettled([loadBase(), loadProducts()]);
  };

  const handleFile = async (event) => {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > 3.5 * 1024 * 1024) {
      onToast('error', 'Arquivo muito grande. Use um CSV de até 3,5 MB por importação.');
      input.value = '';
      return;
    }
    try {
      const text = await file.text();
      setCsvText(text);
      setCsvFileName(file.name);
      setLastImport(null);
    } catch {
      onToast('error', 'Não foi possível ler o arquivo CSV.');
    } finally {
      input.value = '';
    }
  };

  const downloadTemplate = () => {
    const headers = [
      'sku',
      'gtin',
      'titulo',
      'custo',
      'estoque',
      'peso_kg',
      'altura_cm',
      'largura_cm',
      'comprimento_cm',
      'catalogo_id',
      'item_id',
      'ativo',
    ];
    const example = [
      'SKU-001',
      '7891234567890',
      'Produto exemplo',
      '99.90',
      '10',
      '0.3',
      '10',
      '15',
      '20',
      '',
      '',
      '1',
    ];
    const csv = [headers.join(';'), example.join(';')].join('\n');
    const blob = new Blob([`\uFEFF${csv}`], {
      type: 'text/csv;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'modelo-catalogo-melimax.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  const importCsv = async () => {
    if (!csvSupplier) {
      onToast('error', 'Selecione o fornecedor.');
      return;
    }
    if (!csvText.trim()) {
      onToast('error', 'Selecione um arquivo CSV.');
      return;
    }
    const fornecedor = registry.find((item) => item.slug === csvSupplier);
    setImporting(true);
    try {
      const result = await request('/suppliers/custos/importar-csv', {
        method: 'POST',
        body: {
          fornecedor_id: csvSupplier,
          fornecedor_nome: fornecedor?.nome || csvSupplier,
          csv: csvText,
        },
      });
      setLastImport(result);
      onToast(
        'success',
        `${result.importados || 0} produto(s) importado(s); ${result.ignorados || 0} ignorado(s).`
      );
      setCsvText('');
      setCsvFileName('');
      await refresh();
    } catch (error) {
      onToast('error', error?.message || 'Falha ao importar CSV.');
    } finally {
      setImporting(false);
    }
  };

  const summaryFor = (slug) =>
    summary?.fornecedores?.find((item) => item.fornecedor_id === slug) || null;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Produtos no catálogo"
          value={number.format(summary?.total || 0)}
          hint={`${number.format(summary?.ativos || 0)} ativos`}
          accent="brand"
        />
        <StatCard
          label="Fornecedores"
          value={number.format(summary?.fornecedores?.length || 0)}
          hint="Com custo importado"
          accent="sky"
        />
        <StatCard
          label="Estoque desatualizado"
          value={number.format(summary?.desatualizados || 0)}
          hint="Mais de 24h sem reimportar"
          accent={summary?.desatualizados ? 'amber' : 'emerald'}
        />
        <StatCard
          label="Produtos ativos"
          value={number.format(summary?.ativos || 0)}
          hint="Disponíveis para anúncio"
          accent="emerald"
        />
      </div>

      {stale.total > 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <div className="flex items-start gap-3">
            <Icon name="alert" className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <p className="font-semibold">
                {stale.total} produto(s) com estoque sem atualização há mais de 24h.
              </p>
              <p className="mt-1 text-xs">
                Reimporte o CSV do fornecedor antes de publicar. Estoque velho gera cancelamento e prejudica a reputação.
              </p>
              {stale.produtos.length ? (
                <p className="mt-2 text-xs">
                  Exemplos: {stale.produtos.slice(0, 4).map((item) => item.sku).join(', ')}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <div className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-bold">Importar custos e estoque</h3>
            <p className="text-sm text-slate-500">
              CSV com SKU, custo, estoque, peso (kg ou g) e dimensões (cm). Até 2.000 linhas e 3,5 MB. Mantenha o EAN como texto para não perder dígitos.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={downloadTemplate} className="btn-ghost px-3 py-2 text-xs">
              <Icon name="download" className="h-3.5 w-3.5" />
              Baixar modelo
            </button>
            <span className="badge bg-brand-50 text-brand-800">CSV</span>
          </div>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_1fr_auto] lg:items-end">
          <div>
            <label htmlFor="csv-supplier" className="label">
              Fornecedor
            </label>
            <select
              id="csv-supplier"
              className="input mt-1"
              value={csvSupplier}
              onChange={(event) => setCsvSupplier(event.target.value)}
            >
              <option value="">Selecione</option>
              {registry.map((item) => (
                <option key={item.slug} value={item.slug}>
                  {item.nome}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="csv-file" className="label">
              Arquivo CSV
            </label>
            <input
              id="csv-file"
              type="file"
              accept=".csv,text/csv"
              onChange={handleFile}
              className="input mt-1 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white"
            />
          </div>
          <button
            type="button"
            className="btn-primary"
            onClick={importCsv}
            disabled={importing || !csvText}
          >
            {importing ? <Spinner className="h-4 w-4" /> : <Icon name="download" className="h-4 w-4" />}
            {importing ? 'Importando...' : 'Importar CSV'}
          </button>
        </div>

        <p className="mt-2 text-xs text-slate-500">
          {csvFileName ? `Arquivo selecionado: ${csvFileName}` : 'Nenhum arquivo selecionado.'}
        </p>

        {lastImport ? (
          <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">
            <p className="font-semibold">
              Última importação: {lastImport.importados || 0} importados ·{' '}
              {lastImport.ignorados || 0} ignorados · {lastImport.recebidos || 0} recebidos.
            </p>
            {lastImport.erros?.length ? (
              <ul className="mt-2 list-disc space-y-1 pl-4">
                {lastImport.erros.slice(0, 5).map((item, index) => (
                  <li key={`${item.sku || 'erro'}-${index}`}>
                    {item.sku ? `${item.sku}: ` : ''}
                    {item.erro}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>

      <div>
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <h3 className="font-bold">Fornecedores cadastrados</h3>
            <p className="text-sm text-slate-500">Regra atual: grátis, sem mensalidade e sem pedido mínimo.</p>
          </div>
          <button type="button" onClick={refresh} className="btn-ghost" disabled={loading}>
            {loading ? <Spinner className="h-4 w-4" /> : <Icon name="refresh" className="h-4 w-4" />}
            Atualizar
          </button>
        </div>

        {registry.length === 0 ? (
          <div className="card px-6 py-12 text-center text-sm text-slate-500">
            Nenhum fornecedor cadastrado ainda.
          </div>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
            {registry.map((item) => {
              const stats = summaryFor(item.slug);
              return (
                <article key={item.slug} className="card p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate font-bold">{item.nome}</h3>
                      <p className="truncate text-xs text-slate-500">{item.site || 'Sem site'}</p>
                    </div>
                    <span
                      className={`badge ${
                        item.dropshipping
                          ? 'bg-emerald-50 text-emerald-700'
                          : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {item.dropshipping ? 'Dropshipping' : 'Atacado'}
                    </span>
                  </div>
                  <p className="mt-2 line-clamp-2 min-h-[2rem] text-xs text-slate-500">
                    {item.descricao || 'Sem descrição.'}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <span className="badge bg-slate-100 text-slate-600">
                      {item.integracao || 'manual'}
                    </span>
                    {item.pedido_minimo ? (
                      <span className="badge bg-amber-50 text-amber-800">
                        Mín. {brl(item.pedido_minimo)}
                      </span>
                    ) : (
                      <span className="badge bg-emerald-50 text-emerald-700">Sem mínimo</span>
                    )}
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-lg bg-slate-50 p-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                        Produtos
                      </p>
                      <p className="mt-1 font-bold">{number.format(stats?.total || 0)}</p>
                    </div>
                    <div className="rounded-lg bg-slate-50 p-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                        Ativos
                      </p>
                      <p className="mt-1 font-bold">{number.format(stats?.ativos || 0)}</p>
                    </div>
                    <div className="rounded-lg bg-slate-50 p-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                        Atraso
                      </p>
                      <p className={`mt-1 font-bold ${stats?.desatualizados ? 'text-amber-700' : ''}`}>
                        {number.format(stats?.desatualizados || 0)}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn-ghost mt-3 w-full"
                    onClick={() => setSupplierFilter(item.slug)}
                  >
                    Ver produtos
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </div>

      <div className="card overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-slate-100 p-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h3 className="font-bold">Produtos importados</h3>
            <p className="text-sm text-slate-500">
              {loading ? 'Carregando...' : `${number.format(produtos.length)} produto(s) exibidos.`}
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative">
              <Icon
                name="search"
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              />
              <input
                className="input pl-9"
                placeholder="SKU, EAN ou título"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            <select
              className="input"
              value={supplierFilter}
              onChange={(event) => setSupplierFilter(event.target.value)}
            >
              <option value="">Todos os fornecedores</option>
              {registry.map((item) => (
                <option key={item.slug} value={item.slug}>
                  {item.nome}
                </option>
              ))}
            </select>
          </div>
        </div>

        {loading && produtos.length === 0 ? (
          <div className="flex items-center justify-center gap-3 py-16 text-sm font-medium text-slate-500">
            <Spinner />
            Carregando catálogo...
          </div>
        ) : null}

        {!loading && produtos.length === 0 ? (
          <div className="px-6 py-16 text-center text-sm text-slate-500">
            Nenhum produto encontrado. Importe um CSV ou ajuste a busca.
          </div>
        ) : null}

        {produtos.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-semibold">Produto</th>
                  <th className="px-4 py-3 font-semibold">SKU</th>
                  <th className="px-4 py-3 font-semibold">Fornecedor</th>
                  <th className="px-4 py-3 font-semibold">Custo</th>
                  <th className="px-4 py-3 font-semibold">Estoque</th>
                  <th className="px-4 py-3 font-semibold">Peso</th>
                  <th className="px-4 py-3 font-semibold">Atualização</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {produtos.map((item) => (
                  <tr key={item.id} className="align-top">
                    <td className="max-w-[22rem] px-4 py-3">
                      <p className="line-clamp-1 font-semibold">{item.titulo || item.sku}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {item.gtin ? `EAN ${item.gtin}` : 'Sem EAN'}
                      </p>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{item.sku}</td>
                    <td className="px-4 py-3 text-slate-600">
                      {item.fornecedor_nome || item.fornecedor_id}
                    </td>
                    <td className="px-4 py-3 font-semibold">{brl(item.custo)}</td>
                    <td className="px-4 py-3">
                      {item.estoque == null ? '—' : number.format(item.estoque)}
                    </td>
                    <td className="px-4 py-3 text-slate-600">
                      {item.peso_kg ? `${item.peso_kg} kg` : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`badge ${
                          item.desatualizado
                            ? 'bg-amber-50 text-amber-800'
                            : 'bg-emerald-50 text-emerald-700'
                        }`}
                      >
                        {item.desatualizado
                          ? `há ${Math.round(Number(item.horas_desde_atualizacao) || 0)}h`
                          : 'em dia'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CreateListingModal({
  produto,
  margin,
  setMargin,
  freeShipping,
  setFreeShipping,
  cost,
  setCost,
  shippingCost,
  setShippingCost,
  pricing,
  validation,
  validating,
  creating,
  onClose,
  onConfirm,
}) {
  const salePrice = pricing?.price ?? Math.round((Number(cost) || 0) / (1 - margin / 100));
  const profit = pricing?.net_profit ?? null;
  const netMargin = pricing?.net_margin != null ? Math.round(pricing.net_margin * 1000) / 10 : null;
  const score = validation?.score ?? null;
  const viable = pricing?.viable;
  const canPublish = !creating && !validating && Boolean(pricing) && Boolean(viable);
  const market = pricing?.market;
  const warnings = [];

  if (pricing) {
    if (pricing.competitive === false) {
      warnings.push('Preço acima da referência de mercado. Reduza o custo ou a margem.');
    }
    if (pricing.net_margin < 0.45) {
      warnings.push('Margem líquida abaixo de 45%. A publicação fica bloqueada.');
    }
    if (pricing.price_multiple != null && pricing.price_multiple < 3) {
      warnings.push('Multiplicador abaixo de 3x o custo. A publicação fica bloqueada.');
    }
    if (pricing.cost_source === 'ml_offer') {
      warnings.push('Custo vindo da oferta do Mercado Livre. Informe o custo real do fornecedor para calcular o lucro.');
    }
    if (pricing.supplier?.stock_stale) {
      const hours = Math.round(Number(pricing.supplier.stock_age_hours) || 0);
      warnings.push(`Estoque/custo do fornecedor atualizado há ${hours}h. Reimporte o CSV antes de publicar.`);
    }
    if (pricing.shipping_source === 'default') {
      warnings.push('Sem peso/dimensões do fornecedor. Usando frete padrão conservador; ajuste manualmente ou importe o CSV completo.');
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-950/50 p-4 sm:items-center">
      <div className="w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div>
            <h3 className="font-bold">Criar anúncio</h3>
            <p className="text-xs text-slate-500">O anúncio será publicado na sua conta do Mercado Livre.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100" aria-label="Fechar">
            <Icon name="close" className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-[70vh] space-y-5 overflow-y-auto p-5">
          <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-white">
              <img src={imageUrl(produto.thumbnail)} alt="" className="h-full w-full object-contain p-1" />
            </div>
            <div className="min-w-0">
              <p className="line-clamp-2 text-sm font-semibold">{produto.title}</p>
              <p className="mt-1 text-xs text-slate-500">
                {produto.listing_strategy === 'catalog_required' || produto.catalog_required
                  ? 'Anúncio de catálogo · imagens oficiais'
                  : 'Anúncio normal · imagens oficiais'}
              </p>
            </div>
          </div>

          <div>
            <label htmlFor="supplier-cost" className="text-sm font-semibold">
              Custo do fornecedor
            </label>
            <div className="mt-2 flex items-center rounded-lg border border-slate-200 bg-white px-3">
              <span className="text-sm text-slate-400">R$</span>
              <input
                id="supplier-cost"
                type="number"
                min="0"
                step="0.01"
                value={cost}
                onChange={(event) => setCost(Number(event.target.value))}
                className="w-full border-0 bg-transparent px-2 py-2 text-sm outline-none"
              />
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Preço de compra no fornecedor/hub. O preço do anúncio é calculado com taxa do ML, frete, impostos e margem líquida.
            </p>
          </div>

          <div>
            <label htmlFor="shipping-cost" className="text-sm font-semibold">
              Frete estimado
            </label>
            <div className="mt-2 flex items-center rounded-lg border border-slate-200 bg-white px-3">
              <span className="text-sm text-slate-400">R$</span>
              <input
                id="shipping-cost"
                type="number"
                min="0"
                step="0.01"
                value={shippingCost}
                placeholder={
                  pricing?.shipping_cost != null
                    ? `Automático: ${brl(pricing.shipping_cost)}`
                    : 'Automático pelo peso'
                }
                onChange={(event) => setShippingCost(event.target.value)}
                className="w-full border-0 bg-transparent px-2 py-2 text-sm outline-none"
              />
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Deixe vazio para calcular pelo peso/dimensões do fornecedor. Ajuste se tiver uma cotação real.
              {pricing?.shipping_source === 'weight' && pricing?.shipping_weight_kg
                ? ` Peso considerado: ${pricing.shipping_weight_kg} kg.`
                : ''}
            </p>
          </div>

          <div>
            <div className="flex items-center justify-between">
              <label htmlFor="margin" className="text-sm font-semibold">
                Margem líquida desejada
              </label>
              <span className="text-sm font-bold text-brand-700">{margin}%</span>
            </div>
            <input
              id="margin"
              type="range"
              min="40"
              max="70"
              step="1"
              value={margin}
              onChange={(event) => setMargin(Number(event.target.value))}
              className="mt-2 w-full accent-brand-500"
            />
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-slate-50 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Preço de venda</p>
                <p className="mt-1 text-lg font-extrabold">{brl(salePrice)}</p>
              </div>
              <div className="rounded-lg bg-emerald-50 p-3">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-700">Lucro líquido</p>
                <p className="mt-1 text-lg font-extrabold text-emerald-700">
                  {profit == null ? '—' : brl(profit)}
                </p>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg border border-slate-200 p-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Margem</p>
                <p className="mt-1 text-sm font-bold">{netMargin == null ? '—' : `${netMargin}%`}</p>
              </div>
              <div className="rounded-lg border border-slate-200 p-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Score</p>
                <p className="mt-1 text-sm font-bold">{score == null ? '—' : `${score}%`}</p>
              </div>
              <div className="rounded-lg border border-slate-200 p-2">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Mercado</p>
                <p className="mt-1 text-sm font-bold">{market?.median ? brl(market.median) : '—'}</p>
              </div>
            </div>
          </div>

          <label className="flex items-start gap-3 rounded-xl border border-slate-200 p-3">
            <input
              type="checkbox"
              checked={freeShipping}
              onChange={(event) => setFreeShipping(event.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 accent-brand-500"
            />
            <span>
              <span className="block text-sm font-semibold">Oferecer frete grátis</span>
              <span className="text-xs text-slate-500">
                Em anúncios de catálogo o frete grátis pode ser obrigatório. O custo entra no cálculo.
              </span>
            </span>
          </label>

          {validating ? (
            <div className="flex items-center gap-2 rounded-xl bg-slate-50 p-3 text-sm text-slate-600">
              <Spinner className="h-4 w-4" />
              Validando anúncio, atributos e precificação...
            </div>
          ) : null}

          {warnings.length ? (
            <div className="space-y-1 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              {warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </div>
          ) : null}

          {pricing ? (
            <div className={`rounded-xl border p-3 text-xs ${pricing.viable ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-200 bg-rose-50 text-rose-800'}`}>
              <p className="font-semibold">
                {pricing.viable ? 'Anúncio validado e viável.' : 'Anúncio bloqueado para proteger sua margem.'}
              </p>
              <p className="mt-1">
                Custo {brl(pricing.cost)} · Taxa ML {brl(pricing.sale_fee)} · Frete {brl(pricing.shipping_cost)}
                {pricing.shipping_source === 'weight'
                  ? ' (peso)'
                  : pricing.shipping_source === 'manual'
                    ? ' (manual)'
                    : ' (padrão)'}
                {' '}· Impostos {brl(pricing.taxes)}
              </p>
              <p className="mt-1">
                Multiplicador {pricing.price_multiple != null ? `${pricing.price_multiple.toFixed(1)}x` : '—'}
                {' '}· Lucro sobre o custo {pricing.profit_over_cost != null ? `${Math.round(pricing.profit_over_cost * 100)}%` : '—'}
              </p>
              {pricing.supplier ? (
                <p className="mt-1">
                  Fornecedor: {pricing.supplier.nome || pricing.supplier.id} · SKU {pricing.supplier.sku}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-4">
          <button type="button" onClick={onClose} className="btn-ghost" disabled={creating}>
            Cancelar
          </button>
          <button type="button" onClick={onConfirm} className="btn-primary" disabled={!canPublish}>
            {creating ? <Spinner className="h-4 w-4" /> : <Icon name="tag" className="h-4 w-4" />}
            {creating ? 'Publicando...' : validating ? 'Validando...' : pricing && !pricing.viable ? 'Ajuste custo/margem' : 'Publicar anúncio'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [account, setAccount] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [dashboardUnlocked, setDashboardUnlocked] = useState(false);
  const [dashboardUser, setDashboardUser] = useState(null);
  const [dashboardChecking, setDashboardChecking] = useState(true);
  const [dashboardError, setDashboardError] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [view, setView] = useState('dashboard');
  const [mobileNav, setMobileNav] = useState(false);

  const [nichos, setNichos] = useState([]);
  const [selectedNicho, setSelectedNicho] = useState('');
  const [produtos, setProdutos] = useState([]);
  const [fornecedores, setFornecedores] = useState([]);
  const [loadingProdutos, setLoadingProdutos] = useState(false);
  const [loadingFornecedores, setLoadingFornecedores] = useState(false);

  const [listings, setListings] = useState([]);
  const [loadingListings, setLoadingListings] = useState(false);
  const [orders, setOrders] = useState([]);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [monthly, setMonthly] = useState(null);
  const [loadingMonthly, setLoadingMonthly] = useState(false);

  const [toast, setToast] = useState(null);
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [radarVersion, setRadarVersion] = useState(0);
  const [authError, setAuthError] = useState('');
  const [modalProduct, setModalProduct] = useState(null);
  const [margin, setMargin] = useState(50);
  const [freeShipping, setFreeShipping] = useState(false);
  const [creating, setCreating] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [supplierCost, setSupplierCost] = useState(0);
  const [shippingCost, setShippingCost] = useState('');
  const [pricing, setPricing] = useState(null);
  const [validation, setValidation] = useState(null);
  const [validating, setValidating] = useState(false);
  const lastValidationRef = useRef({ key: null, data: null });
  const validationInFlightRef = useRef(null);

  const showToast = useCallback((type, message) => {
    setToast({ type, message, id: Date.now() });
  }, []);

  const handleApiError = useCallback(
    (error) => {
      if (error?.data?.code === 'DASHBOARD_LOCKED') {
        sessionStorage.removeItem(DASHBOARD_TOKEN_STORAGE);
        sessionStorage.removeItem(LEGACY_DASHBOARD_KEY_STORAGE);
        setDashboardUser(null);
        setDashboardUnlocked(false);
        setDashboardError('Sessão bloqueada. Informe usuário e senha novamente.');
        return;
      }
      if (error?.status === 401 || error?.data?.needs_reauth) {
        setAccount((current) => (current ? { ...current, needs_reauth: true } : current));
        showToast('error', 'Sua conexão com o Mercado Livre expirou. Reconecte a conta.');
        return;
      }
      showToast('error', error?.message || 'Não foi possível concluir a operação.');
    },
    [showToast]
  );

  const validateListing = useCallback(
    async (produto, costValue, marginValue, freeShippingValue, shippingValue) => {
      if (!produto) return;
      const costNumber = Number(costValue);
      if (!Number.isFinite(costNumber) || costNumber <= 0) {
        setPricing(null);
        setValidation(null);
        return;
      }
      const shippingNumber =
        shippingValue === '' || shippingValue == null ? null : Number(shippingValue);
      const shippingKey = Number.isFinite(shippingNumber) ? shippingNumber : 'auto';
      const key = `${produto.catalogo_id || produto.id}|${produto.item_id || ''}|${costNumber}|${marginValue}|${freeShippingValue}|${shippingKey}|${produto.seller?.id || ''}`;
      if (lastValidationRef.current.key === key && lastValidationRef.current.data) {
        setPricing(lastValidationRef.current.data?.pricing || null);
        setValidation(lastValidationRef.current.data);
        return;
      }
      if (validationInFlightRef.current === key) return;

      validationInFlightRef.current = key;
      setValidating(true);
      try {
        const data = await request('/listings/validar', {
          method: 'POST',
          body: {
            catalogo_id: produto.catalogo_id || produto.id,
            item_id: produto.item_id || null,
            custo: costNumber,
            margem: marginValue / 100,
            free_shipping: freeShippingValue,
            frete: Number.isFinite(shippingNumber) ? shippingNumber : null,
            fornecedor_id: produto.seller?.id || null,
          },
        });
        lastValidationRef.current = { key, data };
        setPricing(data?.pricing || null);
        setValidation(data || null);
      } catch {
        lastValidationRef.current = { key: null, data: null };
        setPricing(null);
        setValidation(null);
      } finally {
        if (validationInFlightRef.current === key) validationInFlightRef.current = null;
        setValidating(false);
      }
    },
    []
  );

  useEffect(() => {
    if (!modalProduct) return undefined;
    const timer = setTimeout(() => {
      validateListing(modalProduct, supplierCost, margin, freeShipping, shippingCost);
    }, 1000);
    return () => clearTimeout(timer);
  }, [modalProduct, supplierCost, margin, freeShipping, shippingCost, validateListing]);

  const loadListings = useCallback(async () => {
    setLoadingListings(true);
    try {
      const data = await request('/listings');
      setListings(Array.isArray(data) ? data : []);
    } catch (error) {
      handleApiError(error);
    } finally {
      setLoadingListings(false);
    }
  }, [handleApiError]);

  const loadOrders = useCallback(async () => {
    setLoadingOrders(true);
    try {
      const data = await request('/orders');
      setOrders(Array.isArray(data?.orders) ? data.orders : []);
    } catch (error) {
      handleApiError(error);
    } finally {
      setLoadingOrders(false);
    }
  }, [handleApiError]);

  const loadMonthly = useCallback(async () => {
    setLoadingMonthly(true);
    try {
      const data = await request('/orders/resumo-mensal');
      setMonthly(data || null);
    } catch {
      setMonthly(null);
    } finally {
      setLoadingMonthly(false);
    }
  }, []);

  const loadSession = useCallback(async () => {
    try {
      const me = await request('/auth/me');
      if (me?.connected) {
        setAccount({
          user_id: me.user_id,
          nickname: me.nickname,
          expires_at: me.expires_at,
          needs_reauth: Boolean(me.needs_reauth),
        });
        return true;
      }
      setAccount(null);
      return false;
    } catch (error) {
      handleApiError(error);
      setAccount(null);
      return false;
    } finally {
      setAuthLoading(false);
    }
  }, [handleApiError]);

  useEffect(() => {
    let cancelled = false;
    sessionStorage.removeItem(LEGACY_DASHBOARD_KEY_STORAGE);

    (async () => {
      try {
        const status = await request('/auth/painel');
        if (cancelled) return;
        if (!status?.protected) {
          setDashboardUnlocked(true);
          setDashboardChecking(false);
          return;
        }
        const stored = sessionStorage.getItem(DASHBOARD_TOKEN_STORAGE);
        if (!stored) return;
        const session = await request('/auth/sessao');
        if (!cancelled) {
          setDashboardUser(session?.user || null);
          setDashboardUnlocked(true);
        }
      } catch (error) {
        if (cancelled) return;
        sessionStorage.removeItem(DASHBOARD_TOKEN_STORAGE);
        sessionStorage.removeItem(LEGACY_DASHBOARD_KEY_STORAGE);
        setDashboardUser(null);
        setDashboardUnlocked(false);
        setDashboardError(error?.message || 'Informe usuário e senha do painel.');
      } finally {
        if (!cancelled) setDashboardChecking(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (dashboardChecking || !dashboardUnlocked) return undefined;

    const params = new URLSearchParams(window.location.search);
    const connected = params.get('ml_connected');
    const error = params.get('ml_error');

    if (connected || error) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }
    if (error) {
      setAuthError(decodeURIComponent(error));
    }

    let cancelled = false;

    (async () => {
      const authenticated = await loadSession();
      if (cancelled) return;

      try {
        const data = await request('/suppliers/nichos');
        if (!cancelled) setNichos(Array.isArray(data) ? data : []);
      } catch (requestError) {
        if (!cancelled) handleApiError(requestError);
      }

      if (authenticated) {
        if (connected) showToast('success', 'Conta Mercado Livre conectada com sucesso.');
        await Promise.allSettled([loadListings(), loadOrders(), loadMonthly()]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    dashboardChecking,
    dashboardUnlocked,
    handleApiError,
    loadListings,
    loadMonthly,
    loadOrders,
    loadSession,
    showToast,
  ]);

  useEffect(() => {
    if (
      dashboardUnlocked &&
      view === 'pedidos' &&
      orders.length === 0 &&
      account &&
      !loadingOrders
    ) {
      loadOrders();
    }
  }, [dashboardUnlocked, view, orders.length, account, loadingOrders, loadOrders]);

  const unlockDashboard = async (username, password) => {
    setUnlocking(true);
    setDashboardError('');
    try {
      const data = await request('/auth/painel', {
        method: 'POST',
        body: { username, password },
      });
      if (!data?.ok) {
        throw new Error('Não foi possível liberar o painel.');
      }
      if (data.protected === false) {
        sessionStorage.removeItem(DASHBOARD_TOKEN_STORAGE);
        setDashboardUser(null);
      } else {
        if (!data.token) throw new Error('Sessão inválida. Tente novamente.');
        sessionStorage.setItem(DASHBOARD_TOKEN_STORAGE, data.token);
        setDashboardUser(data.user || null);
      }
      setAuthLoading(true);
      setDashboardUnlocked(true);
    } catch (error) {
      setDashboardError(error?.message || 'Senha inválida.');
    } finally {
      setUnlocking(false);
    }
  };

  const lockDashboard = () => {
    sessionStorage.removeItem(DASHBOARD_TOKEN_STORAGE);
    sessionStorage.removeItem(LEGACY_DASHBOARD_KEY_STORAGE);
    setDashboardError('');
    setDashboardUser(null);
    setDashboardUnlocked(false);
    setAccount(null);
    setListings([]);
    setOrders([]);
    setProdutos([]);
    setFornecedores([]);
    setSelectedNicho('');
    setAuthError('');
    setView('dashboard');
  };

  const findSupplierFor = (name) => {
    const query = String(name || '')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .slice(0, 4)
      .join(' ');
    setCatalogSearch(query);
    setCatalogVersion((current) => current + 1);
    setView('catalogo');
    setMobileNav(false);
  };

  const login = async () => {
    try {
      const data = await request('/auth/ml/url');
      if (data?.url) {
        window.location.href = data.url;
      }
    } catch (error) {
      handleApiError(error);
    }
  };

  const logout = async () => {
    try {
      await request('/auth/logout', { method: 'POST' });
    } catch {}
    setAccount(null);
    setListings([]);
    setOrders([]);
    setProdutos([]);
    setFornecedores([]);
    setSelectedNicho('');
    setView('dashboard');
  };

  const selectNicho = async (nichoId) => {
    setSelectedNicho(nichoId);
    setProdutos([]);
    setFornecedores([]);
    setLoadingProdutos(true);
    setLoadingFornecedores(true);

    const produtosPromise = request(`/suppliers/produtos-reais?nicho=${encodeURIComponent(nichoId)}&limite=12&minPreco=80`)
      .then((data) => setProdutos(Array.isArray(data?.produtos) ? data.produtos : []))
      .catch(handleApiError)
      .finally(() => setLoadingProdutos(false));

    const fornecedoresPromise = request(`/suppliers/fornecedores?nicho=${encodeURIComponent(nichoId)}`)
      .then((data) => setFornecedores(Array.isArray(data) ? data : []))
      .catch(() => setFornecedores([]))
      .finally(() => setLoadingFornecedores(false));

    await Promise.allSettled([produtosPromise, fornecedoresPromise]);
  };

  const openCreateModal = (produto) => {
    lastValidationRef.current = { key: null, data: null };
    validationInFlightRef.current = null;
    setModalProduct(produto);
    setMargin(18);
    setFreeShipping(false);
    setSupplierCost(Number(produto.price) || 0);
    setShippingCost('');
    setPricing(null);
    setValidation(null);
    setAuthError('');
  };

  const openRadarProduct = (item) => {
    if (!item?.product_id) return;
    lastValidationRef.current = { key: null, data: null };
    validationInFlightRef.current = null;
    setModalProduct({
      id: item.product_id,
      catalogo_id: item.product_id,
      item_id: item.item_id || null,
      title: item.nome,
      thumbnail: item.thumbnail,
      price: item.preco,
      listing_strategy: 'catalog_required',
      catalog_required: true,
      seller: item.fornecedor_id
        ? { id: String(item.fornecedor_id), nickname: item.fornecedor_nome }
        : null,
    });
    setMargin(18);
    setFreeShipping(false);
    setSupplierCost(Number(item.custo) || 0);
    setShippingCost('');
    setPricing(null);
    setValidation(null);
    setAuthError('');
  };

  const createListing = async () => {
    if (!modalProduct) return;
    if (!pricing?.viable) {
      showToast('error', 'Ajuste o custo ou a margem para o anúncio ficar viável.');
      return;
    }
    setCreating(true);
    try {
      const created = await request('/listings', {
        method: 'POST',
        body: {
          catalogo_id: modalProduct.catalogo_id || modalProduct.id,
          item_id: modalProduct.item_id || null,
          custo: supplierCost,
          margem: margin / 100,
          free_shipping: freeShipping,
          frete:
            shippingCost === '' || !Number.isFinite(Number(shippingCost))
              ? null
              : Number(shippingCost),
          fornecedor: modalProduct.seller?.nickname || null,
          fornecedor_id: modalProduct.seller?.id || null,
        },
      });

      showToast('success', `Anúncio publicado com sucesso (${created.id}).`);
      setModalProduct(null);
      setPricing(null);
      setValidation(null);
      await loadListings();
    } catch (error) {
      handleApiError(error);
    } finally {
      setCreating(false);
    }
  };

  const closeListing = async (listing) => {
    const ok = window.confirm(`Encerrar o anúncio "${listing.title}" no Mercado Livre?`);
    if (!ok) return;
    try {
      await request(`/listings/${listing.id}`, { method: 'DELETE' });
      showToast('success', 'Anúncio encerrado.');
      await loadListings();
    } catch (error) {
      handleApiError(error);
    }
  };

  const pauseAllListings = async () => {
    const ok = window.confirm(
      'Freio de mão: pausar todos os anúncios ativos agora? Use quando bater a cota diária para proteger o caixa e a reputação.'
    );
    if (!ok) return;
    setPausing(true);
    try {
      const result = await request('/listings/pausar-todos', { method: 'POST' });
      showToast(
        'success',
        `${result.atualizados || 0} anúncio(s) pausado(s).${result.falhas?.length ? ` ${result.falhas.length} falha(s).` : ''}`
      );
      await loadListings();
    } catch (error) {
      handleApiError(error);
    } finally {
      setPausing(false);
    }
  };

  const reactivateAllListings = async () => {
    const ok = window.confirm('Reativar todos os anúncios pausados?');
    if (!ok) return;
    setPausing(true);
    try {
      const result = await request('/listings/reativar-todos', { method: 'POST' });
      showToast(
        'success',
        `${result.atualizados || 0} anúncio(s) reativado(s).${result.falhas?.length ? ` ${result.falhas.length} falha(s).` : ''}`
      );
      await loadListings();
    } catch (error) {
      handleApiError(error);
    } finally {
      setPausing(false);
    }
  };

  const downloadLabel = async (order) => {
    try {
      const info = await request(`/labels/order/${order.id}/info`);
      if (!info.label_available) {
        showToast(
          'warning',
          `A etiqueta ainda não está disponível. Status do envio: ${info.status || 'desconhecido'}.`
        );
        return;
      }
      window.open(`${API}/labels/order/${order.id}`, '_blank', 'noopener,noreferrer');
    } catch (error) {
      handleApiError(error);
    }
  };

  const currentTitle = VIEW_TITLES[view] || VIEW_TITLES.dashboard;

  const refreshCurrent = () => {
    if (view === 'catalogo') {
      setCatalogVersion((current) => current + 1);
      return undefined;
    }
    if (view === 'radar') {
      setRadarVersion((current) => current + 1);
      return undefined;
    }
    if (view === 'anuncios') return loadListings();
    if (view === 'pedidos') return loadOrders();
    if (view === 'produtos' && selectedNicho) return selectNicho(selectedNicho);
    if (view === 'fornecedores' && selectedNicho) return selectNicho(selectedNicho);
    return Promise.allSettled([loadListings(), loadOrders(), loadMonthly()]);
  };

  const stats = useMemo(
    () => ({ listings: listings.length, orders: orders.length }),
    [listings.length, orders.length]
  );

  if (dashboardChecking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-white">
        <div className="flex flex-col items-center gap-4">
          <Spinner className="h-8 w-8 text-brand-400" />
          <p className="text-sm text-slate-400">Verificando acesso...</p>
        </div>
      </div>
    );
  }

  if (!dashboardUnlocked) {
    return <PasswordScreen onSubmit={unlockDashboard} error={dashboardError} loading={unlocking} />;
  }

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-white">
        <div className="flex flex-col items-center gap-4">
          <Spinner className="h-8 w-8 text-brand-400" />
          <p className="text-sm text-slate-400">Carregando painel...</p>
        </div>
      </div>
    );
  }

  if (!account) {
    return (
      <>
        <LoginScreen onLogin={login} error={authError} />
        <Toast toast={toast} onClose={() => setToast(null)} />
      </>
    );
  }

  return (
    <div className="min-h-screen lg:flex">
      {mobileNav ? (
        <button
          type="button"
          aria-label="Fechar menu"
          onClick={() => setMobileNav(false)}
          className="fixed inset-0 z-30 bg-slate-950/40 lg:hidden"
        />
      ) : null}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col border-r border-slate-800 bg-slate-950 text-white transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 ${
          mobileNav ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center gap-3 px-5 py-5">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-400 font-black text-slate-950">
            ML
          </div>
          <div>
            <p className="text-sm font-bold">Melimax</p>
            <p className="text-[11px] uppercase tracking-wider text-slate-400">Painel pessoal</p>
          </div>
          <button
            type="button"
            onClick={() => setMobileNav(false)}
            className="ml-auto rounded-lg p-2 text-slate-400 hover:bg-white/10 lg:hidden"
            aria-label="Fechar menu"
          >
            <Icon name="close" className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 space-y-1 px-3 py-2">
          {NAV_ITEMS.filter((item) => item.id !== 'admin' || dashboardUser?.role === 'admin').map((item) => {
            const active = view === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setView(item.id);
                  setMobileNav(false);
                }}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-semibold transition ${
                  active
                    ? 'bg-brand-400 text-slate-950'
                    : 'text-slate-300 hover:bg-white/5 hover:text-white'
                }`}
              >
                <Icon name={item.icon} className="h-5 w-5" />
                {item.label}
              </button>
            );
          })}
        </nav>

        <div className="border-t border-white/10 p-3">
          <div className="rounded-xl bg-white/5 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Conta conectada</p>
            <p className="mt-1 truncate text-sm font-bold">{account.nickname}</p>
            <p className="text-[11px] text-slate-400">ID {account.user_id}</p>
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={login} className="btn-ghost flex-1 px-2 py-1.5 text-xs">
                Reconectar
              </button>
              <button type="button" onClick={logout} className="btn-ghost flex-1 px-2 py-1.5 text-xs">
                <Icon name="logout" className="h-3.5 w-3.5" />
                Desconectar
              </button>
            </div>
            <button
              type="button"
              onClick={lockDashboard}
              className="btn-ghost mt-2 w-full px-2 py-1.5 text-xs"
            >
              <Icon name="shield" className="h-3.5 w-3.5" />
              Bloquear painel
            </button>
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-slate-100/90 backdrop-blur">
          <div className="flex items-center gap-3 px-4 py-4 lg:px-8">
            <button
              type="button"
              onClick={() => setMobileNav(true)}
              className="rounded-lg border border-slate-200 bg-white p-2 text-slate-600 lg:hidden"
              aria-label="Abrir menu"
            >
              <Icon name="menu" className="h-5 w-5" />
            </button>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-xl font-extrabold tracking-tight">{currentTitle.title}</h1>
              <p className="truncate text-xs text-slate-500">{currentTitle.subtitle}</p>
            </div>
            <div className="hidden items-center gap-2 sm:flex">
              <span className="badge bg-white text-slate-600 ring-1 ring-slate-200">
                {stats.listings} anúncios
              </span>
              <span className="badge bg-white text-slate-600 ring-1 ring-slate-200">
                {stats.orders} pedidos
              </span>
            </div>
            <button type="button" onClick={refreshCurrent} className="btn-ghost px-3 py-2" title="Atualizar dados">
              <Icon name="refresh" className="h-4 w-4" />
              <span className="hidden sm:inline">Atualizar</span>
            </button>
          </div>
        </header>

        {account.needs_reauth ? (
          <div className="mx-4 mt-4 flex flex-col gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 sm:flex-row sm:items-center sm:justify-between lg:mx-8">
            <div className="flex items-start gap-2">
              <Icon name="alert" className="mt-0.5 h-5 w-5 shrink-0" />
              <p>
                Sua sessão do Mercado Livre expirou. Reconecte para continuar usando produtos,
                anúncios e pedidos.
              </p>
            </div>
            <button type="button" onClick={login} className="btn-dark shrink-0">
              Reconectar conta
            </button>
          </div>
        ) : null}

        <main className="flex-1 px-4 py-6 lg:px-8">
          {view === 'dashboard' ? (
            <DashboardView
              account={account}
              listings={listings}
              orders={orders}
              monthly={monthly}
              monthlyLoading={loadingMonthly}
              onPauseAll={pauseAllListings}
              onReactivateAll={reactivateAllListings}
              pausing={pausing}
              onNavigate={setView}
            />
          ) : null}
          {view === 'radar' ? (
            <RadarView
              version={radarVersion}
              onFindSupplier={findSupplierFor}
              onAnalyze={openRadarProduct}
              onToast={showToast}
            />
          ) : null}
          {view === 'catalogo' ? (
            <CatalogoView
              key={catalogVersion}
              onToast={showToast}
              externalSearch={catalogSearch}
            />
          ) : null}
          {view === 'produtos' ? (
            <ProductsView
              nichos={nichos}
              selectedNicho={selectedNicho}
              onSelectNicho={selectNicho}
              produtos={produtos}
              loading={loadingProdutos}
              onCreate={openCreateModal}
            />
          ) : null}
          {view === 'fornecedores' ? (
            <SuppliersView
              fornecedores={fornecedores}
              loading={loadingFornecedores}
              selectedNicho={selectedNicho}
            />
          ) : null}
          {view === 'anuncios' ? (
            <ListingsView
              listings={listings}
              loading={loadingListings}
              onRefresh={loadListings}
              onClose={closeListing}
              onPauseAll={pauseAllListings}
              onReactivateAll={reactivateAllListings}
              pausing={pausing}
            />
          ) : null}
          {view === 'pedidos' ? (
            <OrdersView
              orders={orders}
              loading={loadingOrders}
              onRefresh={loadOrders}
              onLabel={downloadLabel}
            />
          ) : null}
          {view === 'admin' ? (
            <AdminView
              currentUser={dashboardUser}
              onToast={showToast}
              onSession={setDashboardUser}
            />
          ) : null}
        </main>
      </div>

      <Toast toast={toast} onClose={() => setToast(null)} />

      {modalProduct ? (
        <CreateListingModal
          produto={modalProduct}
          margin={margin}
          setMargin={setMargin}
          freeShipping={freeShipping}
          setFreeShipping={setFreeShipping}
          cost={supplierCost}
          setCost={setSupplierCost}
          shippingCost={shippingCost}
          setShippingCost={setShippingCost}
          pricing={pricing}
          validation={validation}
          validating={validating}
          creating={creating}
          onClose={() => setModalProduct(null)}
          onConfirm={createListing}
        />
      ) : null}
    </div>
  );
}
