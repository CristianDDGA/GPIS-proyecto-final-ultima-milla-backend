# Paquete canónico de pruebas

`database-package.zip` conserva los archivos originales de `db-proyecto` (migraciones 001 a 010, con las pruebas SQL de la tienda), sin modificar SQL ni crear otra cadena de migraciones. El manifiesto registra sus SHA-256 y la imagen PostgreSQL por digest. CI verifica el archivo, lo extrae en un directorio temporal y el harness verifica cada archivo antes de ejecutarlo. Para actualizarlo, cambiar los archivos en `db-proyecto` y ejecutar `npm run db:package` (fechas fijas: el mismo contenido da siempre el mismo SHA-256); `npm run db:package:check` comprueba que esté al día. Nunca editar SQL dentro del ZIP.

CI crea una base efímera por ejecución y la elimina en `finally`. La aplicación usa el rol restringido `logistica_app`. Las credenciales del paquete son exclusivamente de pruebas locales efímeras.
