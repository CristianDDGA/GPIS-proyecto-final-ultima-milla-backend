import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  detectImageType,
  isValidEcuadorianNationalId,
  isValidIsoDate,
  subtractYears,
  todayInEcuador,
  validateApplicationData,
  validateApplicationId,
  validateFileKind,
} from '../../src/modules/courier-applications/domain/application.js';
import { ApplicationError } from '../../src/modules/courier-applications/domain/application.errors.js';
import { DiskFileStorage } from '../../src/modules/courier-applications/infrastructure/storage/disk-file-storage.js';

const TODAY = '2026-11-16';
const FORM = {
  fullName: 'Carlos Andrade Mora',
  nationalId: '1712345675',
  phone: '0991234567',
  birthDate: '1995-04-20',
  vehicleType: 'moto',
  licenseNumber: 'ec-123456',
  licenseCategory: 'a',
  licenseExpiresOn: '2030-01-31',
};

function rejects(change: Record<string, unknown>, pattern: RegExp): void {
  assert.throws(
    () => validateApplicationData({ ...FORM, ...change }, TODAY),
    (error: unknown) => error instanceof ApplicationError && error.code === 'VALIDATION_ERROR' && pattern.test(error.message),
  );
}

describe('solicitud de conductor · validación del formulario', () => {
  it('normaliza los datos válidos', () => {
    assert.deepEqual(validateApplicationData({ ...FORM, fullName: '  Carlos   Andrade  Mora ', phone: '+593 99-123-4567' }, TODAY), {
      fullName: 'Carlos Andrade Mora',
      nationalId: '1712345675',
      phone: '+593991234567',
      birthDate: '1995-04-20',
      vehicleType: 'moto',
      licenseNumber: 'EC-123456',
      licenseCategory: 'A',
      licenseExpiresOn: '2030-01-31',
    });
  });

  it('rechaza nombres con números, emojis o de una sola palabra', () => {
    rejects({ fullName: 'Carlos 123 Mora' }, /nombre/i);
    rejects({ fullName: 'Carlos 😀 Mora' }, /nombre/i);
    rejects({ fullName: 'Carlos' }, /nombres y apellidos/);
    rejects({ fullName: 42 }, /nombre/i);
  });

  it('exige una cédula ecuatoriana válida: provincia, tercer dígito y dígito verificador', () => {
    rejects({ nationalId: '12345' }, /10 dígitos/);
    rejects({ nationalId: '17123456ab' }, /10 dígitos/);
    rejects({ nationalId: '-171234567' }, /10 dígitos/);
    rejects({ nationalId: '1712345.75' }, /10 dígitos/);
    rejects({ nationalId: '1️⃣7123456' }, /10 dígitos/);
    rejects({ nationalId: '1712345678' }, /ecuatoriana/); // dígito verificador incorrecto
    rejects({ nationalId: '0000000000' }, /ecuatoriana/);
    rejects({ nationalId: '2512345675' }, /ecuatoriana/); // provincia 25 no existe
    rejects({ nationalId: '1762345675' }, /ecuatoriana/); // tercer dígito 6 (no es persona natural)
    for (const valid of ['1712345675', '1723456784', '0912345675', '3012345678']) {
      assert.equal(isValidEcuadorianNationalId(valid), true, valid);
    }
  });

  it('isValidEcuadorianNationalId acepta cédulas reales de ejemplo y rechaza las alteradas', () => {
    assert.equal(isValidEcuadorianNationalId('1710034065'), true);
    assert.equal(isValidEcuadorianNationalId('1710034066'), false);
    assert.equal(isValidEcuadorianNationalId('171003406'), false);
    assert.equal(isValidEcuadorianNationalId('17100340650'), false);
    assert.equal(isValidEcuadorianNationalId('abcdefghij'), false);
  });

  it('el teléfono solo admite dígitos, un + inicial y separadores entre dígitos', () => {
    rejects({ phone: '12345' }, /teléfono/i);
    rejects({ phone: '09912abc45' }, /teléfono/i);
    rejects({ phone: '-0991234567' }, /teléfono/i);
    rejects({ phone: '099--1234567' }, /teléfono/i);
    rejects({ phone: '0991234567-' }, /teléfono/i);
    rejects({ phone: '099.123.4567' }, /teléfono/i);
    rejects({ phone: '099 123 4567 😀' }, /teléfono/i);
    rejects({ phone: '+(593) 991234567' }, /teléfono/i);
    rejects({ phone: '0'.repeat(16) }, /teléfono/i);
    assert.equal(validateApplicationData({ ...FORM, phone: '099 123-4567' }, TODAY).phone, '0991234567');
  });

  it('exige mayoría de edad con el límite exacto de 18 años', () => {
    assert.doesNotThrow(() => validateApplicationData({ ...FORM, birthDate: '2008-11-16' }, TODAY));
    rejects({ birthDate: '2008-11-17' }, /18 años/);
    rejects({ birthDate: '1995-02-31' }, /calendario/);
    rejects({ birthDate: '20/04/1995' }, /AAAA-MM-DD/);
    rejects({ birthDate: '1900-01-01' }, /no es válida/);
  });

  it('valida vehículo, categoría y número de licencia', () => {
    rejects({ vehicleType: 'avion' }, /vehículo/);
    rejects({ licenseCategory: 'Z' }, /categoría/);
    rejects({ licenseNumber: 'AB' }, /licencia/);
    rejects({ licenseNumber: 'AB<script>' }, /licencia/);
    rejects({ licenseNumber: '-ABC123' }, /licencia/);
    rejects({ licenseNumber: 'ABC--123' }, /licencia/);
    rejects({ licenseNumber: 'ABC123-' }, /licencia/);
    rejects({ licenseNumber: 'ABC 😀 123' }, /licencia/);
    rejects({ licenseNumber: 'A'.repeat(21) }, /licencia/);
    rejects({ licenseCategory: 'A1; DROP' }, /categoría/);
    rejects({ licenseCategory: 7 }, /categoría/);
  });

  it('rechaza una licencia caducada o que caduca hoy', () => {
    assert.doesNotThrow(() => validateApplicationData({ ...FORM, licenseExpiresOn: '2026-11-17' }, TODAY));
    rejects({ licenseExpiresOn: TODAY }, /caducada/);
    rejects({ licenseExpiresOn: '2020-01-01' }, /caducada/);
    rejects({ licenseExpiresOn: '2030-13-01' }, /calendario/);
  });
});

