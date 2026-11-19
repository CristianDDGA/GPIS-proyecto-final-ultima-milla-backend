import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectImageType, readImageSize } from '../../src/shared/image-type.js';

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function jpeg(width: number, height: number, extraSegment = false): Buffer {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const comment = extraSegment ? [0xff, 0xfe, 0x00, 0x06, 0x68, 0x6f, 0x6c, 0x61] : [];
  const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 255, height & 255, (width >> 8) & 255, width & 255, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01];
  return Buffer.from([0xff, 0xd8, ...app0, ...comment, ...sof0]);
}

test('detectImageType reconoce JPEG y PNG por su firma y nada más', () => {
  assert.equal(detectImageType(png(10, 10)), 'image/png');
  assert.equal(detectImageType(jpeg(10, 10)), 'image/jpeg');
  for (const bytes of [
    Buffer.from('GIF89a......'),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    Buffer.from('MZ\u0090\u0000ejecutable'),
    Buffer.from('%PDF-1.7'),
    Buffer.from([0xff, 0xd8]),
    Buffer.alloc(0),
  ]) {
    assert.equal(detectImageType(bytes), null);
  }
});

test('readImageSize lee ancho y alto de un PNG', () => {
  assert.deepEqual(readImageSize(png(300, 200), 'image/png'), { width: 300, height: 200 });
  assert.deepEqual(readImageSize(png(4096, 4096), 'image/png'), { width: 4096, height: 4096 });
});

test('readImageSize lee ancho y alto de un JPEG, incluso con segmentos intermedios', () => {
  assert.deepEqual(readImageSize(jpeg(640, 480), 'image/jpeg'), { width: 640, height: 480 });
  assert.deepEqual(readImageSize(jpeg(1920, 1080, true), 'image/jpeg'), { width: 1920, height: 1080 });
});

test('readImageSize devuelve null con cabeceras dañadas, truncadas o con dimensión cero', () => {
  assert.equal(readImageSize(png(0, 100), 'image/png'), null);
  assert.equal(readImageSize(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(4)]), 'image/png'), null);
  const noHeader = Buffer.alloc(40);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(noHeader, 0);
  assert.equal(readImageSize(noHeader, 'image/png'), null);
  assert.equal(readImageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg'), null);
  assert.equal(readImageSize(Buffer.from([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]), 'image/jpeg'), null);
});

test('readImageSize no se cuelga con un JPEG hostil de longitudes inválidas', () => {
  const hostile = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xe0, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]);
  assert.equal(readImageSize(hostile, 'image/jpeg'), null);
});
