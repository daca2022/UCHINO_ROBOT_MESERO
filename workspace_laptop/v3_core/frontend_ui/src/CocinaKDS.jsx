import { useState, useEffect, useMemo } from 'react';
import { useWebSocket, useApi } from './hooks.js';
import { useAuth } from './admin/AuthContext.jsx';

const ESTADOS = [
  { key: 'espera', label: 'En espera', color: '#F43F5E', bg: '#F43F5E20', glow: '0 0 15px #F43F5E60, 0 0 30px #F43F5E20' },
  { key: 'preparando', label: 'Preparando', color: '#F59E0B', bg: '#F59E0B20', glow: '0 0 15px #F59E0B60, 0 0 30px #F59E0B20' },
  { key: 'listo', label: 'Listo', color: '#10B981', bg: '#10B98120', glow: '0 0 15px #10B98160, 0 0 30px #10B98120' },
];

const ESTADO_FLOW = ['espera', 'preparando', 'listo'];

export default function CocinaKDS() {
  const { token, login } = useAuth();
  const [orders, setOrders] = useState([]);
  const [filter, setFilter] = useState('todos');
  const [sort, setSort] = useState('oldest');
  const [clock, setClock] = useState(new Date());
  const [pendingActions, setPendingActions] = useState(() => new Set());
  const [actionError, setActionError] = useState('');
  const [kitchenUser, setKitchenUser] = useState('');
  const [kitchenPassword, setKitchenPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const ws = useWebSocket('/ws/ui', token);
  const cola = useApi('/api/cocina/cola', {
    interval: 5000,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!cola.data) return;
    const enviados = (cola.data.enviados || []).map(o => kitchenOrder(o, 'espera'));
    const enPrep = (cola.data.en_preparacion || []).map(o => kitchenOrder(o, 'preparando'));
    const listos = (cola.data.listos || []).map(o => kitchenOrder(o, 'listo'));
    const apiOrders = [...enviados, ...enPrep, ...listos];
    setOrders(apiOrders);
  }, [cola.data]);

  useEffect(() => {
    if (!ws.data) return;
    if (ws.data.type === 'nuevo_pedido') {
      const o = ws.data.pedido;
      setOrders(prev => {
        if (prev.find(p => p.id === o.id)) return prev;
        const estadoNormalizado = normalizarEstado(o.status || o.estado);
        return [kitchenOrder(o, estadoNormalizado), ...prev];
      });
    }
    if (ws.data.type === 'pedido_listo') {
      setOrders(prev => prev.map(p => p.id === ws.data.pedido.id ? { ...p, estado: 'listo' } : p));
    }
    if (ws.data.type === 'pedido_actualizado' && ws.data.pedido?.id) {
      const updated = ws.data.pedido;
      setOrders(prev => prev.map(order => order.id === updated.id
        ? kitchenOrder(updated, normalizarEstado(updated.status || updated.estado))
        : order));
    }
  }, [ws.data]);

  async function ejecutarAccion(id, action) {
    if (pendingActions.has(id)) return;
    setPendingActions(prev => new Set(prev).add(id));
    setActionError('');
    try {
      const response = await fetch(`/api/cocina/pedido/${id}/${action}`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `No se pudo actualizar el pedido (${response.status}).`);
      }
      cola.reload();
    } catch (error) {
      setActionError(error.message || 'No se pudo actualizar el pedido.');
      cola.reload();
    } finally {
      setPendingActions(prev => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }

  async function authenticateKitchen(event) {
    event.preventDefault();
    if (!kitchenUser.trim() || !kitchenPassword.trim()) return;
    setAuthLoading(true);
    setActionError('');
    try {
      await login(kitchenUser.trim(), kitchenPassword);
      setKitchenPassword('');
    } catch (error) {
      setActionError(error.message || 'No se pudo autenticar Cocina.');
    } finally {
      setAuthLoading(false);
    }
  }

  const filtered = useMemo(() => {
    const visible = filter === 'todos'
      ? orders
      : orders.filter(o => o.estado === filter);

    const stateOrder = { espera: 0, preparando: 1, listo: 2 };
    const timeOf = (order) => {
      const time = order.timestamp ? new Date(order.timestamp).getTime() : NaN;
      return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
    };

    return [...visible].sort((a, b) => {
      if (sort === 'mesa') {
        return String(a.mesa).localeCompare(String(b.mesa), 'es', { numeric: true })
          || String(a.id).localeCompare(String(b.id));
      }
      if (sort === 'estado') {
        return (stateOrder[a.estado] ?? 99) - (stateOrder[b.estado] ?? 99)
          || timeOf(a) - timeOf(b);
      }
      const difference = timeOf(a) - timeOf(b);
      if (difference !== 0) return sort === 'newest' ? -difference : difference;
      return String(a.id).localeCompare(String(b.id));
    });
  }, [filter, orders, sort]);

  const counts = {
    espera: orders.filter(o => o.estado === 'espera').length,
    preparando: orders.filter(o => o.estado === 'preparando').length,
    listo: orders.filter(o => o.estado === 'listo').length,
  };

  return (
    <div className="h-screen flex flex-col bg-chipi-bg text-text-primary overflow-hidden" style={{ fontFamily: "'Segoe UI', system-ui, sans-serif" }}>
      <header className="shrink-0 min-h-16 px-3 sm:px-6 py-2 glass border-b border-chipi-border flex flex-wrap items-center justify-between gap-2 z-20">
        <div className="flex items-center gap-3">
          <span className="text-2xl">👨‍🍳</span>
          <div>
            <h1 className="text-lg font-bold neon-text-amber tracking-tight">Cocina</h1>
            <span className="text-[10px] text-text-dim">KDS v3.0</span>
          </div>
        </div>
        <div className="flex items-center gap-3 sm:gap-6 ml-auto">
          <StatBox label="En espera" value={counts.espera} color="text-neon-rose" />
          <StatBox label="Preparando" value={counts.preparando} color="text-neon-amber" />
          <StatBox label="Listos" value={counts.listo} color="text-neon-green" />
          <time className="text-[10px] sm:text-xs text-text-secondary font-mono whitespace-nowrap" dateTime={clock.toISOString()}>
            {formatFullDateTime(clock)}
          </time>
          {token ? (
            <span className="rounded-lg border border-neon-green/40 bg-neon-green/10 px-2 py-1 text-[10px] text-neon-green">Operador autenticado</span>
          ) : (
            <form onSubmit={authenticateKitchen} className="flex items-center gap-1" aria-label="Autenticar operador de cocina">
              <input
                value={kitchenUser}
                onChange={event => setKitchenUser(event.target.value)}
                placeholder="usuario"
                autoComplete="username"
                className="w-20 rounded-md border border-chipi-border bg-chipi-card px-2 py-1 text-[10px] text-text-primary outline-none"
              />
              <input
                type="password"
                value={kitchenPassword}
                onChange={event => setKitchenPassword(event.target.value)}
                placeholder="clave"
                autoComplete="current-password"
                className="w-20 rounded-md border border-chipi-border bg-chipi-card px-2 py-1 text-[10px] text-text-primary outline-none"
              />
              <button type="submit" disabled={authLoading} className="rounded-md border border-neon-cyan/40 bg-neon-cyan/10 px-2 py-1 text-[10px] text-neon-cyan disabled:opacity-50">
                {authLoading ? '...' : 'Autenticar'}
              </button>
            </form>
          )}
          <div className={`w-2.5 h-2.5 rounded-full ${ws.connected ? 'bg-neon-green glow-pulse-green' : 'bg-neon-rose'}`} />
        </div>
      </header>

      <nav className="shrink-0 flex flex-wrap items-center gap-2 px-3 sm:px-6 py-3 border-b border-chipi-border">
        {['todos', 'espera', 'preparando', 'listo'].map(f => {
          const active = filter === f;
          const cfg = f === 'espera' ? { color: '#F43F5E', label: 'En espera' }
            : f === 'preparando' ? { color: '#F59E0B', label: 'Preparando' }
            : f === 'listo' ? { color: '#10B981', label: 'Listos' }
            : { color: '#F0F0F5', label: 'Todos' };
          return (
            <button
              key={f}
              onClick={() => setFilter(f)}
              aria-pressed={active}
              className="px-5 py-2.5 rounded-xl text-sm font-semibold border transition-all"
              style={{
                background: active ? `${cfg.color}15` : '#ffffff08',
                borderColor: active ? `${cfg.color}50` : 'transparent',
                color: active ? cfg.color : '#a0a0b8',
                boxShadow: active ? `0 0 12px ${cfg.color}20` : 'none',
              }}
            >
              {cfg.label}
            </button>
          );
        })}
        <label className="ml-auto flex items-center gap-2 text-xs text-text-secondary">
          <span>Ordenar</span>
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value)}
            className="rounded-xl border border-chipi-border bg-chipi-card px-3 py-2 text-xs text-text-primary outline-none focus:border-neon-cyan"
          >
            <option value="oldest">Más antiguos</option>
            <option value="newest">Más recientes</option>
            <option value="mesa">Mesa</option>
            <option value="estado">Estado</option>
          </select>
        </label>
      </nav>

      {cola.error && (
        <div className="mx-3 mt-3 rounded-xl border border-neon-rose/50 bg-neon-rose/10 px-3 py-2 text-xs text-neon-rose" role="alert">
          No se pudo actualizar la cola de Cocina. <button onClick={cola.reload} className="font-bold underline">Reintentar</button>
        </div>
      )}

      {actionError && (
        <div className="mx-3 mt-3 rounded-xl border border-neon-rose/50 bg-neon-rose/10 px-3 py-2 text-xs text-neon-rose" role="alert">
          {actionError}
        </div>
      )}

      <main className="flex-1 overflow-y-auto p-3 sm:p-6 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 content-start">
        {filtered.map((pedido, i) => {
          const cfg = ESTADOS.find(e => e.key === pedido.estado) || ESTADOS[0];
          return (
            <div
              key={pedido.id}
              className="rounded-2xl p-5 border flex flex-col gap-3 transition-all hover:scale-[1.01]"
              style={{
                background: '#13121c',
                borderColor: `${cfg.color}40`,
                boxShadow: cfg.glow,
                animation: 'fadeInUp 0.35s ease-out forwards',
                animationDelay: `${i * 80}ms`,
                opacity: 0,
              }}
            >
              <div className="flex justify-between items-start">
                <div className="flex items-center gap-2">
                  <span className="text-2xl font-bold neon-text-cyan">Mesa {pedido.mesa}</span>
                  <span className="text-xs text-text-dim font-mono">#{pedido.id.slice(-4)}</span>
                </div>
                <span className="px-3 py-1 rounded-full text-xs font-bold border" style={{ background: cfg.bg, borderColor: `${cfg.color}40`, color: cfg.color }}>
                  {cfg.label.toUpperCase()}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-[10px] text-text-secondary">
                <span className="rounded-md border border-neon-purple/30 bg-neon-purple/10 px-2 py-1 text-neon-purple">
                  {pedido.order_kind === 'additional' ? `Pedido adicional ${pedido.order_sequence || ''}` : 'Pedido inicial'}
                </span>
                {pedido.visit_id && <span className="font-mono text-text-dim">Visita {pedido.visit_id.slice(0, 8)}</span>}
                {pedido.guest_count && <span className="text-text-dim">👥 {pedido.guest_count}</span>}
              </div>

              {(pedido.special_warning || pedido.declared_allergies?.length > 0 || pedido.allergy_conflicts?.length > 0) && (
                <div className="rounded-xl border-2 border-neon-rose/80 bg-neon-rose/15 px-3 py-2 text-xs font-bold text-neon-rose" role="alert">
                  ALERTA: {pedido.special_warning || `Alergia declarada: ${pedido.declared_allergies.join(', ')}`}
                </div>
              )}
              <ul className="space-y-2">
                {pedido.platos.map((p, j) => (
                  <li key={p.item_id || p.line_id || `${p.nombre}-${j}`} className="rounded-lg border border-chipi-border/70 px-2 py-1.5 text-base">
                    <div className="flex justify-between items-center gap-2">
                      <span className="text-text-primary">{p.nombre} <span className="text-text-dim text-sm">x{p.cantidad || 1}</span></span>
                      <span className="text-sm font-semibold neon-text-amber font-mono">S/ {p.precio}</span>
                    </div>
                    {(p.modificaciones || []).length > 0 && <div className="mt-1 text-xs font-bold text-neon-cyan">{p.modificaciones.map(modifier => modifier.nombre).join(', ')}</div>}
                    {(p.observaciones || []).length > 0 && <div className="mt-1 text-xs font-semibold text-neon-amber">Nota: {p.observaciones.join('; ')}</div>}
                  </li>
                ))}
              </ul>

              <div className="mt-auto pt-3 border-t border-chipi-border flex items-center justify-between">
                <time className="text-xs text-text-dim font-mono" dateTime={pedido.timestamp || undefined}>
                  {formatFullDateTime(pedido.timestamp)}
                </time>
                {pedido.estado !== 'listo' ? (
                  <div className="flex gap-2">
                    {pedido.estado === 'espera' && (
                      <button onClick={() => ejecutarAccion(pedido.id, 'preparar')} disabled={pendingActions.has(pedido.id)} className="btn-amber px-4 py-2 rounded-xl text-xs font-bold disabled:opacity-50 disabled:cursor-wait">
                        {pendingActions.has(pedido.id) ? 'Actualizando…' : 'Preparar'}
                      </button>
                    )}
                    {pedido.estado === 'preparando' && (
                      <button onClick={() => ejecutarAccion(pedido.id, 'listo')} disabled={pendingActions.has(pedido.id)} className="btn-green px-4 py-2 rounded-xl text-xs font-bold disabled:opacity-50 disabled:cursor-wait">
                        {pendingActions.has(pedido.id) ? 'Actualizando…' : 'Marcar Listo'}
                      </button>
                    )}
                  </div>
                ) : (
                  <span className="text-sm font-bold neon-text-green">✅ Listo para recoger</span>
                )}
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div className="col-span-full flex flex-col items-center justify-center py-20 text-text-dim">
            <span className="text-4xl mb-4 opacity-30">🍽️</span>
            <p className="text-sm">No hay pedidos en esta sección</p>
          </div>
        )}
      </main>
    </div>
  );
}

function StatBox({ label, value, color }) {
  return (
    <div className="text-center">
      <div className={`text-xl font-bold ${color}`}>{value}</div>
      <div className="text-[10px] text-text-dim mt-0.5">{label}</div>
    </div>
  );
}

function safeParse(v) {
  try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return []; }
}

