import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readJson<T>(rel: string): T {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')) as T;
}
function readOptionalJson<T>(rel: string, fallback: T): T {
  try { return readJson<T>(rel); } catch { return fallback; }
}

export interface TariffItem { name: string; unit: string; rate: number; source: string; model: boolean }

export interface TariffBook {
  cityCode: string; city: string; since: string; until: string; source: string;
  hasModel: boolean;
  items: Record<string, TariffItem>;
}
interface TariffFile {
  city: string; source: string;
  items: Record<string, { name: string; unit: string; source: string; model?: boolean }>;
  periods: Array<{ since: string; until: string; rates: Record<string, number> }>;
}

const tariffFiles = readJson<Record<string, TariffFile | string>>('config/tariffs.json');
export const tariffCities = Object.keys(tariffFiles).filter(k => !k.startsWith('_'));

export function tariffsFor(cityCode = 'spb', at = new Date()): TariffBook {
  const f = tariffFiles[cityCode];
  if (!f || typeof f === 'string') throw new Error(`no_tariffs_for_city:${cityCode}`);
  const day = at.toISOString().slice(0, 10);
  const period = f.periods.find(p => p.since <= day && day <= p.until)
    || (day < f.periods[0].since ? f.periods[0] : f.periods[f.periods.length - 1]);
  const items: Record<string, TariffItem> = {};
  for (const [key, meta] of Object.entries(f.items)) {
    items[key] = { name: meta.name, unit: meta.unit, source: meta.source, model: !!meta.model, rate: period.rates[key] };
  }
  return {
    cityCode, city: f.city, since: period.since, until: period.until, source: f.source,
    hasModel: Object.values(items).some(i => i.model), items,
  };
}

export interface House {
  fiasId: string; city: string; address: string; yearBuilt: number; floors: number;
  entrances: number; apartmentsCount: number;
  managementCompany: { id: string; name: string; phone: string; emergencyPhone: string; email: string; reception: string };
  elevatorService: { name: string; phone: string };
  overhaulPlan: Array<{
    workType: string; plannedYear: number; status: string; budget: number;
    progressPercent: number; contractor: string; contractorPhone: string;
  }>;
}
export interface KbEntry { id: string; keywords: string[]; answer: string; source: string; verify: boolean }

export const defaultHouse = readJson<House>('config/house.json');
const extraHouses = readOptionalJson<{ houses: House[] }>('config/houses.json', { houses: [] }).houses || [];
export const houses: House[] = [
  defaultHouse,
  ...extraHouses.filter(h => h && h.fiasId && h.fiasId !== defaultHouse.fiasId),
];
const houseIndex = new Map(houses.map(h => [h.fiasId, h]));
export function houseById(fiasId: string | null | undefined): House | null {
  return (fiasId && houseIndex.get(fiasId)) || null;
}

export function housesOfUk(ukId: string): House[] {
  return houses.filter(h => h.managementCompany.id === ukId);
}
for (const h of houses) tariffsFor(h.city);

export const kb = readJson<{ entries: KbEntry[] }>('config/kb.json').entries;

function parseStaffCodes(raw: string): Record<string, string> {
  const codes: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const parts = pair.split(':').map(x => x.trim());
    if (parts.length === 2 && parts[0] && parts[1]) codes[parts[0]] = parts[1];
  }
  return codes;
}

export const env = {
  port: Number(process.env.PORT || 3000),
  isProd: process.env.NODE_ENV === 'production',
  maxToken: process.env.MAX_BOT_TOKEN || '',
  botEnabled: process.env.BOT_ENABLED === '1',
  maxBotUsername: (process.env.MAX_BOT_USERNAME || '').replace(/^@/, ''),
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''),
  gigachatKey: process.env.GIGACHAT_CREDENTIALS || '',
  gigachatScope: process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS',
  gigachatVisionModel: process.env.GIGACHAT_VISION_MODEL || 'GigaChat-2-Max',
  authDev: process.env.AUTH_DEV === '1',
  initDataTtl: Number(process.env.INITDATA_TTL || 3600),
  testApiKey: process.env.TEST_API_KEY || '',
  staffCodes: parseStaffCodes(process.env.STAFF_CODES || ''),
  dispatcherIds: (process.env.DISPATCHER_IDS || '').split(',').map(s => s.trim()).filter(Boolean),

  demoMode: process.env.DEMO_MODE !== '0',
  dadataToken: process.env.DADATA_TOKEN || '',
};

export const miniAppUrl = `${env.publicUrl}/miniapp/`;

export const TEST_USERS: Record<string, { houseId: string; apartment: string }> = {
  'test-resident-1': { houseId: defaultHouse.fiasId, apartment: '42' },
  'test-resident-2': { houseId: houses.find(h => h.city === 'kzn')?.fiasId || defaultHouse.fiasId, apartment: '12' },
};

export const isTestUser = (userId: string) => userId.startsWith('test-');
