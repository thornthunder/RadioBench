import { X509Certificate } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { generate } from 'selfsigned';

/** How long a new certificate is good for: within what browsers on phones accept. */
const VALID_DAYS = 730;
/** A certificate this close to expiry is replaced. */
const RENEW_BEFORE_DAYS = 30;

export interface Certificate {
  /** Private key in PEM. */
  key: string;
  /** Certificate in PEM. */
  cert: string;
  /** Whether it was made just now, as opposed to read from disk. */
  created: boolean;
  /** Why it was made, when it was. */
  reason: string | null;
}

/** The names this PC answers to: for the certificate to match whichever one a browser uses. */
export function ownNames(): { hosts: string[]; ips: string[] } {
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((address) => address?.family === 'IPv4' && !address.internal)
    .map((address) => address?.address ?? '');
  const host = hostname().toLowerCase();
  return { hosts: [...new Set(['localhost', host, `${host}.local`])], ips: ['127.0.0.1', ...ips] };
}

/** What a certificate on disk lacks to be used, or null if it will do. */
function shortcoming(pem: string, names: { hosts: string[]; ips: string[] }): string | null {
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(pem);
  } catch {
    return 'the certificate on disk cannot be read';
  }
  const expiry = new Date(certificate.validTo).getTime();
  if (expiry - Date.now() < RENEW_BEFORE_DAYS * 86_400_000) return 'the certificate is expiring';
  const covered = certificate.subjectAltName ?? '';
  const missing = [
    ...names.hosts.filter((host) => !covered.includes(`DNS:${host}`)),
    ...names.ips.filter((ip) => !covered.includes(`IP Address:${ip}`)),
  ];
  return missing.length === 0 ? null : `the certificate does not name ${missing.join(', ')}`;
}

/**
 * The server's own certificate, read from `dir` or made there: self-signed, naming this PC's
 * hostname and addresses, so that a browser that has been told to trust it is then quiet.
 */
export async function loadCertificate(dir: string, names = ownNames()): Promise<Certificate> {
  const keyPath = join(dir, 'radiobench.key');
  const certPath = join(dir, 'radiobench.crt');
  let reason: string;
  try {
    const key = readFileSync(keyPath, 'utf8');
    const cert = readFileSync(certPath, 'utf8');
    const problem = shortcoming(cert, names);
    if (problem === null) return { key, cert, created: false, reason: null };
    reason = problem;
  } catch {
    reason = 'there was no certificate yet';
  }

  const notBeforeDate = new Date(Date.now() - 86_400_000);
  const pems = await generate([{ name: 'commonName', value: 'RadioBench' }], {
    keyType: 'ec',
    algorithm: 'sha256',
    notBeforeDate,
    notAfterDate: new Date(notBeforeDate.getTime() + VALID_DAYS * 86_400_000),
    extensions: [
      // Marked as its own authority, which is what lets it be installed as a trusted root.
      { name: 'basicConstraints', cA: true, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, keyCertSign: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          ...names.hosts.map((host) => ({ type: 2 as const, value: host })),
          ...names.ips.map((ip) => ({ type: 7 as const, ip })),
        ],
      },
    ],
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(keyPath, pems.private, { mode: 0o600 });
  writeFileSync(certPath, pems.cert);
  return { key: pems.private, cert: pems.cert, created: true, reason };
}
