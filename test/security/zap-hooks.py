"""Hook de OWASP ZAP Baseline: siembra los endpoints de la API.

La API es JSON puro y no expone enlaces, por lo que el spider de ZAP no
descubriria rutas. Este hook visita cada endpoint auditado (incluyendo
payloads de SQL injection y manipulacion de UUID en la query/ruta) para que
las reglas pasivas del baseline analicen sus respuestas.
Ademas registra un usuario temporal, obtiene su JWT y repite el barrido con
`Authorization: Bearer <token>` para que ZAP evalue tambien las respuestas
autenticadas reales (200/201/400/404), no solo los rechazos 401.
Solo se envian peticiones GET/POST de lectura o rechazables por validacion;
no se ejecuta ataque activo.
"""
import json
import time
import urllib.parse
import urllib.request

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
    ('/auth/login', {'email': "' OR 1=1--", 'password': 'invalid'}),
    ('/auth/register', {'email': 'zap-probe@example.com', 'password': '123', 'displayName': '<script>alert(1)</script>'}),
    ('/orders', {'zoneId': "' OR 1=1--", 'lat': "1;DROP TABLE x", 'lng': 'NaN'}),
    ('/zones', {'name': "'; SELECT pg_sleep(5);--"}),
    ('/couriers', {'name': "' OR 1=1--"}),
    ('/delivery-status-changes', {'orderId': 'not-a-uuid', 'status': 'ENTREGADO'}),
    ('/route-plans', {}),
]


def _json_request(url, body=None, method='GET', token=None):
    """Peticion JSON directa al servidor (fuera de ZAP) para obtener el JWT."""
    data = None if body is None else json.dumps(body).encode('utf-8')
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header('Content-Type', 'application/json')
    if token:
        request.add_header('Authorization', 'Bearer ' + token)
    with urllib.request.urlopen(request, timeout=15) as response:
        raw = response.read().decode('utf-8') or '{}'
        return json.loads(raw)


def _obtain_token(base):
    """Registra un usuario temporal y devuelve su JWT."""
    suffix = str(int(time.time() * 1000))
    credentials = {
        'email': 'zap-probe-' + suffix + '@example.com',
        'password': 'ZapProbe-2026!',
        'displayName': 'ZAP Probe',
    }
    try:
        session = _json_request(base + '/auth/register', credentials, method='POST')
        token = session.get('token')
        if isinstance(token, str) and token:
            return token
    except Exception as error:  # el registro puede estar limitado: se intenta login
        print('hook: registro fallido: ' + str(error))
    try:
        session = _json_request(
            base + '/auth/login',
            {'email': credentials['email'], 'password': credentials['password']},
            method='POST',
        )
        token = session.get('token')
        return token if isinstance(token, str) and token else None
    except Exception as error:
        print('hook: login fallido: ' + str(error))
        return None


def _send(zap, base, method, path, body=None, token=None):
    """Envia la peticion a traves de ZAP para que sus reglas la analicen."""
    payload = '' if body is None else json.dumps(body)
    raw = (
        method + ' ' + base + path + ' HTTP/1.1\r\n'
        'Host: ' + urllib.parse.urlparse(base).netloc + '\r\n'
        'Content-Type: application/json\r\n'
        + ('Authorization: Bearer ' + token + '\r\n' if token else '')
        + 'Content-Length: ' + str(len(payload.encode('utf-8'))) + '\r\n\r\n' + payload
    )
    zap.core.send_request(raw)


def zap_started(zap, target):
    base = target.rstrip('/')
    # 1) Barrido anonimo: las rutas protegidas deben responder 401.
    for path in ENDPOINTS:
        try:
            zap.core.access_url(base + path, followredirects='true')
        except Exception as error:  # una ruta caida no debe abortar el baseline
            print('hook: fallo GET ' + path + ': ' + str(error))
    for path, body in POST_ENDPOINTS:
        try:
            _send(zap, base, 'POST', path, body)
        except Exception as error:
            print('hook: fallo POST ' + path + ': ' + str(error))

    # 2) Barrido autenticado con JWT.
    token = _obtain_token(base)
    if token is None:
        print('hook: sin token JWT; se omite el barrido autenticado')
        return
    print('hook: token JWT obtenido; barrido autenticado en curso')
    for path in ENDPOINTS:
        try:
            _send(zap, base, 'GET', path, token=token)
        except Exception as error:
            print('hook: fallo GET auth ' + path + ': ' + str(error))
    for path, body in POST_ENDPOINTS:
        try:
            _send(zap, base, 'POST', path, body, token=token)
        except Exception as error:
            print('hook: fallo POST auth ' + path + ': ' + str(error))
