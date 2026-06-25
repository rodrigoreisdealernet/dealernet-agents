# Spec: Portal/CRUDs — Ações como Botões, Tela Cheia e Correções em Empresa/Marca

## Overview

Ajuste visual e correção de dois bugs funcionais descobertos ao sincronizar as telas novas de CRUDs de concessionária (Empresas, Marcas, Veículos). O change cobre: (1) padronizar ações de linha como botões reais; (2) corrigir validação que impede editar empresas legadas; (3) associar Marca à Empresa; (4) restaurar visibilidade de Marcas na listagem; (5) abrir telas de CRUD maximizadas por padrão.

## Problema / Contexto

Após sincronizar as telas dos CRUDs da concessionária contra o Supabase local (schema com migrations de 2026-06-25), surgiram ajustes de UX/layout e dois bugs de backend confirmados por reprodução:

1. **Ações de tabela como links**: As colunas "Editar" e "Remover/Inativar" nas tabelas são links sublinhados (`text-xs font-medium text-primary hover:underline`), não botões — inconsistente com a linguagem visual e acessibilidade.

2. **Não salva Empresa existente**: Editar uma empresa falha com `company.legal_name is required`, porque as empresas seed têm `name` (domínio rental antigo) mas não `legal_name`. Ao carregar para edição, a view retorna `legal_name = NULL`, então o merge e a validação falham mesmo enviando o valor completo da tela.

3. **Falta vinculação Marca–Empresa**: `CompanyInput` não tem campo de marca, a view não expõe marca, e o form não permite seleção. Necessário para tema por marca (`SPEC-TEMAS-POR-MARCA.md`).

4. **Marca desaparece após criação**: Criar marca não gera erro (a RPC `create_brand` funciona e insere no banco), mas `v_dia_brand_current` retorna 0 linhas — provável que `'brand'` não esteja no catálogo `rental_entity_type_catalog`, assim como ocorreu com `'vehicle'` na migration anterior.

5. **Telas abrem flutuantes**: As telas de CRUD abrem como janelas MDI flutuantes (`maximized: false`), não ocupando a área de trabalho — menos conveniente para preencher formulários longos.

## Critérios de Aceite

- [ ] **Ações como botões**: As colunas de ação (Editar, Remover/Inativar) nas tabelas de Veículos, Empresas, Marcas, Peças, Ordens de Serviço e Usuários exibem-se como botões com ícone + rótulo (não links sublinhados), acessíveis por teclado.

- [ ] **Editar Empresa sem erro**: Ao selecionar uma empresa existente (inclusive as seed) para editar e alterar qualquer campo, a alteração salva sem erro `company.legal_name is required`.

- [ ] **Associar Marca em Empresa**: O formulário de Empresa exibe um **ComboField** para selecionar Marca (vinculação FK); a seleção persiste e a marca aparece na coluna de listagem.

- [ ] **Marca aparece após criação**: Após criar uma nova marca, ela aparece imediatamente na listagem de Marcas; a view `v_dia_brand_current` retorna 1 linha (ou mais, se outras marcas existem).

- [ ] **Telas abrem maximizadas**: Ao abrir uma tela de CRUD pelo menu (Empresas, Marcas, Veículos, etc.), ela ocupa a área de trabalho (estado `maximized: true`) por padrão, não como janela flutuante.

- [ ] **Consistência de UX**: As mudanças aplicam-se **uniformemente** em todos os CRUDs (Veículos, Empresas, Marcas, Peças, Ordens, Usuários), com aparência e comportamento idênticos.

## Não é Escopo

- Redesenho de formulários ou criação de novos campos além de Marca em Empresa.
- Mudança de arquitetura MDI ou sistema de janelas.
- Persistência de preferência de tamanho de janela (fullscreen vs. floating).
- Importação de dados legacy ou migração de `name` → `legal_name` em batch (tratamento isolado na validação).

## Out-of-Scope

- Telas de Peças, Ordens de Serviço e Usuários: A mudança de ações para botões **deve ser aplicada**, mas não é novo recurso; é alinhamento de UX.
- Cache de lista de Marcas: Se a lista for grande, discussão de paginação ou otimização é futura.
- Tema dinâmico por marca: Já documentado em `SPEC-TEMAS-POR-MARCA.md`; esta spec apenas garante que Marca pode ser selecionada/armazenada.

---

**STATUS: DRAFT — Aguardando aprovação antes de qualquer escrita de código.**
