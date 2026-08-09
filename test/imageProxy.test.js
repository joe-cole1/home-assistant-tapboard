import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchCachedImage, isPublicAddress } from '../src/imageProxy.js';

test('image proxy rejects private, reserved, loopback, and malformed addresses', () => {
  for (const address of [
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '172.16.0.1',
    '192.0.2.1',
    '192.168.1.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
    '2002:7f00:1::1',
    '64:ff9b::127.0.0.1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    'not-an-ip'
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('image proxy accepts only credential-free default-port HTTPS URLs', async () => {
  for (const url of [
    'http://example.com/image.png',
    'https://user:password@example.com/image.png',
    'https://example.com:8443/image.png',
    'not-a-url'
  ]) {
    await assert.rejects(() => fetchCachedImage(url), /Unsafe image URL|Invalid URL/);
  }
});
