import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { Agent, fetch as undiciFetch, type RequestInit } from 'undici';
import { ROOT } from './config.js';

const extraCa = fs.readFileSync(path.join(ROOT, 'certs', 'russian-trusted-ca.pem'), 'utf8');

export const httpAgent = new Agent({ connect: { ca: [...tls.rootCertificates, extraCa] } });

export function secureFetch(url: string, init: RequestInit = {}) {
  return undiciFetch(url, { ...init, dispatcher: httpAgent });
}
