import fs from 'node:fs';
import path from 'node:path';
import { ROOT, defaultHouse, houseById, isTestUser } from './config.js';

export type RequestStatus = 'new' | 'assigned' | 'in_progress' | 'done' | 'rejected' | 'auto_closed';
export const OPEN_STATUSES: RequestStatus[] = ['new', 'assigned', 'in_progress'];

export interface StatusEvent { status: RequestStatus; at: string; by: string; note?: string }

export interface ServiceRequest {
  id: string;
  userId: string;
  houseId: string;
  apartment: string;
  category: string;
  title: string;
  description: string;
  priority: 'emergency' | 'normal';
  status: RequestStatus;
  assignedMaster: string;
  slaDeadline: string;
  createdAt: string;
  updatedAt?: string;
  hasPhoto?: boolean;
  history?: StatusEvent[];
  duplicateOf?: string;
}

export interface MeterReading {
  id: string; userId: string; houseId: string; apartment: string; period: string;
  values: Record<string, number>; usage: Record<string, number>;
  amount: number; createdAt: string;
}

export type Choice = 'yes' | 'no' | 'abstain';
export interface Vote {
  id: string; houseId: string; title: string; detail: string; deadline: string;
  total: number; yes: number; no: number; abstain: number;
  ballots: Record<string, Choice>;
  authorId?: string; createdAt?: string;
}

export interface Membership {
  userId: string;
  houseId: string;
  apartment: string;
  consentAt: string;
  joinedAt: string;
}

export interface Staff { userId: string; ukIds: string[]; grantedAt: string }

export interface NoticeResult {
  apartment: number;
  status: 'sent' | 'simulated' | 'no_subscriber' | 'failed';
  subscribers: number;
  delivered?: number;
  error?: string;
  relation?: string;
}

export interface Notice {
  id: string; incidentId: string; houseId: string; sentAt: string; sentBy: string; kind?: 'incident' | 'outage';
  text: string; results: NoticeResult[];
}

interface Data {
  requests: ServiceRequest[];
  notices: Notice[];
  meters: MeterReading[];
  votes: Vote[];
  memberships: Record<string, Membership>;
  staff: Record<string, Staff>;
  reminders: Record<string, string>;
  bot: { marker: number | null; seen: string[] };
  seq: number;
}

const FILE = path.join(ROOT, 'data', 'db.json');
const HOME = defaultHouse.fiasId;

function seed(): Data {
  return {
    requests: [],
    meters: [],
    notices: [],
    memberships: {},
    staff: {},
    reminders: {},
    votes: [
      {
        id: 'v-2026-03', houseId: HOME, title: 'Поставить шлагбаум на въезде во двор',
        detail: 'Смета 380 000 ₽ из средств текущего ремонта, обслуживание 4 500 ₽ в месяц.',
        deadline: '30 сентября', total: 108, yes: 44, no: 12, abstain: 5, ballots: {},
      },
      {
        id: 'v-2026-04', houseId: HOME, title: 'Перенести детскую площадку от третьего подъезда',
        detail: 'Предложение инициативной группы, деньги дома не расходуются, перенос за счёт подрядчика по благоустройству.',
        deadline: '12 октября', total: 108, yes: 15, no: 6, abstain: 2, ballots: {},
      },
      {
        id: 'v-2026-05', houseId: '59d1f52f-a3cc-4525-b6b6-9bff8d2cdc76',
        title: 'Заключить прямой договор с региональным оператором по вывозу ТКО',
        detail: 'Инициатива совета дома, тариф не меняется, прозрачность вывоза.',
        deadline: '5 октября', total: 160, yes: 51, no: 9, abstain: 4, ballots: {},
      },
    ],
    bot: { marker: null, seen: [] },
    seq: 1,
  };
}

function load(): Data {
  const s = seed();
  let raw: Partial<Data>;
  try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Partial<Data>; }
  catch { return s; }
  const d: Data = {
    ...s, ...raw,
    memberships: { ...(raw.memberships || {}) },
    staff: { ...(raw.staff || {}) },
    reminders: { ...(raw.reminders || {}) },
    bot: { ...s.bot, ...(raw.bot || {}) },
  };

  for (const r of d.requests) {
    if (!r.history) r.history = [{ status: 'new', at: r.createdAt, by: 'resident' }];
    if (!r.houseId) r.houseId = HOME;
  }
  for (const v of d.votes) {
    if (!v.houseId) v.houseId = HOME;
    const next: Record<string, Choice> = {};
    for (const [key, choice] of Object.entries(v.ballots || {})) {
      const m = d.memberships[key];
      next[m && m.houseId === v.houseId ? m.apartment : key] = choice;
    }
    v.ballots = next;
  }
  for (const n of d.notices) if (!n.houseId) n.houseId = HOME;
  d.requests.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  d.notices.sort((a, b) => b.sentAt.localeCompare(a.sentAt));

  for (const s of Object.values(d.staff) as Array<Staff & { houseIds?: string[] }>) {
    if (!s.ukIds) {
      s.ukIds = [...new Set((s.houseIds || []).map(id => houseById(id)?.managementCompany.id).filter((x): x is string => !!x))];
      delete s.houseIds;
    }
  }
  return d;
}

let data: Data = load();
let dirty = false;

function persist() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE + '.tmp', JSON.stringify(data, null, 2));
    fs.renameSync(FILE + '.tmp', FILE);
  } catch (e) {
    console.error('Не смог сохранить базу:', e);
  }
}
setInterval(persist, 1000).unref();

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { dirty = true; persist(); process.exit(0); });
}

function touch() { dirty = true; }

