import { env, isTestUser, type House } from './config.js';
import { db, OPEN_STATUSES, type Notice, type NoticeResult, type ServiceRequest } from './store.js';
import { layoutOf, locate, riserZone, apartmentsInScope, FLOOD_FLOORS, type Relation } from './twin.js';
import { sendMaxToUser, canMessage, botActive } from './maxbot.js';
import { fmtTime } from './services.js';

export class DispatchError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

function riserTexts(h: House, apartment: number, title: string): Record<Relation, string> {
  const phone = `Аварийная служба: ${h.managementCompany.emergencyPhone}.`;
  return {
    source: [
      '🚨 Авария в вашей квартире зарегистрирована',
      '',
      `${h.address}, кв. ${apartment}: ${title}.`,
      'Перекройте вентиль на вводе, если ещё не сделали. Стояк перекроют, бригада АДС едет к вам.',
      phone,
    ].join('\n'),
    flood: [
      '⚠️ Возможен залив сверху',
      '',
      h.address,
      `В кв. ${apartment} выше по стояку авария: ${title}.`,
      'Проверьте потолок и стены в ванной и на кухне, уберите вещи от стен. Если уже течёт, сообщите в бот: «🚨 Авария в доме».',
      'Воду на стояке перекроют до устранения аварии.',
      phone,
    ].join('\n'),
    riser: [
      '🚰 Отключение воды на вашем стояке',
      '',
      h.address,
      `В кв. ${apartment} авария: ${title}.`,
      'Воду на стояке перекроют до устранения. Пока идут работы, не сливайте воду в раковину, ванну и унитаз: она уйдёт в аварийный стояк.',
      phone,
    ].join('\n'),
  };
}

function toIncident(h: House, r: ServiceRequest) {
  const layout = layoutOf(h);
  if (!layout) return null;
  const apartment = Number(r.apartment);
  const spot = locate(layout, apartment);
  if (!spot) return null;
  const last = db.notices(r.id)[0];
  const dups = db.duplicatesOf(r.id);
  return {
    id: r.id, apartment, title: r.title, description: r.description, status: r.status,
    assignedMaster: r.assignedMaster, hasPhoto: !!r.hasPhoto || dups.some(d => d.hasPhoto),
    createdAt: r.createdAt, slaDeadline: r.slaDeadline, spot,
    reports: 1 + dups.length,
    reportedFrom: [...new Set([r.apartment, ...dups.map(d => d.apartment)])],
    zone: riserZone(layout, apartment).map(z => ({ ...z, subscribers: db.residentsOf(h.fiasId, String(z.apartment)).length })),
    messages: riserTexts(h, apartment, r.title),
    floodFloors: FLOOD_FLOORS,
    lastNotice: last ? { sentAt: last.sentAt, results: last.results } : null,
  };
}

function isOnPult(r: ServiceRequest) {
  return OPEN_STATUSES.includes(r.status) && !isTestUser(r.userId) && !r.duplicateOf;
}

export function dispatchState(h: House) {
  const open = db.requests({ houseId: h.fiasId }).filter(isOnPult);
  const incidents = open
    .filter(r => r.priority === 'emergency')
    .map(r => toIncident(h, r))
    .filter((i): i is NonNullable<typeof i> => i !== null);
  const requests = open
    .filter(r => r.priority !== 'emergency')
    .map(r => ({ id: r.id, apartment: r.apartment, title: r.title, description: r.description, status: r.status, category: r.category, createdAt: r.createdAt, slaDeadline: r.slaDeadline }));
  const residents = db.residentsOnHouse(h.fiasId);
  const connected = [...new Set(residents.map(m => Number(m.apartment)))].filter(Number.isFinite);
  const outages = db.notices().filter(n => n.houseId === h.fiasId && n.kind === 'outage').slice(0, 3)
    .map(n => ({ id: n.id, sentAt: n.sentAt, text: n.text, recipients: n.results.reduce((s, x) => s + x.subscribers, 0) }));
  return {
    houseId: h.fiasId, layout: layoutOf(h), address: h.address, entrances: h.entrances,
    connectedApartments: connected, residents: residents.length,
    demoMode: env.demoMode, botActive: botActive(),
    incidents, requests, outages,
  };
}

