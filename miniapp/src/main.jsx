import './styles.css';
import './wow.css';
import { Component, useState, useEffect, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { api, store, rub, num, wa, isInsideMax, startParam, haptic, STATUS, statusText, isOpen, tel, fmtSla, fmtTime } from './api.js';
import { PhotoScanner, fmtReading } from './scanner.jsx';
import { Dispatch } from './dispatch.jsx';

const BILL_KEYS = ['cold', 'hot', 'sewer', 'power', 'heat'];
const METER_KEYS = ['cold', 'hot', 'power'];
const NO_READINGS = { cold: '', hot: '', power: '' };

const TITLES = {
  home: 'Дом',
  requests: 'Заявки в УК',
  votes: 'Опросы дома',
  info: 'О доме',
  bill: 'Проверка квитанции',
  meters: 'Показания счётчиков',
  repair: 'Капитальный ремонт',
  dispatch: 'Пульт диспетчера',
  onboarding: 'Ваш дом',
  privacy: 'Обработка данных',
  help: 'Как этим пользоваться',
  staff: 'Вход для сотрудника УК',
};

const ERRORS = {
  network: 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.',
  timeout: 'Сервер отвечает слишком долго. Попробуйте ещё раз.',
  too_many_requests: 'Слишком много запросов подряд. Подождите минуту.',
  membership_required: 'Сначала выберите дом и квартиру.',
  bad_signature: 'Сессия устарела. Закройте приложение и откройте его из чата с ботом.',
  unauthorized: 'Откройте приложение из чата с ботом в MAX.',
};
const errText = (e, fallback = 'Не получилось. Попробуйте ещё раз.') => ERRORS[e && e.message] || fallback;

function Icon({ name, color = 'var(--stamp)', size = 32 }) {
  const d = {
    bill: 'M6 3h20v26l-4-2-3 2-3-2-3 2-4-2V3z M11 10h10 M11 15h10 M11 20h6',
    meter: 'M16 4a12 12 0 1 1 0 24 12 12 0 0 1 0-24z M16 16l6-4 M16 16v6',
    wrench: 'M22 6a6 6 0 0 1-8 8l-7 7 3 3 7-7a6 6 0 0 0 8-8z',
    vote: 'M6 16l6 6 14-14 M6 26h20',
    crane: 'M6 28V6h14l6 6 M6 12h14 M13 12v10 M20 12v6',
    alert: 'M16 4l12 22H4L16 4z M16 13v7 M16 23h.01',
    twin: 'M7 28V5h18v23 M4 28h24 M12 10h2 M18 10h2 M12 15h2 M18 15h2 M12 20h2 M18 20h2 M14 28v-4h4v4',
    home: 'M4 15L16 5l12 10 M7 13v13h18V13 M13 26v-7h6v7',
    info: 'M16 4a12 12 0 1 1 0 24 12 12 0 0 1 0-24z M16 14v8 M16 10h.01',
  }[name];
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true"
      stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
  );
}

const Hint = ({ children, kind }) => <p className={'hint' + (kind ? ' ' + kind : '')}>{children}</p>;

