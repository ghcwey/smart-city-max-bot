import { env, houseById, type House } from './config.js';
import { db, OPEN_STATUSES, type Membership } from './store.js';
import { gigaChat, isAboutMe } from './gigachat.js';
import { secureFetch } from './net.js';
import { createRequest, submitMeters, anomalyLines, ServiceError, STATUS_LABEL, METER_NAMES, slaLine } from './services.js';
import { scanImage, sniffImage } from './vision.js';

const MAX_API_BASE = 'https://platform-api.max.ru';
const EMERGENCY_WAIT_MS = 15 * 60_000;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type MaxButton =
  | { type: 'callback'; text: string; payload: string; intent?: 'default' | 'positive' | 'negative' }
  | { type: 'open_app'; text: string; web_app: string; contact_id?: number; payload?: string };

let polling = false;
let botInfo: { user_id?: number; username?: string; name?: string } = {};

// Пока мини-приложение не привязано к боту, MAX отвечает 400 на кнопку open_app.
// Тогда шлём клавиатуру без неё, чтобы остальные кнопки работали.
let appButtonRejected = false;

export function botActive() { return polling; }

export function canMessage(userId: string) { return polling && /^\d+$/.test(userId); }

async function maxFetch(path: string, init: { method?: string; body?: string } = {}) {
  return secureFetch(`${MAX_API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: env.maxToken },
    signal: AbortSignal.timeout(35_000),
  });
}

const houseFromQr = new Map<string, string>();

function appButton(userId: string): MaxButton {
  return {
    type: 'open_app',
    text: '🏠 Открыть приложение «Дом»',
    web_app: botInfo.username || env.maxBotUsername,
    contact_id: botInfo.user_id,
    payload: houseFromQr.get(userId),
  };
}

function keyboard(userId: string): MaxButton[][] {
  const rows: MaxButton[][] = [
    [
      { type: 'callback', text: '🚨 Авария в доме', payload: 'btn_emergency', intent: 'negative' },
      { type: 'callback', text: '📋 Мои заявки', payload: 'btn_my_requests' },
    ],
    [
      { type: 'callback', text: '💧 Показания', payload: 'btn_meters' },
      { type: 'callback', text: '🏗 Капремонт', payload: 'btn_overhaul' },
    ],
  ];
  if (!appButtonRejected) rows.push([appButton(userId)]);
  return rows;
}

const dialogOf = new Map<string, number>();

function splitText(text: string, limit = 3800): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit / 2) cut = limit;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

export async function sendMaxToUser(userId: string, text: string, withKeyboard = false): Promise<{ ok: boolean; error?: string }> {
  if (!polling) return { ok: false, error: 'bot_disabled' };
  const parts = splitText(text);
  for (let i = 0; i < parts.length; i++) {
    const r = await sendOne(userId, parts[i], withKeyboard && i === parts.length - 1);
    if (!r.ok) return r;
  }
  return { ok: true };
}

async function sendOne(userId: string, text: string, withKeyboard: boolean): Promise<{ ok: boolean; error?: string }> {
  const body = (kb: boolean) => JSON.stringify({
    text,
    ...(kb ? { attachments: [{ type: 'inline_keyboard', payload: { buttons: keyboard(userId) } }] } : {}),
  });
  const chatId = dialogOf.get(userId);
  const target = chatId ? `chat_id=${chatId}` : `user_id=${encodeURIComponent(userId)}`;
  try {
    let res = await maxFetch(`/messages?${target}`, { method: 'POST', body: body(withKeyboard) });
    if (!res.ok && withKeyboard && res.status === 400 && !appButtonRejected) {
      console.warn(`MAX отклонил кнопку open_app (${await res.text()}): мини-приложение ещё не привязано к боту. Шлю клавиатуру без неё.`);
      appButtonRejected = true;
      res = await maxFetch(`/messages?${target}`, { method: 'POST', body: body(true) });
    }
    if (!res.ok) {
      const err = await res.text();
      if (res.status === 403) console.warn(`MAX: пользователю ${userId} писать нельзя (${err})`);
      else console.error(`MAX /messages (user ${userId}) ${res.status}: ${err}`);
      return { ok: false, error: `http_${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    console.error('Сетевая ошибка при отправке в MAX:', (e as Error).message);
    return { ok: false, error: 'network' };
  }
}

const reply = (userId: string, text: string) => sendMaxToUser(userId, text, true);

async function answerCallback(callbackId: string, notification?: string) {
  if (!callbackId) return;
  try {
    await maxFetch(`/answers?callback_id=${encodeURIComponent(callbackId)}`, {
      method: 'POST', body: JSON.stringify(notification ? { notification } : {}),
    });
  } catch (e) {
    console.error('Ошибка answerCallback:', (e as Error).message);
  }
}

const awaitingEmergency = new Map<string, number>();
const armEmergency = (userId: string) => awaitingEmergency.set(userId, Date.now() + EMERGENCY_WAIT_MS);

function homeOf(userId: string): { house: House; membership: Membership; apartment: string } | null {
  const m = db.membership(userId);
  const h = m && houseById(m.houseId);
  return m && h ? { house: h, membership: m, apartment: m.apartment } : null;
}

const HELP_TEXT = [
  'Я бот вашего дома. Главное, для чего я нужен: быстро сообщить об аварии и следить, что с ней происходит.',
  '',
  '🚨 Авария в доме: течёт, залило, искрит, нет воды или света. Пришлите фото или опишите одним сообщением: заявка сразу уйдёт диспетчеру УК, соседей по стояку предупредят, о статусе напишу сюда.',
  '📋 Мои заявки: статусы ваших заявок и сроки.',
  '💧 Показания: пришлите «ХВС 123 ГВС 45 электро 7890», сохраню и посчитаю сумму. Без показаний УК начислит по нормативу, обычно дороже.',
  '🏗 Капремонт: что и когда ремонтируют в доме.',
  '🏠 Открыть приложение «Дом»: всё то же с фото и подсказками, плюс проверка квитанции и опросы соседей.',
  '',
  'Можно просто спросить своими словами: кто чинит стояк, как оспорить квитанцию, что делать при аварии.',
].join('\n');

const NO_HOUSE = '🏠 Сначала выберите свой дом и квартиру в приложении «Дом» (кнопка ниже). Это один раз, дальше я буду знать ваш адрес и телефоны вашей УК.';

async function handleCallback(userId: string, payload: string) {
  const home = homeOf(userId);
  switch (payload) {
    case 'btn_emergency': {
      if (!home) return reply(userId, NO_HOUSE);
      armEmergency(userId);
      return reply(userId,
        `📞 АДС ${home.house.managementCompany.name}: ${home.house.managementCompany.emergencyPhone}\n\n🚨 Аварийная заявка\n1. Перекройте вентиль на вводе в квартиру.\n2. Если опасно (газ, искрит, сильно льёт), сразу звоните по номеру выше.\n\nПришлите фото или опишите одним сообщением, что случилось: я передам заявку диспетчеру ${home.house.managementCompany.name}, кв. ${home.apartment}.`);
    }
    case 'btn_meters':
      return reply(userId,
        '💧 Показания счётчиков\n\nУК принимает показания с 20 по 25 число, если их не передать, начислят по нормативу, а это обычно дороже. Я напомню, когда придёт время.\n\nПришлите одним сообщением числа с циферблатов (чёрные цифры):\nХВС 123\nГВС 456\nЭлектро 7890\n\nЯ сохраню их, посчитаю расход и сумму, а если расход вдруг вырастет вдвое, предупрежу: так часто выглядит скрытая утечка.');
    case 'btn_my_requests': {
      const list = db.requests({ userId });
      if (!list.length) return reply(userId, '📋 У вас пока нет заявок. Нажмите «Авария в доме» или откройте приложение.');
      const text = list.slice(0, 5).map(r =>
        `${r.priority === 'emergency' ? '🚨' : '🔧'} ${r.id} · ${r.title}\nстатус: ${STATUS_LABEL[r.status]}\nисполнитель: ${r.assignedMaster}${OPEN_STATUSES.includes(r.status) ? `\n${slaLine(r)}` : ''}`).join('\n\n');
      return reply(userId, `📋 Ваши заявки:\n\n${text}`);
    }
    case 'btn_overhaul': {
      if (!home) return reply(userId, NO_HOUSE);
      const text = home.house.overhaulPlan.map(w =>
        `${w.workType}\n${w.status === 'in_progress' ? `идёт сейчас, выполнено ${w.progressPercent}%` : `по плану ${w.plannedYear} год`}\nподрядчик: ${w.contractor}`).join('\n\n');
      return reply(userId, `🏗 Капитальный ремонт\n${home.house.address}\n\n${text}`);
    }
    default:
      return reply(userId, 'Не понял кнопку, отправьте /start');
  }
}

function parseMeters(text: string) {
  const t = text.toLowerCase();
  const grab = (re: RegExp) => { const m = t.match(re); return m ? Number(m[1].replace(',', '.')) : null; };
  const out: Record<string, number> = {};
  const cold = grab(/(?:хвс|холодн\w*)\D{0,12}(\d+(?:[.,]\d+)?)/);
  const hot = grab(/(?:гвс|горяч\w*)\D{0,12}(\d+(?:[.,]\d+)?)/);
  const power = grab(/(?:электро\w*|свет)\D{0,12}(\d+(?:[.,]\d+)?)/);
  if (cold != null) out.cold = cold;
  if (hot != null) out.hot = hot;
  if (power != null) out.power = power;
  return Object.keys(out).length ? out : null;
}

async function handleText(userId: string, text: string) {
  const clean = (text || '').trim();
  const lower = clean.toLowerCase();
  const home = homeOf(userId);

  if (clean.startsWith('/start') || lower === 'меню' || lower.startsWith('привет')) {
    awaitingEmergency.delete(userId);
    if (!home) return reply(userId, `👋 Здравствуйте! Я помогаю жителям быстро сообщить об аварии в доме и следить за заявкой.\n\n${NO_HOUSE}`);
    return reply(userId,
      `👋 Здравствуйте!\n\nВаш дом: ${home.house.address}, кв. ${home.apartment}\nУК: ${home.house.managementCompany.name}\nАварийная служба: ${home.house.managementCompany.emergencyPhone}\n\nЧто случилось? Выберите кнопку или напишите вопрос своими словами.`);
  }

  if (isAboutMe(clean)) return reply(userId, HELP_TEXT);

  const until = awaitingEmergency.get(userId);
  if (until && until > Date.now() && home) {
    awaitingEmergency.delete(userId);
    try {
      const r = createRequest(userId, home.membership, { category: 'emergency', description: clean, title: 'Авария: ' + clean.slice(0, 60) });
      if (r.duplicateOf) return;
      return reply(userId, `Диспетчер видит заявку ${r.id} на пульте и оповестит соседей по стояку. Статус пришлю сюда.`);
    } catch (e) {
      if (e instanceof ServiceError && e.code === 'description_too_short') {
        armEmergency(userId);
        return reply(userId, 'Опишите чуть подробнее: где и что течёт или не работает.');
      }
      throw e;
    }
  }

  const meters = parseMeters(clean);
  if (meters) {
    if (!home) return reply(userId, NO_HOUSE);
    try {
      const saved = submitMeters(userId, home.membership, home.house, meters);
      const parts = Object.entries(meters).map(([k, v]) =>
        `${METER_NAMES[k]} ${v} (${saved.baseline.includes(k) ? 'первое показание, принято как начальное' : `расход ${saved.usage[k]}`})`);
      const sum = saved.baseline.length === Object.keys(meters).length
        ? 'Сумму посчитаю со следующей передачи, когда будет с чем сравнить.'
        : `Примерно к оплате: ${saved.amount.toLocaleString('ru-RU')} ₽ по тарифам (${saved.tariffs.city}).`;
      return reply(userId, `💧 Сохранил показания, кв. ${home.apartment}:\n${parts.join('\n')}\n\n${sum}${anomalyLines(saved.anomalies)}`);
    } catch (e) {
      if (e instanceof ServiceError && e.code === 'less_than_previous') {
        return reply(userId, `Число по ${METER_NAMES[String(e.extra.key)]} меньше прошлого (${e.extra.previous}). Проверьте и отправьте ещё раз.`);
      }
      if (e instanceof ServiceError) return reply(userId, 'Не разобрал показания. Формат: ХВС 123 ГВС 456 электро 7890');
      throw e;
    }
  }

  await reply(userId, await gigaChat.ask(clean, home?.house));
}

function senderOf(upd: any): string | null {
  const id = upd?.message?.sender?.user_id ?? upd?.callback?.user?.user_id ?? upd?.user?.user_id ?? null;
  return id == null ? null : String(id);
}

function updateKey(upd: any): string {
  return String(
    upd?.callback?.callback_id ?? upd?.message?.body?.mid ??
    `${upd?.update_type}:${upd?.timestamp ?? ''}:${senderOf(upd) ?? ''}`,
  );
}

async function handleUpdate(upd: any) {
  const userId = senderOf(upd);
  if (!userId) { console.warn('Не определил отправителя:', JSON.stringify(upd).slice(0, 200)); return; }
  const chatId = upd?.message?.recipient?.chat_id ?? upd?.chat_id;
  const chatType = upd?.message?.recipient?.chat_type;
  if (chatId && (!chatType || chatType === 'dialog')) dialogOf.set(userId, Number(chatId));
  if (upd.update_type === 'message_callback' || upd.callback) {
    const cb = upd.callback || {};
    await answerCallback(cb.callback_id);
    return handleCallback(userId, String(cb.payload ?? ''));
  }
  if (upd.update_type === 'bot_started') {
    const payload = String(upd.payload || '');
    const h = houseById(payload);
    if (h && !db.membership(userId)) {
      houseFromQr.set(userId, h.fiasId);
      return reply(userId, `👋 Здравствуйте! Вы пришли по QR-коду дома ${h.address}.\n\nНажмите «Открыть приложение», укажите квартиру, и заявки будут уходить в ${h.managementCompany.name}.`);
    }
    return handleText(userId, '/start');
  }
  const text = upd.message?.body?.text || '';
  const photo = (upd.message?.body?.attachments || []).find((a: any) => a?.type === 'image' && a?.payload?.url);
  if (photo) return handlePhoto(userId, photo.payload.url, text);
  if (text) return handleText(userId, text);
}

async function longPolling() {
  console.log('🔄 Long polling запущен');
  while (polling) {
    try {
      const marker = db.bot.marker;
      const res = await maxFetch(`/updates?timeout=25&limit=100${marker ? `&marker=${marker}` : ''}`);
      if (!res.ok) {
        console.error(`MAX /updates ${res.status}: ${await res.text()}`);
        await sleep(3000);
        continue;
      }
      const data = (await res.json()) as any;
      const updates: any[] = data.updates || [];
      if (data.marker != null) db.bot.marker = data.marker;
      for (const upd of updates) {
        const key = updateKey(upd);
        if (db.bot.isSeen(key)) continue;
        db.bot.markSeen(key);
        try { await handleUpdate(upd); }
        catch (e) { console.error('Ошибка обработки апдейта:', e); }
      }
    } catch (e) {
      console.error('Ошибка long polling:', (e as Error).message);
      await sleep(3000);
    }
  }
}

export async function startBot() {
  if (!env.botEnabled) {
    console.log('ℹ️  BOT_ENABLED не равен 1: бот не запущен, API и мини-приложение работают. Оповещения идут в режиме имитации.');
    return;
  }
  if (!env.maxToken) {
    console.warn('⚠️  BOT_ENABLED=1, но MAX_BOT_TOKEN пуст: бот не запущен.');
    return;
  }

  for (let attempt = 1; ; attempt++) {
    try {
      const res = await maxFetch('/me');
      if (res.status === 401) { console.error('MAX /me 401: неверный MAX_BOT_TOKEN, бот не запущен.'); return; }
      if (res.ok) {
        botInfo = (await res.json()) as typeof botInfo;
        console.log(`✅ Бот подключён к MAX: ${botInfo.name || botInfo.username || 'без имени'}`);
        polling = true;
        void longPolling();
        startReminders();
        return;
      }
      console.error(`MAX /me ${res.status}: ${await res.text()}`);
    } catch (e) {
      console.error(`Не удалось связаться с MAX (попытка ${attempt}):`, (e as Error).message);
    }
    await sleep(Math.min(60_000, attempt * 5000));
  }
}

function moscowNow() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
  }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return { period: `${p.year}-${p.month}`, day: Number(p.day), hour: Number(p.hour) };
}

