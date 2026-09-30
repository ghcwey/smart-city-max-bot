import { tariffsFor, houseById, env, isTestUser, type House } from './config.js';
import { layoutOf, sameRiser } from './twin.js';
import { CATEGORIES } from './categories.js';
import { db, OPEN_STATUSES, type Membership, type RequestStatus, type ServiceRequest } from './store.js';
import { sendMaxToUser, canMessage } from './maxbot.js';

export class ServiceError extends Error {
  constructor(public status: number, public code: string, public extra: Record<string, unknown> = {}) { super(code); }
}

export const STATUS_LABEL: Record<RequestStatus, string> = {
  new: 'принята',
  assigned: 'передана исполнителю',
  in_progress: 'в работе',
  done: 'выполнена',
  rejected: 'отклонена',
  auto_closed: 'закрыта автоматически (демо)',
};

const TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  new: ['assigned', 'in_progress', 'done', 'rejected'],
  assigned: ['in_progress', 'done', 'rejected'],
  in_progress: ['done', 'rejected'],
  done: [],
  rejected: [],
  auto_closed: [],
};

export const SETTABLE_STATUSES = [...new Set(Object.values(TRANSITIONS).flat())];

export const METER_NAMES: Record<string, string> = { cold: 'ХВС', hot: 'ГВС', power: 'электро' };

const SAME_INCIDENT_HOURS = 6;
const STALE_DEMO_HOURS = 12;

export const toNum = (x: unknown) => Number(String(x).replace(',', '.'));

export function createRequest(userId: string, m: Membership, input: {
  category: string; description: string; title?: string; hasPhoto?: boolean;
}): ServiceRequest {
  const cat = CATEGORIES[input.category];
  if (!cat) throw new ServiceError(400, 'bad_category');
  const description = String(input.description || '').trim();
  if (description.length < 5) throw new ServiceError(400, 'description_too_short');
  const emergency = input.category === 'emergency';
  const same = emergency ? findSameIncident(m) : null;
  const r = db.addRequest({
    userId,
    houseId: m.houseId,
    apartment: m.apartment,
    category: input.category,
    title: String(input.title || cat.label).trim().slice(0, 120) || cat.label,
    description: description.slice(0, 2000),
    priority: emergency ? 'emergency' : 'normal',
    status: 'new',
    assignedMaster: emergency ? 'дежурная АДС' : 'назначается',
    slaDeadline: new Date(Date.now() + cat.slaMinutes * 60_000).toISOString(),
    hasPhoto: !!input.hasPhoto,
    ...(same ? { duplicateOf: same.id } : {}),
  });

  if (emergency && !same && !isTestUser(userId)) void alertDispatchers(r);
  if (!canMessage(userId)) return r;

  if (!same) {
    void sendMaxToUser(userId, `✅ Заявка ${r.id} принята\n\n${r.title}\nкв. ${r.apartment}\n${slaLine(r)}\n\nО смене статуса напишу сюда.`);
  } else if (same.userId === userId) {
    void sendMaxToUser(userId, `✅ Эта авария уже на пульте (заявка ${same.id}: ${same.title}). Новое сообщение добавил к ней. Статус пришлю сюда.`);
  } else {
    void sendMaxToUser(userId, `✅ Об этой аварии уже сообщили соседи (заявка ${same.id}: ${same.title}, кв. ${same.apartment}).\n\nДиспетчер видит её на пульте, ваше сообщение добавлено к ней. Статус пришлю сюда.`);
  }
  return r;
}

async function alertDispatchers(r: ServiceRequest) {
  const h = houseById(r.houseId);
  if (!h) return;
  const lines = ['🚨 Новая авария', '', `${h.address}, кв. ${r.apartment}`, r.title];
  if (r.description && r.description !== r.title) lines.push(`«${r.description.slice(0, 200)}»`);
  if (r.hasPhoto) lines.push('есть фото');
  lines.push('', 'Откройте пульт: «Открыть приложение» → «Пульт диспетчера».');

  const ids = [...new Set([...db.staffOfUk(h.managementCompany.id), ...env.dispatcherIds])];
  await Promise.all(ids.filter(canMessage).map(id => sendMaxToUser(id, lines.join('\n'), true)));
}

function findSameIncident(m: Membership): ServiceRequest | null {
  const h = houseById(m.houseId);
  const layout = h && layoutOf(h);
  if (!layout) return null;
  const since = Date.now() - SAME_INCIDENT_HOURS * 3600_000;
  return db.requests({ houseId: m.houseId }).find(r =>
    r.priority === 'emergency' && !r.duplicateOf && !isTestUser(r.userId)
    && OPEN_STATUSES.includes(r.status) && new Date(r.createdAt).getTime() > since
    && sameRiser(layout, Number(r.apartment), Number(m.apartment))) || null;
}

