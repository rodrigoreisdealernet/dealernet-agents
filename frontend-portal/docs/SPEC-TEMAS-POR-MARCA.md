# Spec — Temas de cor configuráveis por Marca

Objetivo: o portal deixa de ter cores hardcoded. O ADMIN configura, por marca, temas
de cor (com SELETOR DE COR) na tela Cadastro de Tema; o USUÁRIO FINAL escolhe entre os
temas da MARCA da empresa logada. A cor pinta o portal inteiro (accent + chrome).

Decisões fechadas (2026-06-15):
- 1 campo de cor (primária) na TRN; o chrome (sidebar/topbar) DERIVA dela (escurecida).
- Só ADMIN configura (no CadastroTema). Usuário final só ESCOLHE.
- A cor padrão segue a MARCA da empresa logada; usuário pode trocar (override local).

Divisão: BACKEND + CadastroTema = chat DHI. CONSUMO no portal = chat PortalDMS.

## STATUS (2026-06-16) — IMPLEMENTADO ✅
- ✅ TRN Tema com `Tema_CorPrimaria` (hex) + seed das cores por marca (GM #0072CE, FIAT #C8102E…).
- ✅ API `GET /tema/list` filtra por Marca (envelope lean; Content traz CorPrimaria/MarcaCodigo).
- ✅ CadastroTema (DHI Front) com ColorPicker (admin grava a cor).
- ✅ Consumo no portal: `getTemas(marcaCod)` + `use-theme` (`applyHex` pinta --primary E --chrome).
- ✅ Cor padrão pela marca da empresa logada (`aplicarHexMarcaSeSemOverride`); override do usuário persiste.
- ✅ Seletor TopBar 🎨: se há temas da marca → mostra SÓ eles (label "Temas <SIGLA>"); senão → paleta fixa.
- ✅ Chip da marca no EmpresaSelector; passo do tour atualizado ("Tema por marca").
- ⏳ PENDENTE: tabelas com MUITOS temas dependem do filtro por marca correto na empresa logada
  (empresa FIAT só vê temas FIAT — by design). Sem itens em aberto críticos.

---

## 1. BACKEND (chat DHI / KB DealernetHubIntegration)

### 1.1 ALTER na TRN Tema — +1 atributo
Adicionar à TRN `Tema` (que já tem Tema_Codigo, Marca_Codigo, Tema_Descricao,
Tema_Posicaomenu, Tema_Ativo):

    Tema_CorPrimaria  Character(7)   -- hex "#RRGGBB" (ex.: "#C8102E")

- Import headless UPDATE da TRN (campo virtual NÃO; é coluna nova → reorg ADD COLUMN,
  não destrutivo). Ver receita [[import-headless-marca-tema-depara-bc-varchar]].
- Tema_Descricao passa a ser o NOME AMIGÁVEL do tema ("FIAT Vermelho", "GM Azul").
- Migrar dados legados: os 5 registros atuais (gray/blue/purple/volks) ganham um hex
  coerente (ex.: FIAT→#C8102E, GM→#0072CE, VOLKS→#001E50, RENAULT→#FFCC33). Definir com
  o cliente as cores oficiais; deixar Tema_CorPrimaria preenchido nos ativos.

### 1.2 API — listar temas POR MARCA
Rota nova (BFF lean, padrão Dealernet): `GET /tema/list?Marca=<Marca_Codigo>`
- Filtra Tema_Ativo=true AND Marca_Codigo=&Marca, ordena por Tema_Posicaomenu.
- Content (JSON): `[{ "Codigo":2, "Descricao":"FIAT Roxo", "CorPrimaria":"#7C3AED",
  "PosicaoMenu":1 }]`
- O List BFF do Tema já existe (rota 'tema'); ESTENDER o SDT_Filtro p/ aceitar Campo=Marca
  (filtro server-side por Marca_Codigo), além do Ativo atual.

### 1.3 Marca da empresa logada (já existe no contexto)
- Empresa tem `Empresa_MarcaCod` / `Empresa_MarcaSgl` (a marca principal).
- A config/identity do portal JÁ devolve a marca da empresa ativa (empresaMarcaSgl).
- O portal passará Empresa_MarcaCod ao /tema/list. Se preferir, a API pode derivar a
  marca do próprio WWPContext (empresa ativa) e ignorar o parâmetro — DECIDIR.

### 1.4 CadastroTema — seletor de cor (DHI Front)
- Tipo `Tema` (src/types/index.ts): adicionar `corPrimaria: string`.
- portalApiReal (DHI front): mapear Tema_CorPrimaria ↔ corPrimaria no to/fromApi da rota 'tema'.
- Tela CadastroTema: adicionar campo "Cor" usando o componente <ColorPicker> (ver §3).
  Combo de Marca já deve existir (Marca_Codigo é FK). Mostrar swatch da cor na lista.

---

## 2. CONSUMO no portal (chat PortalDMS)

### 2.1 API client
- portalApiReal (PortalDMS): novo método `getTemas(marcaCod): Promise<TemaPortal[]>`
  → GET /tema/list?Marca=<cod>. TemaPortal = { codigo, descricao, corPrimaria, posicao }.
- Fallback: se a API falhar/sem temas, usar os ACCENTS fixos atuais (use-theme) — não quebra.

### 2.2 use-theme (PortalDMS) — aceitar tema dinâmico
- applyAccent já aceita um hue/croma. Generalizar p/ aceitar um HEX direto:
  - derivar --primary do hex; --chrome = versão escurecida do mesmo hex (oklch L menor).
- Guardar a escolha do usuário (localStorage) com PRIORIDADE sobre a cor da marca.
- Ao logar / trocar empresa: buscar getTemas(Empresa_MarcaCod) e:
  - se usuário não tem override → aplicar o tema PADRÃO da marca (1º ativo / Posicaomenu).
  - popular o seletor de tema (TopBar/Login) com os temas da marca.

### 2.3 Seletor de tema (TopBar + Login)
- Hoje o seletor mostra ACCENTS fixos. Passar a mostrar os TEMAS da marca (vindos da API),
  cada um com swatch = Tema_CorPrimaria e label = Tema_Descricao.
- Manter os accents fixos como "Temas do sistema" se a marca não tiver temas próprios.

---

## 3. Componente compartilhado — <ColorPicker>
Reutilizável por CadastroTema (admin) E pela aba Cor da Equipe.
- `<input type="color">` nativo + campo texto hex sincronizado (aceita digitar #RRGGBB
  ou escolher na paleta). Validar hex. Mostrar swatch.
- Criar no acervo do PortalDMS (src/portal/components/forms/ColorPicker.tsx) e copiar p/
  o DHI Front (acervos paralelos). Props: value, onChange, label.

---

## 4. Ordem de execução
1. (DHI) ALTER Tema +Tema_CorPrimaria + migrar cores dos 5 registros + build/import.
2. (DHI) API /tema/list?Marca= (estender filtro do List existente).
3. (compartilhado) ColorPicker.
4. (DHI) CadastroTema com ColorPicker + tipo/mapeamento corPrimaria.
5. (PortalDMS) getTemas + use-theme dinâmico + seletor de tema por marca.
6. Testar: logar empresa FIAT → portal mostra temas FIAT → escolher → portal repinta.

## 5. Estado atual (já pronto)
- TRN Tema + Marca importadas; CadastroTema e CadastroMarca existem no DHI Front.
- use-theme (PortalDMS) já pinta accent + chrome e tem MARCA_ACCENT hardcoded (será
  SUBSTITUÍDO pela API). 10 cores fixas servem de fallback.
- Empresa→Marca: Empresa_MarcaCod / Empresa_MarcaSgl disponíveis no contexto.