function Head({ title, subtitle, showBack, onBack }) {
  return (
    <header className="head">
      {showBack && !isInsideMax && (
        <button className="head-back" onClick={onBack} aria-label="Назад">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M12 3L5 10l7 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      <div>
        <div className="head-title">{title}</div>
        {subtitle && <div className="head-sub">{subtitle}</div>}
      </div>
    </header>
  );
}

function useMaxBackButton(visible, onBack) {
  const ref = useRef(onBack);
  ref.current = onBack;
  useEffect(() => {
    const bb = isInsideMax && wa.BackButton;
    if (!bb) return undefined;
    const handler = () => ref.current();
    try {
      if (visible) { bb.onClick(handler); bb.show(); } else bb.hide();
    } catch {}
    return () => { try { bb.offClick(handler); } catch {} };
  }, [visible]);
}

function TabBar({ tab, onPick, badge }) {
  const tabs = [
    { key: 'home', name: 'Главная', icon: 'home' },
    { key: 'requests', name: 'Заявки', icon: 'wrench' },
    { key: 'votes', name: 'Опросы', icon: 'vote' },
    { key: 'info', name: 'О доме', icon: 'info' },
  ];
  return (
    <nav className="tabbar" aria-label="Разделы">
      {tabs.map(t => (
        <button key={t.key} className={'tb' + (tab === t.key ? ' active' : '')}
          aria-current={tab === t.key ? 'page' : undefined} onClick={() => onPick(t.key)}>
          <Icon name={t.icon} color="currentColor" size={24} />
          <span className="tb-name">{t.name}{t.key === 'requests' && badge ? ` · ${badge}` : ''}</span>
        </button>
      ))}
    </nav>
  );
}

function StatusTag({ status }) {
  const s = STATUS[status] || { text: status, cls: 'warn' };
  return <span className={'tag ' + s.cls}>{s.text}</span>;
}

function TariffRow({ item, children }) {
  return (
    <div className="tariff-row">
      <b>{item.name}</b> <span className="src">{item.rate} ₽ за {item.unit}{item.model ? ' · модель' : ''}</span>
      {children}
    </div>
  );
}

function TariffNote({ tariffs }) {
  return (
    <p className="src">
      Тарифы: {tariffs.city}, действуют с {tariffs.since} по {tariffs.until}. {tariffs.source}.
      {tariffs.hasModel ? ' Строки с пометкой «модель» рассчитаны по модельным ставкам.' : ''}
    </p>
  );
}

function Home({ go, house, offline, dispatcher, onEmergency, requests, openRequests }) {
  const mc = house.managementCompany;
  const active = requests.filter(isOpen);
  const last = active[0];
  return (
    <>
      {offline && <Hint kind="offline">Сервер не отвечает, показываю сохранённые данные. Отправка сейчас недоступна.</Hint>}
      <button className="tile wide alarm hero" onClick={onEmergency} disabled={offline}>
        <Icon name="alert" color="var(--alert)" size={40} />
        <div>
          <div className="tile-name">Авария в доме</div>
          <div className="tile-note">Течёт, затопило, искрит, нет воды или света. Сфотографируйте: заявка сразу уйдёт диспетчеру, соседей по стояку предупредят.</div>
        </div>
      </button>
      <p className="src" style={{ marginTop: 8 }}>Если опасно для жизни, звоните сразу: <a href={tel(mc.emergencyPhone)}>{mc.emergencyPhone}</a> (круглосуточно)</p>

      {last && (
        <button className="card card-btn" onClick={openRequests}>
          <div className="row"><b>{last.title}</b><StatusTag status={last.status} /></div>
          <p className="src">Заявка {last.id} · {last.assignedMaster}{active.length > 1 ? ` · ещё открытых: ${active.length - 1}` : ''}</p>
        </button>
      )}

      <div className="grid">
        <button className="tile wide" onClick={() => go('meters')}>
          <Icon name="meter" />
          <div><div className="tile-name">Показания счётчиков</div>
            <div className="tile-note">Напомним в срок, посчитаем сумму, заметим утечку</div></div>
        </button>
        {dispatcher && (
          <button className="tile wide" onClick={() => go('dispatch')}>
            <Icon name="twin" />
            <div><div className="tile-name">Пульт диспетчера</div>
              <div className="tile-note">Аварии на схеме подъезда, оповещение стояка, статусы</div></div>
          </button>
        )}
      </div>

      <h2 className="section">Ещё</h2>
      <div className="more">
        <button className="more-row" onClick={() => go('bill')}><span>Проверить квитанцию</span><span className="more-arrow">›</span></button>
        <button className="more-row" onClick={() => go('repair')}><span>Капитальный ремонт</span><span className="more-arrow">›</span></button>
      </div>
    </>
  );
}

function Requests({ house, membership, categories, requests, onCreated, prefill, clearPrefill, toast, offline }) {
  const [category, setCategory] = useState(prefill ? prefill.category : '');
  const [description, setDescription] = useState(prefill ? prefill.description : '');
  const [photo, setPhoto] = useState(null);
  const [aiTitle, setAiTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(null);
  useEffect(() => () => clearPrefill(), [clearPrefill]);

  const applyIncident = useCallback(res => {
    if (res.category) setCategory(c => (c === 'emergency' ? c : res.category));
    if (res.label) setAiTitle(res.label);
    setDescription(d => (d.trim() ? d : `${res.label || ''}. ${res.summary || ''}`.trim()));
  }, []);

  const cat = categories.find(c => c.key === category);
  const ready = category && description.trim().length > 4;

  const submit = async () => {
    setBusy(true); setErr('');
    try {
      const created = await api('/requests', {
        method: 'POST',
        body: { category, description: description.trim(), title: aiTitle || (prefill && prefill.title) || cat.label, hasPhoto: !!photo },
      });
      onCreated(created);
      setDescription(''); setCategory(''); setPhoto(null); setAiTitle('');
      setOpen(created.id);
      haptic.ok();
      toast(created.duplicateOf ? 'Эта авария уже на пульте, добавили сообщение к заявке ' + created.duplicateOf : 'Заявка ' + created.id + ' отправлена');
    } catch (e) {
      haptic.error();
      setErr(e.message === 'description_too_short' ? 'Опишите проблему хотя бы парой слов.' : errText(e, 'Заявка не отправилась. Текст сохранён, попробуйте ещё раз.'));
    } finally { setBusy(false); }
  };

  return (
    <>
      {category === 'emergency' && (
        <a className="btn alarm call-btn" href={tel(house.managementCompany.emergencyPhone)}>
          Позвонить в АДС {house.managementCompany.emergencyPhone}
        </a>
      )}
      <Hint>{category === 'emergency'
        ? 'Если сильно льёт или искрит, сначала звоните. Заявка здесь нужна, чтобы диспетчер увидел квартиру на схеме и предупредил соседей по стояку.'
        : 'Сфотографируйте проблему или опишите её как соседу: «течёт из-под батареи в кухне». Адрес и квартиру подставим сами.'}</Hint>
      <PhotoScanner mode="incident" categories={categories} onFile={setPhoto} onResult={applyIncident} />
      <div className="card">
        <div className="row"><span className="lbl">Адрес</span><span>{house.address}, кв. {membership.apartment}</span></div>
        <label className="field">Что случилось</label>
        <div className="chips">
          {categories.map(c => (
            <button key={c.key} className="chip" aria-pressed={category === c.key} onClick={() => setCategory(c.key)}>{c.label}</button>
          ))}
        </div>
        {cat && (
          <p className="src">
            {cat.normative ? 'Срок' : 'Ориентировочный срок'}: {fmtSla(cat.slaMinutes)} ({cat.basis}).
            {cat.key === 'emergency' && ` Сначала перекройте вентиль. Если опасно, звоните ${house.managementCompany.emergencyPhone}.`}
          </p>
        )}
        <label className="field">Опишите одной-двумя фразами
          <textarea value={description} onChange={e => setDescription(e.target.value)}
            placeholder="Течёт стояк горячей воды под ванной, капает на пол" />
        </label>
      </div>
      {err && <Hint kind="offline">{err}</Hint>}
      <button className={'btn' + (category === 'emergency' ? ' alarm' : '')}
        disabled={!ready || busy || offline} onClick={submit}>
        {busy ? 'Отправляем…' : !category ? 'Выберите, что случилось' : 'Отправить заявку'}
      </button>

      <h2 className="section">Ваши заявки</h2>
      {!requests.length && <p className="src">Пока ни одной. Здесь появятся номер, статус, исполнитель и срок. О смене статуса бот напишет в чат.</p>}
      {requests.map(r => {
        const left = Math.round((new Date(r.slaDeadline).getTime() - Date.now()) / 60000);
        const closed = !isOpen(r);
        return (
          <div className="card" key={r.id}>
            <button className="card-btn" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id}>
              <div className="row"><b>{r.title}</b><StatusTag status={r.status} /></div>
              <div className="row"><span className="lbl">Номер</span><span className="num">{r.id}</span></div>
              <div className="row"><span className="lbl">Исполнитель</span><span>{r.assignedMaster}</span></div>
              {!closed && (
                <div className="row"><span className="lbl">{r.priority === 'emergency' ? 'Срок локализации (ПП № 416, п. 13)' : 'Ориентир (регламент УК, модель)'}</span>
                  <span className={'num ' + (left > 0 ? '' : 'diff-bad')}>{left > 0 ? (left > 120 ? `${Math.round(left / 60)} ч` : `${left} мин`) : 'просрочено'}</span></div>
              )}
            </button>
            {open === r.id && (
              <ol className="timeline">
                {(r.history || []).map((h, i) => (
                  <li key={i}><b>{statusText(h.status)}</b> · {fmtTime(h.at)}{h.note ? <><br /><span className="src">{h.note}</span></> : null}</li>
                ))}
              </ol>
            )}
          </div>
        );
      })}
    </>
  );
}

function Meters({ tariffs, membership, toast, offline }) {
  const [prev, setPrev] = useState(NO_READINGS);
  const [known, setKnown] = useState({});
  const [cur, setCur] = useState(NO_READINGS);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);
  const [aiKey, setAiKey] = useState(null);
  const day = new Date().getDate();
  const units = Object.fromEntries(METER_KEYS.map(k => [k, tariffs.items[k].unit]));

  const applyScan = useCallback((res, previousKind) => {
    if (!METER_KEYS.includes(res.kind) || res.value == null) return;
    setCur(c => {
      const next = { ...c };
      if (previousKind && METER_KEYS.includes(previousKind) && previousKind !== res.kind) next[previousKind] = '';
      next[res.kind] = fmtReading(res.kind, res.value);
      return next;
    });
    setAiKey(res.kind);
  }, []);
  useEffect(() => {
    if (!aiKey) return undefined;
    const t = setTimeout(() => setAiKey(null), 2600);
    return () => clearTimeout(t);
  }, [aiKey]);

  useEffect(() => {
    api('/meters/last')
      .then(r => { if (r && r.values) { setPrev(p => ({ ...p, ...r.values })); setKnown(r.values); } })
      .catch(() => {});
  }, []);

  const rows = METER_KEYS.map(key => {
    const item = tariffs.items[key];
    const now = num(cur[key]);
    const was = num(prev[key]);
    const use = now == null || was == null ? null : now - was;
    return { key, item, now, was, use, sum: use != null && use >= 0 ? use * item.rate : null };
  });
  const filled = rows.filter(r => r.now != null);
  const bad = rows.some(r => r.use != null && r.use < 0);
  const total = rows.reduce((s, r) => s + (r.sum || 0), 0);

  const send = async () => {
    setBusy(true); setErr('');
    try {
      const values = Object.fromEntries(filled.map(r => [r.key, r.now]));

      const previous = Object.fromEntries(rows.filter(r => r.was != null && known[r.key] == null).map(r => [r.key, r.was]));
      const saved = await api('/meters', { method: 'POST', body: { values, previous } });
      setDone(saved);
      haptic.ok();
      toast('Показания сохранены');
    } catch (e) {
      haptic.error();
      setErr(e.message === 'less_than_previous' ? 'Новое число меньше прошлого. Проверьте цифры на счётчике.' : errText(e, 'Не отправилось. Числа сохранены, попробуйте ещё раз.'));
    } finally { setBusy(false); }
  };

  const startOver = () => {
    setPrev(p => ({ ...p, ...done.values }));
    setKnown(k => ({ ...k, ...done.values }));
    setCur(NO_READINGS);
    setDone(null);
  };

  if (done) return (
    <div className="card">
      <h2>Показания сохранены</h2>
      <div className="row"><span className="lbl">Квартира</span><span className="num">{done.apartment}</span></div>
      {Object.keys(done.usage).map(k => (
        <div className="row" key={k}>
          <span className="lbl">{tariffs.items[k].name}, расход</span>
          <span className="num">{done.usage[k]} {tariffs.items[k].unit}</span>
        </div>
      ))}
      <div className="row"><span className="lbl">Примерно к оплате</span><span className="num"><b>{rub(done.amount)}</b></span></div>
      {done.baseline && done.baseline.length > 0 && <p className="src">Для счётчиков без прошлого числа ({done.baseline.map(k => tariffs.items[k].name.toLowerCase()).join(', ')}) показание принято как начальное: расход и сумму посчитаем со следующей передачи.</p>}
      {done.anomalies && done.anomalies.map(a => (
        <Hint kind="offline" key={a.key}>{tariffs.items[a.key].name}: расход {a.now} {tariffs.items[a.key].unit} против {a.before} в прошлый раз, вдвое больше. Проверьте, не подтекает ли бачок унитаза или смеситель. Если течёт, оставьте заявку во вкладке «Заявки».</Hint>
      ))}
      <p className="src">Передача показаний в биллинг УК в этой версии не подключена, это делается на пилоте вместе с УК. Пока передайте эти числа привычным способом: в квитанции или на Госуслугах.</p>
      <button className="btn ghost" onClick={startOver}>Готово</button>
    </div>
  );

  return (
    <>
      <Hint>
        {day >= 20 && day <= 25
          ? <>Сегодня {day}-е, УК принимает показания (20–25 число).</>
          : <>Сегодня {day}-е. УК принимает показания с 20 по 25 число, бот напомнит.</>}
      </Hint>
      <div className="card">
        <h2>Зачем это нужно</h2>
        <p className="src">В квартире стоят счётчики холодной и горячей воды и электричества. Каждый месяц УК должна узнать, сколько на них набежало, чтобы выставить квитанцию. Это и есть «передать показания».</p>
        <p className="src">Если их не передать, УК посчитает по нормативу (усреднённо на человека), а это обычно дороже. Здесь приложение помогает не переплатить:</p>
        <ol className="steps compact-steps">
          <li><div>бот напомнит, когда УК принимает показания;</div></li>
          <li><div>вы сразу видите расход и примерную сумму по тарифу своего города;</div></li>
          <li><div>если расход вырос вдвое, приложение предупредит: так часто выглядит скрытая утечка.</div></li>
        </ol>
        <p className="src">Первый раз впишите в «Было» число из прошлой квитанции, дальше оно подставится само.</p>
      </div>
      <PhotoScanner mode="meter" units={units} onResult={applyScan} />
      <div className="card">
        <div className="row"><span className="lbl">Квартира</span><span className="num">{membership.apartment}</span></div>
        {rows.map(r => (
          <TariffRow key={r.key} item={r.item}>
            <div className="inline">
              <label className="field">{known[r.key] != null ? 'Было (из прошлой передачи)' : 'Было (из прошлой квитанции)'}
                <input inputMode="decimal" value={prev[r.key] ?? ''} readOnly={known[r.key] != null} placeholder={known[r.key] != null ? '' : '0'}
                  onChange={e => setPrev({ ...prev, [r.key]: e.target.value })} />
              </label>
              <label className={'field' + (aiKey === r.key ? ' ai-filled' : '')}>Сейчас на счётчике (чёрные цифры)
                {aiKey === r.key && <span className="ai-tag">с фото</span>}
                <input inputMode="decimal" value={cur[r.key]}
                  onChange={e => setCur({ ...cur, [r.key]: e.target.value })} />
              </label>
            </div>
            {r.use != null && (
              <p className="src">
                {r.use < 0
                  ? <b className="diff-bad">Новое число меньше прошлого, проверьте</b>
                  : <>Расход {r.use.toFixed(r.key === 'power' ? 0 : 2)} {r.item.unit}, это {rub(r.sum)}</>}
              </p>
            )}
          </TariffRow>
        ))}
        {filled.length > 0 && !bad && (
          <div className="row" style={{ marginTop: 14 }}>
            <span className="lbl">Итого</span><span className="num"><b>{rub(total)}</b></span>
          </div>
        )}
        <TariffNote tariffs={tariffs} />
      </div>
      {err && <Hint kind="offline">{err}</Hint>}
      <p className="src">Показания сохранятся в истории, в чат придёт расход и сумма.</p>
      <button className="btn" disabled={!filled.length || bad || busy || offline} onClick={send}>
        {busy ? 'Сохраняем…' : !filled.length ? 'Впишите хотя бы одно число' : 'Сохранить показания'}
      </button>
    </>
  );
}

function BillCheck({ tariffs, onClaim, toast }) {
  const [area, setArea] = useState(() => store.get('area', ''));
  const [lines, setLines] = useState(() => BILL_KEYS.map(key => ({ key, volume: '', charged: '' })));
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const filled = lines.some(l => num(l.volume) != null && num(l.charged) != null);

  const check = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api('/bill/check', { method: 'POST', body: { area: num(area), lines: lines.filter(l => l.volume !== '' || l.charged !== '') } });
      setResult(r);
      store.set('area', area);
    } catch (e) {
      setErr(errText(e, 'Не удалось проверить. Попробуйте ещё раз.'));
    } finally { setBusy(false); }
  };

  const upd = (i, f, v) => { setResult(null); setLines(ls => ls.map((l, j) => (j === i ? { ...l, [f]: v } : l))); };

  return (
    <>
      <Hint>Возьмите квитанцию и перепишите два числа из каждой строки: <b>объём</b> и <b>сумму</b>. Пустые строки пропустим.</Hint>
      <div className="card">
        <label className="field">Площадь квартиры, м² (для строки «содержание жилья»)
          <input inputMode="decimal" value={area} placeholder="54" onChange={e => { setArea(e.target.value); setResult(null); }} />
        </label>
        {lines.map((l, i) => {
          const item = tariffs.items[l.key];
          const row = result && result.rows.find(r => r.key === l.key);
          return (
            <TariffRow key={l.key} item={item}>
              <div className="inline">
                <label className="field">Объём, {item.unit}
                  <input inputMode="decimal" value={l.volume} onChange={e => upd(i, 'volume', e.target.value)} />
                </label>
                <label className="field">Начислено, ₽
                  <input inputMode="decimal" value={l.charged} onChange={e => upd(i, 'charged', e.target.value)} />
                </label>
              </div>
              {row && row.volume > 0 && (
                <div className="row" style={{ marginTop: 8 }}>
                  <span className="lbl">По тарифу {rub(row.expected)}</span>
                  <span className={'num ' + (row.overcharged ? 'diff-bad' : 'diff-ok')}>
                    {row.overcharged ? `+${rub(row.diff)} лишних` : 'сходится'}
                  </span>
                </div>
              )}
            </TariffRow>
          );
        })}
        {result && result.maintenance ? <p className="src">Содержание жилья при вашей площади: {rub(result.maintenance)} (модельная ставка).</p> : null}
        <TariffNote tariffs={tariffs} />
      </div>
      {err && <Hint kind="offline">{err}</Hint>}

      {!result
        ? <button className="btn" disabled={!filled || busy} onClick={check}>{busy ? 'Считаем…' : filled ? 'Проверить начисления' : 'Заполните хотя бы одну строку'}</button>
        : result.overchargedTotal > 1
          ? <>
            <div className="card">
              <h2>Переплата {rub(result.overchargedTotal)}</h2>
              <p className="src">Строк с расхождением: {result.rows.filter(r => r.overcharged).length}. Текст заявления уже составлен, останется отправить.</p>
            </div>
            <button className="btn alarm" onClick={() => onClaim({ category: 'other', title: 'Перерасчёт по квитанции', description: result.claimText })}>Отправить заявление на перерасчёт</button>
          </>
          : <>
            <div className="card">
              <h2>Квитанция сходится</h2>
              <p className="src">Начисления совпали с тарифом. Сумма всё равно большая? Проверьте в квитанции строки «ОДН» и «долг».</p>
            </div>
            <button className="btn ghost" onClick={() => { setResult(null); toast('Проверено'); }}>Готово</button>
          </>}
    </>
  );
}

