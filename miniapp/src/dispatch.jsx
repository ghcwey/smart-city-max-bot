import { useState, useEffect, useCallback } from 'react';
import { api, statusText, haptic, fmtTime, fmtClock } from './api.js';

const ROW = 52;

const NOTICE_STATUS = {
  sent: { icon: '✓', text: 'доставлено в MAX', cls: 'ok' },
  simulated: { icon: '✓', text: 'имитация: бот выключен или житель не из MAX', cls: 'demo' },
  no_subscriber: { icon: '!', text: 'не подключены к боту, нужен звонок', cls: 'warn' },
  failed: { icon: '✕', text: 'не удалось отправить', cls: 'bad' },
};

const RELATION = {
  source: 'квартира аварии',
  flood: 'может залить',
  riser: 'отключение воды',
};

function useNow(ms = 15000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

function Twin({ layout, incident, picked, onPick, entrance: calmEntrance = 1, connected = [] }) {
  const entrance = incident ? incident.spot.entrance : calmEntrance;
  const riserCol = incident ? incident.spot.column : 0;
  const zoneByApt = incident ? Object.fromEntries(incident.zone.map(z => [z.apartment, z])) : {};
  const online = new Set(connected);
  const floors = Array.from({ length: layout.floors }, (_, i) => layout.floors - i);
  const cols = Array.from({ length: layout.perFloor }, (_, i) => i);
  const at = (floor, col) => (entrance - 1) * layout.perEntrance + (floor - 1) * layout.perFloor + col + 1;

  return (
    <div className="twin" style={{ '--cols': layout.perFloor, '--col': riserCol }}>
      <div className="twin-roof">
        <span>Подъезд {entrance}</span>
        <span>{layout.floors} этажей · кв. {at(1, 0)}–{at(layout.floors, layout.perFloor - 1)}</span>
      </div>
      <div className="twin-body">
        {incident && <div className="twin-pipe hot" aria-hidden="true" style={{ top: 0, height: layout.floors * ROW }} />}
        {floors.map(f => (
          <div className="twin-floor" key={f} style={{ height: ROW }}>
            <span className="twin-fl">{f}</span>
            {cols.map(c => {
              const n = at(f, c);
              const z = zoneByApt[n];
              const state = !z ? '' : z.relation === 'source' ? 'alarm' : z.relation === 'flood' ? 'risk' : 'shut';
              return (
                <button key={n} type="button"
                  className={'twin-apt ' + state + (picked === n ? ' picked' : '') + (!incident && online.has(n) ? ' online' : '')}
                  aria-label={`Квартира ${n}, этаж ${f}` + (z ? ', ' + RELATION[z.relation] : '')}
                  onClick={() => onPick && onPick(n, f)}>
                  <span className="twin-n">{n}</span>
                  {state === 'alarm' && <span className="twin-s">АВАРИЯ</span>}
                  {state === 'risk' && <span className="twin-s">залив</span>}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <div className="twin-base">подвал · стояк ГВС</div>
      {incident ? (
        <div className="twin-legend">
          <span><i className="lg alarm" />авария</span>
          <span><i className="lg risk" />может залить (на {incident.floodFloors} этажа ниже)</span>
          <span><i className="lg shut" />отключение воды на стояке</span>
        </div>
      ) : (
        <div className="twin-legend">
          <span><i className="lg online" />жилец подключён к боту</span>
        </div>
      )}
    </div>
  );
}

function AptInfo({ incident, picked }) {
  if (!picked) return null;
  const z = incident.zone.find(x => x.apartment === picked.n);
  let text;
  if (!z) text = 'Не на аварийном стояке, оповещение не нужно.';
  else if (z.relation === 'source') text = `Источник аварии: «${incident.title}».`;
  else if (z.relation === 'flood') text = 'Ниже аварии по стояку: может залить. Получит «проверьте потолок».';
  else text = 'На том же стояке: получит «воду перекроют, не сливайте воду».';
  if (z && z.relation !== 'source') text += z.subscribers ? ' Жилец в боте.' : ' Жилец не в боте, нужен звонок.';
  return <p className="twin-info"><b>Кв. {picked.n}, {picked.floor} этаж.</b> {text}</p>;
}

function NotifyPanel({ houseId, incident, toast, onSent }) {
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState(null);
  const [view, setView] = useState('flood');
  const notice = local || incident.lastNotice;

  const send = async () => {
    setBusy(true);
    try {
      const n = await api('/dispatch/notify', { method: 'POST', body: { houseId, incidentId: incident.id }, timeout: 25000 });
      setLocal(n);
      haptic.ok();
      if (onSent) onSent();
    } catch (e) {
      toast(e.status === 403 ? 'Нужны права диспетчера'
        : e.message === 'incident_not_found' ? 'Авария уже закрыта'
        : 'Не удалось отправить оповещение, проверьте связь');
    } finally { setBusy(false); }
  };

  const count = relation => incident.zone.filter(z => z.relation === relation).length;
  const offline = incident.zone.filter(z => !z.subscribers).map(z => z.apartment);
  const results = notice ? notice.results.filter(r => r.status !== 'no_subscriber') : [];
  const silent = notice ? notice.results.filter(r => r.status === 'no_subscriber' || r.status === 'failed').map(r => r.apartment) : [];
  const reached = results.filter(r => r.status !== 'failed').length;
  const simulated = notice && notice.results.some(r => r.status === 'simulated');

  return (
    <div className="notify">
      <div className="notify-msg">
        <div className="chips notify-tabs">
          <button className="chip" aria-pressed={view === 'flood'} onClick={() => setView('flood')}>Ниже · {count('flood')} кв.</button>
          <button className="chip" aria-pressed={view === 'riser'} onClick={() => setView('riser')}>Стояк · {count('riser')} кв.</button>
          <button className="chip" aria-pressed={view === 'source'} onClick={() => setView('source')}>Кв. {incident.apartment}</button>
        </div>
        <pre>{incident.messages[view]}</pre>
      </div>
      <button type="button" className={'notify-btn' + (busy ? ' busy' : '')} disabled={busy} onClick={send}>
        {busy ? <><span className="spin" />Отправляем…</> : (notice ? 'Отправить оповещение ещё раз' : `Оповестить стояк: ${incident.zone.length} кв.`)}
      </button>

      {!notice && offline.length > 0 && (
        <p className="twin-info">Не в боте, после оповещения нужен звонок: кв. {offline.join(', ')}.</p>
      )}

      {notice && (
        <div className="notify-res" aria-live="polite">
          <ul>
            {results.map(r => {
              const st = NOTICE_STATUS[r.status];
              return (
                <li key={r.apartment} className={'nr ' + st.cls}>
                  <span className="nr-ic">{st.icon}</span>
                  <span className="nr-apt">кв. {r.apartment}</span>
                  <span className="nr-txt">{RELATION[r.relation] || ''} · {st.text}</span>
                </li>
              );
            })}
          </ul>
          <div className={'notify-sum ' + (silent.length ? 'warn' : 'ok')}>
            {reached ? `Получили сообщение: ${reached} кв.` : results.length ? 'Сообщение никому не дошло.' : 'В боте никого на этом стояке.'}
            {silent.length > 0 && <> Позвонить: кв. {silent.join(', ')}.</>}
            {simulated && <span className="notify-demo">демо: часть отправок имитирована</span>}
            <span className="notify-time">{fmtClock(notice.sentAt)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

const NEXT = {
  new: [['in_progress', 'Принять в работу'], ['done', 'Устранено']],
  assigned: [['in_progress', 'Бригада на месте'], ['done', 'Устранено']],
  in_progress: [['done', 'Устранено, закрыть']],
};

function StatusControls({ request, toast, onChanged, compact }) {
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState('');
  const change = async status => {
    setBusy(status);
    try {
      const r = await api(`/requests/${request.id}`, { method: 'PATCH', body: { status, note: note.trim() || undefined } });
      haptic.ok();
      toast(`Статус: ${statusText(status).toLowerCase()}. ${r.residentNotified ? 'Жителю ушло сообщение в MAX.' : 'Житель увидит статус в приложении.'}`);
      setNote('');
      onChanged();
    } catch (e) {
      toast(e.message === 'bad_transition' ? 'Статус уже изменили, обновляю' : 'Не удалось сменить статус, проверьте связь');
      onChanged();
    } finally { setBusy(null); }
  };
  const actions = NEXT[request.status] || [];
  if (!actions.length) return null;
  return (
    <div className={'status-ctl' + (compact ? ' compact' : '')}>
      {!compact && <input className="status-note" value={note} placeholder="Комментарий жителю (необязательно)" onChange={e => setNote(e.target.value)} />}
      <div className="status-btns">
        {actions.map(([s, label]) => (
          <button key={s} type="button" className={'notify-btn ghost' + (s === 'done' ? ' done' : '')} disabled={!!busy} onClick={() => change(s)}>
            {busy === s ? 'Сохраняем…' : label}
          </button>
        ))}
      </div>
    </div>
  );
}

const pad = n => String(n).padStart(2, '0');
const localInput = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

function tomorrowAt(hour) {
  const d = new Date(Date.now() + 86400000);
  d.setHours(hour, 0, 0, 0);
  return localInput(d);
}

function Outage({ houseId, entrances, toast, onSent, recent = [] }) {
  const [open, setOpen] = useState(false);
  const [utility, setUtility] = useState('hot');
  const [scope, setScope] = useState('entrance');
  const [entrance, setEntrance] = useState(1);
  const [apartment, setApartment] = useState('');
  const [from, setFrom] = useState(() => tomorrowAt(10));
  const [to, setTo] = useState(() => tomorrowAt(16));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  if (!open) return <button type="button" className="notify-btn ghost outage-open" onClick={() => setOpen(true)}>Плановое отключение</button>;

  const send = async () => {
    setBusy(true);
    try {
      const r = await api('/dispatch/outage', {
        method: 'POST', timeout: 25000,
        body: { houseId, utility, scope, entrance, apartment: Number(apartment), from: new Date(from).toISOString(), to: new Date(to).toISOString(), reason },
      });
      setResult(r);
      haptic.ok();
      if (onSent) onSent();
    } catch (e) {
      if (e.message === 'bad_period') toast('Проверьте время: «до» должно быть позже «с»');
      else if (e.message === 'bad_apartment') toast('Укажите квартиру на нужном стояке');
      else {
        const st = await api('/dispatch/state?houseId=' + encodeURIComponent(houseId)).catch(() => null);
        const last = st && st.outages && st.outages[0];
        if (last && Date.now() - new Date(last.sentAt).getTime() < 90_000) {
          setResult({ apartments: null, recipients: last.recipients, delivered: last.recipients, text: last.text });
          if (onSent) onSent();
        } else toast(`Не отправилось (${e.status || e.message}). Попробуйте ещё раз`);
      }
    } finally { setBusy(false); }
  };

  return (
    <div className="outage">
      <h3>Плановое отключение</h3>
      <div className="chips">
        {[['cold', 'ХВС'], ['hot', 'ГВС'], ['power', 'Свет'], ['heat', 'Отопление']].map(([k, l]) => (
          <button key={k} className="chip" aria-pressed={utility === k} onClick={() => setUtility(k)}>{l}</button>
        ))}
      </div>
      <div className="chips">
        {[['house', 'Весь дом'], ['entrance', 'Подъезд'], ['riser', 'Стояк']].map(([k, l]) => (
          <button key={k} className="chip" aria-pressed={scope === k} onClick={() => setScope(k)}>{l}</button>
        ))}
      </div>
      {scope === 'entrance' && (
        <div className="chips">
          {Array.from({ length: entrances }, (_, i) => i + 1).map(n => (
            <button key={n} className="chip" aria-pressed={entrance === n} onClick={() => setEntrance(n)}>{n}</button>
          ))}
        </div>
      )}
      {scope === 'riser' && (
        <label className="outage-field">Любая квартира на стояке
          <input inputMode="numeric" value={apartment} placeholder="42" onChange={e => setApartment(e.target.value.replace(/\D/g, ''))} />
        </label>
      )}
      <div className="outage-row">
        <label className="outage-field">С<input type="datetime-local" value={from} onChange={e => setFrom(e.target.value)} /></label>
        <label className="outage-field">До<input type="datetime-local" value={to} onChange={e => setTo(e.target.value)} /></label>
      </div>
      <label className="outage-field">Причина
        <input value={reason} placeholder="замена задвижки в подвале" onChange={e => setReason(e.target.value)} />
      </label>
      <button type="button" className="notify-btn" disabled={busy || (scope === 'riser' && !apartment)} onClick={send}>
        {busy ? 'Отправляем…' : 'Предупредить жителей'}
      </button>
      {result && (
        <p className="outage-res">
          Отправлено.{result.apartments ? ` Квартир в зоне: ${result.apartments}.` : ''} {result.recipients ? `Сообщение получили жителей: ${result.delivered || (result.simulated ? result.recipients : 0)} из ${result.recipients} в боте.` : 'В этой зоне пока никто не подключён к боту.'}
          {result.simulated && ' Часть отправок имитирована (демо).'}
        </p>
      )}
      {recent.length > 0 && (
        <div className="outage-recent">
          <b>Недавно отправлено</b>
          {recent.map(o => (
            <p key={o.id}>{fmtTime(o.sentAt)} ·{o.text.split('\n')[0].replace('🔧 ', '')} · {o.text.split('\n').find(l => l.startsWith('Где:')) || ''}</p>
          ))}
        </div>
      )}
    </div>
  );
}

export function Dispatch({ toast, houses = [], initialHouse }) {
  const [houseId, setHouseId] = useState(() => (houses.find(h => h.fiasId === initialHouse) || houses[0] || {}).fiasId);
  const [state, setState] = useState(null);
  const [err, setErr] = useState(null);
  const [sel, setSel] = useState(null);
  const [picked, setPicked] = useState(null);
  const [calmEntrance, setCalmEntrance] = useState(1);
  const now = useNow();

  const load = useCallback(async () => {
    try { setState(await api('/dispatch/state?houseId=' + encodeURIComponent(houseId || ''))); setErr(null); }
    catch (e) { setErr(e.status === 403 ? 'forbidden' : 'offline'); }
  }, [houseId]);
  useEffect(() => {
    setState(null);
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  if (err === 'forbidden') return <p className="hint offline">Пульт доступен только диспетчерам управляющей компании.</p>;
  if (!state) return <div className="skeleton">{err ? 'Нет связи с сервером. Пробуем снова…' : 'Подключаемся к пульту…'}</div>;

  const { incidents, layout, requests = [] } = state;
  const inc = incidents.find(i => i.id === sel) || incidents[0];
  const pick = inc && picked && picked.incident === inc.id ? picked : inc ? { incident: inc.id, n: inc.apartment, floor: inc.spot.floor } : null;

  return (
    <div className="dsp">
      {houses.length > 1 && (
        <div className="chips dsp-tabs">
          {houses.map(h => (
            <button key={h.fiasId} className="chip" aria-pressed={h.fiasId === houseId}
              onClick={() => { setHouseId(h.fiasId); setSel(null); setPicked(null); }}>
              {h.address.replace(/^г\. /, '')}
            </button>
          ))}
        </div>
      )}

      {!inc && (
        <>
          <div className="dsp-calm">
            <div className="dsp-calm-row"><b>Штатный режим</b><span>обновлено {fmtClock(now)}</span></div>
            <p>Аварий нет. Как только житель сообщит об аварии, она сама загорится на схеме подъезда в его квартире.</p>
            <p className="dsp-howto">Проверить: в приложении жителя «Главная» → «Авария в доме» → фото прорванной трубы → «Отправить заявку».</p>
          </div>
          <div className="stats">
            <div><b>0</b><span>аварий</span></div>
            <div><b>{requests.length}</b><span>открытых заявок</span></div>
            <div><b>{state.residents || 0}</b><span>жителей в боте</span></div>
          </div>
          {layout && (
            <>
              {state.entrances > 1 && (
                <div className="chips dsp-tabs">
                  {Array.from({ length: state.entrances }, (_, i) => i + 1).map(n => (
                    <button key={n} className="chip" aria-pressed={n === calmEntrance} onClick={() => setCalmEntrance(n)}>Подъезд {n}</button>
                  ))}
                </div>
              )}
              <Twin layout={layout} incident={null} entrance={calmEntrance} connected={state.connectedApartments || []} />
            </>
          )}
        </>
      )}

      {inc && (
        <>
          {incidents.length > 1 && (
            <div className="chips dsp-tabs">
              {incidents.map(i => (
                <button key={i.id} className="chip" aria-pressed={i.id === inc.id} onClick={() => { setSel(i.id); setPicked(null); }}>
                  кв. {i.apartment}
                </button>
              ))}
            </div>
          )}

          <div className="incident">
            <div className="incident-body">
              <div className="incident-row">
                <span className="incident-tag">{statusText(inc.status, 'Новая')}</span>
              </div>
              <h2>{inc.title}</h2>
              <p className="incident-sub">Кв. {inc.apartment}, {inc.spot.floor} этаж, подъезд {inc.spot.entrance} · заявка {inc.id}{inc.hasPhoto ? ' · есть фото' : ''}</p>
              {inc.reports > 1 && <p className="incident-sub">Сообщили {inc.reports} раза: кв. {inc.reportedFrom.join(', ')}</p>}
              {inc.description && <p className="incident-sub">«{inc.description}»</p>}
              <div className="stats">
                <div><b>{inc.zone.filter(z => z.relation === 'flood').length}</b><span>кв. может залить</span></div>
                <div><b>{inc.zone.length}</b><span>кв. на стояке</span></div>
                <div><b>{inc.zone.filter(z => z.subscribers).length}/{inc.zone.length}</b><span>в боте</span></div>
              </div>
            </div>
          </div>

          <Twin layout={layout} incident={inc} picked={pick && pick.n}
            onPick={(n, floor) => setPicked({ incident: inc.id, n, floor })} />
          <AptInfo incident={inc} picked={pick} />

          <NotifyPanel key={inc.id} houseId={houseId} incident={inc} toast={toast} onSent={load} />
          <StatusControls key={'s' + inc.id + inc.status} request={inc} toast={toast} onChanged={load} />
        </>
      )}

      {requests.length > 0 && (
        <div className="dsp-list">
          <h3>Открытые заявки дома · {requests.length}</h3>
          {requests.map(r => (
            <div className="dsp-req" key={r.id}>
              <div className="dsp-req-head"><b>кв. {r.apartment} · {r.title}</b><span>{statusText(r.status)}</span></div>
              <p>{r.description}</p>
              <StatusControls key={r.id + r.status} request={r} toast={toast} onChanged={load} compact />
            </div>
          ))}
        </div>
      )}

      {layout && <Outage key={houseId} houseId={houseId} entrances={state.entrances} toast={toast} onSent={load} recent={state.outages || []} />}
      <a className="dsp-poster" href={`/poster/${houseId}`} target="_blank" rel="noreferrer">QR-листовка для подъезда</a>
    </div>
  );
}
