# «Дом» — эксплуатация живого стенда

Стенд = этот репозиторий в Docker на сервере команды + российский HTTPS-туннель cloudpub.ru,
который отдаёт порт стенда наружу. Бот работает только здесь (`BOT_ENABLED=1`).

## 1. Что где

| Что | Значение |
|---|---|
| Папка проекта на сервере | `~/dom` |
| Контейнер | `max-zhkh` (compose-сервис `app`), `restart: unless-stopped`, healthcheck каждые 30 с |
| Порт на хосте | `HOST_PORT` из `.env` |
| База | том Docker `dom_dom-data` → `/app/data/db.json` |
| Публичный адрес | `PUBLIC_URL` из `.env` (туннель cloudpub, systemd-сервис `cloudpub`) |
| Сторож | cron раз в 3 минуты `~/dom/scripts/watchdog.sh`, лог `~/dom/watchdog.log` |

`.env` стенда (права 600) содержит: `AUTH_DEV=0`, `BOT_ENABLED=1`, `MAX_BOT_TOKEN`,
`MAX_BOT_USERNAME`, `PUBLIC_URL`, `TEST_API_KEY`, `STAFF_CODES` (коды сотрудников по УК), ключ GigaChat, `DADATA_TOKEN`.
Значения ключа тестов и кода сотрудника УК идут на служебный слайд.

## 2. Команды

```bash
cd ~/dom
docker compose ps                          # состояние и health
docker compose logs -f --tail 50 app       # живой лог
curl -s localhost:$HOST_PORT/api/v1/health # локальная проверка
docker compose restart app                 # перезапуск
tail -20 watchdog.log                      # что делал сторож
```

## 3. Обновить код

С рабочей машины собрать архив без `node_modules`, `data`, `.env`, `public/miniapp`, залить и
распаковать в `~/dom`, затем:

```bash
cd ~/dom
docker compose up -d --build   # пересборка ~1 мин, база в томе сохраняется
docker compose logs --tail 20 app
```

Мини-приложение кэшируется во вьюхе MAX: чтобы увидеть новый фронт, закройте и откройте его заново.

## 4. Сторож и мониторинг

`scripts/watchdog.sh` проверяет `/api/v1/health`:
- локально не отвечает → `docker compose up -d` и перезапуск контейнера;
- локально жив, а публичный адрес нет дважды за 20 с → перезапуск туннеля `cloudpub`.

Внешний мониторинг с оповещением (рекомендуется на период проверки): завести бесплатный
HTTP-монитор (UptimeRobot, HetrixTools, Uptime Kuma на другой машине) на `PUBLIC_URL/api/v1/health`
с интервалом 5 минут и уведомлением на почту или в Telegram.

## 5. Мини-приложение в MAX

Мини-приложение открывается только кнопкой `open_app` в чате с ботом (и диплинком
`max.ru/<бот>?startapp=<дом>` из QR). Житель опознаётся по подписанным launch-параметрам MAX.

1. Привязать `PUBLIC_URL/miniapp/` к боту. Ботам хакатона это делают организаторы: ссылку
   отправляем через их форму сбора ссылок на мини-приложения.
2. После привязки `docker compose restart app`.
3. Проверить в мобильном и веб-клиенте MAX: `/start` → «Открыть приложение „Дом“». Если в логе
   «MAX отклонил кнопку open_app», привязки ещё нет: бот шлёт клавиатуру без этой кнопки до перезапуска.

## 6. Сброс демо-данных

```bash
cd ~/dom && docker compose down -v && docker compose up -d
```

Вернёт стартовую базу: три опроса, без заявок, прописок и сотрудников.

## 7. Роли на стенде

- Житель: любой пользователь MAX после выбора дома и квартиры.
- Диспетчер: пользователь, который ввёл код своей УК из `STAFF_CODES` в «О доме → Я сотрудник УК»
  (пульт всех домов этой УК и только их), или user_id из `DISPATCHER_IDS` (все дома).
- Подключить новую УК: добавить её дома в `config/houses.json` с `managementCompany.id` и её код в `STAFF_CODES`.
- Тестовые жители API: `X-Test-Key: $TEST_API_KEY`, `X-Test-User: test-resident-1 | test-resident-2`.
  Диспетчером не становятся.
