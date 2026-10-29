# AGENTS.md — Melimax

## Objetivo

Operação de dropshipping nacional no Mercado Livre com produtos de estoque físico no Brasil, NF-e e lucro sobre o custo ≥ 100% (meta 150–200%+), sempre ao **preço real de mercado** e ponderando **volume de venda do produto e similares**. Exceção: itens de **alto giro** com lucro de **0,8x a 1x do custo** e mercado líquido confirmado.

## Marca

- Nome da loja: **MeLi Max - Shop**.
- Logo oficial: **amarela** (`frontend/public/melimax-logo.png`); ícone/favicon: `brand-icon.png` e `favicon.png`.
- Capa azul para página e redes sociais: `frontend/public/melimax-cover.png`.

## Restrições operacionais críticas

- O Mercado Livre trabalha com **um endereço de remetente/coleta por conta**.
- Para operar com **dois fornecedores diferentes ao mesmo tempo**, os dois devem:
  - estar no **mesmo CEP/armazém**, ou
  - usar um **hub/3PL** que consolide e despache de um único endereço.
- Se os CEPs forem diferentes, operar um como principal e o outro como **backup**, ou contratar hub.
- Limite prático da meta: **10–15 pedidos/dia = 300–450 pedidos/mês**.

## Operação inicial e cautela de caixa

- Com **60–100 SKUs** prontos, montar o lote completo, mas manter os anúncios **pausados por 1–2 semanas** até CNPJ/IE e qualidade estarem acertados.
- Qualidade do anúncio: **sempre ≥ 85%** na plataforma; corrigir fotos, título e ficha técnica antes de ativar.
- Primeiro mês: crescer devagar por causa do **repasse do Mercado Livre** (10 dias após venda/entrega; depois 2 dias após a entrega). Acelerar só com o ciclo de caixa saudável.
- Dois fornecedores só operam juntos se compartilharem o **mesmo CEP/armazém**; senão, um principal + backup/hub.
- Minerar em rodadas, com algumas horas de intervalo, para não esgotar a cota diária de tokens.
- **Shopee Brasil** é referência secundária: preços tendem a ser maiores. Aplicar desconto conservador e nunca usá-la sozinha para justificar 3x/margem.

## Metas comerciais

- **Sem piso fixo de múltiplo.** O preço de venda é definido pelo mercado; o custo pode ser R$ 15 e a venda R$ 85. O gate é o lucro líquido acima de 100% do custo depois de taxas, frete, embalagem e impostos.

- **10–15 pedidos/dia** (300–450/mês).
- Ticket de venda: **sem faixa fixa e sem piso fixo de múltiplo**; o preço é o **preço real de mercado** e precisa deixar **lucro líquido acima de 100% do custo**.
- Custo de compra: **flexível**. Não existe exigência de venda em 3x; um item de R$ 15 pode ser vendido a R$ 85 se o mercado pagar. O que manda é o **preço real de mercado** e o **lucro líquido acima de 100% do custo** após taxas, frete, embalagem e impostos.
- Lucro líquido sobre o custo: **≥ 100% após taxa do ML, frete, impostos e mensalidade**.
- Exceção de alto giro: **0,8x a 1x do custo**, inclusive sem preço de mercado confirmado, desde que o produto tenha demanda validada de 2–3 vendas/mês.
- Buscar **R$ 30 mil em vendas nos primeiros meses** (≈ 273 pedidos a ticket médio de R$ 110).
- Validar cada combinação custo × preço de mercado: o preço praticado pelo mercado precisa deixar **100% do custo** de lucro líquido depois de taxas, frete, embalagem e impostos. **Não usar múltiplo mínimo fixo** como gate.

## Fiscal

- A empresa é **EI (Empresa Individual)**, não MEI. EI pode ter IE e emitir NF-e.
- Bloqueio atual: CNPJ/IE inativos e IE incorreta. Regularizar antes de operar.
- Smarke exige que o lojista emita NF-e ao consumidor final (triangulação: Smarke → lojista → consumidor).
- Ao calcular preço, incluir **impostos, taxa do ML, frete, custo do produto e mensalidade**.
- Não assumir que “margem” do fornecedor é margem líquida.

