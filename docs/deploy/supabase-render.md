# Despliegue: base de datos en Supabase y API en Render

Esta guía deja la base de datos lista en Supabase y la API corriendo en Render, sin tocar el código entre entornos:
todo se configura con variables de entorno.

## 1. Qué cambia respecto al entorno local

| Tema | Local (Docker) | Supabase |
|---|---|---|
| Roles `logistica_app`, `logistica_worker`, `logistica_readonly` | Los crea `00-bootstrap.sh` | Se crean con `apply-migrations.mjs --create-roles` |
| Migraciones | `migrate.sh` dentro del contenedor | `apply-migrations.mjs` (Node, sin psql ni Docker) |
| Usuario de la API | `logistica_app` | `logistica_app.<id-del-proyecto>` por el pooler (la API ya lo acepta) |
| Conexión de la API | Puerto 15432 directo | Pooler en modo transacción, puerto **6543** |
| Conexión de migraciones | Directa | Directa o pooler en modo sesión, puerto **5432** (nunca 6543) |
| SSL | No | Obligatorio (`DB_SSL`) |
| Imágenes | Disco (`COURIER_UPLOADS_DIR`) | Supabase Storage (`STORAGE_DRIVER=supabase`) |

La API es compatible con el pooler en modo transacción: no usa bloqueos de sesión, `LISTEN` ni sentencias preparadas
manuales; los candados son `pg_advisory_xact_lock` y la configuración de sesión usa `set_config(..., true)` (local a la transacción).

## 2. Crear el proyecto en Supabase

1. Crea el proyecto y guarda la **contraseña de la base** (la del usuario `postgres`).
2. En *Project Settings → Database → Connection string* copia dos cadenas:
   - **Direct connection** (o *Session pooler* si tu red no tiene IPv6), puerto 5432, usuario `postgres`.
   - **Transaction pooler**, puerto 6543. El usuario tiene la forma `usuario.<id-del-proyecto>`.
3. En *Project Settings → Data API* comprueba que el esquema `logistica` **no** esté en *Exposed schemas*.
   La API de Supabase solo debe exponer `public` (que este proyecto no usa).

## 3. Preparar la base (una sola vez)

Desde la raíz del backend, con el Node portable 24.22.2. Las contraseñas de los roles son nuevas y propias de este
entorno; genera cada una con `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`.

```bash
# Variables solo en esta terminal (no las guardes en archivos versionados)
export MIGRATION_DATABASE_URL='postgresql://postgres:<CONTRASENA>@db.<id>.supabase.co:5432/postgres'
export DB_SSL=require
export APP_PASSWORD='<contrasena-app>' WORKER_PASSWORD='<contrasena-worker>' READONLY_PASSWORD='<contrasena-readonly>'

# 1) Ensayo: muestra qué se aplicaría y no cambia nada
node scripts/supabase/apply-migrations.mjs --from-zip --create-roles --dry-run

# 2) Aplicación real
node scripts/supabase/apply-migrations.mjs --from-zip --create-roles
```

`--from-zip` usa el paquete canónico del repositorio (`.ci/database-package.zip`, las migraciones 001 a 011), verificado
contra su manifiesto y el SHA-256 de cada archivo. Así la migración sale solo de git: no depende de la carpeta
`db-proyecto` ni de quién la tenga. Sin `--from-zip`, el script usa `DATABASE_PACKAGE_DIR` si esa carpeta existe.

El script es repetible: la segunda vez dice "ya aplicada" en cada migración. Si alguien edita una migración ya aplicada,
se detiene (checksum SHA-256), igual que `migrate.sh`.

Además revoca a `anon`, `authenticated` y `service_role` cualquier permiso sobre el esquema `logistica`, para que la
API pública de Supabase no pueda leer ni ejecutar nada de la logística. Al final imprime una tabla de comprobación:
`logistica_app`, `logistica_worker` y `logistica_readonly` deben mostrar `USAGE=true` y los roles de Supabase `USAGE=false`.

## 3 bis. Primer administrador

Una base nueva no tiene usuarios y el registro público solo crea clientes. Crea el primer administrador una sola vez
(misma conexión directa, 5432):

```bash
export MIGRATION_DATABASE_URL='postgresql://postgres:<CONTRASENA>@db.<id>.supabase.co:5432/postgres'
export DB_SSL=require
export ADMIN_EMAIL='tu-correo@dominio.com' ADMIN_PASSWORD='<clave-larga-de-12+>' ADMIN_NAME='Tu Nombre'
node scripts/supabase/create-admin.mjs
```

La clave se guarda solo como hash scrypt (el mismo formato de la API) y la cuenta nace con el correo verificado. Repetir el
comando no cambia nada si el correo ya existe. Cambia la clave después con `POST /auth/change-password`. Con ese
administrador creas conductores desde la API; los clientes se registran solos.

