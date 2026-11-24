/* Minimal ZIP writer (store method, UTF-8 names). No dependencies.
   Used for 3MF and print-plan bundles. */
(function (root) {
  'use strict';
  const CS = root.CS = root.CS || {};

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function utf8(str) { return new TextEncoder().encode(str); }

  function dosDateTime(date) {
    const d = date || new Date();
    const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
    const day = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    return { time, day };
  }

  const ZIP32_MAX = 0xFFFFFFFF;
  function capErr() { const e = new Error('模型超过 ZIP32 4GB 上限：几何过大。请降低精度（如 2× 而非 4×）或减小成品尺寸。'); e.zipCapacity = true; return e; }

  // F-EXP-01: a file may carry its payload as `parts` (array of Uint8Array) + `size`
  // so the exporter can stream the model XML without materializing one full buffer.
  function rawOf(file) {
    if (file.parts) return { size: file.size, parts: file.parts };
    const data = typeof file.data === 'string' ? utf8(file.data) : file.data;
    return { size: data.length, parts: [data] };
  }
  function crc32Parts(parts) {
    let crc = 0xFFFFFFFF;
    for (const bytes of parts) for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function concatParts(parts, size) { const out = new Uint8Array(size); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }
  async function compressParts(parts) {
    if (typeof CompressionStream === 'undefined' || typeof Response === 'undefined' || typeof Blob === 'undefined') return null;
    try {
      const stream = new Blob(parts).stream().pipeThrough(new CompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (e) { return null; }
  }

  function createZip(files) {
    const packed = [];
    for (const file of files) {
      const r = rawOf(file);
      if (r.size > ZIP32_MAX) throw capErr();
      const raw = concatParts(r.parts, r.size);
      packed.push({ name: utf8(file.name), rawSize: r.size, crc: crc32(raw), stored: raw, method: 0 });
    }
    return assemble(packed);
  }

  // Compress large text payloads (3D model XML) with DEFLATE, streaming the parts so
  // the full uncompressed buffer is never duplicated. CRC is accumulated incrementally.
  async function createZipAsync(files) {
    const packed = [];
    for (const file of files) {
      const r = rawOf(file);
      if (r.size > ZIP32_MAX) throw capErr();
      const crc = crc32Parts(r.parts);
      let stored = null, method = 0;
      if (r.size > 512) {
        const z = await compressParts(r.parts);
        if (z && z.length < r.size) { stored = z; method = 8; }
      }
      if (!stored) stored = concatParts(r.parts, r.size);
      packed.push({ name: utf8(file.name), rawSize: r.size, crc, stored, method });
    }
    return assemble(packed);
  }

  function assemble(packed) {
    // F-EXP-01: ZIP32 capacity guard before writing 32-bit header fields.
    let totalStored = 0;
    for (const e of packed) {
      if (e.rawSize > ZIP32_MAX || e.stored.length > ZIP32_MAX) throw capErr();
      totalStored += e.stored.length;
    }
    if (packed.length > 0xFFFF || totalStored > ZIP32_MAX) throw capErr();
    const chunks = [];
    const central = [];
    let offset = 0;
    const { time, day } = dosDateTime(new Date());
    for (const e of packed) {
      const name = e.name, data = e.stored, crc = e.crc, method = e.method, rawSize = e.rawSize;
      const local = new Uint8Array(30 + name.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034B50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, method, true);
      lv.setUint16(10, time, true);
      lv.setUint16(12, day, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, rawSize, true);
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);
      local.set(name, 30);
      chunks.push(local, data);

      const cd = new Uint8Array(46 + name.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014B50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, method, true);
      cv.setUint16(12, time, true);
      cv.setUint16(14, day, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, rawSize, true);
      cv.setUint16(28, name.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      cd.set(name, 46);
      central.push(cd);
      offset += local.length + data.length;
    }
    const centralSize = central.reduce((sum, c) => sum + c.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054B50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, packed.length, true);
    ev.setUint16(10, packed.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);
    const total = chunks.reduce((s, c) => s + c.length, 0) + centralSize + eocd.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) { out.set(c, pos); pos += c.length; }
    for (const c of central) { out.set(c, pos); pos += c.length; }
    out.set(eocd, pos);
    return out;
  }

  CS.zip = { createZip, createZipAsync, crc32 };
})(typeof globalThis !== 'undefined' ? globalThis : this);
