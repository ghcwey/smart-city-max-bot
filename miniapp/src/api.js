export const wa = (typeof window !== 'undefined' && window.WebApp) || null;
export const isInsideMax = !!(wa && wa.initData);

const safe = fn => { try { return fn(); } catch { return null; } };

function readLaunch() {
  const hash = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
  const query = new URLSearchParams(window.location.search);
  const initData = (wa && wa.initData) || hash.get('WebAppData') || '';

  let debugUser = query.get('debug_user');
  if (debugUser) safe(() => sessionStorage.setItem('dom:debugUser', debugUser));
  else debugUser = safe(() => sessionStorage.getItem('dom:debugUser'));
  if (!debugUser) {
    debugUser = safe(() => localStorage.getItem('dom:deviceUser'));
    if (!debugUser) {
      debugUser = 'dev-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      safe(() => localStorage.setItem('dom:deviceUser', debugUser));
    }
  }
  return { initData, debugUser };
}

const launch = typeof window !== 'undefined' ? readLaunch() : { initData: '', debugUser: 'demo' };

export const startParam = typeof window === 'undefined' ? null
  : (wa && wa.initDataUnsafe && wa.initDataUnsafe.start_param) || new URLSearchParams(window.location.search).get('startapp') || null;

export async function api(path, options = {}) {
  const { timeout = 10000, ...init } = options;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  const headers = { 'Content-Type': 'application/json', ...(init.headers || {}) };
  if (launch.initData) headers['X-Max-Init-Data'] = launch.initData;
  if (launch.debugUser) headers['X-Debug-User'] = launch.debugUser;
  try {
    const res = await fetch('/api/v1' + path, {
      ...init,
      signal: ctl.signal,
      headers,
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw Object.assign(new Error((data && data.error) || String(res.status)), { status: res.status, data });
    return data;
  } catch (e) {
    if (e.status) throw e;
    throw Object.assign(new Error(e.name === 'AbortError' ? 'timeout' : 'network'), { status: 0 });
  } finally {
    clearTimeout(timer);
  }
}

export const haptic = {
  ok: () => isInsideMax && safe(() => wa.HapticFeedback.notificationOccurred('success')),
  error: () => isInsideMax && safe(() => wa.HapticFeedback.notificationOccurred('error')),
};

export const store = {
  get(k, d) { try { const v = localStorage.getItem('dom:' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('dom:' + k, JSON.stringify(v)); } catch {} },
};

export const rub = n =>
  new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(Number(n) || 0) + ' ₽';

export const num = v => {
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

export const STATUS = {
  new: { text: 'Принята', cls: 'warn' },
  assigned: { text: 'Передана исполнителю', cls: 'warn' },
  in_progress: { text: 'В работе', cls: 'warn' },
  done: { text: 'Выполнена', cls: 'ok' },
  rejected: { text: 'Отклонена', cls: 'alert' },
  auto_closed: { text: 'Закрыта автоматически (демо)', cls: 'ok' },
};

export const statusText = (status, fallback = status) => (STATUS[status] ? STATUS[status].text : fallback);

export const isOpen = r => ['new', 'assigned', 'in_progress'].includes(r.status);

export const tel = phone => 'tel:' + String(phone).replace(/[^+\d]/g, '');

export const fmtSla = m => (m >= 1440 ? `${Math.round(m / 1440)} дн.` : `${m} мин`);

export const fmtTime = iso => new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export const fmtClock = when => new Date(when).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
