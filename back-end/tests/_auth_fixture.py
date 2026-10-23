"""Create an isolated synthetic admin and exercise the real login endpoint."""
import http.client
import json
import uuid


def authenticated_headers(server):
    if hasattr(server, '_fixture_headers'):
        return server._fixture_headers.copy()
    username = 'Synthetic-' + uuid.uuid4().hex[:12]
    password = 'Synthetic-test-924'
    server.auth.store.create_user(username, password, role='admin')
    connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=10)
    connection.request('POST', '/api/auth/login', json.dumps({'username': username, 'password': password}),
                       {'Origin': f'http://127.0.0.1:{server.server_port}', 'Content-Type': 'application/json'})
    response = connection.getresponse()
    body = json.loads(response.read())
    if response.status != 200:
        raise AssertionError(body)
    headers = {'Cookie': response.getheader('Set-Cookie').split(';')[0], 'X-Account-ID': body['user']['id']}
    connection.close()
    server._fixture_headers = headers
    return headers.copy()
