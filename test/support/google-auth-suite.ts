import request from 'supertest';
import { AuthError } from '../../src/modules/auth/domain/auth.errors.js';
import type { GoogleIdentity, GoogleTokenVerifier } from '../../src/modules/auth/application/ports/google-token-verifier.port.js';
import type { createApp } from '../../src/bootstrap/create-app.js';
import type { CapturingEmailSender } from './in-memory-auth.js';

// Suite HTTP del inicio de sesión con Google. Se ejecuta igual con repositorios en memoria y con PostgreSQL real
// (migración 014). La verificación del token de Google se sustituye por un doble: el verificador real se prueba aparte
// (test/unit/google-id-token-verifier.test.ts) con claves RSA de prueba.

/** Doble del verificador: cada "token" es una clave que apunta a una identidad ya preparada. */
export class FakeGoogleVerifier implements GoogleTokenVerifier {
  private readonly identities = new Map<string, GoogleIdentity>();
  private counter = 0;

  /** Prepara una identidad y devuelve el "idToken" que el navegador enviaría. */
  tokenFor(identity: Partial<GoogleIdentity> & { sub: string; email: string }): string {
    const token = `fake-google-token-${(this.counter += 1)}`;
    this.identities.set(token, { emailVerified: true, name: 'Ana Pérez', ...identity });
    return token;
  }

  async verify(idToken: string): Promise<GoogleIdentity> {
    const identity = this.identities.get(idToken);
    if (!identity) throw new AuthError('INVALID_GOOGLE_TOKEN');
    return identity;
  }
}

export interface GoogleHarness {
  readonly app: ReturnType<typeof createApp>;
  readonly adminToken: string;
  readonly emails: CapturingEmailSender;
  readonly google: FakeGoogleVerifier;
  /** Cantidad de cuentas con ese correo (para comprobar que no se duplican). */
  readonly countAccounts: (email: string) => Promise<number>;
}

export interface GoogleHarnessOptions { readonly googleEnabled?: boolean }

