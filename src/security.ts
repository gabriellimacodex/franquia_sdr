import { createHmac, timingSafeEqual } from 'node:crypto';

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function verifySignature(raw: Buffer, signature: unknown, secret: string): boolean {
  return !!secret && typeof signature === 'string' && /^[a-f0-9]{64}$/i.test(signature)
    && equal(createHmac('sha256', secret).update(raw).digest('hex'), signature.toLowerCase());
}
export function tokenMatches(header: unknown, token: string | undefined): boolean {
  return !!token && typeof header === 'string' && equal(header, `Bearer ${token}`);
}

export class ServiceError extends Error {
  constructor(public code: string, public statusCode = 400) { super(code); }
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string } };
export async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try { return { ok: true, value: await fn() }; }
  catch (error) { return { ok: false, error: { code: error instanceof ServiceError ? error.code : 'UPSTREAM_UNAVAILABLE' } }; }
}