const CHOICES = {
  yes: { label: 'За', voted: 'За', cls: 'ok' },
  no: { label: 'Против', voted: 'Против', cls: 'alert' },
  abstain: { label: 'Воздержаться', voted: 'Воздержался', cls: 'warn' },
};

function Votes({ votes, setVotes, membership, toast, offline }) {
  const [showNew, setShowNew] = useState(false);
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [deadline, setDeadline] = useState('');
  const [busy, setBusy] = useState(false);
  const [voting, setVoting] = useState(null);

  const cast = async (id, choice) => {
    setVoting(id);
    try {
      const updated = await api(`/votes/${id}`, { method: 'POST', body: { choice } });
      setVotes(vs => vs.map(v => (v.id === id ? { ...v, ...updated } : v)));
      haptic.ok();
      toast('Голос квартиры учтён');
    } catch (e) { toast(errText(e, 'Голос не отправился, попробуйте ещё раз')); }
    finally { setVoting(null); }
  };

  const create = async () => {
    setBusy(true);
    try {
      const v = await api('/votes', { method: 'POST', body: { title: title.trim(), detail: detail.trim(), deadline: deadline.trim() } });
      setVotes(vs => [v, ...vs]);
      setTitle(''); setDetail(''); setDeadline(''); setShowNew(false);
      toast('Опрос опубликован для соседей');
    } catch (e) {
      toast(e.message === 'title_too_short' ? 'Слишком короткий вопрос' : errText(e));
    } finally { setBusy(false); }
  };

  return (
    <>
      <Hint>Предварительный опрос соседей, не официальное собрание. Один голос с квартиры (ваша кв. {membership.apartment}). На общем собрании собственников голоса считаются пропорционально площади, решение принимается там.</Hint>
      {!showNew
        ? <button className="btn ghost" disabled={offline} onClick={() => setShowNew(true)}>Предложить свой опрос</button>
        : <div className="card">
            <h2>Новый опрос по дому</h2>
            <label className="field">Вопрос
              <input value={title} placeholder="Поставить лавочки у подъездов" onChange={e => setTitle(e.target.value)} />
            </label>
            <label className="field">Пояснение
              <textarea value={detail} placeholder="Коротко: зачем и за чей счёт" onChange={e => setDetail(e.target.value)} />
            </label>
            <label className="field">Срок
              <input value={deadline} placeholder="1 ноября" onChange={e => setDeadline(e.target.value)} />
            </label>
            <div className="inline">
              <button className="btn ghost" onClick={() => setShowNew(false)}>Отмена</button>
              <button className="btn" disabled={title.trim().length < 5 || busy} onClick={create}>{busy ? 'Публикуем…' : 'Опубликовать'}</button>
            </div>
          </div>}
      {!votes.length && <p className="src">Пока опросов нет. Предложите первый.</p>}
      {votes.map(v => {
        const q = Math.min(100, Math.round((v.counted / v.total) * 100));
        return (
          <div className="card" key={v.id}>
            <h2>{v.title}</h2>
            <p className="src">{v.detail} Опрос до {v.deadline}.{v.mine ? ' · ваш опрос' : ''}</p>
            <div className="row"><span className="lbl">Ответили</span>
              <span className="num">{v.counted} из {v.total} квартир, {q}%</span></div>
            <div className={'bar' + (v.quorum ? ' q' : '')}><i style={{ width: q + '%' }} /></div>
            <p className="src">{v.quorum
              ? 'Больше половины квартир ответили: вопрос можно выносить на общее собрание.'
              : `Для кворума нужно больше половины: ещё ${Math.max(0, v.quorumNeed - v.counted)} кв.`}</p>
            {v.myChoice
              ? <div className="row"><span className="lbl">Голос вашей квартиры</span>
                <span className={'tag ' + CHOICES[v.myChoice].cls}>{CHOICES[v.myChoice].voted}</span></div>
              : <div className="chips" style={{ marginTop: 12 }}>
                {Object.entries(CHOICES).map(([choice, c]) => (
                  <button key={choice} className="chip" disabled={offline || voting === v.id} onClick={() => cast(v.id, choice)}>{c.label}</button>
                ))}
              </div>}
            <div className="row" style={{ marginTop: 10 }}>
              <span className="lbl">За, против, воздержались</span>
              <span className="num">{v.yes} · {v.no} · {v.abstain}</span>
            </div>
          </div>
        );
      })}
    </>
  );
}

