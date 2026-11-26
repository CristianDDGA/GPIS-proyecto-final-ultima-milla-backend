<#
  Detiene Millast (sin borrar datos). Para volver a encenderlo: Iniciar-Millast.ps1 -SinConstruir
  Para BORRAR también la base y las imágenes (empezar de cero):  .\Detener-Millast.ps1 -BorrarDatos
#>
param([switch]$BorrarDatos)
Set-Location $PSScriptRoot
if ($BorrarDatos) {
  $r = Read-Host "Esto borra la base de datos local y las imágenes subidas. Escribe SI para continuar"
  if ($r -ne "SI") { Write-Host "Cancelado."; return }
  docker compose down -v
} else {
  docker compose down
}
