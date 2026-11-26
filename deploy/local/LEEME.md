# Despliegue local de Millast con Docker (carpeta `deploy/local` del backend)

Levanta **todo el sistema en tu PC** con tres contenedores: base de datos (PostgreSQL), API (Node 24) y web (nginx). Se reinicia solo si Docker arranca de nuevo, y los datos se conservan.

| Pieza | Contenedor | Dirección |
|---|---|---|
| Web | `millast_local-web-1` | http://localhost:5173 |
| API | `millast_local-api-1` | http://localhost:3000 (`/health`) |
| Base de datos | `millast_local-db-1` | Solo accesible desde los otros contenedores (no se publica un puerto) |

## 0. Requisitos (una sola vez)

1. **Docker Desktop** instalado y abierto (Windows 10/11).
2. **Git**. Clona los **dos repositorios en la misma carpeta**, ambos en la rama `develop`:

```powershell
git clone https://github.com/CristianDDGA/GPIS-proyecto-final-ultima-milla-backend.git
git clone https://github.com/CristianDDGA/GPIS-proyecto-final-ultima-milla-frontend.git
```

   Si el frontend queda en otra ruta, define antes `$env:FRONTEND_DIR = "C:\ruta\al\frontend"`.
3. No hace falta instalar Node, PostgreSQL ni nada más: todo se compila dentro de Docker. Los puertos 3000 y 5173 deben estar libres (o usa `-ApiPort` y `-WebPort`).
4. Esta instalación es **independiente de producción**: crea su propia base vacía con las migraciones del repositorio (`.ci/database-package.zip`). No necesitas ninguna clave de Supabase.

## 1. Encender (la primera vez y cuando quieras reconstruir)

1. Abre **Docker Desktop** y espera a que arranque.
2. En PowerShell, dentro de la carpeta `deploy/local` del backend:

```powershell
powershell -ExecutionPolicy Bypass -File .\Iniciar-Millast.ps1
```

Qué hace el script, en orden:
1. Comprueba que Docker responde y que el frontend está clonado junto al backend.
   Extrae las migraciones de `.ci/database-package.zip` a `db-package/` (se ignora en git).
2. Si no existe `.env`, lo **genera** con contraseñas y claves aleatorias (no se muestran) y copia el Client ID de Google del frontend (es público).
3. Construye las imágenes y levanta los tres servicios (`docker compose up -d --build --wait`). La **primera vez** descarga y compila: tarda unos minutos.
4. En el primer arranque la base crea sus roles y aplica **las 20 migraciones**.
5. Crea el **administrador** (`admin@millast.local`). La contraseña queda en el archivo `.env`, clave `ADMIN_PASSWORD`.

Para otro correo de administrador: `.\Iniciar-Millast.ps1 -AdminEmail tu@correo.com` (solo en la primera vez).
Para usar otros puertos: `.\Iniciar-Millast.ps1 -ApiPort 3100 -WebPort 5273`.
Para volver a encender sin reconstruir: `.\Iniciar-Millast.ps1 -SinConstruir`.

## 2. Apagar

```powershell
.\Detener-Millast.ps1                  # detiene, conserva los datos
.\Detener-Millast.ps1 -BorrarDatos     # BORRA la base y las imágenes subidas (pide confirmar escribiendo SI)
```

## 3. Que se prenda solo al encender la PC

Hay **dos capas**, y las dos hacen falta:

### Capa 1 — los contenedores se reinician solos (ya incluida)
En `compose.yaml` cada servicio tiene `restart: unless-stopped`. Si Docker se reinicia o un servicio se cae por sí mismo, los contenedores **vuelven sin que hagas nada**.

> Importante: si **tú** detienes un contenedor a mano (`docker stop`, `docker kill` o `Detener-Millast.ps1`), Docker entiende que lo querías apagado y **no** lo vuelve a levantar hasta que lo enciendas.

### Capa 2 — que Docker arranque con Windows (**tú lo activas una vez**)
Docker Desktop **no** arranca solo por defecto (en esta PC estaba desactivado). Activa:

