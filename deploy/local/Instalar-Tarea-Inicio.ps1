<#
  OPCIONAL. Crea una tarea programada que, cada vez que INICIAS SESIÓN en Windows, espera a que Docker esté listo y
  ejecuta "docker compose up -d" (por si algún contenedor quedó detenido). Complementa a "restart: unless-stopped".
  Uso (PowerShell como tu usuario):   .\Instalar-Tarea-Inicio.ps1        Para quitarla: .\Instalar-Tarea-Inicio.ps1 -Quitar
#>
param([switch]$Quitar)
$nombre = "Millast - iniciar sistema local"
if ($Quitar) { Unregister-ScheduledTask -TaskName $nombre -Confirm:$false -ErrorAction SilentlyContinue; Write-Host "Tarea quitada."; return }

$carpeta = $PSScriptRoot
$comando = "-NoProfile -WindowStyle Hidden -Command `"for(`$i=0;`$i -lt 60;`$i++){ docker info *> `$null; if(`$LASTEXITCODE -eq 0){ break }; Start-Sleep 5 }; Set-Location '$carpeta'; docker compose up -d`""
$accion = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $comando
$disparador = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
Register-ScheduledTask -TaskName $nombre -Action $accion -Trigger $disparador -Description "Levanta Millast (Docker) al iniciar sesión" -Force | Out-Null
Write-Host "Tarea creada: '$nombre' (al iniciar sesión)." -ForegroundColor Green
