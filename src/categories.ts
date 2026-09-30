export interface Category { label: string; slaMinutes: number; basis: string; normative: boolean }

const MODEL = 'ориентировочный срок по регламенту УК (модельное значение)';

export const CATEGORIES: Record<string, Category> = {
  emergency: { label: 'Авария', slaMinutes: 30, normative: true, basis: 'локализация аварии на внутридомовых сетях — 30 минут, ПП РФ от 15.05.2013 № 416, п. 13' },
  plumbing: { label: 'Сантехника', slaMinutes: 3 * 1440, normative: false, basis: MODEL },
  electric: { label: 'Электрика', slaMinutes: 3 * 1440, normative: false, basis: MODEL },
  elevator: { label: 'Лифт', slaMinutes: 1440, normative: false, basis: MODEL },
  cleaning: { label: 'Уборка, мусор', slaMinutes: 1440, normative: false, basis: MODEL },
  other: { label: 'Другое', slaMinutes: 10 * 1440, normative: false, basis: MODEL },
};
