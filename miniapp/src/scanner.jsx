import { useState, useRef, useEffect, useCallback } from 'react';
import { api, fmtSla } from './api.js';

const KIND_LABEL = { cold: 'ХВС', hot: 'ГВС', power: 'Электро', unknown: '?' };
const KIND_OPTIONS = ['cold', 'hot', 'power'];
const INTENSITY = { low: 'низкая', medium: 'средняя', high: 'высокая' };
const SCAN_TEXT = { meter: 'Распознаём цифры…', incident: 'Смотрим, что на фото…' };

export const fmtReading = (kind, v) => (v == null ? '' : kind === 'power' ? String(Math.round(v)) : Number(v).toFixed(2));

async function toJpeg(file, max = 1280, quality = 0.82) {
  let src;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    src = await new Promise((ok, fail) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); ok(img); };
      img.onerror = () => { URL.revokeObjectURL(url); fail(new Error('decode')); };
      img.src = url;
    });
  }
  const w = src.naturalWidth || src.width;
  const h = src.naturalHeight || src.height;
  const k = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
  if (!blob) throw new Error('encode');
  const dataUrl = await new Promise((ok, fail) => {
    const fr = new FileReader();
    fr.onload = () => ok(fr.result);
    fr.onerror = fail;
    fr.readAsDataURL(blob);
  });
  return String(dataUrl).split(',')[1];
}

function Odometer({ value }) {
  const [on, setOn] = useState(false);
  useEffect(() => { const t = setTimeout(() => setOn(true), 80); return () => clearTimeout(t); }, []);
  return (
    <span className="odo" aria-label={value}>
      {[...String(value)].map((ch, i) => (/\d/.test(ch)
        ? (
          <span className="odo-col" key={i} aria-hidden="true">
            <span className="odo-strip" style={{ transform: `translateY(${on ? -Number(ch) : 0}em)`, transitionDelay: `${i * 90}ms` }}>
              {'0123456789'.split('').map(d => <b key={d}>{d}</b>)}
            </span>
          </span>
        )
        : <span className="odo-sep" key={i} aria-hidden="true">{ch}</span>))}
    </span>
  );
}

function SourceBadge({ res }) {
  return res.source === 'demo'
    ? <span className="scan-badge demo" title="Ответ заготовлен: содержимое фото не анализировалось">Демо: фото не анализировалось</span>
    : <span className="scan-badge live">Распознано по фото</span>;
}

function MeterResult({ res, kind, onPick, units }) {
  const known = kind !== 'unknown';
  return (
    <div className="scan-res">
      <SourceBadge res={res} />
      <div className="scan-line">
        {known ? <>Распознано со счётчика <b>{KIND_LABEL[kind]}</b></> : <>Показание считано, тип счётчика не определён</>}
      </div>
      <div className="scan-value">
        <Odometer key={`${kind}-${res.value}`} value={fmtReading(kind, res.value)} />
        {known && <small>{units[kind]}</small>}
      </div>
      <div className="scan-meta">
        {res.serial && <span>Серийный № {res.serial}</span>}
        {res.confidence != null && <span>Уверенность: {(res.confidence * 100).toFixed(1)}%</span>}
      </div>
      <div className="scan-kinds" role="group" aria-label="Тип счётчика">
        <span>{known ? 'Это счётчик:' : 'Выберите, чтобы подставить в поле:'}</span>
        {KIND_OPTIONS.map(k => (
          <button key={k} type="button" className="scan-kind" aria-pressed={kind === k} onClick={() => onPick(k)}>{KIND_LABEL[k]}</button>
        ))}
      </div>
      <p className="scan-note">
        {known ? 'Показание подставлено в поле ниже. ' : ''}Сверьте цифры со счётчиком: если нейросеть ошиблась, поправьте вручную.
      </p>
    </div>
  );
}

