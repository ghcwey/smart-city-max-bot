import { env, defaultHouse, houses, houseById, tariffsFor, miniAppUrl, ROOT } from './config.js';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { api } from './api.js';
import { startBot } from './maxbot.js';
import { gigaChat } from './gigachat.js';
import { closeStaleDemoIncidents } from './services.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

app.use('/api/v1/ai', express.json({ limit: '6mb' }));
app.use(express.json({ limit: '1mb' }));
app.use('/api/v1', api);

const appDir = path.join(ROOT, 'public');
app.use(express.static(appDir, { maxAge: env.isProd ? '10m' : 0 }));
app.get('/', (_req, res) => res.redirect('/miniapp/'));

app.get('/poster/:fiasId', (req, res) => {
  const h = houseById(String(req.params.fiasId));
  if (!h) return res.status(404).send('Дом не найден');
  const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  res.type('html').send(`<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>QR для подъезда</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:32px auto;padding:0 20px;text-align:center;color:#111}
h1{font-size:30px;margin:0 0 8px}p{font-size:18px;line-height:1.45}img{width:320px;height:320px;margin:20px auto;display:block}
.a{font-weight:600}.s{color:#555;font-size:15px}@media print{button{display:none}}</style></head><body>
<h1>Авария в доме? Сообщите в MAX</h1>
<p class="a">${esc(h.address)}</p>
<img src="/api/v1/houses/${esc(h.fiasId)}/qr.svg" alt="QR-код">
<p>Наведите камеру телефона на код. Откроется приложение «Дом» в MAX, ваш дом уже выбран: укажите квартиру и отправьте заявку с фото.</p>
<p class="s">Заявку видит диспетчер ${esc(h.managementCompany.name)}. Соседей по стояку предупредят об отключении воды, статус придёт вам в чат.<br>
Аварийная служба круглосуточно: ${esc(h.managementCompany.emergencyPhone)}</p>
<button onclick="print()">Распечатать</button></body></html>`);
});

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
  console.error('Необработанная ошибка:', err);
  res.status(500).json({ error: 'internal' });
});

app.listen(env.port, () => {
  console.log(`\n🚀 Сервер на порту ${env.port}`);
  console.log(`🏠 Мини-приложение: ${miniAppUrl}`);
  console.log(`🩺 Health: ${env.publicUrl}/api/v1/health`);
  console.log(`🏢 Домов в реестре: ${houses.length} (по умолчанию ${defaultHouse.address})`);
  const t = tariffsFor(defaultHouse.city);
  console.log(`💰 Тарифы ${t.city}: период ${t.since}…${t.until}`);
  if (!fs.existsSync(path.join(appDir, 'miniapp', 'app.js'))) {
    console.warn('⚠️  Бандл мини-аппы не собран. Запустите: npm run build:app');
  }
  if (env.authDev) console.warn('⚠️  AUTH_DEV=1: вход по X-Debug-User без подписи. Только для локального запуска.');
  if (!env.authDev && !env.maxToken) console.warn('⚠️  MAX_BOT_TOKEN пуст и AUTH_DEV выключен: войти можно только по TEST_API_KEY.');
  if (env.demoMode) console.log('🎭 DEMO_MODE: без ключей GigaChat сканер отвечает заготовкой, без бота оповещения имитируются. Везде пометка «демо».');
  void gigaChat.check().then(s => console.log(`🤖 GigaChat: ${s}`));
  closeStaleDemoIncidents();
  setInterval(closeStaleDemoIncidents, 5 * 60_000).unref();
  void startBot();
});
