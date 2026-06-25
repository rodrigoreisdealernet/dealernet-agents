<#
.SYNOPSIS
  Smoke test ponta a ponta da Bridge SSO do Portal DMS.

.DESCRIPTION
  1) Login na DHI (cookie de sessao).
  2) GET /api/v1/portal/bridge/abrir?tela=<X>&engine=<EV2|GX18> -> espera autenticado + token + url.
  3) Valida o formato da url por engine (/DealerNetWF/ vs /DealernetWFNetCore/).
  4) (opcional) confere no banco que a TRN Sessao recebeu o token (Sessao_GUID).

  Rodar APOS importar o pacote PortalBridgeEV2_..._03 e dar Build/publish na DHI.

.EXAMPLE
  pwsh ./scripts/Test-PortalBridge.ps1 -Usuario DEALERNET -Senha 'Dea2@14.' -Tela wwferiado.aspx
#>
param(
  [string]$BaseUrl  = 'http://localhost:8082/DealernetHubIntegrationNETCoreSQL/api/v1/portal',
  [string]$Usuario  = 'DEALERNET',
  [string]$Senha    = 'Dea2@14.',
  [string]$Tela     = 'wwferiado.aspx',
  [ValidateSet('EV2','GX18')][string]$Engine = 'EV2',
  [string]$SqlServer = 'DN-8V2Y194\SQL2022',
  [string]$SqlDb     = 'Dealernetworkflow',
  [switch]$CheckDb
)

$ErrorActionPreference = 'Stop'
function ok($m){ Write-Host "  [OK]  $m" -ForegroundColor Green }
function fail($m){ Write-Host "  [X]   $m" -ForegroundColor Red }
function info($m){ Write-Host $m -ForegroundColor Cyan }

$sess = New-Object Microsoft.PowerShell.Commands.WebRequestSession
$falhas = 0

info "== 1) LOGIN =="
$body = @{ Usuario_Identificador=$Usuario; UsuarioSenha_Senha=$Senha; Empresa_Codigo=0 } | ConvertTo-Json
try {
  $r = Invoke-WebRequest "$BaseUrl/identity/auth" -Method POST -Body $body -ContentType 'application/json' -WebSession $sess -UseBasicParsing -TimeoutSec 20
  $j = $r.Content | ConvertFrom-Json
  if ($j.autenticado) { ok "login autenticado=$($j.autenticado)" } else { fail "login NAO autenticado: $($j.mensagem)"; $falhas++ }
} catch { fail "login HTTP $($_.Exception.Message)"; exit 1 }

info "== 2) BRIDGE /abrir (tela=$Tela engine=$Engine) =="
try {
  $u = "$BaseUrl/bridge/abrir?tela=$([uri]::EscapeDataString($Tela))&engine=$Engine"
  $r = Invoke-WebRequest $u -WebSession $sess -UseBasicParsing -TimeoutSec 30
  $b = $r.Content | ConvertFrom-Json
  if ($b.autenticado) { ok "autenticado=true" } else { fail "autenticado=false: $($b.mensagem)"; $falhas++ }
  if ($b.token -and $b.token.Length -ge 32) { ok "token recebido: $($b.token)" } else { fail "token ausente/curto: '$($b.token)'"; $falhas++ }
  $base = if ($Engine -eq 'GX18') { '/DealernetWFNetCore/bridge.aspx' } else { '/DealerNetWF/bridge.aspx' }
  if ($b.url -like "$base*token=*tela=*") { ok "url ok: $($b.url)" } else { fail "url inesperada p/ ${Engine}: $($b.url)"; $falhas++ }
  $script:token = $b.token
} catch {
  $code = $_.Exception.Response.StatusCode.value__
  if ($code -eq 404) { fail "endpoint /bridge/abrir = 404 -> pacote ainda NAO importado/publicado na DHI" }
  else { fail "bridge HTTP $code" }
  $falhas++
}

if ($CheckDb -and $script:token) {
  info "== 3) BANCO: a Sessao foi gravada? =="
  try {
    $out = & sqlcmd -S $SqlServer -E -d $SqlDb -h -1 -W -Q "SET NOCOUNT ON; SELECT COUNT(*) FROM Sessao WHERE Sessao_GUID='$($script:token)';" 2>&1
    if ("$out".Trim() -eq '1') { ok "Sessao gravada (GUID=$($script:token))" } else { fail "Sessao NAO encontrada p/ o token"; $falhas++ }
  } catch { fail "erro ao consultar banco: $($_.Exception.Message)"; $falhas++ }
}

Write-Host ""
if ($falhas -eq 0) { Write-Host "RESULTADO: PASS (bridge ponta a ponta OK)" -ForegroundColor Green; exit 0 }
else { Write-Host "RESULTADO: FAIL ($falhas verificacao(oes))" -ForegroundColor Red; exit 1 }