export function closeStaleDemoIncidents() {
  if (!env.demoMode) return;
  const cutoff = Date.now() - STALE_DEMO_HOURS * 3600_000;
  for (const r of db.requests()) {
    if (r.priority !== 'emergency' || !OPEN_STATUSES.includes(r.status)) continue;
    if (new Date(r.updatedAt || r.createdAt).getTime() > cutoff) continue;
    db.setStatus(r.id, 'auto_closed', 'system', { note: `Демо-стенд: ${STALE_DEMO_HOURS} часов без движения` });
  }
}

export async function changeStatus(id: string, status: RequestStatus, by: string, extra: { note?: string; master?: string } = {}) {
  const r = db.request(id);
  if (!r) throw new ServiceError(404, 'request_not_found');
  if (r.status === status) return { request: r, residentNotified: false };
  if (!TRANSITIONS[r.status].includes(status)) {
    throw new ServiceError(409, 'bad_transition', { from: r.status, allowed: TRANSITIONS[r.status] });
  }
  const note = extra.note ? String(extra.note).trim().slice(0, 300) : undefined;
  const master = extra.master ? String(extra.master).trim().slice(0, 80) : undefined;
  const updated = db.setStatus(id, status, by, { note, master })!;
  const text = statusText(updated, status, master, note);

  for (const d of db.duplicatesOf(id)) {
    if (!OPEN_STATUSES.includes(d.status)) continue;
    db.setStatus(d.id, status, by, { note, master });
    if (canMessage(d.userId)) void sendMaxToUser(d.userId, text);
  }
  const residentNotified = canMessage(updated.userId) && (await sendMaxToUser(updated.userId, text)).ok;
  return { request: updated, residentNotified };
}

function statusText(r: ServiceRequest, status: RequestStatus, master?: string, note?: string) {
  const icon = status === 'done' ? '✅' : status === 'rejected' ? '⛔' : '🔧';
  const lines = [`${icon} Заявка ${r.id}: ${STATUS_LABEL[status]}`, r.title, `кв. ${r.apartment}`];
  if (master) lines.push(`исполнитель: ${master}`);
  if (note) lines.push(`комментарий УК: ${note}`);
  if (status === 'done') lines.push('', 'Если проблема осталась, ответьте на это сообщение или создайте заявку заново.');
  return lines.join('\n');
}

export function submitMeters(userId: string, m: Membership, house: House,
  values: Record<string, unknown>, previous?: Record<string, unknown> | null) {
  const t = tariffsFor(house.city);
  const last = db.lastMeters(userId, m.houseId);

  const prev: Record<string, unknown> = {
    ...(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}),
    ...(last ? last.values : {}),
  };

  const usage: Record<string, number> = {};
  const clean: Record<string, number> = {};
  const baseline: string[] = [];
  const anomalies: Array<{ key: string; before: number; now: number }> = [];
  let amount = 0;
  for (const [key, raw] of Object.entries(values)) {
    const item = t.items[key];
    if (!item || key === 'maint' || key === 'heat' || key === 'sewer') throw new ServiceError(400, 'unknown_meter', { key });
    const v = toNum(raw);
    if (!Number.isFinite(v) || v < 0 || v >= 1e7) throw new ServiceError(400, 'bad_value', { key });
    clean[key] = v;

    if (prev[key] == null || prev[key] === '') { baseline.push(key); usage[key] = 0; continue; }
    const used = v - (toNum(prev[key]) || 0);
    if (used < 0) throw new ServiceError(400, 'less_than_previous', { key, previous: toNum(prev[key]) || 0 });
    usage[key] = Number(used.toFixed(3));
    amount += used * item.rate;
    const before = last?.usage?.[key];
    if (before && before >= 1 && used >= before * 2) anomalies.push({ key, before, now: usage[key] });
  }
  if (!Object.keys(clean).length) throw new ServiceError(400, 'values_required');

  const day = new Date().getDate();
  const saved = db.addMeters({
    userId, houseId: m.houseId, apartment: m.apartment,
    period: new Date().toISOString().slice(0, 7),
    values: { ...(last?.values || {}), ...clean },
    usage, amount: Number(amount.toFixed(2)),
  });
  return { ...saved, baseline, anomalies, acceptedNow: day >= 20 && day <= 25, tariffs: { city: t.city, since: t.since } };
}

export function anomalyLines(anomalies: Array<{ key: string; before: number; now: number }>) {
  return anomalies.map(a =>
    `\n⚠️ ${METER_NAMES[a.key] || a.key}: расход вырос вдвое (${a.before} → ${a.now}). Проверьте бачок и смесители, похоже на утечку.`).join('');
}

export function slaLine(r: ServiceRequest) {
  return CATEGORIES[r.category]?.normative
    ? `срок локализации: до ${fmtTime(r.slaDeadline)} (ПП РФ № 416, п. 13)`
    : `ориентировочно до ${fmtTime(r.slaDeadline)} (регламент УК, модельное значение)`;
}

export function fmtTime(when: string | Date) {
  return new Date(when).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}