**Docker Desktop → Settings (engranaje) → General → ✔ "Start Docker Desktop when you sign in to your computer" → Apply.**

Con eso, al encender la PC e **iniciar sesión en Windows**, Docker arranca y los tres contenedores vuelven solos (en las pruebas, la API respondió en segundos tras arrancar el motor).

**Límite que debes conocer:** Docker Desktop arranca cuando **un usuario inicia sesión**, no al encender la máquina. Si la PC se reinicia y nadie inicia sesión, el sistema no sube. Para un servidor desatendido hay que usar Windows autologin (menos seguro) o instalar PostgreSQL y la API como servicios de Windows, sin Docker.

### Opcional — tarea programada de respaldo
`.\Instalar-Tarea-Inicio.ps1` crea una tarea de Windows que, al iniciar sesión, espera a que Docker esté listo y ejecuta `docker compose up -d` (útil si algún contenedor se detuvo a mano). Para quitarla: `.\Instalar-Tarea-Inicio.ps1 -Quitar`.

## 4. Comprobar que está bien

```powershell
docker compose ps                       # los tres "Up" y "healthy"
curl.exe http://localhost:3000/health   # {"status":"ok"}
```

Abre http://localhost:5173 e inicia sesión con `admin@millast.local` y la clave de `.env`.

## 5. Datos, correo y Google en local

- **Datos:** viven en dos volúmenes de Docker (`millast_local_pgdata` para la base y `millast_local_uploads` para las imágenes). Sobreviven a apagar y encender. Solo se pierden con `-BorrarDatos` o `docker compose down -v`.
- **Correo:** en local no hay bandeja, así que `EMAIL_VERIFICATION_REQUIRED=false` (las cuentas nuevas entran sin código). Si quieres correos reales, completa `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS` y `MAIL_FROM` en `.env` y pon `EMAIL_VERIFICATION_REQUIRED=true`.
- **Google:** el Client ID se copia del frontend. Funciona en `http://localhost:5173`, que ya está autorizado en Google.
- **Imágenes:** se guardan en disco dentro del volumen (no en Supabase).

## 6. Cambiar puertos o la dirección de la API

Edita `API_PORT` y `WEB_PORT` en `.env` y vuelve a ejecutar `Iniciar-Millast.ps1` (reconstruye la web, porque la dirección de la API se **incrusta al compilar**). Si cambias el puerto de la web, el origen autorizado en Google también debe coincidir.

## 7. Seguridad

- El archivo `.env` contiene secretos: **no lo compartas ni lo subas a ningún repositorio** (ya está en `.gitignore`).
- Los puertos se publican solo en `127.0.0.1`: únicamente tu PC puede entrar. Para abrirlo a otros equipos de la red habría que cambiarlos y usar HTTPS.
- Esta instalación **no usa** la base de producción (Supabase): es una base propia y vacía.

## 8. Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| "Docker no responde" | Docker Desktop apagado | Ábrelo y espera a que arranque |
| Puerto 3000 o 5173 ocupado | Otra API o `npm run dev` abierto | Ciérralo, o cambia el puerto en `.env` |
| Los contenedores no suben tras reiniciar la PC | Docker Desktop no arranca con Windows, o nadie inició sesión | Capa 2 de la sección 3 |
| La web carga pero no inicia sesión | La dirección de la API incrustada no coincide con la real | Sección 6 |
| Quieres empezar de cero | — | `.\Detener-Millast.ps1 -BorrarDatos` y luego `.\Iniciar-Millast.ps1` |
| Ver el registro de un servicio | — | `docker compose logs -f api` (o `db`, `web`) |

## 9. Después de actualizar el código (`git pull`)

- Vuelve a ejecutar `.\Iniciar-Millast.ps1`: reconstruye API y web con el código nuevo.
- Si el `pull` trae **migraciones nuevas**, la base ya creada no las aplica sola. Empieza de cero con `.\Detener-Millast.ps1 -BorrarDatos` y luego `.\Iniciar-Millast.ps1`.