function IncidentResult({ res, categoryLabel }) {
  const emergency = res.priority === 'emergency';
  return (
    <div className={'scan-res inc ' + (emergency ? 'emergency' : 'normal')}>
      <SourceBadge res={res} />
      <div className="scan-line big">Обнаружено: <b>{res.label}</b></div>
      <div className="scan-tags">
        <span className={'sev sev-' + res.intensity}>Интенсивность: {INTENSITY[res.intensity]}</span>
        <span className={'prio ' + (emergency ? 'emergency' : 'normal')}>
          Приоритет: {emergency ? 'Экстренный' : 'Обычный'} ({fmtSla(res.slaMinutes)})
        </span>
      </div>
      {res.summary && <p className="scan-sum">{res.summary}</p>}
      {res.confidence != null && <div className="scan-meta"><span>Уверенность: {(res.confidence * 100).toFixed(1)}%</span></div>}
      <p className="scan-note">Категория «{categoryLabel}» выбрана автоматически. Проверьте описание и отправьте заявку.</p>
    </div>
  );
}

export function PhotoScanner({ mode, units = {}, categories = [], onFile, onResult }) {
  const [phase, setPhase] = useState('idle');
  const [preview, setPreview] = useState(null);
  const [res, setRes] = useState(null);
  const [kind, setKind] = useState('unknown');
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState('');
  const input = useRef(null);
  const seq = useRef(0);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const run = useCallback(async file => {
    if (!file) return;
    if (!file.type || !file.type.startsWith('image/')) {
      setError('Нужна фотография: JPG, PNG или WebP.');
      setPhase('error');
      return;
    }
    const id = ++seq.current;
    setError(''); setRes(null);
    setPreview(URL.createObjectURL(file));
    setPhase('scanning');
    if (onFile) onFile(file);
    try {
      const image = await toJpeg(file);
      const out = await api('/ai/scan', { method: 'POST', body: { mode, image }, timeout: 45000 });
      if (id !== seq.current) return;
      if (!out.readable) {
        setError(mode === 'meter'
          ? 'Не удалось разобрать цифры. Сфотографируйте ближе и без бликов или введите показания вручную.'
          : 'На фото не видно аварии. Опишите проблему словами.');
        setPhase('error');
        return;
      }
      setRes(out);
      setKind(out.kind || 'unknown');
      setPhase('done');
      if (onResult) onResult(out, null);
    } catch (e) {
      if (id !== seq.current) return;
      setError(e && e.status === 429 ? 'Слишком много фото подряд, подождите минуту.'
        : e && (e.status === 503 || e.status === 502) ? 'Распознавание сейчас недоступно. Заполните поля вручную.'
        : 'Не получилось обработать фото. Заполните поля вручную.');
      setPhase('error');
    }
  }, [mode, onFile, onResult]);

  const pickKind = k => {
    const previous = kind;
    setKind(k);
    if (onResult && res) onResult({ ...res, kind: k }, previous);
  };

  const busy = phase === 'scanning';
  const label = mode === 'meter' ? 'Сфотографировать счётчик' : 'Сфотографировать аварию';
  const cat = res && categories.find(c => c.key === res.category);
  const dragOver = e => { e.preventDefault(); if (!busy) setDrag(true); };

  return (
    <div
      className={`scan ${mode} ${phase}${drag ? ' drag' : ''}`}
      onDragOver={dragOver}
      onDragEnter={dragOver}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDrag(false); }}
      onDrop={e => { e.preventDefault(); setDrag(false); if (!busy) run(e.dataTransfer.files && e.dataTransfer.files[0]); }}
    >
      <div className="scan-head">
        {mode === 'meter' ? 'Фото счётчика' : 'Фото аварии'}
      </div>

      {preview && (
        <div className="scan-stage">
          <img src={preview} alt="Загруженное фото" />
          {busy && <div className="scan-status"><i />{SCAN_TEXT[mode]}</div>}
        </div>
      )}

      {!busy && (
        <>
          <button type="button" className={'scan-btn' + (phase === 'done' ? ' again' : '')} onClick={() => input.current && input.current.click()}>
            {phase === 'done' ? 'Сфотографировать ещё раз' : label}
          </button>
          {phase !== 'done' && <div className="scan-drop">или перетащите фото сюда</div>}
        </>
      )}
      <input ref={input} type="file" accept="image/*" hidden
        onChange={e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; run(f); }} />

      {phase === 'error' && <p className="scan-err" role="alert">{error}</p>}
      {phase === 'done' && res && (mode === 'meter'
        ? <MeterResult res={res} kind={kind} onPick={pickKind} units={units} />
        : <IncidentResult res={res} categoryLabel={cat ? cat.label : res.category} />)}
    </div>
  );
}
