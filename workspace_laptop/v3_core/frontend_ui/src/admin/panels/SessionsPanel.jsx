import { useState, useEffect, useCallback } from 'react';

const API = '/api/sessions';

function adminHeaders() {
  try {
    const token = localStorage.getItem('admin_token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

function timeAgo(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function statusColor(status) {
  switch (status) {
    case 'active': return '#10B981';
    case 'initializing': return '#22D3EE';
    case 'completing': return '#F59E0B';
    case 'closed': return '#64748B';
    case 'expired': return '#F43F5E';
    default: return '#64748B';
  }
}

export default function SessionsPanel() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [actionMsg, setActionMsg] = useState(null);

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${API}?include_closed=true&limit=50`, { headers: adminHeaders() });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setSessions(d.data || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchSessions(); }, [fetchSessions]);

  async function sessionAction(endpoint, body) {
    setActionMsg(null);
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...adminHeaders() },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setActionMsg(d.status || d.session_status || 'OK');
      fetchSessions();
    } catch (e) {
      setActionMsg(`Error: ${e.message}`);
    }
  }

  async function startSession(mesa) {
    const r = await fetch(`${API}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...adminHeaders() },
      body: JSON.stringify({ robot_id: 'uchino-01', mesa, source: 'admin' }),
    });
    const d = await r.json();
    if (!r.ok) return setActionMsg(d.error || `HTTP ${r.status}`);
    setActionMsg(`Sesi\u00F3n iniciada: ${d.session_id.slice(0, 24)}...`);
    fetchSessions();
  }

  const [newMesa, setNewMesa] = useState('');
  const activeCount = sessions.filter(s => !['closed', 'expired'].includes(s.session_status)).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="text-lg font-bold text-text-primary">Sesiones</h2>
        <button
          onClick={fetchSessions}
          disabled={loading}
          className="rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-1.5 text-xs font-semibold text-neon-cyan hover:bg-neon-cyan/20 disabled:opacity-50"
        >
          {loading ? 'Cargando...' : 'Actualizar'}
        </button>
        {actionMsg && (
          <span className={`text-xs ${actionMsg.startsWith('Error') ? 'text-neon-rose' : 'text-neon-green'}`}>
            {actionMsg}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap rounded-lg border border-chipi-border bg-chipi-card/50 p-3">
        <span className="text-xs text-text-secondary">Iniciar atención:</span>
        <input
          type="text"
          value={newMesa}
          onChange={e => setNewMesa(e.target.value)}
          placeholder="M8"
          maxLength={6}
          className="w-20 rounded-lg border border-chipi-border bg-chipi-bg px-2 py-1 text-xs text-text-primary placeholder:text-text-dim"
        />
        <button
          onClick={() => { if (newMesa) { startSession(newMesa); setNewMesa(''); } }}
          className="rounded-lg border border-neon-green/40 bg-neon-green/10 px-3 py-1 text-xs font-semibold text-neon-green hover:bg-neon-green/20"
        >
          Iniciar atención
        </button>
        <button
          onClick={() => startSession('M1')}
          className="rounded-lg border border-neon-cyan/30 bg-neon-cyan/10 px-3 py-1 text-xs text-neon-cyan hover:bg-neon-cyan/20"
        >
          Simular llegada M1
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-neon-rose/40 bg-neon-rose/10 p-3 text-xs text-neon-rose">
          {error}
        </div>
      )}

      {sessions.length === 0 && !loading && (
        <div className="rounded-lg border border-chipi-border bg-chipi-card/30 p-6 text-center text-sm text-text-dim">
          No hay sesiones recientes. Uchino está disponible para atender.
        </div>
      )}

      {sessions.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-chipi-border">
          <table className="w-full text-xs">
            <thead className="bg-chipi-card">
              <tr>
                <th className="p-3 text-left text-text-secondary font-semibold">Sesión</th>
                <th className="p-3 text-left text-text-secondary font-semibold">Robot</th>
                <th className="p-3 text-left text-text-secondary font-semibold">Mesa</th>
                <th className="p-3 text-left text-text-secondary font-semibold">Inicio</th>
                <th className="p-3 text-left text-text-secondary font-semibold">Estado</th>
                <th className="p-3 text-left text-text-secondary font-semibold">Modo</th>
                <th className="p-3 text-left text-text-secondary font-semibold">Cierre</th>
                <th className="p-3 text-left text-text-secondary font-semibold">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map(s => (
                <tr key={s.session_id} className="border-t border-chipi-border hover:bg-chipi-card/50">
                  <td className="p-3 font-mono text-neon-cyan max-w-32 truncate" title={s.session_id}>
                    {s.session_id}
                  </td>
                  <td className="p-3 text-text-secondary">{s.robot_id || 'uchino-01'}</td>
                  <td className="p-3 font-semibold">{s.mesa || '—'}</td>
                  <td className="p-3 text-text-dim">{s.last_activity_at ? timeAgo(s.last_activity_at) : '—'}</td>
                  <td className="p-3">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor(s.session_status) }} />
                      {s.session_status || 'unknown'}
                    </span>
                  </td>
                  <td className="p-3 text-text-dim">{s.interaction_mode || '—'}</td>
                  <td className="p-3 text-text-dim">{s.close_reason || '—'}</td>
                  <td className="p-3">
                    <div className="flex gap-1.5 flex-wrap">
                      {!['closed', 'expired'].includes(s.session_status) ? (
                        <>
                          <button
                            onClick={() => sessionAction(`${API}/${s.session_id}/close`, { reason: 'admin_closed', source: 'admin' })}
                            className="rounded border border-neon-rose/40 bg-neon-rose/10 px-2 py-0.5 text-[10px] font-semibold text-neon-rose hover:bg-neon-rose/20"
                          >
                            Cerrar
                          </button>
                          <button
                            onClick={() => sessionAction(`${API}/${s.session_id}/release-robot`, { reason: 'admin_released' })}
                            className="rounded border border-neon-amber/40 bg-neon-amber/10 px-2 py-0.5 text-[10px] text-neon-amber hover:bg-neon-amber/20"
                          >
                            Liberar
                          </button>
                        </>
                      ) : (
                        <span className="text-[10px] text-text-dim">Histórica</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {sessions.length === 0 && loading && (
        <div className="text-center text-text-dim text-xs py-4">Cargando sesiones...</div>
      )}

      <div className="rounded-lg border border-chipi-border bg-chipi-card/50 p-3 text-xs text-text-secondary flex items-center gap-2 flex-wrap">
        <span>Estados:</span>
        {['active', 'initializing', 'completing', 'closed', 'expired'].map(st => (
          <span key={st} className="inline-flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor(st) }} />
            {st}
          </span>
        ))}
        <span className="ml-auto">
          {sessions.length > 0 ? `${activeCount} activa(s) · ${sessions.length} reciente(s)` : 'Sin sesiones recientes'}
        </span>
      </div>
    </div>
  );
}