function Repair({ house }) {
  const mc = house.managementCompany;
  return (
    <>
      <Hint>Что и когда делают в доме за деньги фонда капремонта. Если сроки сорваны, звоните в УК и называйте год из плана.</Hint>
      {house.overhaulPlan.map((w, i) => {
        const inWork = w.status === 'in_progress';
        return (
          <div className="card" key={i}>
            <div className="row"><b>{w.workType}</b>
              <span className={'tag ' + (inWork ? 'ok' : 'warn')}>{inWork ? 'идёт сейчас' : 'по плану ' + w.plannedYear}</span></div>
            <div className="row"><span className="lbl">Смета</span><span className="num">{rub(w.budget)}</span></div>
            <div className="row"><span className="lbl">Выполнено</span><span className="num">{w.progressPercent}%</span></div>
            <div className="bar"><i style={{ width: w.progressPercent + '%' }} /></div>
            <div className="row" style={{ marginTop: 8 }}><span className="lbl">Подрядчик</span>
              <span>{w.contractorPhone ? <a href={tel(w.contractorPhone)}>{w.contractor}</a> : w.contractor}</span></div>
          </div>
        );
      })}
      <div className="card">
        <h2>Куда звонить</h2>
        <div className="row"><span className="lbl">Управляющая компания</span><a className="num" href={tel(mc.phone)}>{mc.phone}</a></div>
        <div className="row"><span className="lbl">Аварийная, круглосуточно</span><a className="num" href={tel(mc.emergencyPhone)}>{mc.emergencyPhone}</a></div>
        <div className="row"><span className="lbl">Приём</span><span>{mc.reception}</span></div>
      </div>
      <p className="src">Данные дома и плана капремонта в MVP модельные (обезличенные).</p>
    </>
  );
}

