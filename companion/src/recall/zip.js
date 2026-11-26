'use strict';
// Just enough ZIP reading for export archives: list the entries from the
// central directory, then read one entry at a time. Random access, so a 4 GB
// Google Takeout is not read into memory to find one JSON file. ZIP64, stored
// and deflated entries; nothing else (no encryption, no other compression).
//
// Source: a file path, or a Buffer (an archive nested inside another one).
const fs = require('fs');
const zlib = require('zlib');

const EOCD = 0x06054b50, EOCD64 = 0x06064b50, EOCD64_LOC = 0x07064b50, CEN = 0x02014b50, LOC = 0x04034b50;

function openSource(src) {
  if (Buffer.isBuffer(src)) return { size: src.length, read: (pos, len) => src.subarray(pos, Math.min(src.length, pos + len)), close: () => {} };
  const fd = fs.openSync(src, 'r');
  const size = fs.fstatSync(fd).size;
  return {
    size,
    read(pos, len) { const buf = Buffer.alloc(Math.max(0, Math.min(len, size - pos))); fs.readSync(fd, buf, 0, buf.length, pos); return buf; },
    close() { try { fs.closeSync(fd); } catch (_) { /* closed */ } },
  };
}
const u64 = (buf, at) => Number(buf.readBigUInt64LE(at));

// -> { entries: [{ name, size, csize, method, offset }], read(entry, max) -> Buffer, close() }.
// Throws on anything that is not a readable ZIP.
function openZip(src) {
  const s = openSource(src);
  try {
    if (s.size < 22) throw new Error('not a zip');
    const tailLen = Math.min(s.size, 65557);
    const tail = s.read(s.size - tailLen, tailLen);
    let at = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === EOCD) { at = i; break; }
    if (at < 0) throw new Error('not a zip');
    let count = tail.readUInt16LE(at + 10), cdSize = tail.readUInt32LE(at + 12), cdOff = tail.readUInt32LE(at + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
      const locAt = s.size - tailLen + at - 20;
      const loc = s.read(locAt, 20);
      if (loc.length === 20 && loc.readUInt32LE(0) === EOCD64_LOC) {
        const rec = s.read(u64(loc, 8), 56);
        if (rec.readUInt32LE(0) !== EOCD64) throw new Error('bad zip64 record');
        count = u64(rec, 32); cdSize = u64(rec, 40); cdOff = u64(rec, 48);
      }
    }
    if (cdSize > 512 * 1024 * 1024) throw new Error('zip directory too large');
    const cd = s.read(cdOff, cdSize);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== CEN) throw new Error('bad zip directory');
      const method = cd.readUInt16LE(p + 10);
      let csize = cd.readUInt32LE(p + 20), size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
      let offset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen).replace(/\\/g, '/');
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const id = cd.readUInt16LE(e), len = cd.readUInt16LE(e + 2);
        if (id === 1) {
          let q = e + 4;
          if (size === 0xffffffff) { size = u64(cd, q); q += 8; }
          if (csize === 0xffffffff) { csize = u64(cd, q); q += 8; }
          if (offset === 0xffffffff) { offset = u64(cd, q); }
        }
        e += 4 + len;
      }
      if (!name.endsWith('/')) entries.push({ name, size, csize, method, offset });
      p = end + commentLen;
    }
    function read(entry, max = 300 * 1024 * 1024) {
      if (entry.size > max) throw new Error(entry.name + ' is larger than ' + Math.round(max / 1048576) + ' MB');
      const head = s.read(entry.offset, 30);
      if (head.length < 30 || head.readUInt32LE(0) !== LOC) throw new Error('bad zip entry ' + entry.name);
      const data = s.read(entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28), entry.csize);
      if (entry.method === 0) return data;
      if (entry.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: Math.max(entry.size, 1) });
      throw new Error('unsupported compression in ' + entry.name);
    }
    return { entries, read, close: s.close };
  } catch (e) { s.close(); throw e; }
}

module.exports = { openZip };