async function deliver(h: House, apartment: number, text: string, relation?: string): Promise<NoticeResult> {
  const ids = db.residentsOf(h.fiasId, String(apartment));
  if (!ids.length) return { apartment, relation, status: 'no_subscriber', subscribers: 0 };
  const reachable = ids.filter(canMessage);
  if (reachable.length) {
    const rs = await Promise.all(reachable.map(id => sendMaxToUser(id, text)));
    const delivered = rs.filter(r => r.ok).length;
    return delivered > 0
      ? { apartment, relation, status: 'sent', subscribers: ids.length, delivered }
      : { apartment, relation, status: 'failed', subscribers: ids.length, delivered: 0, error: rs[0]?.error };
  }
  if (env.demoMode) return { apartment, relation, status: 'simulated', subscribers: ids.length };
  return { apartment, relation, status: 'failed', subscribers: ids.length, error: botActive() ? 'not_in_max' : 'bot_disabled' };
}

export async function notifyRiser(h: House, incidentId: string, sentBy: string): Promise<Notice> {
  const r = db.request(incidentId);
  const inc = r && r.houseId === h.fiasId && r.priority === 'emergency' && isOnPult(r) ? toIncident(h, r) : null;
  if (!inc) throw new DispatchError(404, 'incident_not_found');
  const recent = db.notices(incidentId)[0];
  if (recent && Date.now() - new Date(recent.sentAt).getTime() < 60_000) return recent;
  const results = await Promise.all(inc.zone.map(z => deliver(h, z.apartment, inc.messages[z.relation], z.relation)));
  return db.addNotice({ incidentId, houseId: h.fiasId, sentBy, kind: 'incident', text: inc.messages.riser, results });
}

const UTILITY: Record<string, string> = { cold: 'холодной воды', hot: 'горячей воды', power: 'электричества', heat: 'отопления' };

interface OutageInput {
  utility: string; scope: 'house' | 'entrance' | 'riser';
  entrance?: number; apartment?: number; from: string; to: string; reason?: string;
}

function fmtRange(from: Date, to: Date) {
  if (from.toDateString() !== to.toDateString()) return `${fmtTime(from)} – ${fmtTime(to)}`;
  return `${fmtTime(from)} – ${to.toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' })}`;
}

export async function planOutage(h: House, input: OutageInput, sentBy: string) {
  const layout = layoutOf(h);
  if (!layout) throw new DispatchError(409, 'no_layout');
  const what = UTILITY[input.utility];
  if (!what) throw new DispatchError(400, 'bad_utility');
  const from = new Date(input.from);
  const to = new Date(input.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw new DispatchError(400, 'bad_period');

  let apartments: number[];
  let where: string;
  if (input.scope === 'house') {
    apartments = apartmentsInScope(layout, { kind: 'house' });
    where = 'весь дом';
  } else if (input.scope === 'entrance') {
    const e = Number(input.entrance);
    if (!Number.isInteger(e) || e < 1 || e > layout.entrances) throw new DispatchError(400, 'bad_entrance');
    apartments = apartmentsInScope(layout, { kind: 'entrance', entrance: e });
    where = `подъезд ${e}`;
  } else if (input.scope === 'riser') {
    const a = Number(input.apartment);
    const s = locate(layout, a);
    if (!s) throw new DispatchError(400, 'bad_apartment');
    apartments = apartmentsInScope(layout, { kind: 'riser', apartment: a });
    where = `стояк кв. ${apartments[0]}–${apartments[apartments.length - 1]}, подъезд ${s.entrance}`;
  } else throw new DispatchError(400, 'bad_scope');

  const reason = String(input.reason || '').trim().slice(0, 200);
  const lines = [`🔧 Плановое отключение ${what}`, '', h.address, `Где: ${where}.`, `Когда: ${fmtRange(from, to)}.`];
  if (reason) lines.push(`Причина: ${reason}.`);
  lines.push('', `Вопросы: ${h.managementCompany.name}, ${h.managementCompany.phone}.`);
  const text = lines.join('\n');

  const results = (await Promise.all(apartments.map(a => deliver(h, a, text))))
    .filter(r => r.status !== 'no_subscriber');
  const notice = db.addNotice({ incidentId: `outage-${Date.now().toString(36)}`, houseId: h.fiasId, sentBy, kind: 'outage', text, results });
  return {
    id: notice.id, text, apartments: apartments.length,
    recipients: results.reduce((s, r) => s + r.subscribers, 0),
    delivered: results.reduce((s, r) => s + (r.delivered || 0), 0),
    simulated: results.some(r => r.status === 'simulated'),
  };
}
