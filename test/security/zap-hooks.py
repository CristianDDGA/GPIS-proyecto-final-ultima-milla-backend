"""Hook de OWASP ZAP Baseline: siembra los endpoints de la API.

La API es JSON puro y no expone enlaces, por lo que el spider de ZAP no
descubriria rutas. Este hook visita cada endpoint auditado (incluyendo
payloads de SQL injection y manipulacion de UUID en la query/ruta) para que
las reglas pasivas del baseline analicen sus respuestas.
Solo se envian peticiones GET/POST de lectura o rechazables por validacion;
no se ejecuta ataque activo.
"""
import json
import urllib.parse

UUID_OK = '3f2b8c1e-9d4a-4e7b-8a61-5c0d2f7e9b11'
ENDPOINTS = [
    '/health',
    '/zones',
    '/orders',
    '/couriers',
    '/routes',
    '/delivery-orders/' + UUID_OK,
    '/zones/' + UUID_OK,
    '/orders/' + UUID_OK,
    '/routes/' + UUID_OK,
    '/couriers/' + UUID_OK + '/route',
    # Parameter tampering / SQL injection en ruta y query.
    '/orders/not-a-uuid',
    '/orders/' + urllib.parse.quote("1' OR '1'='1"),
    '/zones/' + urllib.parse.quote("' UNION SELECT NULL--"),
    '/routes/' + urllib.parse.quote("1; DROP TABLE orders;--"),
    '/orders?limit=' + urllib.parse.quote("1 OR 1=1"),
    '/zones?name=' + urllib.parse.quote("' OR 1=1--"),
    '/couriers?available=' + urllib.parse.quote("true' OR '1'='1"),
]
POST_ENDPOINTS = [
    ('/orders', {'zoneId': "' OR 1=1--", 'lat': "1;DROP TABLE x", 'lng': 'NaN'}),
    ('/zones', {'name': "'; SELECT pg_sleep(5);--"}),
    ('/couriers', {'name': "' OR 1=1--"}),
    ('/delivery-status-changes', {'orderId': 'not-a-uuid', 'status': 'ENTREGADO'}),
    ('/route-plans', {}),
]


def zap_started(zap, target):
    base = target.rstrip('/')
    for path in ENDPOINTS:
        try:
            zap.core.access_url(base + path, followredirects='true')
        except Exception as error:  # una ruta caida no debe abortar el baseline
            print('hook: fallo GET ' + path + ': ' + str(error))
    for path, body in POST_ENDPOINTS:
        zap.core.send_request(
            'POST ' + base + path + ' HTTP/1.1\r\nHost: ' + urllib.parse.urlparse(base).netloc
            + '\r\nContent-Type: application/json\r\nContent-Length: '
            + str(len(json.dumps(body))) + '\r\n\r\n' + json.dumps(body)
        )
