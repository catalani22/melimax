# ML Dropshipping

Plataforma profissional de dropshipping conectada à sua conta Mercado Livre.

## Requisitos
- Node.js 18+
- PostgreSQL
- Redis (opcional, para filas)
- Conta de desenvolvedor Mercado Livre (App ID e Client Secret)

## Estrutura
- `backend/` — API Node.js/Express com integração OAuth, produtos reais, anúncios, pedidos e etiquetas
- `frontend/` — React com Tailwind CSS

## Instalação

### Backend
```bash
cd backend
cp .env.example .env
# Edite .env com suas credenciais Mercado Livre e banco de dados
npm install
# Crie o banco de dados e rode o schema
psql -U postgres -d ml_dropshipping -f database.sql
npm run dev
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```

## Acesso ao painel
Defina `DASHBOARD_PASSWORD` no backend para exigir senha. Com a variável preenchida, todas as rotas `/api` ficam protegidas, exceto `health`, `auth/painel` e o callback OAuth do Mercado Livre. A senha fica apenas na sessão do navegador e é enviada no header `x-dashboard-key`.

## Funcionalidades
- Conexão OAuth real com Mercado Livre (MLB)
- Catálogo dos 20 melhores nichos com ticket médio
- Produtos reais da API Mercado Livre (acima de R$ 80)
- Fornecedores validados de renome
- Criação de anúncios com qualificação acima de 85%
- Margem configurável (15-20%)
- Etiquetas de remessa enviadas aos fornecedores
- Dados reais — sem mocks, sem placeholders

## Fluxo
1. Conectar conta Mercado Livre
2. Escolher nicho → carregar produtos reais
3. Selecionar fornecedor → criar anúncio qualificado
4. Vender → fornecedor empacota e envia
5. Etiqueta enviada automaticamente ao fornecedor
6. Lucro real de 15-20% por venda
