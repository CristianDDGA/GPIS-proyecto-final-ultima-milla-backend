# Validación reproducible del Sprint 1

CI ejecuta tipos, ESLint, build y regresiones. Backend también ejecuta la suite HTTP contra PostgreSQL real y las invariantes SQL del paquete canónico. Frontend ejecuta Cypress contra una revisión backend completa fijada en `.ci/integration.json`, API real y una base efímera. Se publican los resultados de `reports/e2e` incluso cuando falla.

En frontend configurar `SPRINT_REPOSITORY_TOKEN`: token de acceso de lectura al repositorio backend privado, limitado a contenido. Publicar primero el commit backend fijado para que checkout pueda resolverlo. Nunca usar una ruta obligatoria a un clon vecino.

El workflow `Sonar quality gate`, ejecutado en PR, push a develop/main y despacho manual, requiere `SONAR_HOST_URL` y `SONAR_TOKEN` en cada repositorio; el servidor debe ser accesible desde GitHub Actions. Un servidor Docker en localhost no es accesible desde runners alojados en GitHub. El job espera el resultado real del quality gate y falla si no pasa. La ejecución local no acredita una ejecución remota ni una cobertura que no se haya medido.

Flujo: commits atómicos → PR a develop → validaciones y revisión → PR de release develop a main. Ningún workflow hace merge automáticamente. El cierre del Sprint requiere conservar los reportes de los seis casos y resolver las dependencias externas pendientes.
