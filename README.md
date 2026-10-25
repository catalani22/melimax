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
Defina `DASHBOARD_PASSWORD` no backend para criar o usuário `admin` inicial. Com a variável preenchida, todas as rotas `/api` ficam protegidas, exceto `health`, `auth/painel` e o callback OAuth do Mercado Livre. O login devolve um token de sessão de 7 dias, enviado no header `x-dashboard-key`. Usuários e senhas podem ser gerenciados em **Administração** por um perfil administrador.

## Funcionalidades
- Conexão OAuth real com Mercado Livre (MLB)
- Catálogo dos 20 melhores nichos com ticket médio
- Produtos reais da API Mercado Livre (acima de R$ 80)
- Fornecedores validados de renome
- Criação de anúncios com qualificação acima de 85%
- Margem configurável (padrão 50%, piso 45%) e multiplicador mínimo de 3x sobre o custo
- Etiquetas de remessa enviadas aos fornecedores
- Radar Viral: tendências do Mercado Livre com snapshots diários, concorrência, preço e margem bruta
- Simulador de margem líquida antes de publicar, com taxa real do ML e frete por peso
- Importação de custos de fornecedores por CSV (C7, Atacadum, FFOrder e genéricos)
- Dados reais — sem mocks, sem placeholders

## Fluxo
1. Conectar conta Mercado Livre
2. Abrir o Radar Viral → coletar tendências → simular margem
3. Importar custos do fornecedor por CSV → criar anúncio qualificado
4. Vender → fornecedor empacota e envia
5. Etiqueta enviada automaticamente ao fornecedor
6. Acompanhar margem líquida real por venda