async function remindMeters() {
  const { period, day, hour } = moscowNow();
  if (day < 20 || day > 25 || hour < 10 || hour >= 20) return;
  for (const m of db.memberships()) {
    if (!canMessage(m.userId) || db.remindedFor(m.userId) === period || db.hasMetersFor(m.userId, period)) continue;
    db.markReminded(m.userId, period);
    await reply(m.userId, '💧 С 20 по 25 число УК принимает показания счётчиков. Если не передать, начислят по нормативу.\n\nПришлите одним сообщением: ХВС 123 ГВС 45 электро 7890. Посчитаю расход и сумму.');
  }
}

function startReminders() {
  const tick = () => remindMeters().catch(e => console.error('Напоминания:', (e as Error).message));
  setTimeout(tick, 60_000);
  setInterval(tick, 20 * 60_000).unref();
}

async function downloadImage(url: string): Promise<{ bytes: Buffer; mime: string } | null> {
  try {
    const res = await secureFetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > 8_000_000) return null;
    const mime = sniffImage(bytes);
    return mime ? { bytes, mime } : null;
  } catch {
    return null;
  }
}

async function handlePhoto(userId: string, url: string, caption: string) {
  const home = homeOf(userId);
  if (!home) return reply(userId, NO_HOUSE);
  const waiting = (awaitingEmergency.get(userId) || 0) > Date.now();
  awaitingEmergency.delete(userId);

  const img = await downloadImage(url);
  const scan = img ? await scanImage('incident', img.bytes, img.mime).catch(() => null) : null;
  const seen = scan?.mode === 'incident' && scan.readable ? scan : null;
  const phone = home.house.managementCompany.emergencyPhone;

  if (!seen && !waiting && !caption.trim()) {
    if (scan) return reply(userId, 'На фото не вижу аварии. Если что-то случилось, нажмите «🚨 Авария в доме» и опишите одним сообщением или пришлите фото ещё раз с подписью.');
    armEmergency(userId);
    return reply(userId, `Распознавание фото сейчас недоступно. Опишите одним сообщением, что случилось, и я передам заявку диспетчеру.\nЕсли сильно льёт или искрит, звоните: ${phone}`);
  }

  const description = caption.trim() || (seen ? `${seen.label}. ${seen.summary}`.trim() : '');
  const r = createRequest(userId, home.membership, {
    category: waiting || !seen ? 'emergency' : seen.category,
    title: seen ? seen.label : 'Авария (фото из чата)',
    description: description.length >= 5 ? description : 'Фото аварии из чата',
    hasPhoto: true,
  });
  if (r.duplicateOf) return;
  const ai = seen ? `\nНа фото: ${seen.label.toLowerCase()}${seen.source === 'demo' ? ' (демо-распознавание)' : ''}.` : '';
  return reply(userId, r.priority === 'emergency'
    ? `Диспетчер видит заявку ${r.id} на пульте и оповестит соседей по стояку.${ai}\nЕсли сильно льёт или искрит, звоните: ${phone}. Статус пришлю сюда.`
    : `Заявка ${r.id} передана в УК.${ai}\nСтатус пришлю сюда.`);
}