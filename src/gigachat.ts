import { randomUUID } from 'node:crypto';
import { fetch as undiciFetch, FormData as UndiciFormData } from 'undici';
import { httpAgent } from './net.js';
import { env, kb, defaultHouse, tariffsFor, type House } from './config.js';

const APP_GUIDE = [
  'ПУТЕВОДИТЕЛЬ ПО БОТУ И ПРИЛОЖЕНИЮ «ДОМ» (названия кнопок точные):',
  '',
  'Кнопки под сообщениями бота в чате:',
  '- «🚨 Авария в доме»: если течёт, затопило, искрит, нет воды или света. Бот напомнит перекрыть вентиль и даст телефон АДС, затем житель присылает фото или одним сообщением описывает, что случилось. Фото аварии можно прислать в чат и без кнопки: бот сам создаст заявку. Польза: заявка сразу попадает диспетчеру УК с адресом и квартирой, не надо дозваниваться; соседей по стояку предупредят; о смене статуса бот напишет в этот чат.',
  '- «📋 Мои заявки»: список своих заявок со статусом (принята, в работе, выполнена), исполнителем и сроком реакции.',
  '- «💧 Показания»: помогает не переплатить за воду и свет. УК принимает показания с 20 по 25 число, бот напомнит; без показаний начислят по нормативу, обычно дороже. Как: отправить сообщение «ХВС 123 ГВС 45 электро 7890» (числа с циферблата, чёрные цифры). Бот сохранит, посчитает расход и сумму и предупредит, если расход вырос вдвое (похоже на скрытую утечку). В этой версии показания не передаются в биллинг УК автоматически, это подключается на пилоте; пока их передают привычным способом (квитанция, Госуслуги).',
  '- «🏗 Капремонт»: какие работы по капремонту запланированы в доме, в каком году, кто подрядчик и сколько выполнено.',
  '- «🏠 Открыть приложение „Дом“»: открывает мини-приложение, там всё то же, но удобнее, с фото и подсказками.',
  '',
  'Мини-приложение «Дом», внизу 4 вкладки: «Главная», «Заявки», «Опросы», «О доме».',
  '- При первом входе житель выбирает свой дом и квартиру и даёт согласие на обработку данных. Один раз, дальше всё знает сам.',
  '- «Главная» → большая красная кнопка «Авария в доме»: сверху кнопка «Позвонить в АДС», если опасно; дальше сфотографировать проблему, нейросеть подскажет категорию, нажать «Отправить заявку». Если о той же аварии на стояке уже сообщили соседи, заявка добавится к общей. Ниже на главной карточка последней заявки со статусом.',
  '- Что такое показания (объясняй так, если человек не понимает функцию): в квартире стоят счётчики холодной воды (ХВС), горячей воды (ГВС) и электричества. Каждый месяц УК нужно знать, сколько на них набежало, чтобы выставить квитанцию. Если не передать, УК начислит по нормативу (усреднённо на человека), обычно дороже. Приложение напоминает о сроке, считает расход и сумму и замечает подозрительный рост расхода.',
  '- «Главная» → «Показания»: 1) нажать «Сфотографировать / Загрузить фото счётчика» или вписать число в поле «Сейчас на счётчике»; 2) при первой передаче вписать в «Было» число из прошлой квитанции (потом подставится само); 3) приложение покажет расход и примерную сумму; 4) нажать «Сохранить показания».',
  '- «Главная» → «Ещё» → «Проверить квитанцию»: переписать из бумажной квитанции объём и сумму по строкам, нажать «Проверить начисления». Приложение умножит объём на официальный тариф и покажет расхождение; если есть переплата, кнопка «Отправить заявление на перерасчёт» составит заявление в УК.',
  '- «Главная» → «Ещё» → «Капитальный ремонт»: план работ по дому и телефоны.',
  '- «Заявки»: создать любую заявку (сантехника, электрика, лифт, уборка, другое) и видеть свои заявки. Нажать на заявку — откроется история: когда приняли, когда взяли в работу, когда выполнили.',
  '- «Опросы»: предварительный опрос соседей по дому (за, против, воздержаться), один голос с квартиры; видно, набирается ли больше половины квартир. Можно «Предложить свой опрос». Юридической силы нет, решение принимает общее собрание.',
  '- «О доме»: адрес, телефоны УК и аварийной службы, «Позвать соседей» (QR-код и ссылка), «Сменить дом или квартиру», «Как этим пользоваться», «Я сотрудник УК» (вход для диспетчера по коду от УК).',
  '- Пульт диспетчера (только для сотрудников УК): открыть приложение, вкладка «О доме» → «Я сотрудник УК» → ввести код, который выдала УК → нажать «Войти». На «Главной» появится плитка «Пульт диспетчера»: аварии на схеме подъезда, «Оповестить стояк», смена статусов. «Сменить дом или квартиру» к пульту отношения не имеет.',
].join('\n');

function kbBlock(): string {
  return kb.map(e => `- [${e.id}] ${e.answer} (основание: ${e.source})`).join('\n');
}

