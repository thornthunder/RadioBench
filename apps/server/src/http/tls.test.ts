import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { loadCertificate, ownNames } from './tls.ts';

const names = { hosts: ['localhost', 'shack'], ips: ['127.0.0.1', '192.168.0.166'] };
let dir: string;

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('makes a certificate naming the PC, keeps it, and replaces it when it falls short', async () => {
  dir = mkdtempSync(join(tmpdir(), 'radiobench-tls-'));

  const made = await loadCertificate(dir, names);
  expect(made).toMatchObject({ created: true, reason: 'there was no certificate yet' });
  const certificate = new X509Certificate(made.cert);
  expect(certificate.subject).toContain('CN=RadioBench');
  expect(certificate.subjectAltName).toContain('DNS:shack');
  expect(certificate.subjectAltName).toContain('IP Address:192.168.0.166');
  expect(
    certificate.checkPrivateKey(
      await import('node:crypto').then((c) => c.createPrivateKey(made.key)),
    ),
  ).toBe(true);
  const years = (new Date(certificate.validTo).getTime() - Date.now()) / (365 * 86_400_000);
  expect(years).toBeGreaterThan(1.9);
  expect(years).toBeLessThan(2.1);

  const kept = await loadCertificate(dir, names);
  expect(kept).toEqual({ ...made, created: false, reason: null });

  const moved = await loadCertificate(dir, { ...names, ips: [...names.ips, '10.0.0.5'] });
  expect(moved.created).toBe(true);
  expect(moved.reason).toBe('the certificate does not name 10.0.0.5');
  expect(moved.cert).not.toBe(made.cert);

  writeFileSync(join(dir, 'radiobench.crt'), 'not a certificate');
  const replaced = await loadCertificate(dir, names);
  expect(replaced).toMatchObject({
    created: true,
    reason: 'the certificate on disk cannot be read',
  });
}, 30_000);

test('the names of this PC include localhost and its hostname', () => {
  const own = ownNames();
  expect(own.hosts[0]).toBe('localhost');
  expect(own.hosts.length).toBeGreaterThanOrEqual(2);
  expect(own.ips[0]).toBe('127.0.0.1');
});
