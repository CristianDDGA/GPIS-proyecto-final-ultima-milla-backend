# Guía rápida: actualizar el entorno a Node 24.22.2

El backend pasó de Node **24.11.0** a **24.22.2**. Es la misma versión 24 con parches de seguridad, así que el código no cambia. También se actualizaron algunas dependencias menores.

Tu `.env`, la base de datos y el paquete `db-proyecto` **no cambian**.

Toma unos 5 minutos. Sigue los pasos en orden.

---

## Paso 1. Comprueba qué versión tienes

Abre una terminal y escribe:

```bash
node -v
```

- Si aparece `v24.22.2`, salta al **Paso 3**.
- Si aparece otra versión, sigue con el **Paso 2**.

---

## Paso 2. Instala Node 24.22.2

Elige **una** de estas opciones.

### Opción A: tienes nvm-windows (recomendada)

Si `nvm version` muestra un número, tienes nvm-windows:

```bash
nvm install 24.22.2
```

```bash
nvm use 24.22.2
```

### Opción B: no tienes nvm

1. Entra en https://nodejs.org/dist/v24.22.2/
2. Descarga `node-v24.22.2-x64.msi`.
3. Ejecútalo y pulsa *Siguiente* hasta terminar. Reemplaza la versión anterior.

### Opción C: Mac o Linux con nvm

Dentro de la carpeta del backend:

```bash
nvm install
```

```bash
nvm use
```

`nvm` lee la versión del archivo `.nvmrc`.

**Cierra la terminal, abre una nueva** y comprueba:

```bash
node -v
```

Debe mostrar `v24.22.2`. `npm -v` debe empezar por `11`.

---

## Paso 3. Trae los cambios de develop

Dentro de la carpeta del backend:

```bash
git fetch origin
```

```bash
git switch develop
```

```bash
git pull --ff-only
```

Si estás trabajando en tu propia rama (`feature/...` o `fix/...`), vuelve a ella y trae develop:

```bash
git switch nombre-de-tu-rama
```

```bash
git merge develop
```

No uses `git push --force`.

---

## Paso 4. Reinstala las dependencias

```bash
npm ci
```

Esto borra `node_modules`, instala exactamente las versiones de `package-lock.json` y regenera Prisma Client.

---

## Paso 5. Comprueba que todo funciona

```bash
npm run typecheck
```

```bash
npm run lint
```

```bash
npm run test:unit
```

Con Docker abierto y `DATABASE_PACKAGE_DIR` configurado en tu `.env`:

```bash
npm run test:integration:postgres
```

Si todo termina sin errores, ya está.

---

## Problemas comunes

| Lo que ves | Qué hacer |
|---|---|
| `npm warn EBADENGINE ... required: { node: '>=24.22.2 <25' }` | Todavía usas otra versión de Node. Repite el **Paso 2** y abre una terminal nueva. |
| `node -v` sigue mostrando la versión vieja | Cierra **todas** las terminales y VS Code y vuelve a abrirlos. Con nvm, ejecuta otra vez `nvm use 24.22.2`. |
| `nvm use` da error de permisos | Abre la terminal como administrador y repite el comando. |
| `npm ci` falla con `EPERM` o archivo en uso | Detén `npm run dev`, cierra VS Code y vuelve a ejecutar `npm ci`. |
| Error de Prisma Client al arrancar | Ejecuta `npm run db:generate`. |
| Tienes Node 25 o 26 | No sirve para este proyecto. Instala la 24.22.2 (Paso 2). Con nvm puedes tener ambas y cambiar con `nvm use`. |

---

## Qué cambió exactamente

| Elemento | Antes | Ahora |
|---|---|---|
| Node (`.nvmrc`) | 24.11.0 | 24.22.2 |
| `engines.node` | `>=24.11.0 <25` | `>=24.22.2 <25` |
| @types/node | 24.19.0 | 24.19.2 |
| eslint | ^10.13.0 | ^10.14.0 |
| supertest | ^7.3.1 | ^7.3.2 |
| tsx | 4.20.6 | 4.23.15 |
| typescript-eslint | ^8.71.2 | ^8.72.1 |

TypeScript (6.0.3), Prisma (7.10.1) y Express (5.3.0) **no cambian**. El CI toma la versión de Node de `.nvmrc`, así que ya usa la 24.22.2.