## 3 ter. Imágenes: Supabase Storage

En Render el disco se borra al reiniciar o redesplegar, así que las imágenes no pueden vivir en él. La API guarda los
archivos en Supabase Storage con `STORAGE_DRIVER=supabase`; en la base de datos solo queda el nombre del archivo.

1. En *Storage* crea **dos buckets**:
   - `product-images` → **público** (fotos del catálogo; se sirven por URL directa desde la CDN).
     Límite de tamaño 5 MB y tipos permitidos `image/jpeg`, `image/png`.
   - `courier-applications` → **privado** (licencia y foto de los conductores: son datos personales).
     Mismo límite y tipos. Solo el backend los lee, y solo el administrador a través de la API.
2. **No crees políticas** de escritura para usuarios: la API escribe con la clave de servicio (`service_role`), que
   se salta las políticas. Sin políticas, nadie más puede escribir ni leer el bucket privado.
3. En *Project Settings → API* copia la **service_role key**. Es un secreto: va solo en las variables de entorno de
   Render (`SUPABASE_SERVICE_ROLE_KEY`). Nunca en el frontend, en git ni en un chat. Si se filtra, regenérala.
4. `SUPABASE_URL` es `https://<id-del-proyecto>.supabase.co`, sin ruta.

Qué hace la API:
- Valida cada archivo antes de subirlo: tipo real por la firma (no por la extensión), máximo 5 MB, entre 64 x 64 y
  4096 x 4096 píxeles, y un nombre aleatorio generado por el servidor (nunca el del cliente).
- Nunca sobrescribe un archivo. Al reemplazar la imagen de un producto sube la nueva, actualiza el producto con control de
  versión y solo entonces borra la anterior; si la actualización falla, borra la nueva.
- Los productos devuelven `imageUrl` con la URL pública de la CDN. Las fotos de conductores nunca tienen URL pública.
- Los tamaños: Render admite cuerpos grandes sin problema; si algún día se despliega en una plataforma con límite de
  cuerpo (por ejemplo funciones serverless de 4,5 MB), habría que bajar el tope de imagen o subir con URL firmada.

Archivos que ya estaban en disco (solicitudes de conductor creadas antes de migrar) no se copian solos: subirlos al bucket
`courier-applications` con el mismo nombre de archivo, o aceptar que esas solicitudes viejas pierdan su imagen.

## 4. Variables de la API (Render)

