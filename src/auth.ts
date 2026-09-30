import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { env, houses, houseById, housesOfUk, TEST_USERS, type House } from './config.js';
import { db, type Membership } from './store.js';

type AuthKind = 'max' | 'test' | 'dev';
export interface AuthUser { id: string; kind: AuthKind; firstName?: string }

declare global {
  namespace Express {
    interface Request { user: AuthUser; membership: Membership; house: House }
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export function checkInitData(raw: string, botToken: string, ttlSec: number, now = Date.now()): AuthUser | null {
  if (!raw || !botToken) return null;
  const pairs = raw.replace(/^[?#]/, '').split('&').filter(Boolean).map(p => {
    const i = p.indexOf('=');
    return i < 0 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)];
  });
  const hashes = pairs.filter(([k]) => k === 'hash');
  if (hashes.length !== 1 || !hashes[0][1]) return null;
  let decoded: string[][];
  try { decoded = pairs.map(([k, v]) => [k, decodeURIComponent(v)]); } catch { return null; }

  const launchParams = decoded
    .filter(([k]) => k !== 'hash')
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = crypto.createHmac('sha256', secretKey).update(launchParams).digest('hex');
  if (!safeEqual(expected, hashes[0][1].toLowerCase())) return null;

  const fields = new Map(decoded as [string, string][]);
  const authDate = Number(fields.get('auth_date'));
  if (!Number.isFinite(authDate)) return null;
  const authMs = authDate > 1e12 ? authDate : authDate * 1000;
  if (now - authMs > ttlSec * 1000 || authMs - now > 5 * 60_000) return null;

  let user: { id?: number | string; first_name?: string } = {};
  try { user = JSON.parse(fields.get('user') || '{}'); } catch { return null; }
  if (user.id == null) return null;
  return { id: String(user.id), kind: 'max', firstName: user.first_name };
}

function identify(req: Request): AuthUser | 'bad_signature' | null {
  const initData = String(req.header('x-max-init-data') || '');
  if (initData) {
    const u = checkInitData(initData, env.maxToken, env.initDataTtl);
    if (u) return u;
    if (!env.authDev) return 'bad_signature';
  }

  const testKey = String(req.header('x-test-key') || '');
  if (testKey && env.testApiKey && safeEqual(testKey, env.testApiKey)) {
    const id = String(req.header('x-test-user') || 'test-resident-1');
    const preset = TEST_USERS[id];
    if (!preset) return null;
    if (!db.membership(id)) db.attach(id, preset.houseId, preset.apartment);
    return { id, kind: 'test' };
  }

  if (env.authDev) {
    const id = String(req.header('x-debug-user') || 'demo');
    if (/^[\w-]{1,64}$/.test(id) && !TEST_USERS[id]) return { id, kind: 'dev' };
  }
  return null;
}

export function auth(req: Request, res: Response, next: NextFunction) {
  const u = identify(req);
  if (u === 'bad_signature') return res.status(401).json({ error: 'bad_signature', hint: 'Подпись MAX не прошла проверку или устарела: откройте приложение из чата с ботом заново' });
  if (!u) return res.status(401).json({ error: 'unauthorized', hint: 'Откройте мини-приложение из чата с ботом в MAX' });
  req.user = u;
  next();
}

export function requireMembership(req: Request, res: Response, next: NextFunction) {
  const m = db.membership(req.user.id);
  const h = m && houseById(m.houseId);
  if (!m || !h) return res.status(403).json({ error: 'membership_required', hint: 'Сначала выберите дом и квартиру: POST /attach' });
  req.membership = m;
  req.house = h;
  next();
}

export function dispatcherHouseIds(u: AuthUser): string[] {
  if (u.kind === 'test') return [];
  if (env.dispatcherIds.includes(u.id)) return houses.map(h => h.fiasId);
  return (db.staff(u.id)?.ukIds || []).flatMap(uk => housesOfUk(uk).map(h => h.fiasId));
}

export function isDispatcher(u: AuthUser, houseId?: string): boolean {
  const ids = dispatcherHouseIds(u);
  return houseId ? ids.includes(houseId) : ids.length > 0;
}

export function dispatcherOnly(req: Request, res: Response, next: NextFunction) {
  if (isDispatcher(req.user)) return next();
  res.status(403).json({ error: 'forbidden', hint: 'Пульт доступен только сотрудникам УК' });
}

export function ukByStaffCode(code: string): string | null {
  let found: string | null = null;
  for (const [uk, c] of Object.entries(env.staffCodes)) if (safeEqual(code, c)) found = uk;
  return found;
}
