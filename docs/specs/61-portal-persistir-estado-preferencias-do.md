# Especificação: Portal - Persistir estado/preferências do app por usuário

## Visão geral

Implementar um contêiner de preferências **namespaceado por usuário** no Portal DMS que persista em localStorage, garantindo que cada usuário logado tenha suas próprias configurações de **tema (modo light/dark + cor)** e **idioma**, isolando-as de outros usuários no mesmo navegador. Refatorar o hook `useTheme` para usar este contêiner mantendo sua API pública inalterada.

## Problema / Contexto

A persistência atual está espalhada em chaves globais, sem namespace de usuário:

- **Tema:** `src/hooks/use-theme.ts` grava `dealernet-portal-theme` (modo), `dealernet-portal-accent` (cor) e `dealernet-portal-themehex` (override hex) — todas globais.
- **MDI:** `src/portal/store/portalStore.ts` persiste em `dealernet-portal-mdi` — global.
- **Identidade:** o usuário logado está em `localStorage` chave `dealernet-portal-auth` (`{ usuario, nome }`).

**Problema:** ao trocar de usuário no mesmo navegador, as preferências se sobrescrevem, vazando dados entre contas.

## Critérios de aceite

- [ ] **AC1 — Per-usuário:** as preferências de tema (modo, accent, hex) persistem por usuário. Ao deslogar e logar novamente com **o mesmo usuário**, o tema escolhido é restaurado no mesmo navegador.
- [ ] **AC2 — Isolamento:** usuários diferentes no mesmo navegador têm preferências completamente isoladas. As escolhas do usuário A não afetam nem sobrescrevem as do usuário B.
- [ ] **AC3 — API compatível:** a assinatura pública de `useTheme` permanece idêntica (`theme`, `setTheme`, `toggleTheme`, `accent`, `setAccent`, `hex`, `setHex`, `aplicarMarcaSeSemOverride`, `aplicarHexMarcaSeSemOverride`). Consumidores como `TopBar.tsx`, `PortalShell` continuam funcionando sem mudança de chamada.
- [ ] **AC4 — Migração legada:** dados já gravados nas chaves globais antigas (`dealernet-portal-theme`, `-accent`, `-themehex`) são automaticamente migrados para o namespace do usuário na primeira leitura, sem perda da preferência atual.
- [ ] **AC5 — Resiliência:** se `localStorage` lançar exceção (cota excedida, indisponível) ou contiver JSON inválido, o portal carrega com defaults e **não** quebra no boot.
- [ ] **AC6 — Campo locale:** o campo `locale` está disponível e persistido na camada de preferências por usuário, pronto para a integração de i18n da issue #58 (sem implementar seletores ou telas aqui).
- [ ] **AC7 — Testes:** builds `npm run build` (`tsc -b`) e checks de lint passam; um novo arquivo `frontend-portal/scripts/verify-user-preferences.mjs` (padrão `node --test`) cobre namespacing por usuário, isolamento entre usuários e migração de chaves legadas, registrado no script `npm test`.

## Não-objetivos / Fora de escopo

- **Não** implementar i18n (telas, mensagens, seletor de idioma) — isso é issue #58; aqui só se garante o contêiner.
- **Não** sincronizar preferências com backend/Supabase — persistência é client-side (localStorage) apenas.
- **Não** alterar backend, migrations, Temporal ou contratos de API.
- **Não** mudar design system, paleta de cores ou stack de UI.
- **Não** migrar estado do MDI (`dealernet-portal-mdi`) para namespace por usuário nesta issue — foco é tema + base para idioma.

## Referências

- `frontend-portal/src/hooks/use-theme.ts` — persistence atual de tema (linhas 46-49: chaves globais `MODE_KEY`, `ACCENT_KEY`, `HEX_KEY`)
- `frontend-portal/src/hooks/use-auth.tsx` — identidade em `dealernet-portal-auth` (linhas 10-15)
- `frontend-portal/src/portal/store/portalStore.ts` — Zustand persist, chave `dealernet-portal-mdi` (linha 22)
- `frontend-portal/src/portal/components/TopBar.tsx` — consumidor do `useTheme` (linha 27)
- Issue #58 — i18n (futuro consumidor do campo `locale`)

---

> **RASCUNHO** — Requer aprovação humana antes de qualquer código ser escrito.