export const db = {
  requests(filter: { userId?: string; houseId?: string } = {}) {
    return data.requests.filter(r =>
      (!filter.houseId || r.houseId === filter.houseId) && (!filter.userId || r.userId === filter.userId));
  },
  request(id: string) {
    return data.requests.find(r => r.id === id) || null;
  },
  duplicatesOf(id: string) {
    return data.requests.filter(r => r.duplicateOf === id);
  },
  addRequest(r: Omit<ServiceRequest, 'id' | 'createdAt' | 'history'>): ServiceRequest {
    const id = `MAX-2026-${String(++data.seq).padStart(3, '0')}`;
    const now = new Date().toISOString();
    const full: ServiceRequest = { ...r, id, createdAt: now, history: [{ status: r.status, at: now, by: 'resident' }] };
    data.requests.unshift(full);
    if (isTestUser(r.userId)) {
      const own = data.requests.filter(x => x.userId === r.userId);
      if (own.length > 3) {
        const drop = new Set(own.slice(3).map(x => x.id));
        data.requests = data.requests.filter(x => !drop.has(x.id));
      }
    }
    touch();
    return full;
  },
  setStatus(id: string, status: RequestStatus, by: string, extra: { note?: string; master?: string } = {}) {
    const r = data.requests.find(x => x.id === id);
    if (!r) return null;
    const now = new Date().toISOString();
    r.status = status;
    r.updatedAt = now;
    if (extra.master) r.assignedMaster = extra.master;
    (r.history ||= []).push({ status, at: now, by, ...(extra.note ? { note: extra.note } : {}) });
    touch();
    return r;
  },

  addMeters(m: Omit<MeterReading, 'id' | 'createdAt'>): MeterReading {
    const full: MeterReading = { ...m, id: `M-${++data.seq}`, createdAt: new Date().toISOString() };
    data.meters.unshift(full);
    if (data.meters.length > 5000) data.meters.length = 5000;
    touch();
    return full;
  },

  lastMeters(userId: string, houseId: string) {
    return data.meters.find(m => m.userId === userId && m.houseId === houseId) || null;
  },
  hasMetersFor(userId: string, period: string) {
    return data.meters.some(m => m.userId === userId && m.period === period);
  },
  memberships() {
    return Object.values(data.memberships);
  },
  remindedFor(userId: string) {
    return data.reminders[userId] || null;
  },
  markReminded(userId: string, period: string) {
    data.reminders[userId] = period; touch();
  },

  notices(incidentId?: string) {
    return incidentId ? data.notices.filter(n => n.incidentId === incidentId) : [...data.notices];
  },
  addNotice(n: Omit<Notice, 'id' | 'sentAt'>): Notice {
    const full: Notice = { ...n, id: `N-${++data.seq}`, sentAt: new Date().toISOString() };
    data.notices.unshift(full);
    if (data.notices.length > 200) data.notices.length = 200;
    touch();
    return full;
  },

  votes(houseId: string) {
    return data.votes.filter(v => v.houseId === houseId)
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  },
  addVote(v: { houseId: string; title: string; detail: string; deadline: string; total: number; authorId?: string }): Vote {
    const full: Vote = {
      id: `v-${Date.now().toString(36)}-${++data.seq}`,
      houseId: v.houseId, title: v.title, detail: v.detail, deadline: v.deadline,
      total: v.total, yes: 0, no: 0, abstain: 0, ballots: {},
      authorId: v.authorId, createdAt: new Date().toISOString(),
    };
    data.votes.unshift(full); touch();
    return full;
  },

  castVote(voteId: string, houseId: string, apartment: string, choice: Choice) {
    const v = data.votes.find(x => x.id === voteId && x.houseId === houseId);
    if (!v) return null;
    if (v.ballots[apartment]) return v;
    v.ballots[apartment] = choice; v[choice] += 1; touch();
    return v;
  },

  membership(userId: string): Membership | null {
    return data.memberships[userId] || null;
  },
  attach(userId: string, houseId: string, apartment: string): Membership {
    const prev = data.memberships[userId];
    const m: Membership = {
      userId, houseId, apartment,
      consentAt: new Date().toISOString(),
      joinedAt: prev?.joinedAt || new Date().toISOString(),
    };
    data.memberships[userId] = m; touch();
    return m;
  },

  residentsOnHouse(houseId: string): Membership[] {
    return Object.values(data.memberships).filter(m => m.houseId === houseId);
  },

  residentsOf(houseId: string, apartment: string): string[] {
    return Object.values(data.memberships)
      .filter(m => m.houseId === houseId && m.apartment === apartment)
      .map(m => m.userId);
  },

  staff(userId: string): Staff | null {
    return data.staff[userId] || null;
  },
  staffOfUk(ukId: string): string[] {
    return Object.values(data.staff).filter(s => (s.ukIds || []).includes(ukId)).map(s => s.userId);
  },
  grantStaff(userId: string, ukId: string): Staff {
    const s = data.staff[userId] || { userId, ukIds: [], grantedAt: new Date().toISOString() };
    if (!s.ukIds.includes(ukId)) s.ukIds.push(ukId);
    data.staff[userId] = s; touch();
    return s;
  },

  bot: {
    get marker() { return data.bot.marker; },
    set marker(m: number | null) { data.bot.marker = m; touch(); },
    isSeen(id: string) { return data.bot.seen.includes(id); },
    markSeen(id: string) {
      data.bot.seen.push(id);
      if (data.bot.seen.length > 500) data.bot.seen = data.bot.seen.slice(-500);
      touch();
    },
  },
};

export function countedVotes(v: Vote) { return v.yes + v.no + v.abstain; }

export function quorumNeed(v: Vote) { return Math.floor(v.total / 2) + 1; }
