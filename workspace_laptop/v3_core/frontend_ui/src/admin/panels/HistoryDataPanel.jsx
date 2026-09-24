import { useCallback, useEffect, useMemo, useState } from 'react';

const VIEW_TABS = [
  ['active', 'Activos'],
  ['history', 'Historial'],
  ['archived', 'Archivados'],
  ['test', 'Datos de prueba'],
  ['retention', 'Retención'],
  ['exports', 'Exportaciones'],
  ['audit', 'Auditoría'],
];

const STATUS_OPTIONS = [
  ['', 'Todos los estados'],
  ['draft', 'Borrador'],
  ['sent_to_kitchen', 'En cocina'],
  ['confirmed', 'Confirmado'],
  ['preparing', 'Preparando'],
  ['ready', 'Listo'],
  ['delivered', 'Entregado'],
  ['cancelled', 'Cancelado'],
];

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function money(value) {
  return `S/ ${Number(value || 0).toFixed(2)}`;
}

function statusLabel(value) {
  return {
    draft: 'Borrador', sent_to_kitchen: 'En cocina', confirmed: 'Confirmado', preparing: 'Preparando',
    ready: 'Listo', delivered: 'Entregado', cancelled: 'Cancelado', closed: 'Cerrado',
  }[value] || value || '—';
}

function statusClass(value) {
  if (['delivered', 'ready'].includes(value)) return 'border-neon-green/40 bg-neon-green/10 text-neon-green';
  if (['preparing', 'sent_to_kitchen', 'confirmed'].includes(value)) return 'border-neon-amber/40 bg-neon-amber/10 text-neon-amber';
  if (['cancelled'].includes(value)) return 'border-slate-500/40 bg-slate-500/10 text-slate-300';
  return 'border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan';
}

function productsSummary(order) {
  return (order.productos || []).map(item => `${item.nombre || 'Producto'} ×${item.cantidad || 1}`).join(', ') || 'Sin productos';
}