| Variable | Valor |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Transaction pooler: `postgresql://logistica_app.<id>:<contrasena-app>@<host-pooler>:6543/postgres` |
| `DB_SSL` | `require` (o `verify` con `DB_SSL_CA`, ver abajo) |
| `DB_POOL_MAX` | `10` (el plan gratuito tiene pocas conexiones) |
| `DB_SEND_STATEMENT_TIMEOUT` | `false`: el rol ya fija `statement_timeout` con `ALTER ROLE` y el pooler puede rechazar parámetros de arranque |
| `JWT_SECRET` | Aleatorio de 32+ caracteres, distinto en cada entorno |
| `WEB_ORIGIN` | URL del frontend (por ejemplo `https://tu-app.vercel.app`), sin ruta |
| `TRUST_PROXY` | `1` (Render pone un proxy delante) |
| `EMAIL_VERIFICATION_REQUIRED` | `true`, con `SMTP_*` y `MAIL_FROM` configurados |
| `STORAGE_DRIVER` | `supabase` (ver la sección de imágenes) |
| `SUPABASE_URL` | `https://<id-del-proyecto>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | La clave `service_role`. Secreto: solo aquí |
| `SUPABASE_PRODUCT_BUCKET` / `SUPABASE_COURIER_BUCKET` | `product-images` / `courier-applications` (por defecto) |

`DB_SSL=verify` valida el certificado: descarga el certificado CA desde *Database → SSL Configuration* y pásalo en
`DB_SSL_CA` (contenido PEM con `\n` o la ruta del archivo). `require` cifra la conexión pero no valida el servidor.

## 5. Render

El archivo `render.yaml` de la raíz describe el servicio. Comando de compilación `npm ci && npm run build`,
de inicio `npm start`, y comprobación de salud en `/health` (responde 503 si PostgreSQL no contesta).
La API escucha en `PORT`, que Render define.

## 6. Comprobación posterior

```bash
curl -s https://<tu-api>.onrender.com/health
curl -s -X POST https://<tu-api>.onrender.com/auth/login -H 'content-type: application/json'   -d '{"email":"<ADMIN_EMAIL>","password":"<ADMIN_PASSWORD>"}'
```

`/health` debe responder `200` con la base conectada. Si responde `503`, revisa `DATABASE_URL`, `DB_SSL` y que el
proyecto de Supabase no esté pausado. El inicio de sesión del administrador debe devolver un `token`.

Lista de verificación antes de dar el enlace al frontend:

- [ ] `apply-migrations.mjs` terminó con `anon`, `authenticated` y `service_role` en `USAGE=false`.
- [ ] El esquema `logistica` **no** está en *Exposed schemas* de la API de Supabase.
- [ ] El bucket `product-images` es público y `courier-applications` es privado, sin políticas de escritura.
- [ ] `JWT_SECRET` es nuevo (no el de desarrollo) y `WEB_ORIGIN` es exactamente la URL del frontend.
- [ ] `SMTP_*` y `MAIL_FROM` configurados (ver abajo). Sin SMTP los clientes no pueden confirmar su correo.
- [ ] Un administrador creó una zona, una categoría y un producto con imagen; la imagen se ve en el catálogo.
- [ ] Un cliente de prueba se registró, confirmó el correo, hizo un pedido y lo canceló (el stock volvió).

## 6 bis. Correos al cliente y plan gratuito de Render

La API envía los avisos del pedido (recibido, en camino, entregado, fallido, cancelado, reprogramado) con un proceso interno
que revisa la cola cada 15 segundos. Los avisos están guardados en la base de datos: si el servicio duerme, no se pierden;
se envían cuando despierta. En el plan gratuito de Render el servicio duerme tras 15 minutos sin tráfico, así que un
aviso puede tardar hasta que llegue la siguiente petición. Para envíos puntuales usa un plan que no duerma, o un monitor
externo gratuito que consulte `/health` cada 10 minutos.

Con `EMAIL_VERIFICATION_REQUIRED=true` y sin `SMTP_HOST`, la API escribe los códigos de verificación en su registro y
arranca con un aviso: sirve solo para desarrollo. Solo reciben avisos las cuentas con el correo confirmado por código.

## 6 bis 2. Inicio de sesión con Google (opcional)

1. En Google Cloud Console crea un proyecto (gratis, **sin facturación**) → *APIs y servicios* → *Pantalla de consentimiento de OAuth* (tipo Externo, con solo
   nombre de la app y tu correo; los ámbitos básicos `openid`, `email` y `profile` no necesitan verificación).
2. *Credenciales* → *Crear credenciales* → *ID de cliente de OAuth* → tipo **Aplicación web**. En *Orígenes autorizados de JavaScript* agrega
   `http://localhost:5173` y la URL del frontend en producción (sin ruta). No hace falta URI de redirección con el botón de Google Identity Services.
3. Copia el **ID de cliente** (`...apps.googleusercontent.com`). Es público: va en `GOOGLE_CLIENT_ID` en Render y en `.env`, y el frontend lo usa en `initialize`.
   El "secreto de cliente" **no se usa** y no debe ir en ningún lado.
4. Con la pantalla de consentimiento en modo *Prueba*, solo entran las cuentas que agregues como *Usuarios de prueba*; pásala a *En producción* para abrirla a todos.
5. Aplica las migraciones 013 y 014 (`apply-migrations.mjs --from-zip`) antes de desplegar.

## 6 ter. Datos que ya tengas en la base local

La migración crea una base **vacía**. Los datos de desarrollo (pedidos de prueba, usuarios de demo) no se copian: en la nube
conviene empezar limpio. Si necesitaras conservar algo concreto, exporta solo esas tablas con `pg_dump --data-only -t
logistica.<tabla>` desde la base local y cárgalas con el usuario `postgres`, respetando el orden de las claves foráneas.
Los usuarios traen su hash de contraseña, así que seguirían entrando con la misma clave. Los archivos que estén en disco
(`./storage`) tampoco se copian: súbelos a los buckets con el mismo nombre de archivo.

## 6 quáter. Copias de seguridad y volver atrás

- Supabase hace copias diarias en los planes de pago; en el gratuito **no** hay copias automáticas: antes de una demo
  importante exporta con `pg_dump` (esquema `logistica`).
- Las migraciones son transaccionales (si una falla, no queda a medias) y no se editan una vez aplicadas. Un cambio nuevo
  es siempre una migración nueva (`012_...`), que se agrega al paquete con `npm run db:package`.

## 7. Problemas comunes

- **El proyecto gratuito de Supabase se pausa tras una semana sin uso.** Despiértalo antes de una demostración.
- **`self-signed certificate in certificate chain`:** usa `DB_SSL=require`, o `verify` con el CA oficial en `DB_SSL_CA`.
- **`La API requiere una conexión PostgreSQL con el rol logistica_app`:** el usuario de `DATABASE_URL` debe ser
  `logistica_app` o `logistica_app.<id-del-proyecto>`.
- **Las migraciones fallan con el puerto 6543:** ese modo no admite una migración completa; usa el 5432.
- **Render tarda en responder la primera vez:** el plan gratuito duerme el servicio; la primera petición lo despierta.
