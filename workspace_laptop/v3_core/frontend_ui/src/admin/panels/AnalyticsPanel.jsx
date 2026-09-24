import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const SECTIONS = [
  ['overview', 'Resumen'],
  ['sales', 'Ventas'],
  ['products', 'Productos'],
  ['tables', 'Mesas'],
  ['operations', 'Cocina'],
  ['delivery', 'Entrega'],
  ['hri', 'HRI / PLN'],
  ['latency', 'Latencia'],
  ['services', 'Servicios'],
  ['data-quality', 'Calidad'],
];

const PERIODS = [
  ['today', 'Hoy'],
  ['yesterday', 'Ayer'],
  ['last7', 'Últimos 7 días'],
  ['last30', 'Últimos 30 días'],
  ['current_week', 'Semana actual'],
  ['current_month', 'Mes actual'],
  ['current_year', 'Año actual'],
];

function money(value) {
  return value === null || value === undefined ? '—' : `S/ ${Number(value).toFixed(2)}`;
}

function integer(value) {
  return value === null || value === undefined ? '—' : Number(value).toLocaleString('es-PE');
}

function percent(value) {
  return value === null || value === undefined ? '—' : `${(Number(value) * 100).toFixed(1)}%`;
}

function dateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'medium' });
}

function statusLabel(status) {
  const labels = {
    ok: 'Datos suficientes',
    no_data: 'Sin datos en el período',
    insufficient_data: 'Instrumentación insuficiente',
    issues_found: 'Revisar calidad',
    current_snapshot: 'Snapshot actual',
  };
  return labels[status] || status || '—';
}

function statusClass(status) {
  if (status === 'ok' || status === 'current_snapshot') return 'border-neon-green/30 bg-neon-green/10 text-neon-green';
  if (status === 'issues_found') return 'border-neon-amber/40 bg-neon-amber/10 text-neon-amber';
  return 'border-neon-cyan/30 bg-neon-cyan/10 text-neon-cyan';
}

function MetaStrip({ payload }) {
  const filters = payload?.filters || {};
  const period = filters.period || {};
  const sample = payload?.sample_size ?? payload?.coverage?.orders?.total ?? payload?.sessions?.started;
  const status = payload?.data_status || payload?.status;
  return (
    <div className="flex flex-wrap items-center gap-2 text-[10px] text-text-dim">
      <span className={`rounded-full border px-2 py-1 ${statusClass(status)}`}>{statusLabel(status)}</span>
      <span>Fuente: {payload?.source || '—'}</span>
      <span>Zona: {filters.timezone || '—'}</span>
      <span>Período: {period.from_local || '—'} → {period.to_local_exclusive || '—'}</span>
      <span>Muestra: {sample === undefined ? '—' : integer(sample)}</span>
      {payload?.trace_id && <span className="font-mono">traza {payload.trace_id.slice(0, 8)}</span>}
    </div>
  );
}

function Limitations({ payload }) {
  if (!Array.isArray(payload?.limitations) || payload.limitations.length === 0) return null;
  return (
    <div className="rounded-xl border border-neon-amber/30 bg-neon-amber/5 px-3 py-2 text-[11px] text-neon-amber">
      <span className="font-semibold">Limitaciones:</span> {payload.limitations.join(' · ')}
    </div>
  );
}

function Metric({ label, value, detail }) {
  return (
    <div className="rounded-xl border border-chipi-border bg-chipi-card/60 p-3">
      <div className="text-[10px] uppercase tracking-wider text-text-dim">{label}</div>
      <div className="mt-1 text-xl font-bold font-mono text-neon-cyan">{value}</div>
      {detail && <div className="mt-1 text-[10px] text-text-dim">{detail}</div>}
    </div>
  );
}

