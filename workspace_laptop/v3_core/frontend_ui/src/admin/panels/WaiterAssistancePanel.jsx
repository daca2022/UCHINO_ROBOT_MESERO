import { useCallback, useEffect, useState } from 'react';

function formatDate(value) {
  if (!value) return 'Sin fecha';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Sin fecha';
  return new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export default function WaiterAssistancePanel({ token, liveEvent }) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [attendingId, setAttendingId] = useState(null);

  const loadRequests = useCallback(async () => {
    if (!token) {
      setLoading(false);
      setError('Inicia sesión de Admin para ver las solicitudes.');
      return;
    }
    try {
      const response = await fetch('/api/admin/waiter-requests?status=all', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setRequests(Array.isArray(body.data) ? body.data : []);
      setError(null);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void loadRequests();
    const timer = setInterval(() => { void loadRequests(); }, 5000);
    return () => clearInterval(timer);
  }, [loadRequests]);

  useEffect(() => {
    if (liveEvent?.type === 'waiter_assistance') void loadRequests();
  }, [liveEvent, loadRequests]);

  async function markAttended(request) {
    setAttendingId(request.request_id);
    try {
      const response = await fetch(`/api/admin/waiter-requests/${encodeURIComponent(request.request_id)}/attend`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setRequests(current => current.map(item => item.request_id === request.request_id ? body.request : item));
      setError(null);
    } catch (markError) {
      setError(markError.message);
    } finally {
      setAttendingId(null);
    }
  }

  const pendingCount = requests.filter(request => request.status === 'pending').length;

  return (
    <section className="space-y-5" aria-label="Solicitudes de mesero">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-wider text-neon-amber font-semibold">Atención humana</p>
          <h2 className="text-xl font-bold text-text-primary">Solicitudes de mesero</h2>
          <p className="mt-1 text-sm text-text-secondary">Canal operativo separado de Cocina. Las solicitudes no crean ni confirman pedidos.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="min-h-10 rounded-xl border border-neon-amber/40 bg-neon-amber/10 px-3 py-2 text-sm font-semibold text-neon-amber">Pendientes: {pendingCount}</span>
          <button onClick={() => void loadRequests()} className="min-h-10 rounded-xl border border-chipi-border px-3 py-2 text-sm font-semibold text-text-secondary hover:text-text-primary">Actualizar</button>
        </div>
      </div>

      {error && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neon-rose/40 bg-neon-rose/10 px-4 py-3 text-xs text-neon-rose" role="alert">
          <span>{error}</span>
          <button onClick={() => void loadRequests()} className="rounded-lg border border-neon-rose/40 px-2 py-1 font-semibold">Reintentar</button>
        </div>
      )}

      <div className="glass overflow-x-auto rounded-2xl border border-chipi-border">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-chipi-border text-left text-xs uppercase tracking-wider text-text-secondary">
              <th className="p-4">Mesa</th>
              <th className="p-4">Hora</th>
              <th className="p-4">Sesión</th>
              <th className="p-4">Origen</th>
              <th className="p-4">Estado</th>
              <th className="p-4">Acción</th>
            </tr>
          </thead>
          <tbody>
            {requests.map(request => (
              <tr key={request.request_id} className="border-b border-chipi-border last:border-0 hover:bg-chipi-card/60">
                <td className="p-4 font-semibold text-neon-cyan">{request.mesa}</td>
                <td className="p-4 whitespace-nowrap text-sm text-text-secondary">{formatDate(request.timestamp)}</td>
                <td className="p-4 font-mono text-xs text-text-secondary">{request.session_id}</td>
                <td className="p-4 text-sm text-text-secondary">{request.origin || 'robot'}</td>
                <td className="p-4">
                  <span className={`rounded-lg border px-2.5 py-1 text-[10px] font-bold ${request.status === 'pending' ? 'border-neon-amber/40 bg-neon-amber/10 text-neon-amber' : 'border-neon-green/40 bg-neon-green/10 text-neon-green'}`}>
                    {request.status === 'pending' ? 'Pendiente' : 'Atendida'}
                  </span>
                </td>
                <td className="p-4">
                  {request.status === 'pending' ? (
                    <button
                      onClick={() => void markAttended(request)}
                      disabled={attendingId === request.request_id}
                      className="min-h-10 rounded-lg border border-neon-green/40 bg-neon-green/10 px-3 py-2 text-xs font-bold text-neon-green disabled:opacity-50"
                    >
                      {attendingId === request.request_id ? 'Guardando...' : 'Marcar atendida'}
                    </button>
                  ) : <span className="text-xs text-text-secondary">Cerrada</span>}
                </td>
              </tr>
            ))}
            {!loading && requests.length === 0 && (
              <tr><td colSpan={6} className="p-10 text-center text-xs text-text-dim">No hay solicitudes registradas.</td></tr>
            )}
            {loading && (
              <tr><td colSpan={6} className="p-10 text-center text-xs text-text-secondary">Cargando solicitudes...</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
