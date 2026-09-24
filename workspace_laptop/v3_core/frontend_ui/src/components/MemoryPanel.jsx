import { useEffect, useMemo, useState } from 'react';

const RECOVERY_KEY = 'uchino_memory_recovery';
const SESSION_TOKEN_KEY = 'uchino_session_access_token';

function sessionHeaders() {
  try {
    const token = sessionStorage.getItem(SESSION_TOKEN_KEY);
    return token ? { 'X-Session-Token': token } : {};
  } catch {
    return {};
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...sessionHeaders(), ...(options.headers || {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function recoverySnapshot() {
  try {
    const value = JSON.parse(sessionStorage.getItem(RECOVERY_KEY) || 'null');
    return value?.profile_id ? value : null;
  } catch {
    return null;
  }
}

export default function MemoryPanel({ sessionId, mesa, memoryEvent = null, onOrderChanged = null }) {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [companion, setCompanion] = useState('');
  const [preference, setPreference] = useState('');
  const [allergy, setAllergy] = useState('');
  const [recovery, setRecovery] = useState(recoverySnapshot);

  const profile = summary?.profile || null;
  const consentLabel = useMemo(() => ({
    temporary: 'Temporal',
    session_only: 'Solo esta sesión',
    disabled: 'Desactivada',
  }[summary?.consent] || 'No seleccionada'), [summary?.consent]);

  async function loadSummary() {
    if (!sessionId) return;
    setLoading(true);
    try {
      const data = await requestJson(`/api/memory/sessions/${encodeURIComponent(sessionId)}/summary`);
      setSummary(data);
      setError('');
      if (data.profile?.display_name) setDisplayName(data.profile.display_name);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setSummary(null);
    setError('');
    if (!sessionId) {
      try { sessionStorage.removeItem(RECOVERY_KEY); } catch {}
      setRecovery(null);
      return;
    }
    setRecovery(recoverySnapshot());
    void loadSummary();
  }, [sessionId]);

  useEffect(() => {
    if (memoryEvent?.type === 'memory_event') void loadSummary();
  }, [memoryEvent?.type, memoryEvent?.timestamp, memoryEvent?.action, sessionId]);

  async function chooseConsent(consent) {
    if (!sessionId) return;
    setWorking(true);
    setError('');
    try {
      const data = await requestJson(`/api/memory/sessions/${encodeURIComponent(sessionId)}/consent`, {
        method: 'POST',
        body: JSON.stringify({ consent, display_name: displayName || undefined, retention_policy: consent === 'temporary' ? '1d' : undefined }),
      });
      setSummary(data.summary ? { ...data.summary, consent: data.consent } : { consent: data.consent, profile: data.profile || null });
      if (data.profile?.profile_id && data.consent === 'temporary') {
        sessionStorage.setItem(RECOVERY_KEY, JSON.stringify({ profile_id: data.profile.profile_id, display_name: displayName || null, consent: data.consent, expires_at: data.profile.expires_at || null }));
        setRecovery(recoverySnapshot());
      }
    } catch (consentError) {
      setError(consentError.message);
    } finally {
      setWorking(false);
    }
  }

  async function recover() {
    if (!sessionId || !recovery) return;
    setWorking(true);
    setError('');
    try {
      await requestJson(`/api/memory/sessions/${encodeURIComponent(sessionId)}/attach`, { method: 'POST', body: JSON.stringify({ profile_id: recovery.profile_id, consent: 'temporary' }) });
      await loadSummary();
    } catch (recoverError) {
      setError(recoverError.message);
      if (/expir|no está disponible/i.test(recoverError.message)) {
        sessionStorage.removeItem(RECOVERY_KEY);
        setRecovery(null);
      }
    } finally {
      setWorking(false);
    }
  }

  async function remember(memoryType, value) {
    if (!sessionId || !value.trim()) return;
    setWorking(true);
    setError('');
    try {
      await requestJson(`/api/memory/sessions/${encodeURIComponent(sessionId)}/remember`, {
        method: 'POST',
        body: JSON.stringify({ memory_type: memoryType, value: value.trim() }),
      });
      if (memoryType === 'preference') setPreference('');
      if (memoryType === 'companion') setCompanion('');
      if (memoryType === 'allergy') setAllergy('');
      await loadSummary();
    } catch (rememberError) {
      setError(rememberError.message);
    } finally {
      setWorking(false);
    }
  }

  async function forget() {
    if (!sessionId || !window.confirm('¿Olvidar toda la memoria personal temporal? Los pedidos no se borrarán.')) return;
    setWorking(true);
    setError('');
    try {
      await requestJson(`/api/memory/sessions/${encodeURIComponent(sessionId)}/forget`, { method: 'POST', body: JSON.stringify({ scope: 'all' }) });
      setSummary({ profile: null, consent: 'disabled', name: null, preferences: [], companions: [], allergies: [], restrictions: [], last_order: null });
      sessionStorage.removeItem(RECOVERY_KEY);
      setRecovery(null);
    } catch (forgetError) {
      setError(forgetError.message);
    } finally {
      setWorking(false);
    }
  }

  async function repeatLastOrder() {
    if (!sessionId) return;
    setWorking(true);
    setError('');
    try {
      const data = await requestJson('/api/asr/process', { method: 'POST', body: JSON.stringify({ session_id: sessionId, mesa, source: 'tablet', user_text: 'Repite mi último pedido', suppress_tts: true }) });
      if (data.products || data.order) onOrderChanged?.(data);
      await loadSummary();
    } catch (orderError) {
      setError(orderError.message);
    } finally {
      setWorking(false);
    }
  }

  async function answerRecoveredAllergy(accepted) {
    if (!sessionId) return;
    setWorking(true);
    setError('');
    try {
      const data = await requestJson('/api/asr/process', { method: 'POST', body: JSON.stringify({ session_id: sessionId, mesa, source: 'tablet', user_text: accepted ? 'Confirmo mi alergia' : 'No', suppress_tts: true }) });
      if (data.products || data.order) onOrderChanged?.(data);
      await loadSummary();
    } catch (allergyError) { setError(allergyError.message); }
    finally { setWorking(false); }
  }

  if (!sessionId) return null;

  return (
    <section className="mt-4 rounded-xl border border-neon-purple/35 bg-neon-purple/5 p-3" aria-label="Memoria temporal del cliente">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-neon-purple">Memoria temporal</p>
          <p className="mt-0.5 text-[10px] text-text-secondary">Solo guardamos lo que declares y confirmes.</p>
        </div>
        <span className="rounded-full border border-neon-purple/35 px-2 py-0.5 text-[9px] font-semibold text-neon-purple">{consentLabel}</span>
      </div>

      {loading && <p className="mt-2 text-[10px] text-text-dim">Consultando memoria...</p>}
      {error && <p className="mt-2 rounded-lg border border-neon-rose/35 bg-neon-rose/10 px-2 py-1 text-[10px] text-neon-rose" role="alert">{error}</p>}

      {!profile && summary?.consent !== 'disabled' && (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <button disabled={working} onClick={() => void chooseConsent('session_only')} className="rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-2 py-2 text-[10px] font-semibold text-neon-cyan disabled:opacity-50">Solo esta sesión</button>
          <button disabled={working} onClick={() => void chooseConsent('temporary')} className="rounded-lg border border-neon-purple/40 bg-neon-purple/10 px-2 py-2 text-[10px] font-semibold text-neon-purple disabled:opacity-50">Conservar 1 día</button>
          <button disabled={working} onClick={() => void chooseConsent('disabled')} className="rounded-lg border border-chipi-border px-2 py-2 text-[10px] font-semibold text-text-secondary disabled:opacity-50">No guardar</button>
        </div>
      )}

      {!profile && recovery && summary?.consent !== 'disabled' && (
        <button disabled={working} onClick={() => void recover()} className="mt-2 w-full rounded-lg border border-neon-amber/40 bg-neon-amber/10 px-2 py-2 text-[10px] font-semibold text-neon-amber disabled:opacity-50">Recuperar memoria declarada{recovery.display_name ? ` de ${recovery.display_name}` : ''}</button>
      )}

      {profile && (
        <div className="mt-3 space-y-2">
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <input value={displayName} onChange={event => setDisplayName(event.target.value)} placeholder="Nombre declarado" aria-label="Nombre declarado" className="min-h-9 rounded-lg border border-chipi-border bg-chipi-bg px-2 text-[10px] text-text-primary outline-none focus:border-neon-cyan" />
            <button disabled={working || !displayName.trim()} onClick={() => void remember('name', displayName)} className="rounded-lg border border-neon-cyan/40 px-2 text-[10px] font-semibold text-neon-cyan disabled:opacity-40">Guardar</button>
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <input value={preference} onChange={event => setPreference(event.target.value)} placeholder="Preferencia declarada" aria-label="Preferencia declarada" className="min-h-9 rounded-lg border border-chipi-border bg-chipi-bg px-2 text-[10px] text-text-primary outline-none focus:border-neon-cyan" />
            <button disabled={working || !preference.trim()} onClick={() => void remember('preference', preference)} className="rounded-lg border border-neon-purple/40 px-2 text-[10px] font-semibold text-neon-purple disabled:opacity-40">Añadir</button>
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <input value={companion} onChange={event => setCompanion(event.target.value)} placeholder="Acompañante declarado" aria-label="Acompañante declarado" className="min-h-9 rounded-lg border border-chipi-border bg-chipi-bg px-2 text-[10px] text-text-primary outline-none focus:border-neon-cyan" />
            <button disabled={working || !companion.trim()} onClick={() => void remember('companion', companion)} className="rounded-lg border border-neon-cyan/40 px-2 text-[10px] font-semibold text-neon-cyan disabled:opacity-40">Añadir</button>
          </div>
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <input value={allergy} onChange={event => setAllergy(event.target.value)} placeholder="Alergia declarada" aria-label="Alergia declarada" className="min-h-9 rounded-lg border border-chipi-border bg-chipi-bg px-2 text-[10px] text-text-primary outline-none focus:border-neon-rose" />
            <button disabled={working || !allergy.trim()} onClick={() => void remember('allergy', allergy)} className="rounded-lg border border-neon-rose/40 px-2 text-[10px] font-semibold text-neon-rose disabled:opacity-40">Declarar</button>
          </div>
          {summary.companions?.length > 0 && <p className="text-[10px] text-text-secondary">Acompañantes: <span className="text-neon-cyan">{summary.companions.join(', ')}</span></p>}
          {summary.preferences?.length > 0 && <p className="text-[10px] text-text-secondary">Preferencias: <span className="text-neon-purple">{summary.preferences.join(', ')}</span></p>}
          {summary.favorite_products?.length > 0 && <p className="text-[10px] text-text-secondary">Favoritos declarados: <span className="text-neon-amber">{summary.favorite_products.join(', ')}</span></p>}
          {summary.allergies?.length > 0 && <div className="rounded-lg border border-neon-rose/35 bg-neon-rose/10 px-2 py-1 text-[10px] text-neon-rose"><p>Alergias recordadas: {summary.allergies.map(item => item.value).join(', ')}. Se deben confirmar en una nueva sesión.</p>{summary.allergies.some(item => item.requires_reconfirmation) && <div className="mt-2 grid grid-cols-2 gap-2"><button disabled={working} onClick={() => void answerRecoveredAllergy(true)} className="rounded-lg border border-neon-rose/50 px-2 py-1 font-semibold disabled:opacity-40">Confirmar para esta atención</button><button disabled={working} onClick={() => void answerRecoveredAllergy(false)} className="rounded-lg border border-chipi-border px-2 py-1 text-text-secondary disabled:opacity-40">No aplicar</button></div>}</div>}
          <div className="grid grid-cols-2 gap-2">
            <button disabled={working} onClick={() => void repeatLastOrder()} className="rounded-lg border border-neon-amber/40 bg-neon-amber/10 px-2 py-2 text-[10px] font-semibold text-neon-amber disabled:opacity-40">Repetir último pedido</button>
            <button disabled={working} onClick={() => void forget()} className="rounded-lg border border-neon-rose/40 bg-neon-rose/10 px-2 py-2 text-[10px] font-semibold text-neon-rose disabled:opacity-40">Olvidar todo</button>
          </div>
        </div>
      )}
    </section>
  );
}
