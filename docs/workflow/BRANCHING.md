# Flujo de ramas del proyecto

- main: rama estable para entregas aceptadas del Sprint.
- develop: integración de las historias y correcciones.
- feature/* y fix/*: trabajo de alcance acotado que se revisa antes de incorporarlo a develop.

La rama local master se renombró a main conservando el commit inicial. El cambio de nombre no promueve automáticamente las historias ni las declara aceptadas.

## Promoción de un Sprint

1. Crear/revisar el PR de la rama de trabajo hacia develop. Mantener los commits atómicos de las correcciones.
2. Ejecutar CI, integración real PostgreSQL, el recorrido Cypress y los análisis exigidos sobre las revisiones que se van a promover.
3. Crear el PR develop hacia main con ambos commits de aplicación y las evidencias de aceptación.
4. Resolver bloqueantes, comprobar que la revisión corresponde a la última versión del PR y fusionar mediante Merge Commit para conservar la atomicidad y la trazabilidad.
5. Actualizar los clones con fetch y fast-forward. No usar push --force para sincronizar ramas compartidas.

Configurar main como predeterminada de GitHub no cambia los destinos correctos: los PR de feature/fix van a develop; los PR de entrega van de develop a main.

La aceptación de los cuatro casos API/PostgreSQL no acredita por sí sola Cypress, Sonar ni CI remoto. No se debe promover un Sprint completo a main con esos criterios pendientes.
