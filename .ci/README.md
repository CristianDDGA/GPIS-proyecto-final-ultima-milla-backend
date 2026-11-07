# Paquete canónico de pruebas

`database-package.zip` conserva los diez archivos originales de `db-proyecto`, sin modificar SQL ni crear otra cadena de migraciones. El manifiesto registra sus SHA-256 y la imagen PostgreSQL por digest. CI verifica el archivo, lo extrae en un directorio temporal y el harness verifica cada archivo antes de ejecutarlo. Para actualizarlo, revisar conjuntamente el paquete original y el manifiesto; nunca editar SQL dentro del ZIP.

CI crea una base efímera por ejecución y la elimina en `finally`. La aplicación usa el rol restringido `logistica_app`. Las credenciales del paquete son exclusivamente de pruebas locales efímeras.