## Fornecedores

- **Smarke**: opção paga de baixo custo; integração direta com ML; estoque próprio em SP; NF-e; planos Básico 50 pedidos, Pro 100, Turbo Pro ilimitado. Para 10–15/dia, só Turbo Pro.
- **C7 Drop**: sem mensalidade; estoque SP; manual; C7 Integra é automação paga. CEP cadastral 01022-050 é um **apartamento** (Parque Dom Pedro II, 268, apto 22); o **CEP de distribuição é 01022-020** (Centro/SP).
- **Dinka**: dropshipping nacional; escritório na Rua Boa Vista 133, Centro/SP, CEP 01014-001; galpões em SP/Guarulhos; NF-e; catálogo importado. **CEP de distribuição ainda não confirmado** (não usar o CEP do escritório como se fosse coleta).
- **Ventura Atacado**: sede cadastral em Itapevi/SP, CEP 06660-390; **CEP de distribuição 01022-020** (Centro/SP), o mesmo do C7; 41 SKUs importados, majoritariamente duplicados do C7.
- **Atacadum**: sem mensalidade e sem mínimo no dropshipping; estoque SP; manual; EAN pago à parte.
- **FFOrder**: descartada para fase 1. Envia da China em 10–15 dias, sem estoque Brasil.
- Novas opções só entram após validar: estoque físico Brasil, NF-e, CSV/API, custo visível, teste antes de mensalidade.

## Regras de decisão

- Se pagar, escolher **duas melhores opções com mesmo CEP**, custo atrativo e operação validada.
- Não assinar plano antes de: CNPJ/IE ativos, CSV/custos reais, amostra de NF-e, pedido-testes e cálculo de margem.
- Filtro de produto: **faixas de custo e venda fluidas**, preço real de mercado, lucro sobre custo ≥ 100% após taxas/frete/impostos, estoque Brasil, boa demanda e concorrência.
- Priorizar **poucos fornecedores** com estoque, NF-e e operação simples; não pulverizar.
- Trabalhar em **lotes pequenos** para não esgotar o CLI e permitir revisão.
- `dados/` passa a ser versionado; nunca commitar tokens, `.env` ou credenciais.

## Dados extraídos (26/10/2026)

- `dados/onedrop.csv`: 418 produtos; 280 fora do Catálogo PRO; 121 com custo R$ 15–30; 92 fecham ≥100% sobre custo a 4,5x. Sem CEP de armazém no catálogo público.
- `dados/c7drop.csv`: 1.366 produtos via API pública `/api/products`; o custo real é o tier `DROPSHIPPING` em `/api/products/{slug}` (não o `price` da lista). CEP 01022-050 (Centro/SP). 38 com estoque e custo R$ 15–30; 32 fecham a meta.
- `dados/smarke.csv`: 141 produtos via API pública; custo `preco_decolar` exige Turbo Pro; CEP 08471-000 (Cidade Tiradentes/SP). Só 9 com custo R$ 15–30.
- `dados/mirao.csv`: 7.128 produtos via GraphQL; 1.751 com preço R$ 15–30, mas só 74 em estoque. Atacado tradicional, sem dropshipping; usar como benchmark.
- `dados/atacadum.csv`: só 5 produtos extraídos. CEP 01012-001 (Centro/SP). Site aplicou rate limit 401 após ~20 requisições; aguardar e raspar devagar.
- **CEP que importa é o de distribuição, não o cadastral.** C7 e Ventura compartilham o CEP de distribuição **01022-020**; os CEPs cadastrais são 01022-050 (C7) e 06660-390 (Ventura). Atacadum 01012-001 e Smarke 08471-000 têm CEP de distribuição próprio. Dinka (01014-001) e OneDrop/Mirão ainda não têm CEP de distribuição confirmado. A regra de um remetente/coleta do ML fica atendida pelo par C7 + Ventura; confirmar o endereço físico de coleta antes de operar.
- `dados/candidatos_unificados.csv`: 189 SKUs que fecham ≥100% sobre custo; a coluna `viavel_plataforma` é histórica e deve ser recalculada com o critério atual: lucro líquido > 100% do custo.

