import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';

const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

function publicIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function ipv6Parts(address) {
  let value = address.toLowerCase().split('%', 1)[0];
  if (value.includes('.')) {
    const separator = value.lastIndexOf(':');
    const ipv4 = value.slice(separator + 1);
    if (net.isIP(ipv4) !== 4) return null;
    const bytes = ipv4.split('.').map(Number);
    value = `${value.slice(0, separator)}:${((bytes[0] << 8) | bytes[1]).toString(16)}:${(
      (bytes[2] << 8) |
      bytes[3]
    ).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const parts = [...left, ...Array(missing).fill('0'), ...right].map((part) => Number.parseInt(part, 16));
  return parts.length === 8 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 0xffff)
    ? parts
    : null;
}

export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return publicIpv4(address);
  if (family !== 6) return false;
  const parts = ipv6Parts(address);
  if (!parts) return false;
  const [a, b, c, d, e, f, g, h] = parts;
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    return publicIpv4(`${g >> 8}.${g & 255}.${h >> 8}.${h & 255}`);
  }
  return !(
    (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0) ||
    (a === 0x64 && b === 0xff9b) ||
    (a === 0x100 && b === 0 && c === 0 && d === 0) ||
    (a === 0x2001 && b <= 0x01ff) ||
    (a === 0x2001 && b === 0x0db8) ||
    a === 0x2002 ||
    (a & 0xfe00) === 0xfc00 ||
    (a & 0xffc0) === 0xfe80 ||
    (a & 0xffc0) === 0xfec0 ||
    (a & 0xff00) === 0xff00
  );
}

function safeUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Unsafe image URL');
  return url;
}

function requestImage(url, { timeoutMs, remainingRedirects }) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8' },
      timeout: timeoutMs,
      lookup(hostname, options, callback) {
        dns.lookup(hostname, options, (error, address, family) => {
          if (error) callback(error);
          else if (!isPublicAddress(address)) callback(new Error('Image host did not resolve publicly'));
          else callback(null, address, family);
        });
      }
    });
    request.once('timeout', () => request.destroy(new Error('Image request timed out')));
    request.once('error', reject);
    request.once('response', (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (remainingRedirects <= 0) return reject(new Error('Too many image redirects'));
        let redirected;
        try {
          redirected = safeUrl(new URL(response.headers.location, url).href);
        } catch (error) {
          return reject(error);
        }
        requestImage(redirected, { timeoutMs, remainingRedirects: remainingRedirects - 1 }).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error('Image request failed'));
        return;
      }
      const contentType = String(response.headers['content-type'] || '')
        .split(';', 1)[0]
        .trim()
        .toLowerCase();
      if (!ALLOWED_TYPES.has(contentType)) {
        response.resume();
        reject(new Error('Unsupported image type'));
        return;
      }
      const declared = Number(response.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
        response.destroy();
        reject(new Error('Image response too large'));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_IMAGE_BYTES) response.destroy(new Error('Image response too large'));
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => resolve({ contentType, body: Buffer.concat(chunks, size) }));
    });
  });
}

export async function fetchCachedImage(url, { timeoutMs = 5_000 } = {}) {
  return await requestImage(safeUrl(url), { timeoutMs, remainingRedirects: MAX_REDIRECTS });
}