const PASSWORD = 'ClaveSegura2026';
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export function defineGoogleLoginSuite(create: (options?: GoogleHarnessOptions) => Promise<GoogleHarness> | GoogleHarness): void {
  let h: GoogleHarness;
  beforeEach(async () => { h = await create(); });

  const api = () => request(h.app);
  const loginWithGoogle = (idToken: unknown) => api().post('/auth/google').send({ idToken });

  /** Cliente que se registró y confirmó su correo con el código (la única cuenta existente a la que Google se vincula). */
  async function verifiedCustomer(email: string): Promise<{ id: string }> {
    const registered = await api().post('/auth/register').send({ email, password: PASSWORD, displayName: 'Ana Pérez' });
    expect(registered.status).toBe(201);
    const verified = await api().post('/auth/verify-email').send({ email, code: h.emails.lastCodeFor(email) });
    expect(verified.status).toBe(200);
    return verified.body.user as { id: string };
  }

  const createByAdmin = (email: string, role: 'admin' | 'repartidor') =>
    api().post('/auth/users').set(bearer(h.adminToken)).send({ email, password: 'Torre-Azul-Cobre-2026', role, displayName: 'Persona Prueba' });

  describe('Inicio de sesión con Google', () => {
    it('sin Client ID configurado responde 503 y no rompe nada', async () => {
      h = await create({ googleEnabled: false });
      const response = await loginWithGoogle('lo-que-sea');
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('GOOGLE_NOT_ENABLED');
    });

    it('rechaza un token que Google no firmó, y un cuerpo sin token', async () => {
      const bad = await loginWithGoogle('token-inventado');
      expect(bad.status).toBe(401);
      expect(bad.body.code).toBe('INVALID_GOOGLE_TOKEN');
      expect((await api().post('/auth/google').send({})).status).toBe(400);
      expect((await loginWithGoogle(123)).status).toBe(400);
      expect((await loginWithGoogle('   ')).status).toBe(400);
    });

    it('una persona nueva entra como cliente verificado, sin contraseña, y su sesión funciona', async () => {
      const response = await loginWithGoogle(h.google.tokenFor({ sub: '1001', email: 'Nueva.Persona@gmail.com', name: 'Nueva Persona' }));
      expect(response.status).toBe(200);
      expect(response.body.user).toMatchObject({ email: 'nueva.persona@gmail.com', role: 'cliente', emailVerified: true, isActive: true });
      const me = await api().get('/auth/me').set(bearer(response.body.token));
      expect(me.status).toBe(200);
      expect(me.body.user.id).toBe(response.body.user.id);

      // No tiene contraseña: el inicio de sesión por clave no sirve y "olvidé mi contraseña" no envía nada.
      const byPassword = await api().post('/auth/login').send({ email: 'nueva.persona@gmail.com', password: PASSWORD });
      expect(byPassword.status).toBe(401);
      expect((await api().post('/auth/forgot-password').send({ email: 'nueva.persona@gmail.com' })).status).toBe(202);
      expect(h.emails.sent).toHaveLength(0);
      expect(await h.countAccounts('nueva.persona@gmail.com')).toBe(1);
    });

    it('la misma cuenta de Google vuelve a entrar a la misma cuenta, aunque cambie de correo', async () => {
      const first = await loginWithGoogle(h.google.tokenFor({ sub: '2002', email: 'maria@gmail.com' }));
      const again = await loginWithGoogle(h.google.tokenFor({ sub: '2002', email: 'maria@gmail.com' }));
      const renamed = await loginWithGoogle(h.google.tokenFor({ sub: '2002', email: 'maria.nueva@gmail.com' }));
      for (const response of [again, renamed]) {
        expect(response.status).toBe(200);
        expect(response.body.user.id).toBe(first.body.user.id);
      }
      expect(await h.countAccounts('maria.nueva@gmail.com')).toBe(0);
    });

    it('varias primeras entradas a la vez crean una sola cuenta', async () => {
      const token = h.google.tokenFor({ sub: '3003', email: 'carrera@gmail.com' });
      const results = await Promise.all([1, 2, 3, 4].map(() => loginWithGoogle(token)));
      expect(results.every((response) => response.status === 200)).toBe(true);
      expect(new Set(results.map((response) => response.body.user.id)).size).toBe(1);
      expect(await h.countAccounts('carrera@gmail.com')).toBe(1);
    });

    it('vincula una cuenta de cliente confirmada por código y conserva su contraseña', async () => {
      const customer = await verifiedCustomer('ana@test.com');
      const response = await loginWithGoogle(h.google.tokenFor({ sub: '4004', email: 'ANA@test.com' }));
      expect(response.status).toBe(200);
      expect(response.body.user.id).toBe(customer.id);
      expect((await api().post('/auth/login').send({ email: 'ana@test.com', password: PASSWORD })).status).toBe(200);
      expect(await h.countAccounts('ana@test.com')).toBe(1);
      // Otra identidad de Google con el mismo correo no puede apropiarse de la cuenta.
      const other = await loginWithGoogle(h.google.tokenFor({ sub: '4005', email: 'ana@test.com' }));
      expect(other.status).toBe(403);
      expect(other.body.code).toBe('GOOGLE_NOT_ALLOWED');
    });

    it('no vincula una cuenta con el correo sin confirmar (no se puede apropiar de un registro ajeno)', async () => {
      const registered = await api().post('/auth/register').send({ email: 'pendiente@test.com', password: PASSWORD, displayName: 'Pendiente Prueba' });
      expect(registered.status).toBe(201);
      const response = await loginWithGoogle(h.google.tokenFor({ sub: '5005', email: 'pendiente@test.com' }));
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('GOOGLE_NOT_ALLOWED');
      // Sigue pudiendo confirmar su correo por la vía normal.
      const verified = await api().post('/auth/verify-email').send({ email: 'pendiente@test.com', code: h.emails.lastCodeFor('pendiente@test.com') });
      expect(verified.status).toBe(200);
    });

    it('nunca crea ni vincula administradores ni conductores', async () => {
      expect((await createByAdmin('jefe@test.com', 'admin')).status).toBe(201);
      expect((await createByAdmin('conductor@test.com', 'repartidor')).status).toBe(201);
      for (const [sub, email] of [['6006', 'jefe@test.com'], ['6007', 'conductor@test.com']] as const) {
        const response = await loginWithGoogle(h.google.tokenFor({ sub, email }));
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('GOOGLE_NOT_ALLOWED');
      }
    });

    it('si Google no confirma el correo, no entra', async () => {
      const response = await loginWithGoogle(h.google.tokenFor({ sub: '7007', email: 'sin.confirmar@gmail.com', emailVerified: false }));
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('GOOGLE_NOT_ALLOWED');
      expect(await h.countAccounts('sin.confirmar@gmail.com')).toBe(0);
    });

    it('una cuenta desactivada no entra con Google', async () => {
      const first = await loginWithGoogle(h.google.tokenFor({ sub: '8008', email: 'baja@gmail.com' }));
      const off = await api().patch(`/auth/users/${first.body.user.id}`).set(bearer(h.adminToken)).send({ isActive: false });
      expect(off.status).toBe(200);
      const response = await loginWithGoogle(h.google.tokenFor({ sub: '8008', email: 'baja@gmail.com' }));
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('USER_INACTIVE');
    });

    it('un nombre de Google con caracteres no admitidos no impide entrar: la cuenta queda sin nombre', async () => {
      const response = await loginWithGoogle(h.google.tokenFor({ sub: '9009', email: 'emoji@gmail.com', name: 'Ana \u{1F600} 123' }));
      expect(response.status).toBe(200);
      expect(response.body.user.displayName).toBeNull();
    });
  });
}
