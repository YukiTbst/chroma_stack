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

  function createZip(files) {
    return assemble(files, null);
  }

  async function compressRaw(data) {
    if (typeof CompressionStream === 'undefined' || typeof Response === 'undefined' || typeof Blob === 'undefined') return null;
    try {
      const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      const ab = await new Response(stream).arrayBuffer();
      return new Uint8Array(ab);
    } catch (e) {
      return null;
    }
  }

  // Compress large text payloads (3D model XML) with DEFLATE. 3MF is a ZIP,
  // and a watertight line-art mesh can be 20-40 MB as stored XML; deflate
  // brings that down by roughly 8-10x with no slicer compatibility cost.
  async function createZipAsync(files) {
    const packed = [];
    for (const file of files) {
      const name = utf8(file.name);
      const data = typeof file.data === 'string' ? utf8(file.data) : file.data;
      let stored = data, method = 0;
      if (data.length > 512) {
        const z = await compressRaw(data);
        if (z && z.length < data.length) { stored = z; method = 8; }
      }
      packed.push({ name, data, stored, method });
    }
    return assemble(packed, true);
  }

  function assemble(files, packedInput) {
    const chunks = [];
    const central = [];
    let offset = 0;
    const { time, day } = dosDateTime(new Date());
    for (const file of files) {
      const name = packedInput ? file.name : utf8(file.name);
      const raw = packedInput ? file.data : (typeof file.data === 'string' ? utf8(file.data) : file.data);
      const data = packedInput ? file.stored : raw;
      const method = packedInput ? file.method : 0;
      const crc = crc32(raw);
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
      lv.setUint32(22, raw.length, true);
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
      cv.setUint32(24, raw.length, true);
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
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
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
