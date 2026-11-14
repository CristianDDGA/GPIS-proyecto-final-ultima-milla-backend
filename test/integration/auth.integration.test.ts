import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../../src/bootstrap/create-app.js';
import { createAuthModule } from '../../src/modules/auth/index.js';
import type { AuthRepository, RegisterUserInput } from '../../src/modules/auth/application/ports/auth.repository.port.js';
import { toPublicRole, type AuthUser, type AuthUserRecord } from '../../src/modules/auth/domain/auth-user.entity.js';
import { AuthError } from '../../src/modules/auth/domain/auth.errors.js';

class InMemoryAuthRepository implements AuthRepository {
  private readonly usersById = new Map<string, AuthUserRecord>();

  async findByEmail(email: string): Promise<AuthUserRecord | null> {
    const normalized = email.toLowerCase();
    for (const user of this.usersById.values()) {
      if (user.email.toLowerCase() === normalized) return user;
    }
    return null;
  }

  async findById(id: string): Promise<AuthUser | null> {
    const record = this.usersById.get(id);
    if (!record) return null;
    const { passwordHash: _passwordHash, ...user } = record;
    return user;
  }

  async registerUser(input: RegisterUserInput): Promise<AuthUser> {
    if (await this.findByEmail(input.email)) {
      throw new AuthError('EMAIL_ALREADY_EXISTS');
    }
    const id = randomUUID();
    const record: AuthUserRecord = {
      id,
      authSubject: input.authSubject,
      email: input.email,
      passwordHash: input.passwordHash,
      role: input.role,
      publicRole: toPublicRole(input.role),
      displayName: input.displayName,
      isActive: true,
      courierId: null,
    };
    this.usersById.set(id, record);
    const { passwordHash: _passwordHash, ...user } = record;
    return user;
  }
}

describe('Auth HTTP Integration (in-memory)', () => {
  let app: ReturnType<typeof createApp>;
  let repository: InMemoryAuthRepository;
  let authModule: ReturnType<typeof createAuthModule>;

  beforeEach(() => {
    repository = new InMemoryAuthRepository();
    authModule = createAuthModule({
      repository,
      jwtSecret: 'integration-test-jwt-secret-1234',
    });
    app = createApp({
      webOrigin: 'http://127.0.0.1:5173',
      routers: [{ basePath: '/auth', router: authModule.router }],
      errorHandlers: [authModule.errorHandler],
    });
  });

  test('POST /auth/register crea cliente, devuelve JWT y bloquea duplicados (409)', async () => {
    const first = await request(app)
      .post('/auth/register')
      .send({ email: 'cliente1@test.com', password: 'Password123', displayName: 'Cliente Uno' });

    expect(first.status).toBe(201);
    expect(first.body.token).toEqual(expect.any(String));
    expect(first.body.user.role).toBe('cliente');
    expect(first.body.user.publicRole).toBe('cliente');

    const duplicate = await request(app)
      .post('/auth/register')
      .send({ email: 'cliente1@test.com', password: 'Password123' });

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('EMAIL_ALREADY_EXISTS');
  });

  test('POST /auth/login valida credenciales y GET /auth/me retorna perfil autenticado', async () => {
    await request(app)
      .post('/auth/register')
      .send({ email: 'cliente2@test.com', password: 'Password123' });

    const badLogin = await request(app)
      .post('/auth/login')
      .send({ email: 'cliente2@test.com', password: 'WrongPassword' });
    expect(badLogin.status).toBe(401);

    const login = await request(app)
      .post('/auth/login')
      .send({ email: 'cliente2@test.com', password: 'Password123' });
    expect(login.status).toBe(200);
    expect(login.body.token).toEqual(expect.any(String));

    const noToken = await request(app).get('/auth/me');
    expect(noToken.status).toBe(401);

    const me = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${login.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('cliente2@test.com');
  });

  test('POST /auth/users permite solo a admin (personal) crear repartidor/admin y rechaza clientes (403)', async () => {
    const customerReg = await request(app)
      .post('/auth/register')
      .send({ email: 'cliente3@test.com', password: 'Password123' });

    const forbidden = await request(app)
      .post('/auth/users')
      .set('Authorization', `Bearer ${customerReg.body.token}`)
      .send({ email: 'driver@test.com', password: 'Password123', role: 'repartidor' });
    expect(forbidden.status).toBe(403);

    const adminSession = await authModule.useCases.registerByAdmin(
      { role: 'personal' },
      { email: 'admin@test.com', password: 'AdminPassword123', role: 'admin', displayName: 'Admin' },
    );
    const adminLogin = await request(app)
      .post('/auth/login')
      .send({ email: adminSession.email, password: 'AdminPassword123' });

    const createdDriver = await request(app)
      .post('/auth/users')
      .set('Authorization', `Bearer ${adminLogin.body.token}`)
      .send({ email: 'driver@test.com', password: 'DriverPassword123', role: 'repartidor', displayName: 'Conductor' });
    expect(createdDriver.status).toBe(201);
    expect(createdDriver.body.user.role).toBe('repartidor');
  });
});
