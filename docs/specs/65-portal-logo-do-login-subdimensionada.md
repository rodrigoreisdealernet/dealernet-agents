# Spec #65: Portal — Logo do Login Subdimensionada

## Visão Geral

O logo Dealernet na tela de login está pequeno demais. A cápsula branca que o envolve (`bg-white px-5 py-3`) ocupa visualmente mais espaço que a própria imagem. O objetivo é aumentar o logo para que ele seja o elemento dominante, ocupando toda ou quase toda a área dedicada, preservando o responsividade e a qualidade visual em todos os temas.

## Problema / Contexto

Na tela de login do Portal DMS (`Login.tsx` ~L44-53), o logo está renderizado dentro de uma cápsula branca com padding (`px-5 py-3`). O elemento `<img>` tem altura `h-14` (~56px), resultando numa proporção visual desproporcional: o fundo branco domina, em vez da marca.

- **Arquivo atual:** `frontend-portal/public/Dealernet_Logo35anos.png` (243×88px, PNG RGBA)
- **Container atual:** `<div className="...rounded-2xl bg-white px-5 py-3 shadow-md ring-1 ring-black/5">` 
- **Imagem atual:** `<img className="h-14 w-auto" />`

O resultado é um bloco branco grande com um logo minúsculo no centro.

## Critérios de Aceitação

1. **[ ] Logo ocupa a maior parte da área:** O logo está visível e ocupa toda ou a maior parte do espaço da cápsula; o fundo branco não aparece como elemento visual dominante (no máximo uma margem mínima é aceitável).

2. **[ ] Sem distorção:** O logo mantém seu aspect ratio (243:88 = ~2.76:1) e é exibido sem esticamento ou achatamento em qualquer resolução.

3. **[ ] Responsivo:** O layout do card de login não quebra ou desalinha em dispositivos mobile (< 480px), tablet (480px–1024px) ou desktop (> 1024px). O logo escala proporcionalmente.

4. **[ ] Contraste e clareza:** O logo permanece legível e bem contrastado tanto no tema claro (`bg-white`) quanto no tema escuro (fundo da cápsula se adapta ou o logo é visível).

5. **[ ] Sem regressão:** Não há mudança indesejada no restante do formulário de login (campos, botões, espaçamentos). A animação de entrada (motion.div, spring) continua funcionando.

6. **[ ] Sem rebranding:** O arquivo PNG não é substituído; apenas o dimensionamento e layout (classes CSS ou propriedades de img) são ajustados.

## Não-Objetivos

- Trocar ou otimizar o arquivo de imagem da logo.
- Alterar a logo da Sidebar (`/dia-logo.svg`).
- Modificar fluxo de autenticação, i18n ou seletor de tema.

## Fora de Escopo

- Mudanças no card de login além do bloco da logo.
- Alterações em outras telas do Portal (ex: Dashboard, páginas autenticadas).

---

**Status: RASCUNHO** — Aprovação manual necessária antes de implementação.