function DataTable({ columns, rows, empty = 'Sin datos reales para mostrar.' }) {
  if (!Array.isArray(rows) || rows.length === 0) return <div className="rounded-xl border border-dashed border-chipi-border p-6 text-center text-xs text-text-dim">{empty}</div>;
  return (
    <div className="overflow-x-auto rounded-xl border border-chipi-border">
      <table className="w-full min-w-[560px] text-xs">
        <thead>
          <tr className="border-b border-chipi-border text-left text-[10px] uppercase tracking-wider text-text-dim">
            {columns.map(([key, label]) => <th key={key} className="p-3">{label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.id || row.product_id || row.table_id || row.event || index}`} className="border-b border-chipi-border/60 last:border-0">
              {columns.map(([key, _label, formatter]) => <td key={key} className="p-3 text-text-secondary">{formatter ? formatter(row[key], row) : (row[key] ?? '—')}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OverviewSection({ data }) {
  const sales = data?.sales || {};
  const tables = data?.tables || {};
  const hri = data?.hri || {};
  const delivery = data?.delivery || {};
  const noSalesData = data?.data_status === 'no_data';
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <Metric label="Ventas válidas" value={noSalesData ? '—' : money(sales.sales_total)} detail={noSalesData ? 'Sin pedidos en el período' : `${integer(sales.valid_orders)} pedidos`} />
        <Metric label="Ticket promedio" value={noSalesData ? '—' : money(sales.average_ticket)} detail="Solo pedidos válidos" />
        <Metric label="Ocupación actual" value={percent(tables.occupancy_rate)} detail={`${integer(tables.occupied_tables)} / ${integer(tables.enabled_tables)} mesas · snapshot actual`} />
        <Metric label="Cierre de sesiones" value={percent(hri.completion_rate)} detail={`${integer(hri.closed)} cerradas de ${integer(hri.started)}`} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="rounded-xl border border-chipi-border bg-chipi-card/40 p-4">
          <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-text-secondary">Productos más solicitados</h3>
          <DataTable columns={[
            ['product_name', 'Producto'],
            ['category', 'Categoría'],
            ['units', 'Unidades', integer],
            ['revenue', 'Venta', money],
          ]} rows={data?.top_products} />
        </section>
        <section className="rounded-xl border border-chipi-border bg-chipi-card/40 p-4">
          <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-text-secondary">Entrega y operación</h3>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <Metric label="Simulada" value={integer(delivery.simulated?.count)} detail="eventos persistidos" />
            <Metric label="Física" value={integer(delivery.real?.count)} detail={delivery.real?.available ? 'disponible' : 'no disponible'} />
          </div>
          {delivery.unverified?.count > 0 && <p className="mt-2 text-[11px] text-neon-amber">{integer(delivery.unverified.count)} eventos sin origen explícito no se cuentan como entrega física.</p>}
          <p className="mt-3 text-[11px] text-text-dim">Los datos de entrega se mantienen separados por modo. La ausencia de bridge ROS 2 físico no se convierte en una cifra sintética.</p>
        </section>
      </div>
    </div>
  );
}

function SectionContent({ section, data }) {
  if (!data) return null;
  if (section === 'overview') return <OverviewSection data={data} />;
  if (section === 'sales') return (
    <div className="space-y-4">
      {data.data_status === 'no_data' && <div className="rounded-xl border border-dashed border-chipi-border p-4 text-xs text-text-dim">No hay pedidos válidos en el período seleccionado; no se reemplazan por datos simulados.</div>}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <Metric label="Pedidos válidos" value={data.data_status === 'no_data' ? '—' : integer(data.kpis?.valid_orders)} />
        <Metric label="Ventas" value={data.data_status === 'no_data' ? '—' : money(data.kpis?.sales_total)} />
        <Metric label="Ticket promedio" value={data.data_status === 'no_data' ? '—' : money(data.kpis?.average_ticket)} />
        <Metric label="Adicionales" value={data.data_status === 'no_data' ? '—' : percent(data.kpis?.additional_order_rate)} detail={data.data_status === 'no_data' ? 'Sin datos' : `${integer(data.kpis?.additional_orders)} pedidos`} />
      </div>
      <DataTable columns={[
        ['bucket', 'Intervalo'],
        ['valid_orders', 'Pedidos', integer],
        ['sales_total', 'Ventas', money],
      ]} rows={data.series} />
      <div className="text-xs text-text-dim">Comparación anterior: {money(data.comparison?.sales_total)} · Variación: {percent(data.comparison?.sales_delta_rate)}</div>
    </div>
  );
  if (section === 'products') return (
    <div className="space-y-4">
      <DataTable columns={[
        ['product_name', 'Producto'],
        ['category', 'Categoría'],
        ['units', 'Unidades', integer],
        ['revenue', 'Venta', money],
        ['line_count', 'Líneas', integer],
      ]} rows={data.products} />
      <DataTable columns={[
        ['category', 'Categoría'],
        ['units', 'Unidades', integer],
        ['revenue', 'Venta', money],
        ['product_count', 'Productos', integer],
      ]} rows={data.categories} empty="Sin categorías agregadas en este período." />
    </div>
  );
  if (section === 'tables') return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <Metric label="Habilitadas" value={integer(data.snapshot?.enabled_tables)} />
        <Metric label="Ocupadas" value={integer(data.snapshot?.occupied_tables)} />
        <Metric label="Disponibles" value={integer(data.snapshot?.available_tables)} />
        <Metric label="Ocupación actual" value={percent(data.snapshot?.occupancy_rate)} detail="Snapshot actual; independiente del período" />
      </div>
      <DataTable columns={[
        ['table_id', 'Mesa'],
        ['visits', 'Visitas', integer],
        ['closed_visits', 'Cerradas', integer],
        ['guest_count', 'Comensales', integer],
        ['average_duration_seconds', 'Duración (s)', (value) => value === null ? '—' : Number(value).toFixed(1)],
      ]} rows={data.visits} />
    </div>
  );
  if (section === 'operations') return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <Metric label="Enviados a Cocina" value={integer(data.kitchen?.sent_to_kitchen)} />
        <Metric label="Preparando" value={integer(data.kitchen?.preparing)} />
        <Metric label="Listos" value={integer(data.kitchen?.ready)} />
        <Metric label="Latencia Cocina" value={data.latency?.p50_ms === null ? '—' : `${Number(data.latency.p50_ms).toFixed(0)} ms`} detail={statusLabel(data.latency?.status)} />
      </div>
      <DataTable columns={[['status', 'Estado'], ['count', 'Pedidos', integer]]} rows={data.order_statuses} />
      <DataTable columns={[['event', 'Evento'], ['count', 'Registros', integer]]} rows={data.kitchen?.stage_events} empty="No hay eventos de etapa persistidos." />
    </div>
  );
  if (section === 'delivery') return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <Metric label="Simulada" value={integer(data.mode?.simulated?.count)} detail="Disponible para demostración" />
        <Metric label="Real" value={integer(data.mode?.real?.count)} detail={data.mode?.real?.available ? 'Publicador activo' : 'Bridge no disponible'} />
      </div>
      {data.mode?.unverified?.count > 0 && <p className="text-[11px] text-neon-amber">{integer(data.mode.unverified.count)} eventos quedaron como no verificados y no se cuentan como reales.</p>}
      <DataTable columns={[
        ['delivery_mode', 'Modo'],
        ['event', 'Evento'],
        ['count', 'Registros', integer],
      ]} rows={[...(data.mode?.simulated?.events || []), ...(data.mode?.real?.events || [])]} />
    </div>
  );
  if (section === 'hri') return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <Metric label="Sesiones iniciadas" value={integer(data.sessions?.started)} />
        <Metric label="Sesiones cerradas" value={integer(data.sessions?.closed)} />
        <Metric label="Recuperadas" value={integer(data.sessions?.recovered)} />
        <Metric label="Ambigüedades" value={integer(data.navigation?.ambiguous_references)} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <DataTable columns={[['mode', 'Modo'], ['count', 'Selecciones', integer]]} rows={data.interaction_modes} empty="No hay selección de modo instrumentada." />
        <DataTable columns={[['event', 'Evento HRI'], ['count', 'Eventos', integer], ['sessions', 'Sesiones', integer]]} rows={data.event_counts} />
      </div>
    </div>
  );
  if (section === 'latency') return (
    <div className="space-y-4">
      <DataTable columns={[
        ['metric', 'Métrica'],
        ['value', 'Estado / muestra', (value) => `${statusLabel(value?.status)} · n=${integer(value?.sample_size)}`],
        ['p50', 'P50', (_value, row) => row.value?.p50_ms === null ? '—' : `${Number(row.value.p50_ms).toFixed(1)} ms`],
        ['p95', 'P95', (_value, row) => row.value?.p95_ms === null ? '—' : `${Number(row.value.p95_ms).toFixed(1)} ms`],
      ]} rows={Object.entries(data.metrics || {}).map(([metric, envelope]) => ({ metric, value: envelope.value, p50: envelope.value?.p50_ms, p95: envelope.value?.p95_ms }))} />
      <p className="text-[11px] text-text-dim">P50/P95 solo aparecen con al menos cinco pares de eventos válidos. No se muestran ceros cuando no existe instrumentación.</p>
    </div>
  );
  if (section === 'services') return (
    <div className="space-y-4">
      <DataTable columns={[
        ['service', 'Servicio'],
        ['state', 'Estado'],
        ['detail', 'Detalle'],
      ]} rows={Object.entries(data.current || {}).flatMap(([service, state]) => [{ service, state: typeof state === 'object' ? (state.status || state.available === false ? 'degraded' : 'available') : String(state), detail: typeof state === 'object' ? JSON.stringify(state) : '' }])} />
      <Limitations payload={data} />
    </div>
  );
  if (section === 'data-quality') return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <Metric label="Pedidos revisados" value={integer(data.coverage?.orders?.total)} />
        <Metric label="Eventos revisados" value={integer(data.coverage?.events?.total)} />
        <Metric label="Órdenes huérfanas" value={integer(data.issues?.find((issue) => issue.key === 'orphan_events')?.count)} />
        <Metric label="Cobertura temporal" value={data.issues?.some((issue) => issue.count > 0) ? 'Revisar' : 'OK'} />
      </div>
      <DataTable columns={[
        ['key', 'Control'],
        ['count', 'Casos', integer],
        ['severity', 'Severidad'],
      ]} rows={data.issues} />
      <DataTable columns={[['event', 'Evento instrumentado'], ['count', 'Registros', integer]]} rows={Object.entries(data.instrumentation_coverage || {}).map(([event, count]) => ({ event, count }))} empty="No hay eventos de latencia o recepción instrumentados." />
    </div>
  );
  return <div className="text-xs text-text-dim">Panel no disponible.</div>;
}

export default function AnalyticsPanel({ token }) {
  const [section, setSection] = useState('overview');
  const [period, setPeriod] = useState('last30');
  const [timezone, setTimezone] = useState('America/Lima');
  const [tableId, setTableId] = useState('');
  const [category, setCategory] = useState('');
  const [interactionMode, setInteractionMode] = useState('');
  const [deliveryMode, setDeliveryMode] = useState('all');
  const [data, setData] = useState(null);
  const [dictionary, setDictionary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const requestControllerRef = useRef(null);

  const query = useMemo(() => {
    const params = new URLSearchParams({ period, timezone, delivery_mode: deliveryMode });
    if (refreshNonce > 0) params.set('refresh', 'true');
    if (tableId) params.set('table_id', tableId);
    if (category) params.set('category', category);
    if (interactionMode) params.set('interaction_mode', interactionMode);
    if (section === 'sales') params.set('granularity', 'day');
    return params.toString();
  }, [period, timezone, tableId, category, interactionMode, deliveryMode, section, refreshNonce]);

  const load = useCallback(async () => {
    if (!token) return;
    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    setLoading(true);
    setError(null);
    const endpoint = section === 'data-quality' ? 'data-quality' : section;
    try {
      const response = await fetch(`/api/admin/analytics/${endpoint}?${query}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setData(body);
    } catch (requestError) {
      if (requestError.name === 'AbortError') return;
      setError(requestError.message);
      setData(null);
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
        setLoading(false);
      }
    }
  }, [token, section, query]);

  useEffect(() => {
    load();
    return () => requestControllerRef.current?.abort();
  }, [load]);

  useEffect(() => {
    if (!token || dictionary) return;
    fetch('/api/admin/analytics/dictionary', { headers: { Authorization: `Bearer ${token}` } })
      .then((response) => response.ok ? response.json() : null)
      .then((body) => setDictionary(body))
      .catch(() => {});
  }, [token, dictionary]);

  async function exportData(format) {
    if (!token) return;
    setExporting(true);
    try {
      const response = await fetch(`/api/admin/analytics/export?dataset=${encodeURIComponent(section)}&format=${format}&${query}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `uchino-analytics-${section}.${format}`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      setError(`No se pudo exportar: ${exportError.message}`);
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-4">
      <header className="glass rounded-2xl border border-neon-cyan/30 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-neon-cyan">Analítica real</h2>
            <p className="mt-1 max-w-3xl text-xs text-text-secondary">Agregados consultados desde PostgreSQL. Los pedidos de prueba se excluyen por defecto; una ausencia de instrumentación se muestra como tal.</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setRefreshNonce((value) => value + 1)} disabled={loading} className="rounded-lg border border-chipi-border px-3 py-2 text-xs text-text-secondary hover:text-text-primary disabled:opacity-50">Actualizar</button>
            <button onClick={() => exportData('json')} disabled={exporting || loading} className="rounded-lg border border-chipi-border px-3 py-2 text-xs text-text-secondary hover:text-text-primary disabled:opacity-50">JSON</button>
            <button onClick={() => exportData('csv')} disabled={exporting || loading} className="rounded-lg border border-neon-cyan/40 px-3 py-2 text-xs text-neon-cyan hover:bg-neon-cyan/10 disabled:opacity-50">CSV</button>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-6">
          <label className="text-[10px] text-text-dim">Período<select value={period} onChange={(event) => setPeriod(event.target.value)} className="mt-1 w-full rounded-lg border border-chipi-border bg-chipi-bg px-2 py-2 text-xs text-text-primary"><option value="today">Hoy</option>{PERIODS.slice(1).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="text-[10px] text-text-dim">Zona horaria<select value={timezone} onChange={(event) => setTimezone(event.target.value)} className="mt-1 w-full rounded-lg border border-chipi-border bg-chipi-bg px-2 py-2 text-xs text-text-primary"><option value="America/Lima">America/Lima</option><option value="UTC">UTC</option></select></label>
          <label className="text-[10px] text-text-dim">Mesa<select value={tableId} onChange={(event) => setTableId(event.target.value)} className="mt-1 w-full rounded-lg border border-chipi-border bg-chipi-bg px-2 py-2 text-xs text-text-primary"><option value="">Todas</option>{Array.from({ length: 12 }, (_, index) => `M${index + 1}`).map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          <label className="text-[10px] text-text-dim">Categoría<select value={category} onChange={(event) => setCategory(event.target.value)} className="mt-1 w-full rounded-lg border border-chipi-border bg-chipi-bg px-2 py-2 text-xs text-text-primary"><option value="">Todas</option><option value="plato">Platos</option><option value="bebida">Bebidas</option><option value="postre">Postres</option></select></label>
          <label className="text-[10px] text-text-dim">Modo interacción<select value={interactionMode} onChange={(event) => setInteractionMode(event.target.value)} className="mt-1 w-full rounded-lg border border-chipi-border bg-chipi-bg px-2 py-2 text-xs text-text-primary"><option value="">Todos</option><option value="voice">Voz</option><option value="screen">Pantalla</option><option value="human_waiter">Mesero</option><option value="tablet">Tableta</option></select></label>
          <label className="text-[10px] text-text-dim">Entrega<select value={deliveryMode} onChange={(event) => setDeliveryMode(event.target.value)} className="mt-1 w-full rounded-lg border border-chipi-border bg-chipi-bg px-2 py-2 text-xs text-text-primary"><option value="all">Todas</option><option value="simulated">Simulada</option><option value="real">Real</option></select></label>
        </div>
      </header>

      <nav className="flex gap-2 overflow-x-auto rounded-xl border border-chipi-border p-2" aria-label="Secciones de analítica">
        {SECTIONS.map(([value, label]) => <button key={value} onClick={() => setSection(value)} className={`whitespace-nowrap rounded-lg px-3 py-2 text-xs font-semibold ${section === value ? 'nav-active' : 'text-text-secondary hover:text-text-primary'}`}>{label}</button>)}
      </nav>

      {error && <div className="flex items-center justify-between gap-3 rounded-xl border border-neon-rose/30 bg-neon-rose/10 px-3 py-2 text-xs text-neon-rose" role="alert"><span>{error}</span><button onClick={load} className="underline">Reintentar</button></div>}
      {loading && <div className="rounded-xl border border-neon-cyan/30 bg-neon-cyan/5 px-3 py-2 text-xs text-neon-cyan">Consultando agregados reales…</div>}
      {data && <MetaStrip payload={data} />}
      {data && <Limitations payload={data} />}
      {data && <SectionContent section={section} data={data} />}
      {!loading && !data && !error && <div className="rounded-xl border border-dashed border-chipi-border p-8 text-center text-xs text-text-dim">No hay datos disponibles para esta consulta.</div>}

      {dictionary?.metrics && (
        <details className="rounded-xl border border-chipi-border bg-chipi-card/30 p-3">
          <summary className="cursor-pointer text-xs font-semibold text-text-secondary">Diccionario y fórmulas</summary>
          <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
            {Object.values(dictionary.metrics).slice(0, 8).map((metric) => <div key={metric.key} className="rounded-lg border border-chipi-border p-2 text-[10px] text-text-dim"><span className="font-semibold text-text-secondary">{metric.label}</span> · {metric.formula} · fuente: {metric.source}</div>)}
          </div>
        </details>
      )}
    </div>
  );
}
