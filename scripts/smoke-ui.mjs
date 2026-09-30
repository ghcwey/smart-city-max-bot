import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const origin = process.argv[2] || 'http://localhost:3000';
const USER = process.argv[3] || 'smoke-' + Date.now().toString(36);
const doAttach = process.argv[4] === 'attach';
const staffCode = process.argv[5] || '';
const base = origin + '/api/v1';

if (doAttach) {
  await fetch(base + '/attach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-User': USER },
    body: JSON.stringify({ houseId: 'c637718a-3358-4dd6-ad87-e2dabf2bebe9', apartment: '42', consent: true }),
  });
}

if (staffCode) {
  await fetch(base + '/staff/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-User': USER }, body: JSON.stringify({ code: staffCode }) });
  await fetch(base + '/requests', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-User': USER }, body: JSON.stringify({ category: 'emergency', description: 'Течёт стояк, вода на полу' }) });
}

const html = fs.readFileSync('./public/miniapp/index.html', 'utf8').replace(/<script src="https:[^>]+><\/script>/, '');
const dom = new JSDOM(html, { runScripts: 'outside-only', url: origin + '/miniapp/?debug_user=' + USER });
const { window } = dom;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.scrollTo = () => {};
window.fetch = async (url, { signal, ...opts } = {}) => {
  const r = await fetch(base + String(url).replace('/api/v1', ''), opts);
  const text = await r.text();
  return { ok: r.ok, status: r.status, json: async () => JSON.parse(text) };
};
window.eval(fs.readFileSync('./public/miniapp/app.js', 'utf8'));
await new Promise(r => setTimeout(r, 2000));
const root = window.document.getElementById('root');
console.log('RENDER:', root.textContent.replace(/\s+/g, ' ').slice(0, 300));
console.log('tiles:', root.querySelectorAll('.tile').length, '| hero:', root.querySelectorAll('.hero').length, '| tabs:', root.querySelectorAll('.tabbar .tb').length);
const errors = [];
window.addEventListener('error', e => errors.push(e.message));
for (const tb of [...root.querySelectorAll('.tabbar .tb')]) {
  tb.click();
  await new Promise(r => setTimeout(r, 1200));
  const text = root.textContent.replace(/\s+/g, ' ');
  console.log('TAB', tb.textContent.trim(), '->', text.length > 50 ? 'ok ' + text.slice(0, 70) : 'EMPTY');
}
if (staffCode) {
  [...root.querySelectorAll('.tabbar .tb')][0].click();
  await new Promise(r => setTimeout(r, 800));
  const tile = [...root.querySelectorAll('.tile')].find(x => x.textContent.includes('Пульт'));
  if (tile) tile.click();
  await new Promise(r => setTimeout(r, 2000));
  const txt = root.textContent.replace(/\s+/g, ' ');
  console.log('PULT', root.querySelectorAll('.twin-apt.alarm').length, 'alarm,', root.querySelectorAll('.twin-apt.shut').length, 'shut,', root.querySelectorAll('.twin-apt.risk').length, 'risk |', txt.includes('Плановое отключение') ? 'outage btn ok' : 'NO outage');
}
if (errors.length) console.log('ERRORS', errors);
process.exit(0);
