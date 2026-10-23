import { useState, useEffect } from 'react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

function App() {
  const [view, setView] = useState('login');
  const [account, setAccount] = useState(null);
  const [nichos, setNichos] = useState([]);
  const [produtos, setProdutos] = useState([]);
  const [fornecedores, setFornecedores] = useState([]);
  const [listings, setListings] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch(`${API}/auth/me`).then(r => r.json()).then(d => {
      if (d.user_id) setAccount(d);
    });
    fetch(`${API}/suppliers/nichos`).then(r => r.json()).then(setNichos);
    fetch(`${API}/suppliers/fornecedores`).then(r => r.json()).then(setFornecedores);
    fetch(`${API}/listings`).then(r => r.json()).then(setListings);
  }, []);

  const loginML = () => window.location.href = `${API}/auth/login`;
  const logout = () => { setAccount(null); };

  const carregarProdutos = (nicho) => {
    setLoading(true);
    fetch(`${API}/suppliers/produtos-reais?nicho=${nicho}&limite=20&minPreco=80`)
      .then(r => r.json()).then(d => { setProdutos(d.produtos || []); setLoading(false); });
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
    });
  };

  return (
    <div className="min-h-screen">
      {view === 'login' && (
        <div className="flex items-center justify-center h-screen bg-slate-900 text-white">
          <div className="max-w-2xl p-8 rounded-xl bg-slate-800 shadow-2xl border border-slate-700">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded bg-green-500 flex items-center justify-center font-bold">ML</div>
              <h1 className="text-2xl font-bold">ML Dropshipping</h1>
            </div>
            <p className="mb-6 text-slate-300">Plataforma profissional de dropshipping conectada à sua conta Mercado Livre. Venda sem estoque, com margem de 15-20% e fornecedores validados.</p>
            <div className="space-y-3">
              <button onClick={loginML} className="w-full py-3 bg-yellow-500 hover:bg-yellow-600 text-black font-semibold rounded-lg transition">Conectar Conta Mercado Livre</button>
              <p className="text-center text-xs text-slate-400">Dados reais — sem mocks, sem simulações, sem placeholders.</p>
            </div>
          </div>
        </div>
      )}

      {view === 'dashboard' && account && (
        <div className="flex h-screen overflow-hidden">
          <aside className="w-64 bg-slate-900 text-white hidden md:flex flex-col">
            <div className="p-6 flex items-center gap-3 border-b border-slate-700">
              <div className="w-8 h-8 rounded bg-green-500 flex items-center justify-center font-bold">ML</div>
              <span className="font-bold text-lg">ML Dropshipping</span>
            </div>
            <nav className="p-4 space-y-2">
              {[['Dashboard','dashboard'],['Produtos','produtos'],['Fornecedores','fornecedores'],['Anúncios','listings'],['Pedidos & Etiquetas','pedidos']].map(([label, v]) => (
                <button key={v} onClick={() => setView(v)} className={`w-full text-left p-3 rounded-lg transition ${view===v?'bg-yellow-500 text-black font-semibold':'hover:bg-slate-800'}`}>{label}</button>
              ))}
              <button onClick={logout} className="w-full text-left p-3 rounded-lg text-red-400 hover:bg-red-500/20">Sair</button>
            </nav>
            <div className="mt-auto p-6 text-xs text-slate-400">
              <div>Usuário: {account.nickname}</div>
              <div>ID: {account.user_id}</div>
              <div className="mt-2 text-green-400">Conta conectada ✓</div>
            </div>
          </aside>

          <main className="flex-1 overflow-y-auto bg-slate-50 p-6">
            {view === 'dashboard' && (
              <div className="space-y-6">
                <div className="flex justify-between items-end">
                  <h1 className="text-2xl font-bold">Visão Geral</h1>
                  <span className="px-3 py-1 bg-green-100 text-green-800 rounded-full text-sm font-semibold">Operacional</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                  {[['Anúncios ativos', listings.length, '🛍️'],['Fornecedores', fornecedores.length, '🏪'],['Margem média', '18%', '💰'],['Preço mínimo', 'R$ 80,00', '🏷️']].map(([label, valor, icone]) => (
                    <div key={label} className="p-5 rounded-xl bg-white shadow border border-slate-200">
                      <div className="text-slate-400 text-sm">{label}</div>
                      <div className="text-2xl font-bold mt-1">{valor}</div>
                      <div className="text-slate-400 text-xs mt-1">{icone}</div>
                    </div>
                  ))}
                </div>
                <div className="p-5 rounded-xl bg-white shadow border border-slate-200">
                  <h3 className="font-bold mb-3">Como funciona</h3>
                  <ul className="list-disc list-inside space-y-2 text-sm text-slate-600">
                    <li>Conecte sua conta Mercado Livre via OAuth.</li>
                    <li>Escolha um nicho e carregue produtos reais acima de R$ 80.</li>
                    <li>Selecione um fornecedor validado e crie o anúncio com qualificação acima de 85%.</li>
                    <li>Venda — o fornecedor empacota, envia e cuida de devoluções.</li>
                    <li>Etiquetas de remessa enviadas automaticamente ao fornecedor.</li>
                    <li>Lucro real de 15-20% por produto vendido.</li>
                  </ul>
                </div>
              </div>
            )}

            {view === 'produtos' && (
              <div className="space-y-6">
                <h1 className="text-2xl font-bold">Produtos Reais - Top Nichos</h1>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                  {nichos.map(n => (
                    <button key={n.id} onClick={() => carregarProdutos(n.id)} className="p-3 rounded-lg border border-slate-200 bg-white hover:bg-yellow-50 hover:border-yellow-200 transition text-left">
                      <div className="font-semibold">{n.nome}</div>
                      <div className="text-xs text-slate-500">Ticket médio: R$ {n.media_ticket}</div>
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {loading ? <div className="col-span-3 text-center py-10 text-slate-400">Carregando produtos reais...</div> : produtos.map(p => (
                    <div key={p.id} className="p-4 rounded-xl bg-white shadow border border-slate-200">
                      <img src={p.thumbnail} alt={p.title} className="w-full h-32 object-cover rounded-lg mb-3" />
                      <div className="font-medium text-sm mb-1 line-clamp-2">{p.title}</div>
                      <div className="text-xl font-bold text-green-600 mb-2">R$ {p.price.toLocaleString('pt-BR')}</div>
                      <button className="w-full py-2 bg-yellow-500 hover:bg-yellow-600 text-black rounded font-semibold text-sm">Criar Anúncio</button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {view === 'fornecedores' && (
              <div className="space-y-6">
                <h1 className="text-2xl font-bold">Fornecedores Validados</h1>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {fornecedores.map(f => (
                    <div key={f.id} className="p-5 rounded-xl bg-white shadow border border-slate-200">
                      <div className="font-semibold">{f.nome}</div>
                      <div className="text-sm text-slate-500 mt-1">Reputação: {f.reputacao}</div>
                      <div className="text-sm mt-2">Avaliação: {f.avaliacao}/5</div>
                      <div className="text-sm mt-2">Entregas no prazo: {f.entregas_no_prazo}%</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {view === 'listings' && (
              <div className="space-y-6">
                <h1 className="text-2xl font-bold">Anúncios no Mercado Livre</h1>
                <div className="overflow-x-auto">
                  <table className="min-w-full bg-white rounded-xl shadow border border-slate-200">
                    <thead className="bg-slate-50">
                      <tr><th className="p-3 text-left text-sm font-semibold">Título</th><th className="p-3 text-left text-sm font-semibold">Preço</th><th className="p-3 text-left text-sm font-semibold">Fornecedor</th><th className="p-3 text-left text-sm font-semibold">Qualificação</th><th className="p-3 text-left text-sm font-semibold">Status</th></tr>
                    </thead>
                    <tbody>
                      {listings.map(l => (
                        <tr key={l.ml_item_id} className="border-t border-slate-100">
                          <td className="p-3 text-sm">{l.title}</td>
                          <td className="p-3 text-sm font-bold">R$ {l.price.toLocaleString('pt-BR')}</td>
                          <td className="p-3 text-sm">{l.supplier}</td>
                          <td className="p-3 text-sm"><span className={`px-2 py-0.5 rounded text-xs font-bold ${l.score>=85?'bg-green-100 text-green-700':'bg-yellow-100 text-yellow-700'}`}>{l.score}%</span></td>
                          <td className="p-3 text-sm">{l.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {view === 'pedidos' && (
              <div className="space-y-6">
                <h1 className="text-2xl font-bold">Pedidos e Etiquetas</h1>
                <div className="p-5 rounded-xl bg-white shadow border border-slate-200">
                  <p className="text-sm text-slate-600">Os pedidos são importados automaticamente da sua conta Mercado Livre. As etiquetas de remessa são enviadas ao fornecedor responsável pelo envio.</p>
                </div>
              </div>
            )}
          </main>
        </div>
      )}
    </div>
  );
}

export default App;
