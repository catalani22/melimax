# Plano de Best-Sellers, Publicação Pausada e Preço Dinâmico

## Objetivo

Ter uma lista grande de produtos em tendência, com poucos fornecedores, margem real acima de 100% sobre o custo e tudo pronto na Melimax para publicar assim que CNPJ/CNAEs forem regularizados. Os anúncios podem ser criados agora como `paused` e ativados em lote depois.

## Estratégia de lotes

- Base atual: 4.750 posições de best-sellers do ML em 246 categorias.
- Processar em lotes de **10 categorias por vez** (até 200 produtos), nunca a base inteira.
- Meta por lote: 200 minerados, 50 validados, 30 precificados e 10–20 anúncios pausados.
- Cadência: 1 lote por dia útil; 10–15 minutos de uso de API/CLI por lote.
- Prioridade: categorias com maior aderência ao catálogo C7/OneDrop/Atacadum e menor concorrência.
- Só avançar para o próximo lote depois de fechar o anterior (mineração → match → preço → pausado → QA).

## Pipeline por lote

1. **Mineração**: buscar best-sellers da categoria, concorrência, preço mínimo/mediano/máximo, vendedores e frete grátis.
2. **Match**: casar best-seller com SKU de fornecedor por GTIN, marca/modelo e similaridade de título; exigir confiança ≥ 0,80 para publicar.
3. **Precificação**: calcular preço-alvo, piso e teto com custo atual, taxa ML, imposto, frete e embalagem.
4. **Staging**: gravar produto, custo, mercado, preço-alvo, margem e status `draft`.
5. **Anúncio pausado**: criar item no ML com `status: paused`, fotos reais, título SEO e ficha completa.
6. **QA**: validar score ≥ 85, estoque, peso, categoria, GTIN e descrição.
7. **Publicação**: quando CNPJ/CNAEs estiverem prontos, ativar em lote.
8. **Preço dinâmico**: sincronizar custo do fornecedor e mercado, atualizando somente o que preserva a margem.

## Regras de preço

- Lucro líquido sobre o custo acima de 100% (ideal 150–200%).
- Teto competitivo: mediana de mercado × 1,05.
- Piso: preço que ainda entrega lucro líquido acima de 100% do custo.
- Arredondar para cima em reais.
- Não atualizar se a variação for menor que 1%.
- Anúncios `paused` podem ser atualizados livremente; anúncios ativos exigem aprovação.

## Endpoints da Melimax

- `POST /api/listings/sync-prices`
  - `{ "dry_run": true, "status": "paused", "max_batch": 20, "margem": 0.5 }`
  - Calcula e, se `dry_run: false`, atualiza preço no ML e no banco.
- `POST /api/listings/publicar-lote`
  - `{ "ids": ["123", "MLB..."], "max_batch": 20 }`
  - Ativa anúncios pausados em lote.
- `POST /api/listings/pausar-todos` e `POST /api/listings/reativar-todos` já existem.
- `POST /api/listings` aceita `status: "paused"` e usa `paused` como padrão.
- `GET /api/trends/radar` e `GET /api/trends/palavras` alimentam a mineração.

## Dados e status

- `supplier_products`: custo, estoque, peso e vínculo com catálogo/GTIN.
- `listings`: anúncio, preço, margem, status, `catalogo_id`, `listing_type_id`, `price_floor`, `price_ceiling`, `last_price_sync_at`.
- `trend_product_snapshots`: demanda, preço, concorrência e posição.
- Status do funil: `draft` → `paused` → `active` → `closed`.

## Critérios para publicar

- Fornecedor com estoque no Brasil e NF-e.
- Custo atualizado há menos de 24h.
- Lucro líquido > 100% sobre o custo.
- Preço dentro do teto de mercado.
- Fotos reais, título ≤ 60 caracteres, ficha técnica completa e descrição > 100 caracteres.
- Score de qualidade ≥ 85.

## Rotina diária

1. Rodar 1 lote de mineração (10 categorias).
2. Validar 20–50 produtos.
3. Criar 10–20 anúncios pausados.
4. Rodar `sync-prices` em modo `dry_run` e revisar.
5. Aplicar atualizações somente no que preserva margem.
6. Registrar contagem de minerados, aprovados, pausados e erros.

## Métricas

- Produtos minerados por lote.
- Taxa de match confiável.
- Margem média sobre custo e líquida.
- Anúncios pausados prontos.
- Erros de API e tempo por lote.
- Variação de preço de fornecedor e mercado.