describe('solicitud de conductor · utilidades', () => {
  it('valida fechas del calendario, incluidos años bisiestos', () => {
    assert.equal(isValidIsoDate('2024-02-29'), true);
    assert.equal(isValidIsoDate('2026-02-29'), false);
    assert.equal(isValidIsoDate('2026-4-1'), false);
  });

  it('resta años cuidando el 29 de febrero', () => {
    assert.equal(subtractYears('2026-11-16', 18), '2008-11-16');
    assert.equal(subtractYears('2024-02-29', 1), '2023-02-28');
  });

  it('todayInEcuador usa la zona horaria de Guayaquil', () => {
    // 02:00 UTC del día 17 todavía es el día 16 en Ecuador (UTC-5).
    assert.equal(todayInEcuador(new Date('2026-11-17T02:00:00Z')), '2026-11-16');
    assert.equal(todayInEcuador(new Date('2026-11-17T06:00:00Z')), '2026-11-17');
  });

  it('reconoce JPEG y PNG por su firma y nada más', () => {
    assert.equal(detectImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00])), 'image/jpeg');
    assert.equal(detectImageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])), 'image/png');
    assert.equal(detectImageType(new TextEncoder().encode('GIF89a')), null);
    assert.equal(detectImageType(new TextEncoder().encode('<svg onload="alert(1)">')), null);
    assert.equal(detectImageType(new TextEncoder().encode('%PDF-1.7')), null);
    assert.equal(detectImageType(new Uint8Array()), null);
    assert.equal(detectImageType(Uint8Array.from([0xff, 0xd8])), null);
  });

  it('valida el tipo de archivo y el identificador', () => {
    assert.equal(validateFileKind('license'), 'license');
    assert.equal(validateFileKind('photo'), 'photo');
    assert.throws(() => validateFileKind('cedula'), ApplicationError);
    assert.throws(() => validateFileKind(undefined), ApplicationError);
    assert.equal(validateApplicationId('11111111-1111-4111-8111-111111111111'), '11111111-1111-4111-8111-111111111111');
    assert.throws(() => validateApplicationId('no-es-uuid'), ApplicationError);
  });
});

describe('solicitud de conductor · almacenamiento en disco', () => {
  it('guarda, lee y borra solo con claves generadas por el servidor', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'courier-app-'));
    try {
      const storage = new DiskFileStorage(join(dir, 'privada'));
      const key = `${'a'.repeat(32)}.png`;
      assert.equal(await storage.read(key), null);
      await storage.save(key, Uint8Array.from([1, 2, 3]));
      assert.deepEqual([...(await storage.read(key))!], [1, 2, 3]);
      // Nunca sobrescribe un archivo existente.
      await assert.rejects(() => storage.save(key, Uint8Array.from([9])), ApplicationError);
      await storage.delete(key);
      await storage.delete(key);
      assert.equal(await storage.read(key), null);
      assert.deepEqual(await readdir(join(dir, 'privada')), []);

      for (const bad of ['../secreto.png', 'a/b.png', `${'a'.repeat(32)}.exe`, `${'A'.repeat(32)}.png`, 'corto.png', '']) {
        await assert.rejects(() => storage.save(bad, Uint8Array.from([1])), ApplicationError);
        await assert.rejects(() => storage.read(bad), ApplicationError);
        await assert.rejects(() => storage.delete(bad), ApplicationError);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
