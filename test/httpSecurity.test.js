import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  MAX_JSON_BYTES,
  SECURITY_HEADERS,
  applySecurityHeaders,
  enforceOrigin,
  isContainedPath,
  publicError,
  readEmptyJsonBody,
  readJsonBody,
  resolvePublicPath
} from '../src/httpSecurity.js';

function request(body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  req.headers = headers;
  return req;
}

function jsonOfSize(size) {
  const fixed = Buffer.byteLength('{"value":""}');
  return `{"value":"${'x'.repeat(size - fixed)}"}`;
}

test('JSON parser enforces media type, exact byte ceiling, malformed JSON, and required bodies', async () => {
  const exact = jsonOfSize(MAX_JSON_BYTES);
  assert.equal(Buffer.byteLength(exact), MAX_JSON_BYTES);
  assert.equal((await readJsonBody(request(exact, { 'content-type': 'application/json; charset = UTF-8' }))).value.length > 0, true);
  await assert.rejects(readJsonBody(request(jsonOfSize(MAX_JSON_BYTES + 1), { 'content-type': 'application/json' })), error => error.status === 413);
  await assert.rejects(readJsonBody(request('{}', { 'content-type': 'application/problem+json' })), error => error.status === 415);
  await assert.rejects(readJsonBody(request('{', { 'content-type': 'application/json' })), error => error.status === 400);
  await assert.rejects(readJsonBody(request('', { 'content-type': 'application/json' })), error => error.status === 400);
  await assert.rejects(readJsonBody(request('{}', { 'content-type': 'text/plain' })), error => error.status === 415);

  const aborted = new Readable({ read() { this.destroy(new Error('connection aborted')); } });
  aborted.headers = { 'content-type': 'application/json' };
  await assert.rejects(readJsonBody(aborted), error => error.status === 400 && !error.message.includes('aborted'));
});

test('bodyless routes accept no body or an empty JSON object only', async () => {
  assert.deepEqual(await readEmptyJsonBody(request()), {});
  assert.deepEqual(await readEmptyJsonBody(request('{}', { 'content-type': 'application/json', 'content-length': '2' })), {});
  await assert.rejects(readEmptyJsonBody(request('{"x":1}', { 'content-type': 'application/json', 'content-length': '7' })), error => error.status === 400);
  await assert.rejects(readEmptyJsonBody(request('{}', { 'content-type': 'text/plain', 'content-length': '2' })), error => error.status === 415);
});

test('origin policy is exact for direct and configured reverse-proxy origins', () => {
  assert.doesNotThrow(() => enforceOrigin({ headers: { host: 'tap.local:3005' } }));
  assert.doesNotThrow(() => enforceOrigin({ headers: { host: 'tap.local:3005', origin: 'http://tap.local:3005' } }));
  assert.doesNotThrow(() => enforceOrigin({ headers: { host: 'internal:3000', origin: 'https://tap.example' } }, 'https://tap.example'));
  for (const origin of ['null', 'http://evil.example', 'https://tap.example/', 'not-an-origin']) {
    assert.throws(() => enforceOrigin({ headers: { host: 'tap.local:3005', origin } }), error => error.status === 403);
  }
});

test('the complete approved header set is applied without CORS authorization or HSTS', () => {
  const headers = new Map();
  applySecurityHeaders({ setHeader: (key, value) => headers.set(key.toLowerCase(), value) });
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(headers.get(name.toLowerCase()), value);
  const csp = headers.get('content-security-policy');
  for (const directive of ["script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "frame-src 'none'"]) assert.match(csp, new RegExp(directive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(headers.has('access-control-allow-origin'), false);
  assert.equal(headers.has('strict-transport-security'), false);
});

test('public errors hide internal exception details', () => {
  const seeded = new Error('SQLITE /private/path bearer-secret PIN=2468\nstack details');
  assert.deepEqual(publicError(seeded), { status: 500, message: 'Internal server error' });
});

test('static resolution rejects encoded traversal, malformed encodings, NUL, backslashes, and prefix collisions', () => {
  const root = path.resolve('/srv/tapboard/public');
  assert.equal(resolvePublicPath(root, '/app.js'), path.join(root, 'app.js'));
  assert.throws(() => resolvePublicPath(root, '/..%2farchitecture.md'), error => error.status === 403);
  assert.throws(() => resolvePublicPath(root, '/%E0%A4%A'), error => error.status === 400);
  assert.throws(() => resolvePublicPath(root, '/bad%00name'), error => error.status === 400);
  assert.throws(() => resolvePublicPath(root, '/..%5csecret'), error => error.status === 400);
  assert.equal(isContainedPath(root, path.resolve('/srv/tapboard/publicity/secret')), false);
  assert.equal(isContainedPath(root, path.join(root, 'nested', 'asset.js')), true);

  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'tapboard-static-security-'));
  const publicRoot = path.join(sandbox, 'public');
  const outside = path.join(sandbox, 'outside.txt');
  mkdirSync(publicRoot);
  writeFileSync(outside, 'private');
  const link = path.join(publicRoot, 'escape.txt');
  symlinkSync(outside, link);
  assert.equal(isContainedPath(realpathSync(publicRoot), realpathSync(link)), false);
});
