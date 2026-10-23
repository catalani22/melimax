import { useState, useEffect } from 'react';

const API = 'https://melimax-backend.vercel.app/api';

function App() {
  const [view, setView] = useState('login');
  const [account, setAccount] = useState(null);
  const [nichos, setNichos] = useState([]);
  const [produtos, setProdutos] = useState([]);
  const [fornecedores, setFornecedores] = useState([]);
  const [listings, setListings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r1 = await fetch(`${API}/auth/me`);
        const d1 = await r1.json();
        if (!cancelled && d1.user_id) setAccount(d1);
      } catch (e) { if (!cancelled) setApiError('Erro ao conectar com o backend: ' + e.message); }
      try {
        const r2 = await fetch(`${API}/suppliers/nichos`);
        const d2 = await r2.json();
        if (!cancelled) setNichos(d2 || []);
      } catch (e) { if (!cancelled) setApiError('Erro ao carregar nichos: ' + e.message); }
      try {
        const r3 = await fetch(`${API}/suppliers/fornecedores`);
        const d3 = await r3.json();
        if (!cancelled) setFornecedores(d3 || []);
      } catch (e) { if (!cancelled) setApiError('Erro ao carregar fornecedores: ' + e.message); }
      try {
        const r4 = await fetch(`${API}/listings`);
        const d4 = await r4.json();
        if (!cancelled) setListings(d4 || []);
      } catch (e) { if (!cancelled) setApiError('Erro ao carregar anuncios: ' + e.message); }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  const loginML = () => { window.location.href = `${API}/auth/login`; };
  const logout = () => { setAccount(null); };

  const carregarProdutos = (nicho) => {
    setLoading(true);
    fetch(`${API}/suppliers/produtos-reais?nicho=${nicho}&limite=20&minPreco=80`)
      .then(r => r.json()).then(d => { setProdutos(d.produtos || []); setLoading(false); })
      .catch(e => { setLoading(false); setApiError(e.message); });
  };

  const criarAnuncio = (produto, fornecedor) => {
    setLoading(true);
    fetch(`${API}/listings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ produto, fornecedor, margem: 0.18 }),
    }).then(r => r.json()).then(d => {
      setListings(prev => [d, ...prev]);
      setLoading(false);
    }).catch(e => { setLoading(false); setApiError(e.message); });
  };

  const cn = (...classes) => classes.filter(Boolean).join(' ');

  if (apiError) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-red-50">
        <div className="max-w-md p-6 bg-white rounded-lg border border-red-200 shadow-lg">
          <h2 className="text-xl font-bold text-red-700 mb-3">Erro de configuraçăo</h2>
          <p className="text-sm text-red-600 mb-4">{apiError}</p>
          <button onClick={() => setApiError(null)} className="w-full py-2 bg-red-600 hover:bg-red-700 text-white rounded font-semibold">Fechar</button>
        </div>
      </div>
    );
  }

  if (view === 'login') {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-slate-900">
        <div className="max-w-md p-8 bg-slate-800 rounded-xl border border-slate-700 shadow-2xl text-white">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded bg-green-500 flex items-center justify-center font-bold">ML</div>
            <h1 className="text-2xl font-bold">ML Dropshipping</h1>
          </div>
          <p className="text-slate-300 mb-6">Plataforma profissional de dropshipping conectada à sua conta Mercado Livre.</p>
          <div className="space-y-3">
            <button onClick={loginML} className="w-full py-3 bg-yellow-500 hover:bg-yellow-600 text-black font-semibold rounded-lg transition">Conectar Conta Mercado Livre</button>
            <p className="text-center text-xs text-slate-400">Dados reais — sem mocks.</p>
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-green-500 mb-4"></div>
          <p className="text-slate-600">Carregando plataforma...</p>
        </div>
      </div>
    );
  }

  if (!account) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-slate-900">
        <div className="max-w-md p-8 bg-slate-800 rounded-xl border border-slate-700 shadow-2xl text-white">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded bg-green-500 flex items-center justify-center font-bold">ML</div>
            <h1 className="text-2xl font-bold">ML Dropshipping</h1>
          </div>
          <p className="text-slate-300 mb-6">Faça login na sua conta Mercado Livre para continuar.</p>
          <div className="space-y-3">
            <button onClick={loginML} className="w-full py-3 bg-yellow-500 hover:bg-yellow-600 text-black font-semibold rounded-lg transition">Conectar Conta Mercado Livre</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8">
      <header className="mb-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded bg-green-500 flex items-center justify-center font-bold">ML</div>
          <h1 className="text-2xl font-bold">ML Dropshipping</h1>
        </div>
        <div className="flex items-center gap-2 bg-white p-3 rounded-lg border border-slate-200 shadow-sm">
          <span className="text-xs font-semibold text-slate-600 uppercase tracking-wider">Conectado</span>
          <span className="text-xs text-slate-400 ml-2">{account.nickname}</span>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <aside className="lg:col-span-1">
          <nav className="space-y-1">
            <button
              onClick={() => setView('dashboard')}
              className={cn('w-full text-left px-4 py-3 rounded-lg transition', view === 'dashboard' ? 'bg-yellow-500 text-black font-semibold' : 'text-slate-600 hover:bg-slate-100')}
            >Dashboard</button>
            <button
              onClick={() => setView('produtos')}
              className={cn('w-full text-left px-4 py-3 rounded-lg transition', view === 'produtos' ? 'bg-yellow-500 text-black font-semibold' : 'text-slate-600 hover:bg-slate-100')}
            >Produtos</button>
            <button
              onClick={() => setView('fornecedores')}
              className={cn('w-full text-left px-4 py-3 rounded-lg transition', view === 'fornecedores' ? 'bg-yellow-500 text-black font-semibold' : 'text-slate-600 hover:bg-slate-100')}
            >Fornecedores</button>
            <button
              onClick={() => setView('listings')}
              className={cn('w-full text-left px-4 py-3 rounded-lg transition', view === 'listings' ? 'bg-yellow-500 text-black font-semibold' : 'text-slate-600 hover:bg-slate-100')}
            >Anúncios</button>
            <button
              onClick={() => setView('pedidos')}
              className={cn('w-full text-left px-4 py-3 rounded-lg transition', view === 'pedidos' ? 'bg-yellow-500 text-black font-semibold' : 'text-slate-600 hover:bg-slate-100')}
            >Pedidos</button>
            <button onClick={logout} className="w-full text-left px-4 py-3 rounded-lg text-red-600 hover:bg-red-50 font-semibold">Sair</button>
          </nav>
        </aside>

        <main className="lg:col-span-2">
          {view === 'dashboard' && (
            <div className="space-y-6">
              <h1 className="text-xl font-bold">Visão Geral</h1>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                {[['Anúncios ativos', listings.length], ['Fornecedores', fornecedores.length], ['Margem média', '18%'], ['Preço mínimo', 'R$ 80,00']].map(([label, valor]) => (
                  <div key={label} className="p-5 bg-white rounded-xl border border-slate-200 shadow-sm">
                    <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">{label}</div>
                    <div className="text-2xl font-bold mt-1">{valor}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {view === 'produtos' && (
            <div className="space-y-6">
              <h1 className="text-xl font-bold">Produtos Reais por Nicho</h1>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
                {nichos.map(n => (
                  <button key={n.id} onClick={() => carregarProdutos(n.id)} className="p-3 bg-white rounded-lg border border-slate-200 hover:border-yellow-200 hover:bg-yellow-50 text-left transition">
                    <div className="font-semibold text-sm">{n.nome}</div>
                    <div className="text-xs text-slate-500 mt-1">Ticket: R$ {n.media_ticket}</div>
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                {loading ? (
                  <div className="col-span-full text-center py-10 text-slate-400">Carregando produtos reais...</div>
                ) : produtos.map(p => (
                  <div key={p.id} className="p-4 bg-white rounded-lg border border-slate-200 shadow-sm">
                    <img src={p.thumbnail} alt={p.title} className="w-full h-32 object-cover rounded-lg mb-3" />
                    <div className="font-medium text-sm mb-1 line-clamp-2">{p.title}</div>
                    <div className="text-xl font-bold text-green-600 mb-3">R$ {p.price.toLocaleString('pt-BR')}</div>
                    <button onClick={() => criarAnuncio(p, fornecedores[0])} className="w-full py-2 bg-yellow-500 hover:bg-yellow-600 text-black rounded font-sm font-semibold">Criar Anúncio</button>
                  </div>
                ))}
              </div>
            </div>
          )}
          {view === 'fornecedores' && (
            <div className="space-y-6">
              <h1 className="text-xl font-bold">Fornecedores Validados</h1>
              <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                {fornecedores.map(f => (
                  <div key={f.id} className="p-4 bg-white rounded-lg border border-slate-200 shadow-sm">
                    <div className="font-semibold text-sm">{f.nome}</div>
                    <div className="text-xs text-slate-500 mt-1">Reputação: {f.reputacao}</div>
                    <div className="text-xs mt-1">Avaliação: {f.avaliacao}/5</div>
                    <div className="text-xs mt-1">Entregas no prazo: {f.entregas_no_prazo}%</div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {view === 'listings' && (
            <div className="space-y-6">
              <h1 className="text-xl font-bold">Anúncios no Mercado Livre</h1>
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                <table className="w-full text-left">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-4 py-3 text-xs font-semibold text-slate-400 uppercase">Título</th>
                      <th className="px-4 py-3 text-xs font-semibold text-slate-400 uppercase">Preço</th>
                      <th className="px-4 py-3 text-xs font-semibold text-slate-400 uppercase">Fornecedor</th>
                      <th className="px-4 py-3 text-xs font-semibold text-slate-400 uppercase">Qualificação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {listings.map(l => (
                      <tr key={l.ml_item_id} className="border-t border-slate-100">
                        <td className="px-4 py-3 text-sm">{l.title}</td>
                        <td className="px-4 py-3 text-sm font-bold">R$ {l.price.toLocaleString('pt-BR')}</td>
                        <td className="px-4 py-3 text-sm">{l.supplier}</td>
                        <td className="px-4 py-3 text-sm">{l.score}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {view === 'pedidos' && (
            <div className="p-6 bg-white rounded-xl border border-slate-200 shadow-sm">
              <h1 className="text-xl font-bold mb-4">Pedidos e Etiquetas</h1>
              <p className="text-sm text-slate-600">Os pedidos são importados da sua conta Mercado Livre. As etiquetas de remessa são enviadas automaticamente ao fornecedor.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default App;
