import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildZip } from '../src/server/http/zip.js';

/** Minimal ZIP reader for the round-trip test (stored entries only). */
function readZip(buf: Buffer): Array<{ name: string; data: Buffer }> {
  const entries = [];
  let o = 0;
  while (buf.readUInt32LE(o) === 0x04034b50) {
    const nameLen = buf.readUInt16LE(o + 26);
    const extraLen = buf.readUInt16LE(o + 28);
    const size = buf.readUInt32LE(o + 18);
    const name = buf.subarray(o + 30, o + 30 + nameLen).toString('utf8');
    const data = buf.subarray(o + 30 + nameLen + extraLen, o + 30 + nameLen + extraLen + size);
    entries.push({ name, data: Buffer.from(data) });
    o += 30 + nameLen + extraLen + size;
  }
  if (buf.readUInt32LE(o) !== 0x02014b50) throw new Error('central directory missing');
  return entries;
}

describe('zip', () => {
  it('round-trips stored entries with names and bytes intact', () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const manifest = Buffer.from(JSON.stringify({ job: 'j1' }));
    const zip = buildZip([
      { name: 'adfit-ig-feed-11-1.png', data: png },
      { name: 'manifest.json', data: manifest },
    ]);
    const back = readZip(zip);
    expect(back.map((e) => e.name)).toEqual(['adfit-ig-feed-11-1.png', 'manifest.json']);
    expect(back[0]?.data.equals(png)).toBe(true);
    expect(back[1]?.data.equals(manifest)).toBe(true);
    expect(z.string().parse(back[1]?.data.toString())).toContain('j1');
  });

  it('writes flags and method in the right local-header fields (macOS Archive Utility rejects a wrong method)', () => {
    const zip = buildZip([{ name: 'a.png', data: Buffer.from([1, 2, 3]) }]);
    expect(zip.readUInt16LE(6)).toBe(0x0800); // general purpose flags: UTF-8 names
    expect(zip.readUInt16LE(8)).toBe(0); // compression method: stored
    const cd = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(zip.readUInt16LE(cd + 8)).toBe(0x0800);
    expect(zip.readUInt16LE(cd + 10)).toBe(0);
  });
});
