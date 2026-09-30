#!/bin/bash
# Сторож стенда «Дом»: локальный health -> перезапуск контейнера, публичный health -> перезапуск туннеля.
# Запускается cron раз в 3 минуты:  */3 * * * * /путь/к/проекту/scripts/watchdog.sh
cd "$(dirname "$0")/.." || exit 0
LOG="$PWD/watchdog.log"
PUB=$(grep ^PUBLIC_URL= .env | cut -d= -f2-)
PORT=$(grep ^HOST_PORT= .env | cut -d= -f2-)
ts() { date '+%F %T'; }

if ! curl -fsS -m 10 "http://127.0.0.1:${PORT:-3001}/api/v1/health" >/dev/null; then
  echo "$(ts) local health FAIL -> docker compose up -d / restart" >> "$LOG"
  docker compose up -d >> "$LOG" 2>&1
  docker compose restart app >> "$LOG" 2>&1
  exit 0
fi

if [ -n "$PUB" ] && ! curl -fsS -m 20 "$PUB/api/v1/health" >/dev/null; then
  sleep 20
  if ! curl -fsS -m 20 "$PUB/api/v1/health" >/dev/null; then
    echo "$(ts) public health FAIL -> restart tunnel" >> "$LOG"
    sudo systemctl restart cloudpub >> "$LOG" 2>&1
  fi
fi
tail -n 500 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