## Alerta de validação de mercado (26/10/2026)

- Os CSVs `*_candidatos.csv` usam preço = 4,5x custo e **não são preço de mercado**. A validação por busca no ML mostrou que os itens de custo R$ 15–30 do C7 são commodities vendidas por R$ 20–70 (luminária R$ 35–86; alfabeto R$ 22–40; pula pirata R$ 20–28; xadrez R$ 24–67; depilador R$ 18–105). Nesses preços, taxa ML + frete de ~R$ 38 consomem o lucro.
- No OneDrop, itens genéricos também falham: smartwatch R$ 24–76, microfone lapela R$ 55–70, máquina de tosa commodity R$ 63. Só versões premium/marcas com preço de mercado ≥ R$ 110–120 fecham a meta.
- Conclusão atual: **não usar a API do Mercado Livre como catálogo pronto**. A operação parte dos produtos baratos dos fornecedores; usa o **preço real de mercado** e exige lucro líquido acima de 100% do custo depois de todas as taxas, frete, embalagem e impostos; depois validar demanda de 2–3 vendas/mês. Não há piso fixo de múltiplo.
- Amostra em `dados/validacao_mercado.csv`. Shortlists `dados/shortlist_c7.csv` e `dados/shortlist_onedrop.csv` são pré-validação e não devem ser publicadas sem checar preço/concorrência no ML.


## Diretriz atual (27/10/2026)

- Meta: lista grande de produtos **em tendência**, com **poucos fornecedores** e **margem alta real**.
- Critério: volume de venda do produto/similares + lucro sobre custo ≥ 100% após taxa ML, frete, imposto e embalagem, usando **preço médio praticado no mercado** (similar ou superior), não preço projetado 4,5x.
- Faixas de custo e venda são **fluidas**; não cortar artificialmente em R$ 15–30.
- Minerar demanda por categorias/best-sellers do ML, palavras-chave e concorrência; validar preço real antes de publicar.
- Priorizar produtos leves, baixo índice de devolução, estoque Brasil e fornecedor com NF-e.
- Anúncios: fotos reais, título SEO, ficha técnica completa, descrição com benefícios/diferenciais e monitoramento de qualidade.
- Automação: importar catálogo, ajustar preço/estoque e publicar via API; garantir estoque antes de anunciar.

## Funil de mercado (27/10/2026)

- `dados/catalogo_unificado.csv`: 742 SKUs em estoque (C7 243, OneDrop 392, Smarke 34, Mirão 73), todas as faixas.
- `dados/produtos_avaliados.csv`: 742 avaliados; 378 com oferta real no ML.
- `dados/produtos_ideais.csv`: 10 SKUs de alta confiança (confiança ≥ 0,80) com margem ≥ 100% ao preço real.
- `dados/produtos_shortlist.csv`: 30 SKUs para validação manual.
- Gargalo: catálogo em estoque pequeno para chegar a centenas; ampliar fornecedores/estoque ou incluir itens sob consulta.
- Token ML expira em ~6h; renovar chamando um endpoint do backend que use `mlFetch` (ex.: `/api/products`), que atualiza `ml_accounts` no Postgres remoto.
- Cores da plataforma alinhadas ao Mercado Livre: azul `#3483FA`, azul escuro `#2968C8`, amarelo `#FFE600`, amarelo escuro `#F2C200`, ink `#2D3277`, fundo `#EBEBEB`.

## Orquestração

