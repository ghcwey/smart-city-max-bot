import { JSDOM } from 'jsdom';
import fs from 'node:fs';

const origin = process.argv[2] || 'http://127.0.0.1:3000';
const code = process.argv[3] || 'local-umny';
const USER = 'ou-' + Date.now().toString(36);
const base = origin + '/api/v1';
const H = { 'Content-Type': 'application/json', 'X-Debug-User': USER };
await fetch(base + '/attach', { method: 'POST', headers: H, body: JSON.stringify({ houseId: 'c637718a-3358-4dd6-ad87-e2dabf2bebe9', apartment: '5', consent: true }) });
await fetch(base + '/staff/login', { method: 'POST', headers: H, body: JSON.stringify({ code }) });

const html = fs.readFileSync('./public/miniapp/index.html', 'utf8').replace(/<script src="https:[^>]+><\/script>/, '');
const dom = new JSDOM(html, { runScripts: 'outside-only', url: origin + '/miniapp/?debug_user=' + USER });
const { window } = dom;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.scrollTo = () => {};
const origErr = window.console.error;
window.console.error = (...a) => { console.log('CONSOLE.ERROR', ...a.map(String)); origErr(...a); };
window.fetch = async (url, { signal, ...opts } = {}) => {
  const r = await fetch(base + String(url).replace('/api/v1', ''), opts);
  const text = await r.text();
  return { ok: r.ok, status: r.status, json: async () => JSON.parse(text) };
};
window.eval(fs.readFileSync('./public/miniapp/app.js', 'utf8'));
const wait = ms => new Promise(r => setTimeout(r, ms));
await wait(1800);
const root = window.document.getElementById('root');
[...root.querySelectorAll('.tile')].find(x => x.textContent.includes('Пульт')).click();
await wait(1500);
[...root.querySelectorAll('button')].find(b => b.textContent === 'Плановое отключение').click();
await wait(300);
[...root.querySelectorAll('.outage .notify-btn')].find(b => b.textContent.includes('Предупредить')).click();
await wait(1500);
const toast = root.querySelector('.toast');
console.log('TOAST:', toast ? toast.textContent : '(нет)');
console.log('RESULT:', root.querySelector('.outage-res') ? root.querySelector('.outage-res').textContent : '(нет)');
process.exit(0);
