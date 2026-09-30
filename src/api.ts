import { Router, type Request, type Response, type NextFunction } from 'express';
import QRCode from 'qrcode';
import { houses, houseById, housesOfUk, tariffsFor, tariffCities, env, miniAppUrl, type House } from './config.js';
import { db, countedVotes, quorumNeed, type Membership, type RequestStatus, type Vote } from './store.js';
import { gigaChat } from './gigachat.js';
import { auth, requireMembership, isDispatcher, dispatcherHouseIds, dispatcherOnly, ukByStaffCode } from './auth.js';
import { botActive, canMessage, sendMaxToUser } from './maxbot.js';
import { CATEGORIES } from './categories.js';
import { scanImage, sniffImage, visionStatus, VisionError } from './vision.js';
import { dispatchState, notifyRiser, planOutage, DispatchError } from './dispatch.js';
import { createRequest, changeStatus, submitMeters, anomalyLines, toNum, METER_NAMES, SETTABLE_STATUSES, ServiceError } from './services.js';
import { secureFetch } from './net.js';

export const api = Router();
const VERSION = '0.5.3';

function rateLimit(name: string, max: number, windowMs = 60_000) {
  const hits = new Map<string, number[]>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.user?.id || req.ip || 'anon';
    const now = Date.now();
    const list = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (list.length >= max) { hits.set(key, list); return res.status(429).json({ error: 'too_many_requests', scope: name }); }
    list.push(now); hits.set(key, list);
    next();
  };
}

function sendError(res: Response, e: unknown) {
  if (e instanceof ServiceError) return res.status(e.status).json({ error: e.code, ...e.extra });
  if (e instanceof DispatchError || e instanceof VisionError) return res.status(e.status).json({ error: e.code });
  console.error('Ошибка API:', e);
  return res.status(500).json({ error: 'internal' });
}

function houseBrief(h: House) {
  return { fiasId: h.fiasId, city: h.city, cityName: tariffsFor(h.city).city, address: h.address, uk: h.managementCompany.name, apartmentsCount: h.apartmentsCount };
}

function membershipBrief(m: Membership) {
  return { houseId: m.houseId, apartment: m.apartment, consentAt: m.consentAt };
}

function houseLink(h: House) {
  if (env.maxBotUsername) return `https://max.ru/${env.maxBotUsername}?startapp=${h.fiasId}`;
  return `${miniAppUrl}?startapp=${h.fiasId}`;
}

api.param('fiasId', (_req: Request, res: Response, next: NextFunction, id: string) => {
  const h = houseById(id);
  if (!h) return res.status(404).json({ error: 'house_not_found' });
  res.locals.house = h;
  next();
});

api.get('/health', async (_req: Request, res: Response) => {
  const gigachat = await gigaChat.status(3000);
  res.json({
    status: 'ok',
    version: VERSION,
    service: 'max-zhkh-dom',
    timestamp: new Date().toISOString(),
    checks: {
      maxBot: botActive() ? 'polling' : (env.botEnabled ? 'starting_or_failed' : 'disabled'),
      gigachat,
      auth: env.authDev ? 'dev_mode' : 'max_signature',
      tariffs: 'by_city_and_date',
      vision: visionStatus(gigachat),
      demoMode: env.demoMode,
      houses: houses.length,
      cities: tariffCities,
    },
  });
});

api.get('/houses', (_req: Request, res: Response) => {
  res.json(houses.map(houseBrief));
});

api.get('/houses/fias/:fiasId', (_req: Request, res: Response) => {
  res.json(res.locals.house);
});