export default function HistoryDataPanel({ token, liveEvent = null }) {
  const [tab, setTab] = useState('active');
  const [filters, setFilters] = useState({ date_preset: '', date_from: '', date_to: '', status: '', table: '', order_kind: '', archived: '', is_test: '', search: '', sort: 'newest', page_size: '25' });
  const [page, setPage] = useState(1);
  const [orders, setOrders] = useState({ items: [], pagination: { page: 1, page_size: 25, total_items: 0, total_pages: 0 } });
  const [audit, setAudit] = useState({ items: [], pagination: { page: 1, page_size: 25, total_items: 0, total_pages: 0 } });
  const [policy, setPolicy] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [retentionSaving, setRetentionSaving] = useState(false);
  const [visitDetails, setVisitDetails] = useState(null);
  const [exportView, setExportView] = useState('history');

  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const request = useCallback(async (url, options = {}) => {
    const response = await fetch(url, {
      ...options,
      headers: { ...authHeaders, ...(options.headers || {}) },
    });
    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('json') ? await response.json().catch(() => ({})) : await response.text();
    if (!response.ok) throw new Error(body?.error || body?.message || `HTTP ${response.status}`);
    return body;
  }, [authHeaders]);

  const orderView = ['active', 'history', 'archived', 'test'].includes(tab);

  const loadOrders = useCallback(async () => {
    if (!token || !orderView) return;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ view: tab, page: String(page), page_size: String(filters.page_size), sort: filters.sort });
      for (const [key, value] of Object.entries(filters)) {
        if (value && !['page_size', 'sort'].includes(key)) params.set(key, value);
      }
      const data = await request(`/api/admin/orders?${params.toString()}`);
      setOrders(data);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }, [filters, page, request, tab, token, orderView]);

  const loadAudit = useCallback(async () => {
    if (!token || tab !== 'audit') return;
    setLoading(true);
    setError('');
    try {
      setAudit(await request(`/api/admin/orders/audit?page=${page}&page_size=${filters.page_size}`));
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  }, [filters.page_size, page, request, tab, token]);

  const loadPolicy = useCallback(async () => {
    if (!token || tab !== 'retention') return;
    try { setPolicy(await request('/api/admin/retention/policy')); } catch (loadError) { setError(loadError.message); }
  }, [request, tab, token]);

  useEffect(() => { loadOrders(); }, [loadOrders]);
  useEffect(() => { loadAudit(); }, [loadAudit]);
  useEffect(() => { loadPolicy(); }, [loadPolicy]);

  useEffect(() => {
    if (!liveEvent || !['history_updated', 'order_archived', 'order_unarchived', 'order_deleted', 'retention_job_completed', 'test_data_cleanup_completed'].includes(liveEvent.type || liveEvent.event)) return undefined;
    const timer = setTimeout(() => {
      if (orderView) loadOrders();
      if (tab === 'audit') loadAudit();
    }, 250);
    return () => clearTimeout(timer);
  }, [liveEvent, loadAudit, loadOrders, orderView, tab]);

  function changeTab(nextTab) {
    setTab(nextTab);
    setPage(1);
    setError('');
    setActionError('');
    setPreview(null);
    setVisitDetails(null);
  }

  function changeFilter(key, value) {
    setFilters(current => ({ ...current, [key]: value }));
    setPage(1);
  }

  async function orderAction(order, action) {
    const isArchive = action === 'archive';
    const question = isArchive ? '¿Archivar este pedido? Se conservarán todos sus datos.' : '¿Borrar definitivamente este dato permitido? Esta operación no es reversible.';
    if (!window.confirm(question)) return;
    const reason = window.prompt('Indica el motivo de la operación:', isArchive ? 'retención administrativa' : 'fixture abandonado');
    if (!reason?.trim()) return;
    setBusyId(order.id);
    setActionError('');
    try {
      const endpoint = isArchive ? `/api/admin/orders/${encodeURIComponent(order.id)}/archive` : `/api/admin/orders/${encodeURIComponent(order.id)}`;
      await request(endpoint, {
        method: isArchive ? 'POST' : 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, confirm: true }),
      });
      await loadOrders();
    } catch (operationError) {
      setActionError(operationError.message);
    } finally {
      setBusyId('');
    }
  }

  async function unarchive(order) {
    if (!window.confirm('¿Desarchivar este pedido para devolverlo al historial?')) return;
    const reason = window.prompt('Motivo del desarchivado:', 'revisión administrativa');
    if (!reason?.trim()) return;
    setBusyId(order.id);
    try {
      await request(`/api/admin/orders/${encodeURIComponent(order.id)}/unarchive`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }),
      });
      await loadOrders();
    } catch (operationError) { setActionError(operationError.message); }
    finally { setBusyId(''); }
  }

  async function generatePreview(kind = 'test') {
    setPreviewBusy(true);
    setActionError('');
    try {
      setPreview(await request(kind === 'test' ? '/api/admin/test-data/preview' : '/api/admin/retention/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind }),
      }));
    } catch (previewError) { setActionError(previewError.message); }
    finally { setPreviewBusy(false); }
  }

  async function executePreview() {
    if (!preview || !window.confirm(`¿Ejecutar limpieza sobre ${preview.summary?.count || 0} registros?`)) return;
    const reason = window.prompt('Motivo de limpieza:', preview.kind === 'test' ? 'limpieza de datos de prueba' : 'mantenimiento administrativo');
    if (!reason?.trim()) return;
    setPreviewBusy(true);
    try {
      const result = await request(preview.kind === 'test' ? '/api/admin/test-data/cleanup' : '/api/admin/retention/execute', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preview_token: preview.preview_token, confirm: true, reason }),
      });
      setPreview({ ...preview, executed: result });
      await loadOrders();
    } catch (executeError) { setActionError(executeError.message); }
    finally { setPreviewBusy(false); }
  }

  async function savePolicy() {
    setRetentionSaving(true);
    setActionError('');
    try {
      setPolicy(await request('/api/admin/retention/policy', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(policy),
      }));
    } catch (saveError) { setActionError(saveError.message); }
    finally { setRetentionSaving(false); }
  }

  async function exportOrders(format = 'csv') {
    try {
      const params = new URLSearchParams({ view: exportView, format, sort: filters.sort, page: '1', page_size: String(filters.page_size) });
      for (const [key, value] of Object.entries(filters)) if (value && !['page_size', 'sort'].includes(key)) params.set(key, value);
      const response = await fetch(`/api/admin/orders/export?${params.toString()}`, { headers: authHeaders });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = format === 'csv' ? 'uchino-pedidos.csv' : 'uchino-pedidos.json';
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (exportError) { setActionError(exportError.message); }
  }

  async function showVisit(visitId) {
    if (!visitId) return;
    try { setVisitDetails(await request(`/api/admin/visits/${encodeURIComponent(visitId)}/history?page=1&page_size=10`)); }
    catch (visitError) { setActionError(visitError.message); }
  }

  const pagination = tab === 'audit' ? audit.pagination : orders.pagination;
  const visibleItems = tab === 'audit' ? audit.items : orders.items;

  return (
    <section className="space-y-4" aria-label="Historial y datos administrativos">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.24em] text-neon-cyan">Control de datos</p>
          <h2 className="mt-1 text-xl font-bold text-text-primary">Historial y datos</h2>
          <p className="mt-1 max-w-3xl text-xs text-text-dim">Consultas paginadas desde PostgreSQL. Archivar conserva la trazabilidad; borrar requiere una regla explícita y confirmación.</p>
        </div>
        <span className="rounded-full border border-neon-green/30 bg-neon-green/10 px-3 py-1 text-[10px] font-semibold text-neon-green">Sin carga masiva</span>
      </div>

      <div className="flex gap-2 overflow-x-auto border-b border-chipi-border pb-2">
        {VIEW_TABS.map(([id, label]) => (
          <button key={id} type="button" onClick={() => changeTab(id)} className={`whitespace-nowrap rounded-xl border px-3 py-2 text-xs font-semibold transition-colors ${tab === id ? 'nav-active' : 'border-transparent text-text-secondary hover:border-chipi-border hover:text-text-primary'}`}>
            {label}
          </button>
        ))}
      </div>

      {orderView && (
        <div className="glass rounded-2xl border border-chipi-border p-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-6">
            <label className="text-[10px] text-text-dim">Período
              <select value={filters.date_preset} onChange={event => changeFilter('date_preset', event.target.value)} className="mt-1 w-full rounded-lg border border-chipi-border bg-chipi-bg px-2 py-2 text-xs text-text-primary">
                <option value="">Cualquier fecha</option><option value="today">Hoy</option><option value="yesterday">Ayer</option><option value="last7">Últimos 7 días</option><option value="current_month">Mes actual</option><option value="current_year">Año actual</option>
              </select>
            </label>
            <label className="text-[10px] text-text-dim">Estado
              <select value={filters.status} onChange={event => changeFilter('status', event.target.value)} className="mt-1 w-full rounded-lg border border-chipi-border bg-chipi-bg px-2 py-2 text-xs text-text-primary">
                {STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="text-[10px] text-text-dim">Tipo de pedido
              <select value={filters.order_kind} onChange={event => changeFilter('order_kind', event.target.value)} className="mt-1 w-full rounded-lg border border-chipi-border bg-chipi-bg px-2 py-2 text-xs text-text-primary">
                <option value="">Inicial y adicional</option><option value="initial">Inicial</option><option value="additional">Adicional</option>
              </select>
            </label>
            <label className="text-[10px] text-text-dim">Mesa
              <input value={filters.table} onChange={event => changeFilter('table', event.target.value)} placeholder="M8" maxLength={5} className="mt-1 w-full rounded-lg border border-chipi-border bg-chipi-bg px-2 py-2 text-xs text-text-primary" />
            </label>
            <label className="text-[10px] text-text-dim md:col-span-2 xl:col-span-2">Buscar pedido, producto, visita u observación
              <input value={filters.search} onChange={event => changeFilter('search', event.target.value)} placeholder="ID, ceviche, visit_id…" className="mt-1 w-full rounded-lg border border-chipi-border bg-chipi-bg px-2 py-2 text-xs text-text-primary" />
            </label>
            <label className="text-[10px] text-text-dim">Orden
              <select value={filters.sort} onChange={event => changeFilter('sort', event.target.value)} className="mt-1 w-full rounded-lg border border-chipi-border bg-chipi-bg px-2 py-2 text-xs text-text-primary">
                <option value="newest">Más recientes</option><option value="oldest">Más antiguos</option><option value="total">Total</option><option value="table">Mesa</option><option value="status">Estado</option><option value="confirmed">Confirmación</option><option value="delivered">Entrega</option>
              </select>
            </label>
            <label className="text-[10px] text-text-dim">Archivado
              <select value={filters.archived} onChange={event => changeFilter('archived', event.target.value)} className="mt-1 w-full rounded-lg border border-chipi-border bg-chipi-bg px-2 py-2 text-xs text-text-primary">
                <option value="">Según vista</option><option value="false">No archivado</option><option value="true">Archivado</option>
              </select>
            </label>
            <label className="text-[10px] text-text-dim">Origen de datos
              <select value={filters.is_test} onChange={event => changeFilter('is_test', event.target.value)} className="mt-1 w-full rounded-lg border border-chipi-border bg-chipi-bg px-2 py-2 text-xs text-text-primary">
                <option value="">Reales y prueba</option><option value="false">Solo reales</option><option value="true">Solo prueba</option>
              </select>
            </label>
            <label className="text-[10px] text-text-dim">Desde
              <input type="date" value={filters.date_from} onChange={event => changeFilter('date_from', event.target.value)} className="mt-1 w-full rounded-lg border border-chipi-border bg-chipi-bg px-2 py-2 text-xs text-text-primary" />
            </label>
            <label className="text-[10px] text-text-dim">Hasta
              <input type="date" value={filters.date_to} onChange={event => changeFilter('date_to', event.target.value)} className="mt-1 w-full rounded-lg border border-chipi-border bg-chipi-bg px-2 py-2 text-xs text-text-primary" />
            </label>
          </div>
        </div>
      )}

      {actionError && <div role="alert" className="rounded-xl border border-neon-rose/40 bg-neon-rose/10 px-4 py-3 text-xs text-neon-rose">{actionError}</div>}
      {error && <div role="alert" className="rounded-xl border border-neon-rose/40 bg-neon-rose/10 px-4 py-3 text-xs text-neon-rose">No se pudo cargar el historial: {error}</div>}

      {orderView && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-text-secondary">
            <span>{loading ? 'Cargando página…' : `${pagination.total_items || 0} resultados · página ${pagination.page || page} de ${pagination.total_pages || 0}`}</span>
            <div className="flex items-center gap-2">
              <label>Tamaño <select value={filters.page_size} onChange={event => changeFilter('page_size', event.target.value)} className="ml-1 rounded-lg border border-chipi-border bg-chipi-bg px-2 py-1 text-xs text-text-primary"><option value="10">10</option><option value="25">25</option><option value="50">50</option><option value="100">100</option></select></label>
              <button type="button" disabled={page <= 1 || loading} onClick={() => setPage(value => Math.max(1, value - 1))} className="rounded-lg border border-chipi-border px-3 py-1.5 disabled:opacity-40">Anterior</button>
              <button type="button" disabled={!pagination.has_next || loading} onClick={() => setPage(value => value + 1)} className="rounded-lg border border-chipi-border px-3 py-1.5 disabled:opacity-40">Siguiente</button>
            </div>
          </div>
          <div className="glass overflow-x-auto rounded-2xl border border-chipi-border">
            <table className="w-full min-w-[980px] text-xs">
              <thead><tr className="border-b border-chipi-border text-left text-[10px] uppercase tracking-wider text-text-dim"><th className="p-3">Fecha</th><th className="p-3">Mesa / visita</th><th className="p-3">Pedido</th><th className="p-3">Total</th><th className="p-3">Estado</th><th className="p-3">Origen</th><th className="p-3">Acciones</th></tr></thead>
              <tbody>
                {visibleItems.map(order => (
                  <tr key={order.id} className="border-b border-chipi-border/60 align-top hover:bg-chipi-card/60">
                    <td className="whitespace-nowrap p-3 text-text-secondary">{formatDate(order.created_at)}</td>
                    <td className="p-3"><strong className="text-neon-cyan">{order.table_id || '—'}</strong><br />{order.visit_id ? <button type="button" onClick={() => showVisit(order.visit_id)} className="mt-1 max-w-[150px] truncate text-[10px] text-text-dim underline">{order.visit_id}</button> : <span className="text-[10px] text-text-dim">Sin visita</span>}</td>
                    <td className="max-w-[300px] p-3 text-text-secondary">{productsSummary(order)}<br /><span className="font-mono text-[10px] text-text-dim">{String(order.id).slice(0, 8)}…</span></td>
                    <td className="whitespace-nowrap p-3 font-mono font-semibold text-neon-amber">{money(order.total)}</td>
                    <td className="p-3"><span className={`inline-flex rounded-lg border px-2 py-1 text-[10px] font-semibold ${statusClass(order.status)}`}>{statusLabel(order.status)}</span>{order.archived_at && <span className="mt-1 block text-[10px] text-text-dim">Archivado {formatDate(order.archived_at)}</span>}</td>
                    <td className="p-3 text-text-secondary">{order.is_test ? <span className="rounded-md border border-neon-rose/30 bg-neon-rose/10 px-2 py-1 text-[10px] text-neon-rose">TEST</span> : order.data_origin || 'customer_order'}</td>
                    <td className="p-3">
                      <div className="flex flex-wrap gap-1.5">
                        {order.can_archive && <button type="button" disabled={busyId === order.id} onClick={() => orderAction(order, 'archive')} className="rounded-lg border border-neon-amber/40 px-2 py-1 text-[10px] text-neon-amber disabled:opacity-40">Archivar</button>}
                        {order.archived_at && <button type="button" disabled={busyId === order.id} onClick={() => unarchive(order)} className="rounded-lg border border-neon-cyan/40 px-2 py-1 text-[10px] text-neon-cyan disabled:opacity-40">Desarchivar</button>}
                        {order.can_delete && <button type="button" disabled={busyId === order.id} onClick={() => orderAction(order, 'delete')} className="rounded-lg border border-neon-rose/40 px-2 py-1 text-[10px] text-neon-rose disabled:opacity-40">Borrar permitido</button>}
                        {!order.can_archive && !order.archived_at && !order.can_delete && <span className="text-[10px] text-text-dim">Protegido</span>}
                      </div>
                    </td>
                  </tr>
                ))}
                {!loading && visibleItems.length === 0 && <tr><td colSpan={7} className="p-10 text-center text-text-dim">No hay registros para estos filtros.</td></tr>}
              </tbody>
            </table>
          </div>
          {visitDetails && <div className="glass rounded-2xl border border-neon-cyan/30 p-4"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold text-neon-cyan">Visita {visitDetails.visit?.visit_id}</h3><button type="button" onClick={() => setVisitDetails(null)} className="text-xs text-text-dim underline">Cerrar</button></div><p className="mt-2 text-xs text-text-secondary">{visitDetails.visit?.table_id} · {visitDetails.visit?.status} · abierta {formatDate(visitDetails.visit?.opened_at)} · cerrada {formatDate(visitDetails.visit?.closed_at)}</p><p className="mt-2 text-xs text-text-secondary">{visitDetails.summary?.order_count || 0} pedidos · iniciales {visitDetails.summary?.initial_count || 0} · adicionales {visitDetails.summary?.additional_count || 0} · entregados {visitDetails.summary?.delivered_count || 0} · total {money(visitDetails.summary?.total_amount)}</p><p className="mt-2 text-xs text-text-dim">Los pedidos vinculados se consultan con paginación; no se carga la visita completa de una sola vez.</p></div>}
        </>
      )}

      {tab === 'test' && <div className="glass rounded-2xl border border-neon-rose/30 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-sm font-semibold text-neon-rose">Limpieza de datos de prueba</h3><p className="mt-1 text-xs text-text-dim">Solo se consideran registros etiquetados is_test=true. Los datos sin etiqueta permanecen protegidos.</p></div><button type="button" onClick={() => generatePreview('test')} disabled={previewBusy} className="rounded-xl border border-neon-rose/40 px-3 py-2 text-xs font-semibold text-neon-rose disabled:opacity-40">{previewBusy ? 'Calculando…' : 'Previsualizar limpieza'}</button></div>{preview && preview.kind === 'test' && <PreviewCard preview={preview} onExecute={executePreview} busy={previewBusy} />}</div>}

      {tab === 'retention' && <RetentionPanel policy={policy} onChange={setPolicy} onSave={savePolicy} onPreview={() => generatePreview('maintenance')} onExecute={executePreview} preview={preview} saving={retentionSaving} busy={previewBusy} />}

      {tab === 'exports' && <div className="glass rounded-2xl border border-neon-cyan/30 p-5"><h3 className="text-sm font-semibold text-neon-cyan">Exportaciones seguras</h3><p className="mt-1 max-w-2xl text-xs text-text-dim">La exportación respeta los filtros, vista, orden y rango de fechas seleccionados. Excluye perfiles, sesiones, tokens, prompts y alergias personales. El backend limita el máximo a 5.000 filas.</p><label className="mt-4 block max-w-xs text-[10px] text-text-dim">Vista a exportar<select value={exportView} onChange={event => setExportView(event.target.value)} className="mt-1 w-full rounded-lg border border-chipi-border bg-chipi-bg px-2 py-2 text-xs text-text-primary"><option value="active">Activos</option><option value="history">Historial</option><option value="archived">Archivados</option><option value="test">Datos de prueba</option><option value="all">Todo permitido</option></select></label><div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={() => exportOrders('csv')} className="rounded-xl border border-neon-cyan/40 px-4 py-2 text-xs font-semibold text-neon-cyan">Descargar CSV</button><button type="button" onClick={() => exportOrders('json')} className="rounded-xl border border-chipi-border px-4 py-2 text-xs text-text-secondary">Descargar JSON técnico</button></div></div>}

      {tab === 'audit' && <div className="glass overflow-x-auto rounded-2xl border border-chipi-border"><div className="flex items-center justify-between border-b border-chipi-border p-4"><div><h3 className="text-sm font-semibold text-text-primary">Auditoría de historial</h3><p className="mt-1 text-[10px] text-text-dim">Acciones administrativas, motivos y resultados. También se consulta por páginas.</p></div><span className="text-xs text-text-secondary">{pagination.total_items || 0} eventos</span></div><table className="w-full min-w-[760px] text-xs"><thead><tr className="border-b border-chipi-border text-left text-[10px] uppercase tracking-wider text-text-dim"><th className="p-3">Fecha</th><th className="p-3">Evento</th><th className="p-3">Actor</th><th className="p-3">Pedido</th><th className="p-3">Resultado / motivo</th></tr></thead><tbody>{audit.items.map(event => <tr key={event.id} className="border-b border-chipi-border/60"><td className="p-3 text-text-secondary">{formatDate(event.timestamp)}</td><td className="p-3 text-neon-cyan">{event.event}</td><td className="p-3">{event.actor}</td><td className="p-3 font-mono text-[10px]">{event.order_id || '—'}</td><td className="max-w-[360px] p-3 text-text-dim">{event.metadata?.reason || event.metadata?.result || '—'}</td></tr>)}{!loading && audit.items.length === 0 && <tr><td colSpan={5} className="p-10 text-center text-text-dim">No hay auditoría de historial todavía.</td></tr>}</tbody></table><div className="flex justify-end gap-2 p-3"><button type="button" disabled={page <= 1 || loading} onClick={() => setPage(value => Math.max(1, value - 1))} className="rounded-lg border border-chipi-border px-3 py-1.5 text-xs disabled:opacity-40">Anterior</button><button type="button" disabled={!pagination.total_pages || page >= pagination.total_pages || loading} onClick={() => setPage(value => value + 1)} className="rounded-lg border border-chipi-border px-3 py-1.5 text-xs disabled:opacity-40">Siguiente</button></div></div>}
    </section>
  );
}