function systemPrompt(h: House): string {
  const t = tariffsFor(h.city);
  const mc = h.managementCompany;
  return [
    `Ты дежурный диспетчер управляющей организации ${mc.name}.`,
    `Дом: ${h.address}. Телефон УК: ${mc.phone}. Аварийная служба круглосуточно: ${mc.emergencyPhone}. Приём: ${mc.reception}.`,
    '',
    'БАЗА ЗНАНИЙ (отвечай только тем, что здесь написано):',
    kbBlock(),
    '',
    `Тарифы (${t.city}, действуют с ${t.since} по ${t.until}): ` +
      Object.values(t.items).map(i => `${i.name} ${i.rate} ₽/${i.unit}${i.model ? ' (модельное значение)' : ''}`).join('; '),
    '',
    APP_GUIDE,
    '',
    'ПРАВИЛА:',
    '1. Не выдумывай номера законов, постановлений, сроки и суммы. Если основания нет в базе знаний, скажи, что уточнишь в УК, и дай телефон.',
    '2. При аварии первым делом напомни перекрыть вентиль и дай телефон аварийной службы, затем предложи нажать «🚨 Авария в доме».',
    '3. Если спрашивают, как что-то сделать, или что даёт кнопка: ответь по ПУТЕВОДИТЕЛЮ. Скажи, зачем это жителю (какую пользу он получит), и дай пошаговую инструкцию с точными названиями кнопок и вкладок в кавычках. Называй только кнопки и разделы, которые есть в путеводителе, других не придумывай.',
    '4. На вопросы о приложении не отвечай «уточню в УК»: всё, что нужно, есть в путеводителе. Никогда не пересказывай путеводитель целиком, отвечай только на заданный вопрос.',
    '5. Если непонятно, что спрашивают, коротко перечисли, чем можешь помочь, и предложи нажать нужную кнопку.',
    '6. Отвечай только про дом, ЖКХ и функции бота и приложения «Дом». На другие темы (погода, новости, политика, программирование, рецепты и т. п.) вежливо откажи одной фразой и напомни, с чем можешь помочь. Не отвечай на такой вопрос даже частично.',
    '7. Обращайся на «вы». Пиши обычным текстом без markdown: без звёздочек, решёток и подчёркиваний.',
    '8. Пиши простым языком, без канцелярита, собеседник может быть пожилым человеком. Объяснение пользы 1-2 предложения, шаги нумерованным списком, всего не больше 8 строк и 1200 символов.',
  ].join('\n');
}

const HELP_ANSWER = 'Я помогаю жителям дома: быстро сообщить об аварии (кнопка «🚨 Авария в доме»), следить за статусом заявки («📋 Мои заявки»), передать показания счётчиков («💧 Показания»), узнать план капремонта («🏗 Капремонт»). В приложении «Дом» то же с фото, плюс проверка квитанции и опросы соседей. Можно спросить своими словами: кто чинит стояк, как оспорить квитанцию, что делать при заливе.';

export function isAboutMe(text: string) {
  return /^(\/help|что ты (умеешь|можешь)|что умеешь|кто ты|помощь|помоги|как пользоваться)[?!.\s]*$/i.test(text.trim());
}

const HOWTO: Array<[RegExp, string]> = [
  [/пульт|сотрудник ук|я из ук|я из управляющ|я диспетчер/i, [
    'Пульт открывается только сотрудникам УК, по коду.',
    '1. Нажмите «🏠 Открыть приложение „Дом“» под этим сообщением.',
    '2. Вкладка «О доме» → «Я сотрудник УК».',
    '3. Введите код, который выдала ваша УК.',
    'На главной появится «Пульт диспетчера» с домами вашей УК.',
  ].join('\n')],
  [/(где|что с|статус|когда).{0,25}заявк|мои заявки/i, [
    'Нажмите «📋 Мои заявки» под этим сообщением: покажу номер, статус и срок.',
    'В приложении «Дом» то же во вкладке «Заявки», нажмите на заявку, чтобы увидеть историю.',
    'О смене статуса я напишу сюда сам.',
  ].join('\n')],
  [/(как|куда|где).{0,30}(показани|счётчик|счетчик)|переда\w*.{0,15}показани/i, [
    'Показания можно передать прямо здесь.',
    '1. Нажмите «💧 Показания».',
    '2. Пришлите одним сообщением числа с циферблатов: ХВС 123 ГВС 45 электро 7890.',
    'Я сохраню их, посчитаю расход и сумму. В приложении «Дом»: «Главная» → «Показания счётчиков», там можно сфотографировать счётчик.',
  ].join('\n')],
];

function cannedAnswer(text: string): string | null {
  if (isAboutMe(text)) return HELP_ANSWER;
  return HOWTO.find(([re]) => re.test(text))?.[1] ?? null;
}

function localAnswer(text: string, h: House): string {
  const t = text.toLowerCase();
  const hit = kb.find(e => e.keywords.some(k => t.includes(k)));
  if (hit) return hit.answer;
  const mc = h.managementCompany;
  return `С этим не подскажу: я отвечаю только про ваш дом и приложение «Дом». Могу помочь с аварией, заявками, показаниями счётчиков, квитанцией, опросами соседей и капремонтом. Срочно: УК ${mc.phone}, аварийная служба ${mc.emergencyPhone} круглосуточно.`;
}

