import path from 'node:path';

export const MAX_JSON_BYTES = 16_384;

export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; frame-src 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy':
    'accelerometer=(), autoplay=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Permitted-Cross-Domain-Policies': 'none',
  Vary: 'Origin'
});

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function applySecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
}

function normalizedOrigin(value) {
  if (typeof value !== 'string' || value === '' || value === 'null') return null;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || value !== parsed.origin) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function enforceOrigin(req, configuredOrigin = process.env.TAPBOARD_PUBLIC_ORIGIN) {
  const supplied = req.headers.origin;
  if (!supplied) return;

  const actualOrigin = normalizedOrigin(supplied);
  const directOrigin = normalizedOrigin(`http://${req.headers.host || 'localhost'}`);
  const expectedOrigin = configuredOrigin ? normalizedOrigin(configuredOrigin) : directOrigin;
  if (!actualOrigin || !expectedOrigin || actualOrigin !== expectedOrigin) {
    throw new HttpError(403, 'Origin not allowed');
  }
}

export function isJsonContentType(value) {
  return typeof value === 'string' && /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(value);
}

function declaredLength(req) {
  const raw = req.headers['content-length'];
  if (raw === undefined) return null;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, 'Invalid request body');
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new HttpError(413, 'Request body too large');
  return value;
}

async function collectBody(req) {
  const declared = declaredLength(req);
  if (declared !== null && declared > MAX_JSON_BYTES) throw new HttpError(413, 'Request body too large');

  const chunks = [];
  let size = 0;
  try {
    for await (const rawChunk of req) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      size += chunk.length;
      if (size > MAX_JSON_BYTES) throw new HttpError(413, 'Request body too large');
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Invalid request body');
  }
  return Buffer.concat(chunks, size);
}

function parseJson(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

export async function readJsonBody(req) {
  if (!isJsonContentType(req.headers['content-type'])) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
  const body = await collectBody(req);
  if (body.length === 0) throw new HttpError(400, 'Request body is required');
  return parseJson(body);
}

export async function readEmptyJsonBody(req) {
  const declared = declaredLength(req);
  const hasTransferEncoding = req.headers['transfer-encoding'] !== undefined;
  if ((declared === null || declared === 0) && !hasTransferEncoding) return {};
  if (!isJsonContentType(req.headers['content-type'])) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
  const body = await collectBody(req);
  if (body.length === 0) return {};
  const parsed = parseJson(body);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length !== 0) {
    throw new HttpError(400, 'Invalid request body');
  }
  return parsed;
}

export async function readOptionalJsonBody(req) {
  const declared = declaredLength(req);
  const hasTransferEncoding = req.headers['transfer-encoding'] !== undefined;
  if ((declared === null || declared === 0) && !hasTransferEncoding) return {};
  if (!isJsonContentType(req.headers['content-type'])) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
  const body = await collectBody(req);
  if (body.length === 0) return {};
  return parseJson(body);
}

export function publicError(error) {
  if (error instanceof HttpError) return { status: error.status, message: error.message };
  return { status: 500, message: 'Internal server error' };
}

export function isContainedPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function resolvePublicPath(publicDir, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'Invalid request URL');
  }
  if (decoded.includes('\0') || decoded.includes('\\')) throw new HttpError(400, 'Invalid request URL');
  const relativeRequest = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const candidate = path.resolve(publicDir, relativeRequest);
  if (!isContainedPath(publicDir, candidate)) throw new HttpError(403, 'Forbidden');
  return candidate;
}