function PreviewCard({ preview, onExecute, busy }) {
  const summary = preview.summary || {};
  return <div className="mt-4 rounded-xl border border-neon-amber/30 bg-neon-amber/5 p-4"><div className="grid grid-cols-2 gap-3 text-xs md:grid-cols-4"><div><span className="block text-[10px] text-text-dim">Registros afectados</span><strong className="text-neon-amber">{summary.count || 0}</strong><span className="block text-[10px] text-text-dim">pedidos: {summary.order_count || 0}</span></div><div><span className="block text-[10px] text-text-dim">Estados</span><span>{Object.entries(summary.by_status || {}).map(([key, value]) => `${key}: ${value}`).join(' · ') || '—'}</span></div><div><span className="block text-[10px] text-text-dim">Fechas</span><span>{formatDate(summary.date_range?.from)} → {formatDate(summary.date_range?.to)}</span></div><div><span className="block text-[10px] text-text-dim">Dependencias</span><span>visitas {summary.dependencies?.visits || 0} · perfiles {summary.dependencies?.profiles || 0} · eventos {summary.dependencies?.events || 0}</span></div></div><p className="mt-3 text-[10px] text-text-dim">Tipos: pedidos {summary.data_types?.orders || 0}, visitas {summary.data_types?.visits || 0}, perfiles {summary.data_types?.profiles || 0}, eventos {summary.data_types?.events || 0}. La operación es {summary.reversible ? 'reversible (archivado)' : 'irreversible (borrado)'}. Auditoría: conservar {summary.audit_retention?.policy_days || '—'} días, candidatos informativos {summary.audit_retention?.candidate_count || 0}; no se borran automáticamente. Las relaciones se vuelven a comprobar al ejecutar.</p>{preview.executed ? <p className="mt-3 text-xs text-neon-green">Ejecutado: {JSON.stringify(preview.executed)}</p> : <><p className="mt-3 text-[10px] text-text-dim">Token válido hasta {preview.expires_at ? new Date(preview.expires_at).toLocaleString('es-PE') : '—'}. Si cambia un candidato, una dependencia o la política, el backend rechazará la ejecución.</p><button type="button" onClick={onExecute} disabled={busy || !summary.count} className="mt-3 rounded-xl border border-neon-rose/40 px-3 py-2 text-xs font-semibold text-neon-rose disabled:opacity-40">Confirmar limpieza</button></>}</div>;
}