- Plano de lotes, publicação pausada e preço dinâmico em `PLANO_BESTSELLERS.md`.
- `POST /api/listings/sync-prices`: recalcula preço por custo/mercado; `dry_run` padrão.
- `POST /api/listings/publicar-lote`: ativa anúncios pausados em lote.
- Novos anúncios usam `status: paused` por padrão; `status: active` só quando o CNPJ/CNAEs estiverem prontos.


## Dados operacionais importados

- `supplier_products`: 2.211 SKUs importados (C7 1.432, OneDrop 392, Dinka 239, Mirão 73, Smarke 34, Ventura 41); 1.091 ativos com estoque.
- Cada linha guarda custo, estoque, peso, tara, categoria, URL, preço mediano de mercado, ofertas, vendedores, confiança do match e IDs de catálogo.
- `suppliers`: endereço/CEP cadastral/CEP de distribuição/CNPJ/prazo/custo de embalagem quando conhecidos. A prontidão usa `cep_distribuicao`; o `cep` cadastral não entra na regra de remetente único.
- Importação de 28/10/2026: `carga_em_massa_todos_fornecedores_mercado_livre.csv` (1.644 linhas). Custo C7 exato por título em `dados/c7drop.csv` (999 casos); nos demais, custo = `PRICE * 0,88 - 35`. 1.432 inseridos/atualizados, 175 custos C7 atualizados, 1.120 SKUs C7 ficaram sem estoque e não entram na operação.
- `scripts/importar-catalogo-avaliado.mjs`: importa `dados/produtos_avaliados.csv` para o Postgres usando `DATABASE_URL`.

## Controle de preços e alertas

- `price_alerts` registra alterações de custo do fornecedor e de preço de venda.
- Triggers no Postgres gravam custo anterior/novo e preço anterior/novo, margem anterior/nova e lucro anterior/novo.
- `GET /api/suppliers/prontidao` mede volume viável pelo **preço real de mercado** com lucro líquido acima de 100% do custo (sem piso fixo de múltiplo), mais a faixa de alto giro (0,8x a 1x do custo com match confiável ou validação manual), o potencial sem preço de mercado, candidatos por custo, SKUs confiáveis, grupos de CEP e pendências operacionais.
- Estado de 2026-10-28 (após enriquecer custos reais C7 DROPSHIPPING e Ventura): **1.473 produtos C7 + Ventura**, 352 ativos com estoque, 150 com preço de mercado confiável, **7 acima de 100%**, **1 na faixa de 0,8x a 1x**, 145 sem preço de mercado e **153 no pool**. O Catálogo agora mostra **somente C7 + Ventura**, no CEP de distribuição 01022-020, com filtro padrão de **lucro líquido >= 0,8x o custo**; o restante fica em auditoria. `atende_volume=false` e `atende_volume_confirmado=false` porque o pool confirmado é 8. A demanda de 2–3 vendas/mês precisa ser validada.
- Faixa 0,8x–1x: não é mais uma exceção de 4 SKUs; ela usa o pool de centenas de candidatos sem preço de mercado. O catálogo importado pode ser precificado para essa faixa, mas a demanda e o preço competitivo ainda precisam ser checados antes de anunciar.
- Enriquecimento de mercado bloqueado em 28/10/2026: o refresh token do ML retorna `invalid client_id or client_secret`; é preciso reconectar a conta via OAuth para renovar o token e retomar os lotes.
- `GET /api/listings/alertas?limite=30` retorna os alertas com nome do fornecedor.
- `POST /api/listings/alertas/lidas` marca alertas como lidos.
- `POST /api/listings/sync-prices` recalcula preço e, quando aplicado, dispara o alerta de venda.
- A tela de Catálogo mostra faixa de custo, venda, lucro, margem, estoque, fornecedor, CEP de distribuição, composição do preço e detalhes completos.
- A tela de Anúncios permite simular e aplicar reajuste em lote, com tabela de preço atual, novo preço, margem e lucro.

## URLs

- Frontend de produção: `https://melimax-two.vercel.app`.
- Backend de produção: `https://melimax-backend.vercel.app/api`.
- `melimax.vercel.app` não é este projeto.