function itemsFromPedido(pedido) {
  return Array.isArray(pedido.items)
    ? pedido.items
    : Array.isArray(pedido.platos)
      ? pedido.platos
      : safeParse(pedido.items || pedido.platos);
}

function kitchenOrder(order, estado) {
  return {
    id: order.id,
    mesa: normalizeMesa(order.table_id || order.mesa) || 'M?',
    platos: itemsFromPedido(order),
    estado,
    timestamp: order.timestamp || null,
    visit_id: order.visit_id || null,
    guest_count: order.guest_count || null,
    order_sequence: order.order_sequence || null,
    order_kind: order.order_kind || 'initial',
    declared_allergies: order.declared_allergies || [],
    allergy_conflicts: order.allergy_conflicts || [],
    special_warning: order.special_warning || '',
    requires_special_confirmation: Boolean(order.requires_special_confirmation),
  };
}

function normalizarEstado(status) {
  const map = {
    sent_to_kitchen: 'espera',
    confirmed: 'espera',
    preparing: 'preparando',
    ready: 'listo',
    en_preparacion: 'preparando',
    listo: 'listo',
    provisional: 'espera',
  };
  return map[status] || 'espera';
}

function normalizeMesa(value) {
  const raw = String(value || '').trim().toUpperCase().replace(/^MESA\s*/, '').replace(/^M(?=\d)/, '');
  return /^([1-9]|1[0-2])$/.test(raw) ? `M${Number(raw)}` : '';
}

function formatFullDateTime(value) {
  if (!value) return 'Hora no disponible';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Hora no disponible';
  return new Intl.DateTimeFormat('es-PE', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}