function RetentionPanel({ policy, onChange, onSave, onPreview, onExecute, preview, saving, busy }) {
  if (!policy) return <div className="glass rounded-2xl border border-chipi-border p-5 text-xs text-text-dim">Cargando política centralizada…</div>;
  const field = (key, label) => <label className="text-[10px] text-text-dim">{label}<input type="number" min="0" value={policy[key] ?? 0} onChange={event => onChange({ ...policy, [key]: Number(event.target.value) })} className="mt-1 w-full rounded-lg border border-chipi-border bg-chipi-bg px-2 py-2 text-xs text-text-primary" /></label>;
  return <div className="space-y-4"><div className="glass rounded-2xl border border-neon-amber/30 p-5"><h3 className="text-sm font-semibold text-neon-amber">Política de retención</h3><p className="mt-1 text-xs text-text-dim">Los valores se guardan, pero no ejecutan limpieza automáticamente. El borrado automático de históricos reales permanece desactivado.</p><div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5">{field('draft_hours', 'Drafts (horas)')}{field('test_hours', 'Tests (horas)')}{field('delivered_days', 'Entregados (días)')}{field('cancelled_days', 'Cancelados (días)')}{field('audit_days', 'Auditoría (días)')}</div><div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={onSave} disabled={saving} className="rounded-xl border border-neon-green/40 px-4 py-2 text-xs font-semibold text-neon-green disabled:opacity-40">{saving ? 'Guardando…' : 'Guardar política'}</button><button type="button" onClick={onPreview} disabled={busy} className="rounded-xl border border-neon-amber/40 px-4 py-2 text-xs text-neon-amber disabled:opacity-40">Previsualizar mantenimiento</button></div>{preview?.kind === 'maintenance' && <PreviewCard preview={preview} onExecute={onExecute} busy={busy} />}</div></div>;
}