function InviteNeighbours({ house, toast }) {
  const [link, setLink] = useState(null);
  useEffect(() => { api(`/houses/${house.fiasId}/link`).then(setLink).catch(() => {}); }, [house.fiasId]);
  const [copied, setCopied] = useState(false);
  if (!link) return null;
  const text = `Наш дом ${house.address} подключён к приложению «Дом» в MAX: аварии, заявки в УК и опросы соседей.`;
  const share = async () => {
    if (isInsideMax && wa.shareMaxContent) {
      try { wa.shareMaxContent({ text, link: link.link }); return; } catch {}
    }

    if (navigator.share) {
      try { await navigator.share({ text, url: link.link }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }

    try {
      await navigator.clipboard.writeText(`${text} ${link.link}`);
      setCopied(true);
      toast('Ссылка скопирована, отправьте её соседям в домовой чат');
    } catch {
      setCopied(true);
      toast('Скопируйте ссылку ниже или покажите соседу QR-код');
    }
  };
  return (
    <div className="card">
      <h2>Позвать соседей</h2>
      <p className="src">Чем больше соседей подключено, тем больше квартир получат предупреждение об отключении воды при аварии на стояке.</p>
      <img className="qr" src={link.qr} alt="QR-код для подключения к дому" width="180" height="180" />
      <button className="btn ghost" onClick={share}>Поделиться ссылкой с соседями</button>
      {copied && <p className="src" style={{ wordBreak: 'break-all', userSelect: 'all' }}>{link.link}</p>}
    </div>
  );
}

function Info({ house, membership, me, onHelp, onChangeHouse, onStaff, toast }) {
  const mc = house.managementCompany;
  return (
    <>
      <div className="card">
        <h2>{house.address}</h2>
        <div className="row"><span className="lbl">Ваша квартира</span><span className="num">{membership.apartment}</span></div>
        <div className="row"><span className="lbl">Год постройки</span><span className="num">{house.yearBuilt}</span></div>
        <div className="row"><span className="lbl">Этажей / подъездов / квартир</span><span className="num">{house.floors} / {house.entrances} / {house.apartmentsCount}</span></div>
      </div>
      <div className="card">
        <h2>Управляющая компания</h2>
        <div className="row"><span className="lbl">{mc.name}</span><a className="num" href={tel(mc.phone)}>{mc.phone}</a></div>
        <div className="row"><span className="lbl">Аварийная, круглосуточно</span><a className="num" href={tel(mc.emergencyPhone)}>{mc.emergencyPhone}</a></div>
        <div className="row"><span className="lbl">Приём</span><span>{mc.reception}</span></div>
        {mc.email && <div className="row"><span className="lbl">Почта</span><span>{mc.email}</span></div>}
      </div>
      <InviteNeighbours house={house} toast={toast} />
      <button className="btn ghost" onClick={onHelp}>Как этим пользоваться</button>
      <button className="btn ghost" onClick={onChangeHouse}>Сменить дом или квартиру</button>
      {me.staffLoginAvailable && <button className="btn ghost" onClick={onStaff}>{me.role === 'dispatcher' ? 'Добавить УК по коду' : 'Я сотрудник УК'}</button>}
    </>
  );
}

function StaffLogin({ onDone, toast }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    setBusy(true); setErr('');
    try {
      await api('/staff/login', { method: 'POST', body: { code: code.trim() } });
      haptic.ok();
      toast('Готово, дома этой УК добавлены на пульт');
      await onDone();
    } catch (e) {
      setErr(e.message === 'bad_code' ? 'Код не подошёл. Его выдаёт ваша управляющая компания.' : errText(e));
    } finally { setBusy(false); }
  };
  return (
    <>
      <Hint>Диспетчер УК видит аварии своих домов на схеме подъезда, оповещает соседей по стояку и меняет статусы заявок. Код выдаёт управляющая компания: он открывает пульт только её домов.</Hint>
      <div className="card">
        <label className="field">Код сотрудника УК
          <input value={code} autoComplete="off" onChange={e => setCode(e.target.value)} />
        </label>
      </div>
      {err && <Hint kind="offline">{err}</Hint>}
      <button className="btn" disabled={!code.trim() || busy} onClick={submit}>{busy ? 'Проверяем…' : 'Войти'}</button>
    </>
  );
}

function Help({ onDone }) {
  return (
    <>
      <Hint>Главное, для чего приложение: быстро сообщить об аварии и видеть, что с ней происходит.</Hint>
      <ol className="steps">
        <li><div><b>Авария.</b> На главной нажмите «Авария в доме», сфотографируйте, что случилось. Нейросеть подскажет категорию, адрес и квартиру подставим сами.</div></li>
        <li><div><b>Что дальше.</b> Заявка сразу появляется у диспетчера на схеме подъезда. Соседи по стояку получают в MAX предупреждение об отключении воды.</div></li>
        <li><div><b>Статус.</b> Когда заявку примут в работу и когда её закроют, бот напишет вам в чат. История видна во вкладке «Заявки».</div></li>
        <li><div><b>Ещё.</b> Показания счётчиков, проверка квитанции, опросы соседей и план капремонта.</div></li>
      </ol>
      <button className="btn" onClick={onDone}>Понятно</button>
    </>
  );
}

function Onboarding({ houses, initialHouse, current, onAttached, toast, goPrivacy, addressSearch }) {
  const valid = houses.find(h => h.fiasId === initialHouse);
  const [houseId, setHouseId] = useState(valid ? initialHouse : '');
  const [apartment, setApartment] = useState(current ? current.apartment : '');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [sugs, setSugs] = useState([]);
  const [searchOn, setSearchOn] = useState(!!addressSearch);
  const [notConnected, setNotConnected] = useState(null);
  const [searching, setSearching] = useState(false);
  const h = houses.find(x => x.fiasId === houseId);
  const aptNum = Number(apartment);
  const aptOk = /^\d{1,5}$/.test(apartment.trim()) && aptNum >= 1 && (!h || aptNum <= h.apartmentsCount);
  const ready = h && aptOk && consent && !busy;

  useEffect(() => {
    if (q.trim().length < 3) { setSugs([]); return undefined; }
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await api('/address/suggest?q=' + encodeURIComponent(q.trim()));
        if (r.source === 'off') setSearchOn(false);
        setSugs((r && r.items) || []);
      } catch { setSugs([]); }
      finally { setSearching(false); }
    }, 350);
    return () => clearTimeout(t);
  }, [q]);

  const pickAddress = s => {
    if (s.connected) { setHouseId(s.fiasId); setQ(''); setSugs([]); setNotConnected(null); toast('Дом найден в ФИАС и подключён'); }
    else setNotConnected(s.value);
  };

  const submit = async () => {
    setBusy(true); setErr('');
    try {
      await api('/attach', { method: 'POST', body: { houseId, apartment: apartment.trim(), consent: true } });
      haptic.ok();
      await onAttached();
    } catch (e) {
      const code = e.data && e.data.error;
      setErr(code === 'bad_apartment' || code === 'apartment_out_of_range' ? `Проверьте номер квартиры: в доме квартиры с 1 по ${h ? h.apartmentsCount : '…'}.`
        : code === 'consent_required' ? 'Нужно согласие на обработку данных.'
        : errText(e, 'Не удалось привязать, попробуйте ещё раз.'));
    } finally { setBusy(false); }
  };

  if (!houses.length) return <Hint kind="offline">Не удалось загрузить список домов. Проверьте связь и откройте приложение заново.</Hint>;

  const byCity = houses.reduce((acc, x) => { (acc[x.cityName] ||= []).push(x); return acc; }, {});

  return (
    <>
      <Hint>{current ? 'Выберите новый дом или исправьте номер квартиры.' : valid ? 'Дом выбран по QR-коду из подъезда. Укажите квартиру.' : 'Выберите свой дом и квартиру. Это нужно один раз: заявки уйдут в вашу УК, а при аварии на стояке вас предупредят.'}</Hint>
      <div className="card">
        <label className="field">Дом</label>
        {Object.entries(byCity).map(([city, list]) => (
          <div key={city}>
            <p className="src" style={{ margin: '8px 0 4px' }}>{city}</p>
            <div className="chips">
              {list.map(x => (
                <button key={x.fiasId} className="chip" aria-pressed={houseId === x.fiasId} onClick={() => setHouseId(x.fiasId)}>
                  {x.address.replace(/^г\. [^,]+, /, '')}
                </button>
              ))}
            </div>
          </div>
        ))}
        {h && <p className="src">УК: {h.uk}. Квартир в доме: {h.apartmentsCount}.</p>}
        {searchOn && (
          <label className="field">Нет в списке? Найдите дом по адресу (ФИАС)
            <input value={q} placeholder="Казань, Чистопольская 71" onChange={e => setQ(e.target.value)} />
          </label>
        )}
        {searching && <p className="src">Ищем в ФИАС…</p>}
        {!searching && searchOn && q.trim().length >= 3 && !sugs.length && <p className="src">Ничего не нашли. Добавьте номер дома, например «Парголовская 11».</p>}
        {notConnected && <Hint kind="offline">Дом «{notConnected}» есть в ФИАС, но его управляющая компания пока не подключена к сервису. Подключение нового дома делает УК, для жителя это одна запись в реестре. Пока можно выбрать один из подключённых домов выше.</Hint>}
        {sugs.length > 0 && (
          <div className="chips" style={{ flexDirection: 'column', alignItems: 'stretch', marginTop: 6 }}>
            {sugs.map((s, i) => (
              <button key={i} className="chip" style={{ textAlign: 'left' }} onClick={() => pickAddress(s)}>
                {s.value}{s.connected ? ' · подключён' : ' · не подключён'}
              </button>
            ))}
          </div>
        )}
        <label className="field">Номер квартиры
          <input inputMode="numeric" value={apartment} placeholder="42" onChange={e => setApartment(e.target.value.replace(/\D/g, ''))} />
        </label>
        {apartment && !aptOk && h && <p className="src diff-bad">В этом доме квартиры с 1 по {h.apartmentsCount}.</p>}
        <label className="consent">
          <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />
          <span>Согласен на обработку персональных данных (дом, квартира, идентификатор MAX) для работы с заявками и оповещениями.{' '}
            <button type="button" className="linklike" onClick={goPrivacy}>Как обрабатываем</button></span>
        </label>
      </div>
      {err && <Hint kind="offline">{err}</Hint>}
      <button className="btn" disabled={!ready} onClick={submit}>
        {busy ? 'Сохраняем…' : !h ? 'Выберите дом' : !aptOk ? 'Укажите квартиру' : !consent ? 'Нужно согласие' : 'Готово, это мой дом'}
      </button>
    </>
  );
}

