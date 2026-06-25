# Auditoria dos 9 CRUDs lean — gaps vs TRN real (2026-06-11)

Comparação do que cada CRUD lean trouxe vs a TRN real da KB DHI. Excluída a auditoria
(UsuCod*/UsuNom*/Data*Criacao/Alteracao — corretamente omitida do CRUD).

Legenda: 🟦 domínio enum (tratar badge/combo) · ➕ campo faltante · 🔗 FK/relação

---

## 1. PerfilAcesso
**🟦 Domínios:** `Tipo` (TipoPerfilAcesso) — JÁ no CRUD, mas hoje mostra cru "NAO". **`PermiteSMS` (SimNao)** — faltando.
**➕ Campos faltantes:** PermiteSMS(SimNao), DiasPrevisaoEntrega(num), DiasLimiteCredito(num).
**🔗 FK:** PerfilAcessoCodSuperior → autorreferência (perfil pai) + DesSuperior(display).

## 2. Empresa  ⚠️ só 5 de ~26 campos
**🟦 Domínios faltando:** RegimeTributaria, Segmento(SegmentoEmpresa), CentroDistribuicao(Flag), DealerNet(Flag), CNAECodPrincipal.
**➕ Campos faltantes relevantes:** NomeFantasia(já tem), RegimeTributaria, Segmento, MoedaCod, URLImagem, CentroDistribuicao, DealerNet.
**🔗 FKs:** GrupoEmpresa_Codigo (grupo), EmpresaCodMatriz (matriz, autoref), PessoaCod, Identificador_Codigo (tipo doc), MarcaCod, Pais_Codigo, MoedaCod — todas N:1 com display.

## 3. GrupoEmpresa  ⚠️ só 3 de ~14 campos
**🟦 Domínios faltando:** MetodoAutenticacao, DealerNet(Flag), ValidaGrupoFinanceiro(Flag).
**➕ Campos faltantes:** LinguagemCod(idioma), MetodoAutenticacao, ValidaGrupoFinanceiro, GoogleAnalytics, GoogleAds, ReCaptchaSiteKey, ReCaptchaSecretKey, DataAtuCadBasico, DataVersao.
**🔗 FK:** nenhuma (entidade raiz).

## 4. Departamento  🔗 relação N:N não trazida
**🟦 Domínios:** todos OK (Codigo/Descricao/Ativo).
**➕ Campos:** nível raiz completo.
**🔗 RELAÇÃO:** subnível **Empresa (N:N)** — DepartamentoEmp_EmpCod. O CRUD não traz a associação Departamento↔Empresas.

## 5. Equipe  ➕ campos + 🔗 N:N
**🟦 Domínios faltando:** Cor(DomIdentificador), AtivoAgendamento(Ativo).
**➕ Campos faltantes:** HorarioTrabalho_Codigo(FK+desc), Cor, AtivoAgendamento.
**🔗 RELAÇÃO:** subnível **Empresa (N:N)** com config por empresa (QtdeAgendamento, LimiteAlocacao, etc.).

## 6. Usuario  ➕ Pessoa + displays
**🟦 Domínios:** TipoAcesso(DomUsuarioTipoAcesso) JÁ tratado (badge ✅), Administrador/AutenticaLocal(Flag) OK.
**➕ Campos faltantes:** PessoaCod/PessoaNom/PessoaDoc (vínculo Pessoa), EmpresaNomDefault(display).
**🔗 FKs:** EmpresaCodDefault, Equipe, Cargo, SetorServico (já tem cod; faltam os displays *_Descricao p/ combo mostrar nome), PessoaCod.

## 7. SetorServico  🟦 1 domínio a mais
**🟦 Domínio faltando:** **`Tipo` (TipoSetorServico)** — existe na TRN, não veio no CRUD.
**➕ Campos:** adicionar Tipo.

## 8. Cargo  ✅ completo
Codigo/Descricao/Ativo = tudo que a TRN tem. OK.

## 9. SolucaoDMS  ✅ completo
7 campos, todos no CRUD. TipoProduto(PacoteProduto) já tratado. OK.

---

## Priorização sugerida
**Fase A — Domínios (rápido, alto impacto visual):** tratar como badge/combo em TODAS as telas:
PerfilAcesso.Tipo, SetorServico.Tipo (+add campo), Empresa.RegimeTributaria/Segmento,
GrupoEmpresa.MetodoAutenticacao, flags (DealerNet/ValidaGrupoFinanceiro/PermiteSMS/CentroDistribuicao).

**Fase B — Campos faltantes simples (sem FK):** Equipe(Cor/AtivoAgendamento), GrupoEmpresa(integrações),
PerfilAcesso(PermiteSMS/dias), Empresa(campos próprios), Usuario(displays).

**Fase C — FKs/combos:** displays *_Descricao no Usuario (combos já existem), Empresa(GrupoEmpresa/Marca/Pais),
Equipe.HorarioTrabalho.

**Fase D — Relações N:N (maior esforço, tela com sub-grid):** Departamento↔Empresa, Equipe↔Empresa.
