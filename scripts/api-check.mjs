const base = process.argv[2] || 'http://localhost:3000/api/v1';
const testKey = process.argv[3] || '';
const invite = process.argv[4] || '';
let failed = 0;

async function call(method, path, { user, test, body, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (user) h['X-Debug-User'] = user;
  if (test) { h['X-Test-Key'] = testKey; h['X-Test-User'] = test; }
  const r = await fetch(base + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}
function expect(name, cond, info) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${name}${cond ? '' : ' -> ' + JSON.stringify(info).slice(0, 300)}`);
  if (!cond) failed++;
}

const TIP = 'c637718a-3358-4dd6-ad87-e2dabf2bebe9';
const NAUKA = '59d1f52f-a3cc-4525-b6b6-9bff8d2cdc76';
const u1 = 'chk-' + Date.now().toString(36);
const u2 = u1 + '-b';
const u3 = u1 + '-c';

let r = await call('GET', '/health');
expect('health 200', r.status === 200 && r.data.status === 'ok', r);

r = await call('GET', '/me');
expect('без входа /me -> 401 (если AUTH_DEV выключен) или dev', r.status === 401 || r.status === 200, r);

r = await call('GET', '/me', { user: 'anyone' });
expect('случайный X-Debug-User не диспетчер', r.status !== 200 || r.data.role === 'resident', r.data);

r = await call('GET', '/dispatch/state', { user: 'anyone' });
expect('случайный пользователь не открывает пульт (403)', r.status === 403 || r.status === 401, r);

r = await call('POST', '/requests', { user: u1, body: { category: 'emergency', description: 'Течёт стояк, вода на полу' } });
expect('заявка без прописки -> 403', r.status === 403 && r.data.error === 'membership_required', r);

r = await call('POST', '/attach', { user: u1, body: { houseId: TIP, apartment: '42', consent: true } });
expect('прописка u1 в Типанова кв.42', r.status === 201, r);
r = await call('POST', '/attach', { user: u2, body: { houseId: NAUKA, apartment: '12', consent: true } });
expect('прописка u2 на Науки кв.12', r.status === 201, r);
r = await call('POST', '/attach', { user: u2, body: { houseId: TIP, apartment: '999', consent: true } });
expect('квартира вне дома -> 400', r.status === 400, r);

r = await call('POST', '/requests', { user: u1, body: { apartment: '1', category: 'emergency', description: 'Течёт стояк ГВС, вода на полу' } });
expect('квартира берётся из прописки, а не из тела', r.status === 201 && r.data.apartment === '42' && r.data.houseId === TIP, r.data);
const reqId = r.data?.id;

r = await call('GET', '/votes', { user: u1 });
const tipVote = (r.data || [])[0];
expect('опросы своего дома', r.status === 200 && tipVote, r);
r = await call('POST', `/votes/${tipVote.id}`, { user: u2, body: { choice: 'yes' } });
expect('голос в опросе чужого дома -> 404', r.status === 404, r);
r = await call('POST', `/votes/${tipVote.id}`, { user: u1, body: { choice: 'no' } });
expect('голос квартиры учтён', r.status === 200 && r.data.myChoice === 'no', r.data);
await call('POST', '/attach', { user: u3, body: { houseId: TIP, apartment: '42', consent: true } });
r = await call('POST', `/votes/${tipVote.id}`, { user: u3, body: { choice: 'yes' } });
expect('второй житель той же квартиры не голосует повторно', r.status === 200 && r.data.myChoice === 'no', r.data);
expect('кворум = больше половины', r.data.quorumNeed === Math.floor(r.data.total / 2) + 1, r.data);

r = await call('POST', '/meters', { user: u1, body: { values: { cold: 100, hot: 50 }, previous: { cold: 90, hot: 45 } } });
expect('показания приняты', r.status === 201 && r.data.usage.cold === 10, r.data);
r = await call('POST', '/meters', { user: u1, body: { values: { cold: 95 }, previous: { cold: 0 } } });
expect('previous из тела не перекрывает базу (меньше прошлого -> 400)', r.status === 400 && r.data.error === 'less_than_previous', r.data);
r = await call('GET', '/meters/last', { user: u3 });
expect('сосед по квартире не видит чужие показания', r.status === 200 && r.data.values === null, r.data);

r = await call('PATCH', `/requests/${reqId}`, { user: u1, body: { status: 'done' } });
expect('житель не меняет статус (403)', r.status === 403, r);

if (invite) {
  r = await call('POST', '/staff/login', { user: u2, body: { code: 'wrong' } });
  expect('неверный код сотрудника -> 403', r.status === 403, r);
  const disp = u1 + '-d';
  await call('POST', '/attach', { user: disp, body: { houseId: TIP, apartment: '1', consent: true } });
  r = await call('POST', '/staff/login', { user: disp, body: { code: invite } });
  expect('сотрудник УК входит по коду', r.status === 201, r);
  r = await call('GET', '/dispatch/state', { user: disp });
  expect('пульт своего дома', r.status === 200 && r.data.incidents.some(i => i.id === reqId), r.data);
  r = await call('GET', `/dispatch/state?houseId=${NAUKA}`, { user: disp });
  expect('пульт чужого дома -> 403', r.status === 403, r);
  await call('POST', '/attach', { user: disp, body: { houseId: NAUKA, apartment: '5', consent: true } });
  await call('POST', '/staff/login', { user: disp, body: { code: invite } });
  r = await call('GET', `/dispatch/state?houseId=${NAUKA}`, { user: disp });
  expect('смена дома + тот же код не открывают пульт другой УК', r.status === 403, r);
  await call('POST', '/attach', { user: disp, body: { houseId: TIP, apartment: '1', consent: true } });
  const u4 = u1 + '-e';
  await call('POST', '/attach', { user: u4, body: { houseId: TIP, apartment: '46', consent: true } });
  r = await call('POST', '/requests', { user: u4, body: { category: 'emergency', description: 'Сверху течёт по стояку, вода в ванной' } });
  expect('сосед по стояку: заявка приклеилась к открытой аварии', r.status === 201 && r.data.duplicateOf === reqId, r.data);
  r = await call('GET', '/dispatch/state', { user: disp });
  const inc = (r.data.incidents || []).find(i => i.id === reqId);
  expect('на пульте одна авария, сообщили двое', inc && inc.reports === 2 && r.data.incidents.filter(i => i.apartment === 46).length === 0, inc);
  expect('зона = весь стояк, залив только на 1-2 этажа ниже', inc && inc.zone.length === 9 && inc.zone.find(z => z.apartment === 38).relation === 'flood' && inc.zone.find(z => z.apartment === 46).relation === 'riser', inc && inc.zone);
  r = await call('POST', '/dispatch/notify', { user: disp, body: { incidentId: reqId } });
  expect('оповещение стояка по пропискам', r.status === 201 && r.data.results.some(x => x.apartment === 42 && x.subscribers >= 2 && x.relation === 'source'), r.data);
  r = await call('POST', '/dispatch/outage', { user: disp, body: { utility: 'hot', scope: 'entrance', entrance: 2, from: new Date(Date.now() + 864e5).toISOString(), to: new Date(Date.now() + 90e6).toISOString(), reason: 'замена задвижки' } });
  expect('плановое отключение по подъезду', r.status === 201 && r.data.apartments === 36 && r.data.recipients >= 3, r.data);
  r = await call('POST', '/dispatch/outage', { user: disp, body: { utility: 'hot', scope: 'house', from: new Date(Date.now() + 90e6).toISOString(), to: new Date(Date.now() + 864e5).toISOString() } });
  expect('отключение с перепутанным временем -> 400', r.status === 400, r.data);
  r = await call('POST', '/dispatch/outage', { user: u1, body: { utility: 'hot', scope: 'house', from: new Date().toISOString(), to: new Date(Date.now() + 1e6).toISOString() } });
  expect('житель не делает отключение (403)', r.status === 403, r.data);
  r = await call('PATCH', `/requests/${reqId}`, { user: disp, body: { status: 'in_progress', note: 'Бригада выехала' } });
  expect('диспетчер: в работе', r.status === 200 && r.data.request.status === 'in_progress', r.data);
  r = await call('PATCH', `/requests/${reqId}`, { user: disp, body: { status: 'done' } });
  expect('диспетчер: закрыта', r.status === 200 && r.data.request.status === 'done', r.data);
  r = await call('GET', '/dispatch/state', { user: disp });
  expect('закрытая авария ушла с пульта', !r.data.incidents.some(i => i.id === reqId), r.data);
  r = await call('GET', '/requests', { user: u1 });
  expect('житель видит статус и историю', r.data[0].status === 'done' && r.data[0].history.length >= 3, r.data[0]);
  r = await call('GET', '/requests', { user: u4 });
  expect('статус ушёл и соседу, который сообщил второй', r.data[0].status === 'done', r.data[0]);
}

if (testKey) {
  r = await call('GET', '/me', { test: 'test-resident-1' });
  expect('тестовый житель по X-Test-Key', r.status === 200 && r.data.membership && r.data.role === 'resident', r.data);
  r = await call('POST', '/staff/login', { test: 'test-resident-1', body: { code: invite || 'x' } });
  expect('тестовый житель не становится диспетчером', r.status === 403, r);
  r = await call('GET', '/me', { test: 'nobody' });
  expect('неизвестный тестовый пользователь -> 401', r.status === 401, r);
  r = await call('GET', '/house', { test: 'test-resident-2' });
  expect('тестовый житель 2 в Казани', r.status === 200 && r.data.city === 'kzn', r.data);
  r = await call('GET', '/tariffs?city=kzn');
  expect('тарифы Казани', r.status === 200 && r.data.city === 'Казань', r.data);
}

console.log(failed ? `\n${failed} проверок не прошло` : '\nВсе проверки прошли');
process.exit(failed ? 1 : 0);
