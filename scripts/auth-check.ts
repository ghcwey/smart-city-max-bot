import crypto from 'node:crypto';
import { checkInitData } from '../src/auth.js';

const TOKEN = 'test-bot-token';

function sign(params: Record<string, string>, token = TOKEN): string {
  const launch = Object.entries(params).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(launch).digest('hex');
  return Object.entries({ ...params, hash }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

const now = Math.floor(Date.now() / 1000);
const user = JSON.stringify({ id: 1234567, first_name: 'Олег' });
const base = { auth_date: String(now), query_id: 'q1', user, start_param: 'c637718a-3358-4dd6-ad87-e2dabf2bebe9' };

const cases: Array<[string, string, boolean]> = [
  ['валидная подпись', sign(base), true],
  ['подменён user', sign(base).replace(encodeURIComponent(user), encodeURIComponent(JSON.stringify({ id: 1, first_name: 'X' }))), false],
  ['чужой токен', sign(base, 'other-token'), false],
  ['просрочено на 2 часа', sign({ ...base, auth_date: String(now - 7200) }), false],
  ['два hash', sign(base) + '&hash=00', false],
  ['пусто', '', false],
];

let failed = 0;
for (const [name, raw, want] of cases) {
  const got = !!checkInitData(raw, TOKEN, 3600);
  console.log(`${got === want ? 'OK  ' : 'FAIL'} ${name}`);
  if (got !== want) failed++;
}
const u = checkInitData(sign(base), TOKEN, 3600);
console.log(u?.id === '1234567' ? 'OK   user_id из подписанных данных' : 'FAIL user_id');
process.exit(failed || u?.id !== '1234567' ? 1 : 0);
