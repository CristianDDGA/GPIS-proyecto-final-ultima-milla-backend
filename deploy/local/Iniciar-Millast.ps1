<#
  Levanta Millast en local con Docker (base de datos + API + web) y crea el administrador la primera vez.
  Uso (desde esta carpeta):   powershell -ExecutionPolicy Bypass -File .\Iniciar-Millast.ps1
  - Si no existe .env, lo genera con contraseñas y claves aleatorias (no se imprimen).
  - Es seguro repetirlo: reconstruye lo que cambió y no borra datos.
#>
param(
  [string]$AdminEmail = "admin@millast.local",
  [int]$ApiPort = 3000,
  [int]$WebPort = 5173,
  [switch]$SinConstruir
)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function New-Secreto([int]$bytes) {
  $buffer = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($buffer)
  return (($buffer | ForEach-Object { $_.ToString("x2") }) -join "")
}

# 1) Docker listo
docker info *> $null
if ($LASTEXITCODE -ne 0) { throw "Docker no responde. Abre Docker Desktop, espera a que arranque y vuelve a ejecutar este script." }

# 2) Repositorio del frontend (debe estar clonado junto al del backend) y paquete de base de datos
$backend = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$frontend = if ($env:FRONTEND_DIR) { $env:FRONTEND_DIR } else { Join-Path (Split-Path $backend -Parent) "GPIS-proyecto-final-ultima-milla-frontend" }
if (-not (Test-Path (Join-Path $frontend "package.json"))) {
  throw "No encuentro el repositorio del frontend en '$frontend'. Clónalo junto al del backend (misma carpeta padre) o define la variable FRONTEND_DIR con su ruta."
}
$frontend = (Resolve-Path $frontend).Path
$zip = Join-Path $backend ".ci\database-package.zip"
$destino = Join-Path $PSScriptRoot "db-package"
if (-not (Test-Path $zip)) { throw "Falta $zip. ¿Estás en la rama develop actualizada?" }
if (-not (Test-Path (Join-Path $destino "database\init\00-bootstrap.sh")) -or ((Get-Item $zip).LastWriteTimeUtc -gt (Get-Item (Join-Path $destino "database\init\00-bootstrap.sh")).LastWriteTimeUtc)) {
  if (Test-Path $destino) { Remove-Item $destino -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $destino -Force
  Write-Host "Paquete de base de datos extraído (migraciones del repositorio)." -ForegroundColor Green
}

# 3) Archivo .env con secretos (solo la primera vez)
if (-not (Test-Path .env)) {
  $googleId = ""
  $frontEnv = Join-Path $frontend ".env"
  if (Test-Path $frontEnv) {
    $linea = Select-String -Path $frontEnv -Pattern '^VITE_GOOGLE_CLIENT_ID=' | Select-Object -First 1
    if ($linea) { $googleId = $linea.Line.Split('=', 2)[1].Trim() }   # el Client ID de Google es público
  }
  $contenido = @(
    "# Generado por Iniciar-Millast.ps1. NO lo compartas ni lo subas a ningún repositorio.",
    "POSTGRES_PASSWORD=$(New-Secreto 16)",
    "APP_PASSWORD=$(New-Secreto 16)",
    "WORKER_PASSWORD=$(New-Secreto 16)",
    "READONLY_PASSWORD=$(New-Secreto 16)",
    "JWT_SECRET=$(New-Secreto 32)",
    "ADMIN_EMAIL=$AdminEmail",
    "ADMIN_PASSWORD=$(New-Secreto 8)Aa1",
    "FRONTEND_DIR=$($frontend.Replace([string][char]92, "/"))",
    "WEB_DOCKERFILE=$((Join-Path $PSScriptRoot "Dockerfile.web").Replace([string][char]92, "/"))",
    "API_PORT=$ApiPort",
    "WEB_PORT=$WebPort",
    "EMAIL_VERIFICATION_REQUIRED=false",
    "VITE_GOOGLE_CLIENT_ID=$googleId",
    "GOOGLE_CLIENT_ID=$googleId"
  )
  Set-Content -Path .env -Value $contenido -Encoding ascii
  Write-Host "Se creó .env con secretos nuevos." -ForegroundColor Green
}

# 4) Construir y levantar (espera a que todo esté sano)
$args = @("compose", "up", "-d", "--wait")
if (-not $SinConstruir) { $args += "--build" }
docker @args
if ($LASTEXITCODE -ne 0) { throw "No se pudo levantar el sistema. Revisa: docker compose logs" }

# 5) Primer administrador (idempotente: si el correo ya existe, no cambia nada)
$vars = @{}
Get-Content .env | Where-Object { $_ -match '^[A-Z_]+=' } | ForEach-Object { $k, $v = $_.Split('=', 2); $vars[$k] = $v }
docker compose exec -T `
  -e "MIGRATION_DATABASE_URL=postgresql://logistica_admin:$($vars['POSTGRES_PASSWORD'])@db:5432/logistica" `
  -e "ADMIN_EMAIL=$($vars['ADMIN_EMAIL'])" -e "ADMIN_PASSWORD=$($vars['ADMIN_PASSWORD'])" -e "ADMIN_NAME=Administrador" -e "DB_SSL=disable" `
  api node scripts/supabase/create-admin.mjs

Write-Host ""
Write-Host "Millast está corriendo:" -ForegroundColor Green
Write-Host "  Web:  http://localhost:$($vars['WEB_PORT'])"
Write-Host "  API:  http://localhost:$($vars['API_PORT'])/health"
Write-Host "  Administrador: $($vars['ADMIN_EMAIL'])   (la contraseña está en el archivo .env, clave ADMIN_PASSWORD)"
Write-Host ""
Write-Host "Se reinicia solo si Docker arranca de nuevo. Para que Docker arranque al encender la PC, activa en Docker Desktop:" -ForegroundColor Yellow
Write-Host "  Settings > General > 'Start Docker Desktop when you sign in to your computer'"
