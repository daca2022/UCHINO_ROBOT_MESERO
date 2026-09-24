import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const STATUS_CONFIG = {
  available: { label: 'Disponible', color: '#10B981', bg: '#10B98118' },
  occupied: { label: 'Ocupada', color: '#F59E0B', bg: '#F59E0B18' },
  ordering: { label: 'Tomando pedido', color: '#22D3EE', bg: '#22D3EE18' },
  order_confirmed: { label: 'Pedido confirmado', color: '#A855F7', bg: '#A855F718' },
  preparing: { label: 'Preparando', color: '#F59E0B', bg: '#F59E0B18' },
  ready: { label: 'Listo', color: '#10B981', bg: '#10B98118' },
  delivery_in_progress: { label: 'Entrega en curso', color: '#60A5FA', bg: '#60A5FA18' },
  served: { label: 'Atendida', color: '#60A5FA', bg: '#60A5FA18' },
  closed: { label: 'Cerrada', color: '#64748B', bg: '#64748B18' },
};

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' });
}

function statusConfig(status) {
  return STATUS_CONFIG[status] || { label: status || 'Sin estado', color: '#94A3B8', bg: '#94A3B818' };
}

function shortId(value) {
  return value ? String(value).slice(0, 8) : '—';
}

export default function TablesPanel({ token, liveEvent }) {
  const [tables, setTables] = useState([]);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);
  const [history, setHistory] = useState(null);
  const [waiterRequests, setWaiterRequests] = useState([]);
  const [tableFilter, setTableFilter] = useState('all');
  const [alertsOnly, setAlertsOnly] = useState(false);
  const lastVersionsRef = useRef(new Map());

  const headers = useMemo(() => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  }), [token]);

  const loadTables = useCallback(async (silent = false) => {
    if (!token) return;
    if (!silent) setLoading(true);
    try {
      const response = await fetch('/api/admin/tables', { headers });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      const nextTables = body.data || [];
      setTables(nextTables);
      nextTables.forEach(table => {
        const version = Number(table.version || 0);
        if (version > (lastVersionsRef.current.get(table.table_id) || 0)) {
          lastVersionsRef.current.set(table.table_id, version);
        }
      });
      setConfig(body.config || null);
      setError(null);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [headers, token]);

  const loadWaiterRequests = useCallback(async () => {
    if (!token) return;
    try {
      const response = await fetch('/api/admin/waiter-requests?status=pending', { headers });
      const body = await response.json().catch(() => ({}));
      if (response.ok) setWaiterRequests(body.data || []);
    } catch {
      setWaiterRequests([]);
    }
  }, [headers, token]);

  useEffect(() => {
    loadTables();
    loadWaiterRequests();
    const timer = setInterval(() => loadTables(true), 5000);
    const waiterTimer = setInterval(loadWaiterRequests, 5000);
    return () => {
      clearInterval(timer);
      clearInterval(waiterTimer);
    };
  }, [loadTables, loadWaiterRequests]);

  useEffect(() => {
    if (liveEvent?.type === 'waiter_assistance' || liveEvent?.type === 'waiter_assistance_updated') {
      loadWaiterRequests();
      loadTables(true);
      return;
    }
    if (!(liveEvent?.type?.startsWith('table_') || liveEvent?.type === 'additional_order_started')) return;
    const tableId = liveEvent.table_id || liveEvent.table?.table_id;
    const incomingVersion = Number(liveEvent.version || liveEvent.table?.version || 0);
    const previousVersion = tableId ? (lastVersionsRef.current.get(tableId) || 0) : 0;
    if (tableId && incomingVersion > 0 && incomingVersion <= previousVersion) return;
    if (tableId && incomingVersion > 0) lastVersionsRef.current.set(tableId, incomingVersion);
    loadTables(true);
  }, [liveEvent, loadTables, loadWaiterRequests]);

  async function request(url, method = 'POST', body = undefined) {
    const response = await fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const blockers = Array.isArray(payload.blockers) && payload.blockers.length > 0
        ? ` Bloqueos: ${payload.blockers.map(item => item.status || item.id || item.session_id).join(', ')}.`
        : '';
      throw new Error(`${payload.error || `HTTP ${response.status}`}${blockers}`);
    }
    return payload;
  }

  async function runAction(table, action) {
    const visitId = table.current_visit_id || table.visit?.visit_id;
    if (['continue', 'additional', 'close'].includes(action) && !visitId) return;
    setBusyId(table.table_id);
    setError(null);
    setMessage(null);
    try {
      if (action === 'start') {
        await request(`/api/admin/tables/${table.table_id}/visits/start`, 'POST', { robot_id: 'uchino-01', source: 'admin' });
        setMessage(`${table.table_id}: atención iniciada.`);
      } else if (action === 'arrival') {
        await request(`/api/admin/tables/${table.table_id}/visits/start`, 'POST', { robot_id: 'uchino-01', source: 'robot_arrival' });
        setMessage(`${table.table_id}: llegada del robot simulada.`);
      } else if (action === 'continue') {
        await request(`/api/admin/tables/${table.table_id}/visits/${visitId}/continue`, 'POST', { robot_id: 'uchino-01' });
        setMessage(`${table.table_id}: visita continuada.`);
      } else if (action === 'additional') {
        await request(`/api/admin/tables/${table.table_id}/visits/additional`, 'POST', { robot_id: 'uchino-01' });
        setMessage(`${table.table_id}: nuevo pedido adicional iniciado.`);
      } else if (action === 'close') {
        await request(`/api/admin/tables/${table.table_id}/visits/${visitId}/close`, 'POST', { reason: 'admin_closed' });
        setMessage(`${table.table_id}: visita cerrada y mesa liberada.`);
      } else if (action === 'force-close') {
        const reason = window.prompt('Motivo obligatorio para el cierre forzado:');
        if (!reason?.trim()) return;
        if (!window.confirm(`Confirmar cierre forzado de ${table.table_id}?`)) return;
        await request(`/api/admin/tables/${table.table_id}/visits/${visitId}/force-close`, 'POST', {
          confirmation: true,
          reason: reason.trim(),
        });
        setMessage(`${table.table_id}: visita cerrada de forma forzada.`);
      } else if (action === 'disable') {
        await request(`/api/admin/tables/${table.table_id}`, 'PATCH', { enabled: false });
        setMessage(`${table.table_id}: mesa deshabilitada.`);
      } else if (action === 'enable') {
        await request(`/api/admin/tables/${table.table_id}`, 'PATCH', { enabled: true });
        setMessage(`${table.table_id}: mesa habilitada.`);
      } else if (action === 'rename') {
        const displayName = window.prompt('Nombre visible de la mesa:', table.display_name || `Mesa ${table.table_id}`);
        if (!displayName?.trim()) return;
        await request(`/api/admin/tables/${table.table_id}`, 'PATCH', { display_name: displayName.trim() });
        setMessage(`${table.table_id}: nombre actualizado.`);
      }
      await loadTables(true);
    } catch (actionError) {
      setError(`${table.table_id}: ${actionError.message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function updateGuestCount(table, value) {
    const visitId = table.current_visit_id || table.visit?.visit_id;
    if (!visitId || !value) return;
    setBusyId(table.table_id);
    try {
      await request(`/api/admin/tables/${table.table_id}/visits/${visitId}/guest-count`, 'PATCH', { guest_count: Number(value) });
      setMessage(`${table.table_id}: cantidad de comensales actualizada.`);
      await loadTables(true);
    } catch (actionError) {
      setError(`${table.table_id}: ${actionError.message}`);
    } finally {
      setBusyId(null);
    }
  }

  async function loadHistory(tableId, offset = 0) {
    try {
      const body = await request(`/api/admin/tables/${tableId}/history?limit=10&offset=${Math.max(0, offset)}`, 'GET');
      setHistory({ tableId, visits: body.data || [], total: Number(body.total || 0), limit: Number(body.limit || 10), offset: Number(body.offset || 0), has_more: Boolean(body.has_more) });
    } catch (historyError) {
      setError(`${tableId}: ${historyError.message}`);
    }
  }

  async function toggleAutoRelease() {
    const enabled = !Boolean(config?.auto_release_after_delivery);
    try {
      await request('/api/admin/tables/config/auto-release', 'PATCH', { enabled });
      setConfig(current => ({ ...current, auto_release_after_delivery: enabled }));
      setMessage(`Liberación automática después de entrega: ${enabled ? 'activada' : 'desactivada'}.`);
    } catch (actionError) {
      setError(actionError.message);
    }
  }

  const activeCount = tables.filter(table => table.status !== 'available' && table.enabled).length;
  const availableCount = tables.filter(table => table.status === 'available' && table.enabled).length;
  const filteredTables = useMemo(() => tables.filter(table => {
    const matchesFilter = tableFilter === 'all'
      || (tableFilter === 'occupied' && table.status !== 'available')
      || (tableFilter === 'alerts' && table.waiter_assistance_pending)
      || table.status === tableFilter;
    return matchesFilter && (!alertsOnly || table.waiter_assistance_pending);
  }), [alertsOnly, tableFilter, tables]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-text-primary">Mesas y ocupación</h2>
          <p className="mt-1 text-xs text-text-secondary">Una visita agrupa pedidos relacionados sin fusionar sus órdenes.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-lg border border-neon-green/30 bg-neon-green/10 px-3 py-2 text-neon-green">Disponibles: {availableCount}</span>
          <span className="rounded-lg border border-neon-amber/30 bg-neon-amber/10 px-3 py-2 text-neon-amber">Ocupadas: {activeCount}</span>
          <button onClick={() => loadTables()} disabled={loading} className="rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-2 font-semibold text-neon-cyan disabled:opacity-50">
            {loading ? 'Cargando...' : 'Actualizar'}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-chipi-border bg-chipi-card/50 p-3 text-xs">
        <span className="text-text-secondary">Liberar mesa automáticamente al completar la entrega simulada</span>
        <button
          onClick={toggleAutoRelease}
          className={`rounded-lg border px-3 py-1.5 font-semibold ${config?.auto_release_after_delivery ? 'border-neon-green/50 bg-neon-green/10 text-neon-green' : 'border-chipi-border bg-chipi-bg text-text-secondary'}`}
        >
          {config?.auto_release_after_delivery ? 'Activado' : 'Desactivado'}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-chipi-border bg-chipi-card/50 p-3 text-xs">
        <label className="flex items-center gap-2 text-text-secondary">
          <span>Filtrar mesas</span>
          <select value={tableFilter} onChange={event => setTableFilter(event.target.value)} className="rounded-lg border border-chipi-border bg-chipi-bg px-2 py-1.5 text-text-primary">
            <option value="all">Todas</option>
            <option value="available">Disponibles</option>
            <option value="occupied">Ocupadas</option>
            <option value="preparing">Preparando</option>
            <option value="ready">Listas</option>
            <option value="delivery_in_progress">Entrega</option>
            <option value="served">Servidas</option>
            <option value="alerts">Con alertas</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-text-secondary">
          <input type="checkbox" checked={alertsOnly} onChange={event => setAlertsOnly(event.target.checked)} />
          Solo solicitudes de mesero
        </label>
        <span className="text-text-dim">{filteredTables.length} de {tables.length} mesas</span>
      </div>

      {message && <div className="rounded-xl border border-neon-green/35 bg-neon-green/10 px-4 py-3 text-xs font-semibold text-neon-green" role="status">{message}</div>}
      {error && <div className="rounded-xl border border-neon-rose/40 bg-neon-rose/10 px-4 py-3 text-xs text-neon-rose" role="alert">{error}</div>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {filteredTables.map(table => {
          const cfg = statusConfig(table.status);
          const visit = table.visit;
          const busy = busyId === table.table_id;
          const hasVisit = Boolean(table.current_visit_id || visit?.visit_id);
          return (
            <article key={table.table_id} className="glass rounded-2xl border border-chipi-border p-4" style={{ boxShadow: `inset 0 1px 0 ${cfg.color}22` }}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xl font-bold neon-text-cyan">{table.table_id}</span>
                    {!table.enabled && <span className="rounded px-1.5 py-0.5 text-[9px] font-bold text-text-dim border border-chipi-border">DESHABILITADA</span>}
                  </div>
                  <div className="mt-1 text-[10px] text-text-dim">{table.display_name || `Mesa ${table.table_id}`}</div>
                </div>
                <span className="inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[10px] font-bold" style={{ color: cfg.color, background: cfg.bg, borderColor: `${cfg.color}55` }}>
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: cfg.color }} />
                  {cfg.label}
                </span>
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-2 text-[10px]">
                <div><dt className="text-text-dim">Visita</dt><dd className="font-mono text-text-secondary">{shortId(visit?.visit_id || table.current_visit_id)}</dd></div>
                <div><dt className="text-text-dim">Pedidos activos</dt><dd className="font-semibold text-text-primary">{table.active_order_count ?? table.active_order_ids?.length ?? 0}</dd></div>
                <div><dt className="text-text-dim">Entregados</dt><dd className="font-semibold text-text-secondary">{table.delivered_order_count ?? 0}</dd></div>
                <div><dt className="text-text-dim">Sesiones</dt><dd className="font-mono text-text-secondary">{table.session_count ?? visit?.session_ids?.length ?? 0} · {shortId(table.active_session_id)}</dd></div>
                <div><dt className="text-text-dim">Apertura</dt><dd className="text-text-secondary">{formatDate(table.opened_at || visit?.opened_at)}</dd></div>
                <div><dt className="text-text-dim">Última actividad</dt><dd className="text-text-secondary">{formatDate(table.last_activity_at)}</dd></div>
                <div><dt className="text-text-dim">Entrega</dt><dd className="text-text-secondary">{table.delivery_in_progress || table.status === 'delivery_in_progress' ? 'En curso' : '—'}</dd></div>
              </dl>

              {table.waiter_assistance_pending && (
                <div className="mt-3 rounded-lg border border-neon-amber/40 bg-neon-amber/10 px-2 py-1.5 text-[10px] font-semibold text-neon-amber">
                  Solicitud de mesero pendiente ({waiterRequests.filter(request => request.mesa === table.table_id).length})
                </div>
              )}

              {hasVisit && (
                <label className="mt-4 flex items-center justify-between gap-2 text-[10px] text-text-secondary">
                  <span>Comensales</span>
                  <input
                    type="number"
                    min="1"
                    max="99"
                    defaultValue={visit?.guest_count || ''}
                    onBlur={event => updateGuestCount(table, event.target.value)}
                    className="w-16 rounded-lg border border-chipi-border bg-chipi-bg px-2 py-1 text-center text-xs text-text-primary outline-none focus:border-neon-cyan"
                  />
                </label>
              )}

              <div className="mt-4 flex flex-wrap gap-2">
                {table.enabled && table.status === 'available' && (
                  <>
                    <button onClick={() => runAction(table, 'start')} disabled={busy} className="rounded-lg border border-neon-green/40 bg-neon-green/10 px-2.5 py-2 text-[10px] font-bold text-neon-green disabled:opacity-50">Iniciar atención</button>
                    <button onClick={() => runAction(table, 'arrival')} disabled={busy} className="rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-2.5 py-2 text-[10px] font-bold text-neon-cyan disabled:opacity-50">Simular llegada</button>
                  </>
                )}
                {table.enabled && hasVisit && (
                  <>
                    <button onClick={() => runAction(table, 'continue')} disabled={busy} className="rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-2.5 py-2 text-[10px] font-bold text-neon-cyan disabled:opacity-50">Continuar visita</button>
                    <button onClick={() => runAction(table, 'additional')} disabled={busy} className="rounded-lg border border-neon-purple/40 bg-neon-purple/10 px-2.5 py-2 text-[10px] font-bold text-neon-purple disabled:opacity-50">Pedido adicional</button>
                    <button onClick={() => runAction(table, 'close')} disabled={busy} className="rounded-lg border border-chipi-border bg-chipi-bg px-2.5 py-2 text-[10px] font-bold text-text-secondary disabled:opacity-50">Cerrar visita</button>
                    <button onClick={() => runAction(table, 'force-close')} disabled={busy} className="rounded-lg border border-neon-rose/35 bg-neon-rose/10 px-2.5 py-2 text-[10px] font-bold text-neon-rose disabled:opacity-50">Forzar cierre</button>
                  </>
                )}
                <button onClick={() => loadHistory(table.table_id)} className="rounded-lg border border-chipi-border bg-chipi-bg px-2.5 py-2 text-[10px] font-semibold text-text-dim">Historial</button>
                <button onClick={() => runAction(table, 'rename')} disabled={busy} className="rounded-lg border border-chipi-border bg-chipi-bg px-2.5 py-2 text-[10px] font-semibold text-text-dim disabled:opacity-50">Renombrar</button>
                {table.enabled && !hasVisit && table.status === 'available' && <button onClick={() => runAction(table, 'disable')} disabled={busy} className="rounded-lg border border-chipi-border bg-chipi-bg px-2.5 py-2 text-[10px] font-semibold text-text-dim disabled:opacity-50">Deshabilitar</button>}
                {!table.enabled && <button onClick={() => runAction(table, 'enable')} disabled={busy} className="rounded-lg border border-neon-green/35 bg-neon-green/10 px-2.5 py-2 text-[10px] font-semibold text-neon-green disabled:opacity-50">Habilitar</button>}
              </div>
            </article>
          );
        })}
      </div>

      {history && (
        <section className="glass rounded-2xl border border-chipi-border p-4" aria-label={`Historial de ${history.tableId}`}>
          <div className="mb-3 flex items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-bold text-text-primary">Historial de {history.tableId}</h3>
              <p className="mt-1 text-[10px] text-text-dim">{history.total} visita(s) · página {Math.floor(history.offset / history.limit) + 1}</p>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => loadHistory(history.tableId, history.offset - history.limit)} disabled={history.offset === 0} className="text-xs text-text-dim underline disabled:opacity-40">Anterior</button>
              <button onClick={() => loadHistory(history.tableId, history.offset + history.limit)} disabled={!history.has_more} className="text-xs text-text-dim underline disabled:opacity-40">Siguiente</button>
              <button onClick={() => setHistory(null)} className="text-xs text-text-dim underline">Cerrar</button>
            </div>
          </div>
          {history.visits.length === 0 ? <p className="text-xs text-text-dim">No hay visitas registradas.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-xs">
                <thead><tr className="border-b border-chipi-border text-left text-text-dim"><th className="p-2">Visita</th><th className="p-2">Apertura</th><th className="p-2">Cierre</th><th className="p-2">Pedidos</th><th className="p-2">Motivo</th></tr></thead>
                <tbody>{history.visits.map(visit => <tr key={visit.visit_id} className="border-b border-chipi-border/70"><td className="p-2 font-mono text-neon-cyan">{shortId(visit.visit_id)}</td><td className="p-2 text-text-secondary">{formatDate(visit.opened_at)}</td><td className="p-2 text-text-secondary">{formatDate(visit.closed_at)}</td><td className="p-2 text-text-secondary">{visit.order_ids?.length || 0}</td><td className="p-2 text-text-dim">{visit.close_reason || 'Activa'}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
