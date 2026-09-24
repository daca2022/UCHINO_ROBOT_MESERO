import { useCallback, useEffect, useState } from 'react';

const RETENTION_OPTIONS = [
  ['session_only', 'Solo la sesión'],
  ['1d', '1 día'],
  ['7d', '7 días'],
  ['30d', '30 días'],
  ['disabled', 'Desactivada'],
];

export default function MemoryPanel({ token, liveEvent = null }) {
  const [snapshot, setSnapshot] = useState(null);
  const [profiles, setProfiles] = useState([]);
  const [audit, setAudit] = useState([]);
  const [retention, setRetention] = useState('1d');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [summaryResponse, settingsResponse, profilesResponse, auditResponse] = await Promise.all([
        fetch('/api/admin/memory/summary', { headers }),
        fetch('/api/admin/memory/settings', { headers }),
        fetch('/api/admin/memory/profiles?limit=100', { headers }),
        fetch('/api/admin/memory/audit?limit=30', { headers }),
      ]);
      const bodies = await Promise.all([summaryResponse.json(), settingsResponse.json(), profilesResponse.json(), auditResponse.json()]);
      if (bodies.some((body, index) => ![summaryResponse, settingsResponse, profilesResponse, auditResponse][index].ok)) throw new Error('No se pudo cargar la memoria administrativa.');
      setSnapshot(bodies[0]);
      setRetention(bodies[1].retention_policy || '1d');
      setProfiles(bodies[2].data || []);
      setAudit(bodies[3].data || []);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (liveEvent?.type === 'memory_event') void load();
  }, [liveEvent?.type, liveEvent?.timestamp, load]);

  async function saveRetention(event) {
    const value = event.target.value;
    setRetention(value);
    setMessage('');
    setError('');
    try {
      const response = await fetch('/api/admin/memory/settings', { method: 'PATCH', headers, body: JSON.stringify({ retention_policy: value }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setMessage('Política de retención actualizada.');
      await load();
    } catch (saveError) { setError(saveError.message); }
  }

  async function cleanup() {
    setMessage('');
    setError('');
    try {
      const response = await fetch('/api/admin/memory/cleanup', { method: 'POST', headers, body: '{}' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setMessage(`Limpieza completada: ${body.expired || 0} registros expirados.`);
      await load();
    } catch (cleanupError) { setError(cleanupError.message); }
  }

  async function forgetProfile(profile) {
    if (!window.confirm(`¿Olvidar toda la memoria de ${profile.display_name || 'este perfil'}? Los pedidos históricos no se borrarán.`)) return;
    setError('');
    try {
      const response = await fetch(`/api/admin/memory/profiles/${encodeURIComponent(profile.profile_id)}`, { method: 'DELETE', headers, body: JSON.stringify({ confirm: true, scope: 'all' }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setMessage('Perfil olvidado. El historial operativo permanece intacto.');
      await load();
    } catch (forgetError) { setError(forgetError.message); }
  }

  async function anonymizeProfile(profile) {
    if (!window.confirm(`¿Anonimizar ${profile.display_name || 'este perfil'}? Se eliminará su memoria personal y no se borrarán pedidos.`)) return;
    setError('');
    try {
      const response = await fetch(`/api/admin/memory/profiles/${encodeURIComponent(profile.profile_id)}/anonymize`, { method: 'POST', headers, body: JSON.stringify({ confirm: true }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setMessage('Perfil anonimizado. El historial operativo permanece intacto.');
      await load();
    } catch (anonymizeError) { setError(anonymizeError.message); }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-wider text-neon-purple">Memoria temporal / privacidad</p>
          <h2 className="mt-1 text-lg font-bold text-text-primary">Perfiles explícitos y expirables</h2>
          <p className="mt-1 text-xs text-text-secondary">No se recupera por nombre, mesa ni client_id. Los pedidos no forman parte del borrado.</p>
        </div>
        <button onClick={() => void load()} disabled={loading} className="rounded-xl border border-neon-cyan/40 px-3 py-2 text-xs font-semibold text-neon-cyan disabled:opacity-50">Reintentar</button>
      </div>
      {error && <div className="rounded-xl border border-neon-rose/40 bg-neon-rose/10 px-3 py-2 text-xs text-neon-rose" role="alert">{error}</div>}
      {message && <div className="rounded-xl border border-neon-green/40 bg-neon-green/10 px-3 py-2 text-xs text-neon-green" role="status">{message}</div>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <div className="glass rounded-xl border border-chipi-border p-3"><p className="text-[10px] text-text-secondary">Perfiles activos</p><p className="mt-1 text-xl font-bold text-neon-cyan">{snapshot?.profiles ?? '—'}</p></div>
        <div className="glass rounded-xl border border-chipi-border p-3"><p className="text-[10px] text-text-secondary">Próximos a vencer</p><p className="mt-1 text-xl font-bold text-neon-amber">{snapshot?.expiring_profiles ?? '—'}</p></div>
        <div className="glass rounded-xl border border-chipi-border p-3"><p className="text-[10px] text-text-secondary">Vencidos</p><p className="mt-1 text-xl font-bold text-neon-rose">{snapshot?.expired_profiles ?? '—'}</p></div>
        <div className="glass rounded-xl border border-chipi-border p-3"><p className="text-[10px] text-text-secondary">Memorias activas</p><p className="mt-1 text-xl font-bold text-neon-purple">{snapshot?.entries ?? '—'}</p></div>
        <div className="glass rounded-xl border border-chipi-border p-3"><p className="text-[10px] text-text-secondary">Auditoría</p><p className="mt-1 text-xl font-bold text-neon-amber">{snapshot?.audit_events ?? '—'}</p></div>
        <div className="glass rounded-xl border border-chipi-border p-3"><p className="text-[10px] text-text-secondary">Política por defecto</p><p className="mt-1 text-xl font-bold text-neon-green">{snapshot?.policy?.retention_policy || retention}</p></div>
      </div>

      <div className="glass rounded-2xl border border-chipi-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h3 className="text-sm font-bold text-text-primary">Retención predeterminada</h3><p className="mt-1 text-[10px] text-text-secondary">Se aplica solo cuando el cliente elige memoria temporal.</p></div>
          <div className="flex items-center gap-2"><select value={retention} onChange={saveRetention} className="min-h-10 rounded-lg border border-chipi-border bg-chipi-bg px-3 text-xs text-text-primary outline-none focus:border-neon-cyan">{RETENTION_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><button onClick={() => void cleanup()} className="min-h-10 rounded-lg border border-neon-amber/40 bg-neon-amber/10 px-3 text-xs font-semibold text-neon-amber">Limpiar expiradas</button></div>
        </div>
      </div>

      <div className="glass rounded-2xl border border-chipi-border p-4 text-[10px] text-text-secondary">
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          <span>Última limpieza: <strong className="text-text-primary">{snapshot?.last_cleanup_at ? new Date(snapshot.last_cleanup_at).toLocaleString() : 'No ejecutada'}</strong></span>
          <span>Errores registrados: <strong className={snapshot?.last_cleanup_error ? 'text-neon-rose' : 'text-neon-green'}>{snapshot?.last_cleanup_error ? 'Sí' : 'Ninguno'}</strong></span>
          {snapshot?.last_cleanup_metadata && <span>Resultado: <strong className="text-neon-cyan">{`${snapshot.last_cleanup_metadata.entries || 0} entradas · ${snapshot.last_cleanup_metadata.profiles || 0} perfiles`}</strong></span>}
        </div>
      </div>

      <div className="glass rounded-2xl border border-chipi-border p-4">
        <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-bold text-text-primary">Perfiles con memoria temporal</h3><span className="text-[10px] text-text-dim">{profiles.length} visibles</span></div>
        <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[760px] text-xs"><thead><tr className="border-b border-chipi-border text-left text-[10px] uppercase tracking-wider text-text-dim"><th className="p-2">Perfil</th><th className="p-2">Consentimiento</th><th className="p-2">Expira</th><th className="p-2">Estado</th><th className="p-2 text-right">Acción</th></tr></thead><tbody>{profiles.map(profile => <tr key={profile.profile_id} className="border-b border-chipi-border/50"><td className="p-2 text-text-primary">{profile.display_name || 'Sin nombre declarado'}</td><td className="p-2 text-neon-purple">{profile.consent_status}</td><td className="p-2 font-mono text-text-secondary">{profile.expires_at ? new Date(profile.expires_at).toLocaleString() : 'Sesión'}</td><td className="p-2 text-neon-green">{profile.status}</td><td className="p-2 text-right"><div className="flex justify-end gap-1"><button onClick={() => void forgetProfile(profile)} className="rounded-lg border border-neon-rose/40 px-2 py-1 text-[10px] text-neon-rose">Olvidar</button><button onClick={() => void anonymizeProfile(profile)} className="rounded-lg border border-neon-amber/40 px-2 py-1 text-[10px] text-neon-amber">Anonimizar</button></div></td></tr>)}{profiles.length === 0 && <tr><td colSpan="5" className="p-5 text-center text-xs text-text-dim">No hay perfiles persistentes activos.</td></tr>}</tbody></table></div>
      </div>

      <div className="glass rounded-2xl border border-chipi-border p-4"><h3 className="text-sm font-bold text-text-primary">Auditoría de memoria</h3><div className="mt-3 max-h-64 overflow-y-auto space-y-1">{audit.map(event => <div key={event.audit_id} className="grid grid-cols-[auto_1fr_auto] gap-2 rounded-lg border border-chipi-border/60 px-2 py-1.5 text-[10px]"><span className="text-neon-cyan">{event.event}</span><span className="truncate text-text-secondary">{event.memory_type || 'perfil'} · {event.action}</span><span className="font-mono text-text-dim">{new Date(event.created_at).toLocaleString()}</span></div>)}{audit.length === 0 && <p className="text-xs text-text-dim">Sin eventos de memoria.</p>}</div></div>
    </div>
  );
}