function Privacy({ onBack }) {
  return (
    <>
      <div className="card">
        <h2>Как мы обрабатываем данные</h2>
        <p className="src">
          Приложение хранит минимум: ваш идентификатор в MAX, выбранный дом и номер квартиры. Это нужно, чтобы передать заявку
          в вашу управляющую компанию, прислать статус и предупредить при аварии на вашем стояке.
        </p>
        <p className="src">
          Мы не собираем паспортные данные и телефон, не передаём сведения третьим лицам и не показываем ваши заявки другим жителям:
          соседи видят только обезличенные итоги опросов. Фото аварии анализируется и не сохраняется.
          Отозвать согласие можно, сменив дом или обратившись в УК.
        </p>
        <p className="src">Основание обработки: ваше согласие (Федеральный закон № 152-ФЗ «О персональных данных»).</p>
      </div>
      <button className="btn" onClick={onBack}>Понятно, назад</button>
    </>
  );
}

export function App() {
  const [tab, setTab] = useState('home');
  const [sub, setSub] = useState(null);
  const [phase, setPhase] = useState('loading');
  const [authHint, setAuthHint] = useState('');
  const [me, setMe] = useState(null);
  const [boot, setBoot] = useState(null);
  const [housesList, setHousesList] = useState([]);
  const [requests, setRequests] = useState([]);
  const [votes, setVotes] = useState([]);
  const [offline, setOffline] = useState(false);
  const [prefill, setPrefill] = useState(null);
  const [toastMsg, setToastMsg] = useState(null);

  const toast = useCallback(m => { setToastMsg(m); setTimeout(() => setToastMsg(null), 2800); }, []);
  const openSub = useCallback(s => { setSub(s); window.scrollTo(0, 0); }, []);
  const backSub = useCallback(() => { setSub(null); window.scrollTo(0, 0); }, []);
  const pickTab = useCallback(t => { setTab(t); setSub(null); window.scrollTo(0, 0); }, []);
  const clearPrefill = useCallback(() => setPrefill(null), []);

  useEffect(() => { try { if (isInsideMax && wa.ready) wa.ready(); } catch {} }, []);

  useEffect(() => {
    const forced = new URLSearchParams(window.location.search).get('ui_theme');
    const theme = sub === 'dispatch' ? 'dark' : (forced === 'dark' || forced === 'light' ? forced : null);
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }, [sub]);

  const load = useCallback(async () => {
    setPhase(p => (p === 'ready' ? p : 'loading'));
    try {
      const [meData, categories, hl] = await Promise.all([api('/me'), api('/categories'), api('/houses')]);
      setMe(meData);
      setHousesList(hl);
      if (meData.membership) {
        const [house, tariffs, rq, vt] = await Promise.all([
          api('/house'), api('/tariffs?city=' + encodeURIComponent(meData.house.city)), api('/requests'), api('/votes'),
        ]);
        setBoot({ house, tariffs, categories });
        setRequests(rq); setVotes(vt);
        store.set('boot', { me: meData, house, tariffs, categories, requests: rq });
      } else {
        setBoot({ house: null, tariffs: null, categories });
      }
      setOffline(false);
      setPhase('ready');
    } catch (e) {
      if (e.status === 401) { setAuthHint(errText(e)); setPhase('auth'); return; }
      const cached = store.get('boot', null);
      if (cached && cached.house) {
        setMe(cached.me); setBoot(cached); setRequests(cached.requests || []);
        setOffline(true); setPhase('ready');
      } else setPhase('down');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const hasMembership = !!(me && me.membership);
  useEffect(() => {
    if (!hasMembership || offline) return undefined;
    const t = setInterval(() => { api('/requests').then(setRequests).catch(() => {}); }, 20000);
    return () => clearInterval(t);
  }, [hasMembership, offline]);

  const needsOnboarding = phase === 'ready' && !!me && !me.membership && !offline;
  const showBack = phase === 'ready' && !!sub && !(needsOnboarding && sub !== 'privacy');
  useMaxBackButton(showBack, backSub);

  if (phase === 'loading') return <div className="skeleton">Загружаем данные дома…</div>;
  if (phase === 'auth') {
    return (
      <div className="skeleton">
        <p><b>Не удалось вас узнать.</b></p>
        <p>{authHint}</p>
        <p className="src">Приложение «Дом» открывается из чата с ботом в MAX: кнопка «Открыть приложение „Дом“».</p>
      </div>
    );
  }
  if (phase === 'down') {
    return (
      <div className="skeleton">
        <p><b>Сервер временно недоступен.</b></p>
        <p>Если у вас авария, не ждите: перекройте вентиль и звоните в аварийную службу своей УК.</p>
        <button className="btn" onClick={load}>Попробовать снова</button>
      </div>
    );
  }

  const { house, tariffs, categories } = boot;
  const membership = (me && me.membership) || null;
  const dispatcher = !!me && me.role === 'dispatcher';
  const openCount = requests.filter(isOpen).length;

  const attached = async () => { await load(); setSub(null); setTab('home'); window.scrollTo(0, 0); };
  const claim = p => { setPrefill(p); setSub(null); setTab('requests'); window.scrollTo(0, 0); };
  const onEmergency = () => claim({ category: 'emergency', title: 'Авария', description: '' });
  const staffDone = async () => { await load(); openSub('dispatch'); };

  const view = needsOnboarding && sub !== 'privacy' ? 'onboarding' : (sub || tab);
  const onboarding = { houses: housesList, addressSearch: me.addressSearch, toast, goPrivacy: () => openSub('privacy'), onAttached: attached };

  let body;
  if (sub === 'privacy') body = <Privacy onBack={backSub} />;
  else if (needsOnboarding) body = <Onboarding {...onboarding} initialHouse={startParam} />;
  else if (sub === 'onboarding') body = <Onboarding {...onboarding} initialHouse={membership.houseId} current={membership} />;
  else if (sub === 'bill') body = <BillCheck tariffs={tariffs} onClaim={claim} toast={toast} />;
  else if (sub === 'meters') body = <Meters tariffs={tariffs} membership={membership} toast={toast} offline={offline} />;
  else if (sub === 'repair') body = <Repair house={house} />;
  else if (sub === 'dispatch') body = <Dispatch toast={toast} houses={me.dispatchHouses} initialHouse={membership.houseId} />;
  else if (sub === 'help') body = <Help onDone={backSub} />;
  else if (sub === 'staff') body = <StaffLogin onDone={staffDone} toast={toast} />;
  else if (tab === 'requests') body = (
    <Requests house={house} membership={membership} categories={categories} requests={requests} prefill={prefill}
      clearPrefill={clearPrefill} toast={toast} offline={offline}
      onCreated={r => setRequests(list => [r, ...list])} />
  );
  else if (tab === 'votes') body = <Votes votes={votes} setVotes={setVotes} membership={membership} toast={toast} offline={offline} />;
  else if (tab === 'info') body = <Info house={house} membership={membership} me={me} toast={toast} onHelp={() => openSub('help')} onChangeHouse={() => openSub('onboarding')} onStaff={() => openSub('staff')} />;
  else body = <Home go={openSub} house={house} offline={offline} dispatcher={dispatcher} onEmergency={onEmergency} requests={requests} openRequests={() => pickTab('requests')} />;

  const subtitle = house ? `${house.address}${membership ? ', кв. ' + membership.apartment : ''}` : 'Приложение для жителей дома';

  return (
    <>
      <Head title={TITLES[view] || ''} subtitle={subtitle} showBack={showBack} onBack={backSub} />
      {body}
      {toastMsg && <div className="toast" role="status">{toastMsg}</div>}
      {!needsOnboarding && <TabBar tab={tab} onPick={pickTab} badge={openCount} />}
    </>
  );
}

const rootEl = typeof document !== 'undefined' && document.getElementById('root');
class Guard extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e) { console.error(e); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="skeleton">
        <p><b>Что-то пошло не так.</b></p>
        <p>Если у вас авария, перекройте вентиль и звоните в аварийную службу своей УК.</p>
        <button className="btn" onClick={() => window.location.reload()}>Открыть заново</button>
      </div>
    );
  }
}

if (rootEl) createRoot(rootEl).render(<Guard><App /></Guard>);