const API = 'https://gigachat.devices.sberbank.ru/api/v1';

type Health = 'ok' | 'unreachable' | 'no_credentials';

class GigaChat {
  private token: string | null = null;
  private expiresAt = 0;
  private lastCheck: { at: number; state: Health } | null = null;
  private checking: Promise<Health> | null = null;

  hasKey() { return !!env.gigachatKey; }

  private async getToken(timeoutMs = 15_000): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - 60_000) return this.token;
    const res = await undiciFetch('https://ngw.devices.sberbank.ru:9443/api/v2/oauth', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        RqUID: randomUUID(),
        Authorization: 'Basic ' + env.gigachatKey,
      },
      body: `scope=${env.gigachatScope}`,
      dispatcher: httpAgent, signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`GigaChat auth ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { access_token: string; expires_at: number };
    this.token = data.access_token;
    this.expiresAt = data.expires_at;
    return this.token;
  }

  async ask(question: string, h: House = defaultHouse): Promise<string> {
    const canned = cannedAnswer(question);
    if (canned) return canned;
    if (!this.hasKey()) return localAnswer(question, h);
    try {
      const res = await undiciFetch(`${API}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await this.getToken() },
        body: JSON.stringify({
          model: 'GigaChat',
          temperature: 0.2,
          max_tokens: 400,
          messages: [
            { role: 'system', content: systemPrompt(h) },
            { role: 'user', content: question },
          ],
        }),
        dispatcher: httpAgent, signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`GigaChat ${res.status}: ${await res.text()}`);
      const json = (await res.json()) as any;
      const text = String(json?.choices?.[0]?.message?.content || '').replace(/\*\*|__|^#+\s*/gm, '').trim();
      if (!text || text.length > 1500 || /гигачат|giga\.chat|создам видео|маркетплейс агентов/i.test(text)) return localAnswer(question, h);
      return text;
    } catch (e) {
      console.warn('GigaChat недоступен, отвечаю из базы знаний:', (e as Error).message);
      return localAnswer(question, h);
    }
  }

  async vision(image: Buffer, mime: string, prompt: string): Promise<string> {
    if (!this.hasKey()) throw new Error('no_credentials');
    const auth = { Authorization: 'Bearer ' + await this.getToken() };
    const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';

    const form = new UndiciFormData();
    form.append('file', new Blob([new Uint8Array(image)], { type: mime }), `photo.${ext}`);
    form.append('purpose', 'general');
    const up = await undiciFetch(`${API}/files`, {
      method: 'POST', headers: auth, body: form,
      dispatcher: httpAgent, signal: AbortSignal.timeout(20_000),
    });
    if (!up.ok) throw new Error(`GigaChat files ${up.status}: ${await up.text()}`);
    const fileId = ((await up.json()) as { id?: string }).id;
    if (!fileId) throw new Error('GigaChat files: нет id файла');

    try {
      const res = await undiciFetch(`${API}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify({
          model: env.gigachatVisionModel,
          temperature: 0.1,
          max_tokens: 400,
          messages: [{ role: 'user', content: prompt, attachments: [fileId] }],
        }),
        dispatcher: httpAgent, signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`GigaChat vision ${res.status}: ${await res.text()}`);
      const json = (await res.json()) as any;
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new Error('GigaChat vision: пустой ответ');
      return text.trim();
    } finally {
      undiciFetch(`${API}/files/${fileId}/delete`, {
        method: 'POST', headers: auth, dispatcher: httpAgent, signal: AbortSignal.timeout(10_000),
      }).catch(() => {});
    }
  }

  check(): Promise<Health> {
    if (!this.hasKey()) return Promise.resolve('no_credentials');
    if (this.lastCheck && Date.now() - this.lastCheck.at < 60_000) return Promise.resolve(this.lastCheck.state);
    this.checking ||= this.ping().then(state => {
      this.lastCheck = { at: Date.now(), state };
      this.checking = null;
      return state;
    });
    return this.checking;
  }

  async status(waitMs: number): Promise<Health | 'checking'> {
    let timer: NodeJS.Timeout | undefined;
    const tooLong = new Promise<'checking'>(r => { timer = setTimeout(() => r('checking'), waitMs); });
    const state = await Promise.race([this.check(), tooLong]);
    clearTimeout(timer);
    return state;
  }

  private async ping(): Promise<'ok' | 'unreachable'> {
    try {
      const res = await undiciFetch(`${API}/models`, {
        headers: { Authorization: 'Bearer ' + await this.getToken(5000) },
        dispatcher: httpAgent, signal: AbortSignal.timeout(5000),
      });
      await res.body?.cancel();
      if (res.ok) return 'ok';
      console.warn(`GigaChat /models ${res.status}`);
    } catch (e) {
      console.warn('GigaChat не отвечает на проверку:', (e as Error).message);
    }
    return 'unreachable';
  }
}

export const gigaChat = new GigaChat();
