import { crc32 } from 'node:zlib';

export type ScreenshotType = 'image/png' | 'image/jpeg';

const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const jpegFrames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function validSize(width: number, height: number) {
  return width > 0 && height > 0 && width * height <= 40_000_000;
}

function isPng(bytes: Buffer) {
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(pngSignature) ||
    bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR' ||
    !validSize(bytes.readUInt32BE(16), bytes.readUInt32BE(20))) return false;

  let hasData = false;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset);
    const checksumAt = offset + size + 8;
    if (checksumAt + 4 > bytes.length ||
      bytes.readUInt32BE(checksumAt) !== crc32(bytes.subarray(offset + 4, checksumAt))) return false;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    offset = checksumAt + 4;
    if (type === 'IEND') return hasData && size === 0 && offset === bytes.length;
    if (type === 'IDAT' && size > 0) hasData = true;
  }
  return false;
}

function isJpeg(bytes: Buffer) {
  if (bytes.length < 16 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) {
    return false;
  }
  let hasFrame = false;
  for (let offset = 2; offset + 4 < bytes.length;) {
    if (bytes[offset++] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0 || marker === 0xd8 || marker === 0xd9 || offset + 2 > bytes.length) return false;
    const size = bytes.readUInt16BE(offset);
    if (size < 2 || offset + size > bytes.length - 2) return false;
    if (jpegFrames.has(marker)) {
      if (size < 11 || !validSize(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3))) return false;
      hasFrame = true;
    }
    if (marker === 0xda) return hasFrame && size >= 6 && offset + size < bytes.length - 2;
    offset += size;
  }
  return false;
}

export function isScreenshot(bytes: Buffer, mime: ScreenshotType) {
  return mime === 'image/png' ? isPng(bytes) : isJpeg(bytes);
}
