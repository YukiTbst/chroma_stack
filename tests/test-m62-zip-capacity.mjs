/* F-EXP-01 contract: the ZIP writer must refuse entries beyond the ZIP32 4GB limit
   with an actionable error (zipCapacity flag) instead of silently overflowing the
   32-bit header. A fake oversized length exercises the guard without allocating 4GB.
   Run: node tests/test-m62-zip-capacity.mjs */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
for (const m of ['color', 'zip']) require('../app/js/' + m + '.js');
const Z = globalThis.CS.zip;

/* oversized single entry -> reject with zipCapacity, no corrupt output. */
{
  const fake = { name: '3D/3dmodel.model', data: { length: 0x100000000 } }; // 4GB + 1
  let caught = null;
  try { Z.createZip([fake]); } catch (e) { caught = e; }
  assert.ok(caught, 'oversized entry must throw');
  assert.equal(caught.zipCapacity, true, 'error carries zipCapacity flag');
  assert.match(caught.message, /ZIP32/, 'message names ZIP32 limit');
}

/* normal small zip still works and is readable. */
{
  const bytes = Z.createZip([{ name: 'a.txt', data: 'hello' }, { name: 'b.txt', data: 'world' }]);
  assert.ok(bytes.length > 0);
  assert.equal(bytes[0], 0x50); assert.equal(bytes[1], 0x4B); // PK local header
}

/* crc32 sanity (known vector). */
assert.equal(Z.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);

console.log('all ZIP capacity checks passed');