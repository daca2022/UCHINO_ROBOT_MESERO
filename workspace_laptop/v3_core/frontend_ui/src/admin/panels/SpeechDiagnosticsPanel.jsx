import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../AuthContext.jsx';

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('es-PE');
}

function Status({ value }) {
  const good = ['ready', 'speaking', 'ok', 'completed', 'simulated'].includes(String(value || '').toLowerCase());
  return <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${good ? 'border-neon-green/40 bg-neon-green/10 text-neon-green' : 'border-neon-amber/40 bg-neon-amber/10 text-neon-amber'}`}>{value || '—'}</span>;
}

export default function SpeechDiagnosticsPanel({ liveEvent }) {
  const { token } = useAuth();
  const [diagnostics, setDiagnostics] = useState(null);
  const [text, setText] = useState('Hola, soy Uchino. ¿En qué puedo ayudarte?');
  const [loading, setLoading] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);

  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);
  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const response = await fetch('/api/admin/speech/diagnostics', { headers, cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setDiagnostics(body);
      setError(null);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }, [headers, token]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [load]);

  async function preview() {
    if (!text.trim()) return;
    setPreviewing(true);
    setMessage(null);
    try {
      const response = await fetch('/api/admin/speech/preview', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setMessage('Vista previa enviada a la cola TTS.');
      setDiagnostics(current => ({ ...current, diagnostics: { ...current?.diagnostics, current: body } }));
    } catch (previewError) {
      setError(previewError.message);
    } finally {
      setPreviewing(false);
    }
  }

  const current = diagnostics?.diagnostics?.current;
  const event = liveEvent?.type === 'speech_tts_event' ? liveEvent : null;

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.2em] text-neon-cyan">Admin / diagnóstico</p>
          <h2 className="mt-1 text-xl font-bold text-text-primary">Voz y TTS</h2>
          <p className="mt-1 max-w-3xl text-xs text-text-secondary">Texto visual separado del texto hablado, segmentos, cola y eventos de reproducción.</p>
        </div>
        <button type="button" onClick={load} disabled={loading} className="rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-2 text-xs font-semibold text-neon-cyan disabled:opacity-50">{loading ? 'Actualizando...' : 'Actualizar'}</button>
      </div>

      {error && <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neon-rose/50 bg-neon-rose/10 p-3 text-xs text-neon-rose"><span>{error}</span><button type="button" onClick={load} className="rounded-lg border border-neon-rose/50 px-3 py-1.5 font-semibold">Reintentar</button></div>}
      {message && <div className="rounded-xl border border-neon-green/40 bg-neon-green/10 p-3 text-xs text-neon-green">{message}</div>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          ['Motor', diagnostics?.tts_engine],
          ['Estado', diagnostics?.tts_status],
          ['Listo', diagnostics?.ready ? 'sí' : 'no'],
          ['Hablando', diagnostics?.speaking ? 'sí' : 'no'],
          ['Pendientes', diagnostics?.diagnostics?.pending_segments ?? 0],
        ].map(([label, value]) => <div key={label} className="rounded-xl border border-chipi-border bg-chipi-card/60 p-3"><p className="text-[10px] uppercase tracking-wider text-text-dim">{label}</p><div className="mt-2 text-sm font-semibold text-text-primary"><Status value={value} /></div></div>)}
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="rounded-2xl border border-chipi-border bg-chipi-card/50 p-4">
          <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-text-secondary">Vista previa controlada</h3>
          <textarea value={text} onChange={eventInput => setText(eventInput.target.value)} rows={5} className="w-full resize-y rounded-xl border border-chipi-border bg-chipi-bg p-3 text-xs text-text-primary outline-none focus:border-neon-cyan/60" aria-label="Texto de vista previa TTS" />
          <button type="button" onClick={preview} disabled={previewing || !text.trim()} className="mt-3 rounded-lg border border-neon-green/40 bg-neon-green/10 px-4 py-2 text-xs font-semibold text-neon-green disabled:opacity-50">{previewing ? 'Enviando...' : 'Reproducir vista previa'}</button>
        </div>
        <div className="rounded-2xl border border-chipi-border bg-chipi-card/50 p-4">
          <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-text-secondary">Última respuesta</h3>
          <p className="text-[10px] uppercase tracking-wider text-text-dim">Pantalla</p>
          <p className="mt-1 min-h-10 text-sm text-text-primary">{current?.display_text || event?.display_text || '—'}</p>
          <p className="mt-3 text-[10px] uppercase tracking-wider text-text-dim">Voz</p>
          <p className="mt-1 min-h-10 text-xs text-neon-cyan">{current?.speech_text || event?.speech_text || '—'}</p>
          <div className="mt-3 flex flex-wrap gap-2 text-[10px] text-text-secondary"><span>Segmentos: {current?.segment_count ?? current?.speech_segments?.length ?? current?.sanitization?.segments_count ?? event?.segment_count ?? event?.speech_segments?.length ?? 0}</span><span>Latencia: {current?.sanitization?.duration_ms ?? event?.duration_ms ?? '—'} ms</span></div>
        </div>
      </div>

      <div className="rounded-2xl border border-chipi-border bg-chipi-card/50 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-xs font-bold uppercase tracking-wider text-text-secondary">Eventos TTS</h3><span className="text-[10px] text-text-dim">{formatDate(event?.timestamp || diagnostics?.generated_at)}</span></div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg border border-chipi-border p-2"><p className="text-[10px] text-text-dim">Evento</p><p className="mt-1 text-xs text-text-primary">{event?.event || '—'}</p></div>
          <div className="rounded-lg border border-chipi-border p-2"><p className="text-[10px] text-text-dim">Sesión</p><p className="mt-1 truncate font-mono text-[10px] text-text-primary">{event?.session_id || current?.session_id || '—'}</p></div>
          <div className="rounded-lg border border-chipi-border p-2"><p className="text-[10px] text-text-dim">Fuente</p><p className="mt-1 text-xs text-text-primary">{event?.source || current?.source || '—'}</p></div>
          <div className="rounded-lg border border-chipi-border p-2"><p className="text-[10px] text-text-dim">Error</p><p className="mt-1 text-xs text-neon-rose">{event?.error || '—'}</p></div>
        </div>
      </div>
    </section>
  );
}