api.get('/houses/:fiasId/qr.svg', async (_req: Request, res: Response) => {
  const svg = await QRCode.toString(houseLink(res.locals.house), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=3600').send(svg);
});

api.get('/houses/:fiasId/link', (_req: Request, res: Response) => {
  const h: House = res.locals.house;
  res.json({ link: houseLink(h), qr: `/api/v1/houses/${h.fiasId}/qr.svg`, poster: `/poster/${h.fiasId}` });
});

api.get('/tariffs', (req: Request, res: Response) => {
  const city = String(req.query.city || 'spb');
  const at = req.query.date ? new Date(String(req.query.date)) : new Date();
  if (Number.isNaN(at.getTime())) return res.status(400).json({ error: 'bad_date' });
  try { res.json(tariffsFor(city, at)); }
  catch { res.status(404).json({ error: 'no_tariffs_for_city', cities: tariffCities }); }
});

api.get('/categories', (_req: Request, res: Response) => {
  res.json(Object.entries(CATEGORIES).map(([key, v]) => ({ key, ...v })));
});

api.get('/address/suggest', auth, rateLimit('suggest', 30), async (req: Request, res: Response) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  if (!env.dadataToken) return res.json({ items: [], source: 'off' });
  if (q.length < 3) return res.json({ items: [], source: 'dadata' });
  try {
    const r = await secureFetch('https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/address', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Token ' + env.dadataToken },
      body: JSON.stringify({ query: q, count: 7, from_bound: { value: 'house' }, to_bound: { value: 'house' } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return res.status(502).json({ items: [], error: 'dadata_' + r.status });
    const data = (await r.json()) as any;
    const items = (data.suggestions || [])
      .map((s: any) => {
        const fiasId = s.data?.house_fias_id || s.data?.fias_id || '';
        return { value: s.value as string, fiasId, connected: !!houseById(fiasId) };
      })
      .filter((x: any) => x.fiasId);
    res.json({ items, source: 'dadata' });
  } catch {
    res.status(502).json({ items: [], error: 'dadata_unreachable' });
  }
});

api.get('/me', auth, (req: Request, res: Response) => {
  const m = db.membership(req.user.id);
  const h = m && houseById(m.houseId);
  const dispatchHouses = dispatcherHouseIds(req.user).map(houseById).filter((x): x is House => !!x);
  res.json({
    id: req.user.id,
    auth: req.user.kind,
    firstName: req.user.firstName || null,
    role: dispatchHouses.length ? 'dispatcher' : 'resident',
    membership: m && h ? membershipBrief(m) : null,
    house: h ? houseBrief(h) : null,
    dispatchHouses: dispatchHouses.map(houseBrief),
    staffLoginAvailable: Object.keys(env.staffCodes).length > 0 && req.user.kind !== 'test',
    addressSearch: !!env.dadataToken,
  });
});

api.post('/attach', auth, (req: Request, res: Response) => {
  const { houseId, apartment, consent } = req.body || {};
  if (consent !== true) return res.status(400).json({ error: 'consent_required' });
  const h = houseById(String(houseId || ''));
  if (!h) return res.status(404).json({ error: 'house_not_found' });
  const apt = String(apartment ?? '').trim();
  if (!/^\d{1,5}$/.test(apt) || Number(apt) < 1) return res.status(400).json({ error: 'bad_apartment' });
  if (Number(apt) > h.apartmentsCount) return res.status(400).json({ error: 'apartment_out_of_range', max: h.apartmentsCount });
  const m = db.attach(req.user.id, h.fiasId, String(Number(apt)));
  res.status(201).json({ ok: true, membership: membershipBrief(m), house: houseBrief(h) });
});

api.get('/house', auth, requireMembership, (req: Request, res: Response) => res.json(req.house));

api.post('/staff/login', auth, rateLimit('staff', 5), (req: Request, res: Response) => {
  if (req.user.kind === 'test') return res.status(403).json({ error: 'forbidden' });
  const uk = ukByStaffCode(String(req.body?.code || '').trim());
  if (!uk) return res.status(403).json({ error: 'bad_code' });
  db.grantStaff(req.user.id, uk);
  const list = housesOfUk(uk);
  res.status(201).json({ ok: true, role: 'dispatcher', uk: list[0]?.managementCompany.name || uk, houseIds: list.map(h => h.fiasId) });
});

api.get('/requests', auth, requireMembership, (req: Request, res: Response) => {
  res.json(db.requests({ userId: req.user.id, houseId: req.house.fiasId }));
});

api.post('/requests', auth, requireMembership, rateLimit('requests', 10), (req: Request, res: Response) => {
  const { category, description, title, hasPhoto } = req.body || {};
  try { res.status(201).json(createRequest(req.user.id, req.membership, { category, description, title, hasPhoto })); }
  catch (e) { sendError(res, e); }
});

api.get('/requests/:id', auth, (req: Request, res: Response) => {
  const r = db.request(String(req.params.id));
  if (!r || (r.userId !== req.user.id && !isDispatcher(req.user, r.houseId))) return res.status(404).json({ error: 'request_not_found' });
  res.json(r);
});

api.patch('/requests/:id', auth, async (req: Request, res: Response) => {
  if (!isDispatcher(req.user)) return res.status(403).json({ error: 'forbidden', hint: 'Статус меняет диспетчер УК' });
  const r = db.request(String(req.params.id));
  if (!r) return res.status(404).json({ error: 'request_not_found' });
  if (!isDispatcher(req.user, r.houseId)) return res.status(403).json({ error: 'forbidden', hint: 'Статус меняет диспетчер УК этого дома' });
  const status = req.body?.status as RequestStatus;
  if (!SETTABLE_STATUSES.includes(status)) return res.status(400).json({ error: 'bad_status', allowed: SETTABLE_STATUSES });
  try { res.json(await changeStatus(r.id, status, req.user.id, { note: req.body?.note, master: req.body?.master })); }
  catch (e) { sendError(res, e); }
});

api.get('/meters/last', auth, requireMembership, (req: Request, res: Response) => {
  res.json(db.lastMeters(req.user.id, req.house.fiasId) || { values: null });
});

api.post('/meters', auth, requireMembership, rateLimit('meters', 10), (req: Request, res: Response) => {
  const { values, previous } = req.body || {};
  if (!values || typeof values !== 'object' || Array.isArray(values)) return res.status(400).json({ error: 'values_required' });
  try {
    const saved = submitMeters(req.user.id, req.membership, req.house, values, previous);
    if (canMessage(req.user.id)) {
      const lines = Object.keys(saved.usage).map(k =>
        `${METER_NAMES[k] || k} ${saved.values[k]} (${saved.baseline.includes(k) ? 'начальное' : `расход ${saved.usage[k]}`})`);
      void sendMaxToUser(req.user.id, [
        `💧 Показания кв. ${saved.apartment} приняты:`,
        ...lines,
        '',
        `Примерно к оплате: ${saved.amount.toLocaleString('ru-RU')} ₽.${anomalyLines(saved.anomalies)}`,
      ].join('\n'));
    }
    res.status(201).json(saved);
  } catch (e) { sendError(res, e); }
});

api.post('/bill/check', auth, requireMembership, (req: Request, res: Response) => {
  const { area, lines } = req.body || {};
  if (!Array.isArray(lines) || lines.length > 20) return res.status(400).json({ error: 'lines_required' });
  const t = tariffsFor(req.house.city);
  const rows = lines.map((l: any) => {
    const item = t.items[l?.key];
    if (!item) return { key: String(l?.key), error: 'unknown_service' };
    const volume = toNum(l.volume);
    const charged = toNum(l.charged);
    const expected = Number(((Number.isFinite(volume) ? volume : 0) * item.rate).toFixed(2));
    const diff = Number(((Number.isFinite(charged) ? charged : 0) - expected).toFixed(2));
    return { key: l.key, name: item.name, unit: item.unit, rate: item.rate, model: item.model, volume, charged, expected, diff, overcharged: diff > 1 };
  });
  const over = rows.filter((r: any) => r.overcharged);
  const a = toNum(area ?? '');
  res.json({
    tariffs: { city: t.city, since: t.since, until: t.until, source: t.source, hasModel: t.hasModel },
    maintenance: Number.isFinite(a) && a > 0 ? Number((a * t.items.maint.rate).toFixed(2)) : null,
    rows,
    overchargedTotal: Number(over.reduce((s: number, r: any) => s + r.diff, 0).toFixed(2)),
    claimText: over.length
      ? `Прошу проверить начисления по кв. ${req.membership.apartment} и сделать перерасчёт.\n\n` + over.map((r: any) =>
          `${r.name}: начислено ${r.charged} ₽, по тарифу ${r.rate} ₽/${r.unit} за ${r.volume} ${r.unit} должно быть ${r.expected} ₽ (разница ${r.diff} ₽).`).join('\n')
      : null,
  });
});

function voteView(v: Vote, apartment: string, userId: string) {
  const counted = countedVotes(v);
  const need = quorumNeed(v);
  return {
    id: v.id, title: v.title, detail: v.detail, deadline: v.deadline,
    total: v.total, yes: v.yes, no: v.no, abstain: v.abstain,
    counted, quorumNeed: need, quorum: counted >= need,
    myChoice: v.ballots[apartment] || null,
    mine: v.authorId === userId,
  };
}

api.get('/votes', auth, requireMembership, (req: Request, res: Response) => {
  res.json(db.votes(req.house.fiasId).map(v => voteView(v, req.membership.apartment, req.user.id)));
});

api.post('/votes', auth, requireMembership, rateLimit('votes', 5), (req: Request, res: Response) => {
  const title = String(req.body?.title || '').trim();
  const detail = String(req.body?.detail || '').trim();
  const deadline = String(req.body?.deadline || '').trim();
  if (title.length < 5) return res.status(400).json({ error: 'title_too_short' });
  const v = db.addVote({
    houseId: req.house.fiasId,
    title: title.slice(0, 160),
    detail: (detail || 'Предложение жителя дома.').slice(0, 400),
    deadline: deadline.slice(0, 40) || 'без срока',
    total: req.house.apartmentsCount,
    authorId: req.user.id,
  });
  res.status(201).json(voteView(v, req.membership.apartment, req.user.id));
});

api.post('/votes/:id', auth, requireMembership, (req: Request, res: Response) => {
  const choice = req.body?.choice;
  if (!['yes', 'no', 'abstain'].includes(choice)) return res.status(400).json({ error: 'bad_choice' });
  const v = db.castVote(String(req.params.id), req.house.fiasId, req.membership.apartment, choice);
  if (!v) return res.status(404).json({ error: 'vote_not_found' });
  res.json(voteView(v, req.membership.apartment, req.user.id));
});

api.post('/assistant', auth, rateLimit('assistant', 15), async (req: Request, res: Response) => {
  const text = String(req.body?.text || '').slice(0, 1000);
  if (!text.trim()) return res.status(400).json({ error: 'text_required' });
  const m = db.membership(req.user.id);
  res.json({ answer: await gigaChat.ask(text, (m && houseById(m.houseId)) || undefined) });
});

api.post('/ai/scan', auth, rateLimit('scan', 20), async (req: Request, res: Response) => {
  const { mode, image } = req.body || {};
  if (mode !== 'meter' && mode !== 'incident') return res.status(400).json({ error: 'bad_mode' });
  if (typeof image !== 'string' || image.length < 100) return res.status(400).json({ error: 'image_required' });
  if (image.length > 6_000_000) return res.status(413).json({ error: 'image_too_large' });
  const bytes = Buffer.from(image, 'base64');
  const mime = sniffImage(bytes);
  if (!mime) return res.status(400).json({ error: 'bad_image' });
  try { res.json(await scanImage(mode, bytes, mime)); }
  catch (e) { sendError(res, e); }
});

function dispatchHouse(req: Request, res: Response): House | null {
  const allowed = dispatcherHouseIds(req.user);
  const want = String(req.query.houseId || req.body?.houseId || allowed[0] || '');
  if (!allowed.includes(want)) { res.status(403).json({ error: 'forbidden' }); return null; }
  return houseById(want);
}

api.get('/dispatch/state', auth, dispatcherOnly, (req: Request, res: Response) => {
  const h = dispatchHouse(req, res);
  if (h) res.json(dispatchState(h));
});

api.post('/dispatch/notify', auth, dispatcherOnly, rateLimit('notify', 10), async (req: Request, res: Response) => {
  const h = dispatchHouse(req, res);
  if (!h) return;
  try { res.status(201).json(await notifyRiser(h, String(req.body?.incidentId || ''), req.user.id)); }
  catch (e) { sendError(res, e); }
});

api.post('/dispatch/outage', auth, dispatcherOnly, rateLimit('outage', 10), async (req: Request, res: Response) => {
  const h = dispatchHouse(req, res);
  if (!h) return;
  const b = req.body || {};
  try {
    res.status(201).json(await planOutage(h, {
      utility: String(b.utility || ''), scope: b.scope, entrance: b.entrance, apartment: b.apartment,
      from: String(b.from || ''), to: String(b.to || ''), reason: b.reason,
    }, req.user.id));
  } catch (e) {
    console.warn('Плановое отключение отклонено:', (e as Error).message);
    sendError(res, e);
  }
});

api.use((_req: Request, res: Response) => res.status(404).json({ error: 'not_found' }));
