import { useState, useMemo, useEffect } from 'react';
import { useApi, useWebSocket } from './hooks.js';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';
import RosMap from './components/RosMap.jsx';
import { useAuth } from './admin/AuthContext.jsx';
import PersonalidadPanel from './admin/panels/Personalidad.jsx';
import MenuEditorPanel from './admin/panels/MenuEditor.jsx';
import HardwareControlPanel from './admin/panels/HardwareControl.jsx';
import Ros2DeliveryPanel from './admin/panels/Ros2DeliveryPanel.jsx';
import WaiterAssistancePanel from './admin/panels/WaiterAssistancePanel.jsx';
import SafetyOrdersPanel from './admin/panels/SafetyOrdersPanel.jsx';
import SessionsPanel from './admin/panels/SessionsPanel.jsx';
import HistoryDataPanel from './admin/panels/HistoryDataPanel.jsx';
import TablesPanel from './admin/panels/TablesPanel.jsx';
import MemoryPanel from './admin/panels/MemoryPanel.jsx';
import SpeechDiagnosticsPanel from './admin/panels/SpeechDiagnosticsPanel.jsx';
import AnalyticsPanel from './admin/panels/AnalyticsPanel.jsx';

const CATEGORIAS = ['plato', 'bebida', 'postre'];

const CATEGORIA_CONFIG = {
  plato: { label: 'Platos', color: '#22D3EE', gradient: 'linear-gradient(145deg, #22D3EE20, #22D3EE05)' },
  bebida: { label: 'Bebidas', color: '#F59E0B', gradient: 'linear-gradient(145deg, #F59E0B20, #F59E0B05)' },
  postre: { label: 'Postres', color: '#F43F5E', gradient: 'linear-gradient(145deg, #F43F5E20, #F43F5E05)' },
};

const FALLBACK_MENU = [
  { nombre: 'Lomo Saltado', precio: 25, categoria: 'plato', desc: 'Carne + papas' },
  { nombre: 'Ceviche', precio: 22, categoria: 'plato', desc: 'Pescado fresco' },
  { nombre: 'Pollo Brasa', precio: 30, categoria: 'plato', desc: '1/4 con papas' },
  { nombre: 'Tallarines', precio: 20, categoria: 'plato', desc: 'Verduras salteadas' },
  { nombre: 'Inca Kola', precio: 5, categoria: 'bebida', desc: '500ml' },
  { nombre: 'Chicha Morada', precio: 4, categoria: 'bebida', desc: 'Vaso grande' },
  { nombre: 'Helado Artesanal', precio: 8, categoria: 'postre', desc: 'Vainilla' },
  { nombre: 'Torta de Chocolate', precio: 12, categoria: 'postre', desc: 'Porción' },
];

const LANGGRAPH_STATES = [
  { key: 'idle', label: 'Inactivo', color: '#64748B' },
  { key: 'listening', label: 'Escuchando', color: '#22D3EE' },
  { key: 'processing', label: 'Procesando', color: '#A855F7' },
  { key: 'responding', label: 'Respondiendo', color: '#10B981' },
  { key: 'navigating', label: 'Navegando', color: '#F59E0B' },
];

function agruparVentasPorHora(pedidos) {
  const horas = {};
  for (const p of pedidos) {
    const ts = p.timestamp || p.createdAt || p.created_at;
    if (!ts) continue;
    const d = new Date(ts);
    const h = d.getHours();
    const label = `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;
    horas[label] = (horas[label] || 0) + parseFloat(p.total || 0);
  }
  const orden = ['8am', '9am', '10am', '11am', '12pm', '1pm', '2pm', '3pm', '4pm', '5pm', '6pm', '7pm', '8pm', '9pm'];
  return orden.map(h => ({ h, ventas: horas[h] || 0 }));
}

function fechaPedido(pedido) {
  return pedido.timestamp || pedido.createdAt || pedido.created_at || null;
}

function normalizarEstadoPedido(pedidoOrStatus) {
  const raw = typeof pedidoOrStatus === 'string'
    ? pedidoOrStatus
    : pedidoOrStatus?.status || pedidoOrStatus?.estado;
  const map = {
    draft: 'draft',
    pending_confirmation: 'draft',
    provisional: 'draft',
    confirmed: 'confirmed',
    confirmado: 'confirmed',
    sent_to_kitchen: 'confirmed',
    preparing: 'preparing',
    en_preparacion: 'preparing',
    preparando: 'preparing',
    ready: 'ready',
    listo: 'ready',
    delivered: 'delivered',
    entregado: 'delivered',
    cancelled: 'cancelled',
    cancelado: 'cancelled',
  };
  return map[raw] || 'unknown';
}

function pedidosPorPopularidad(pedidos) {
  const counts = new Map();
  for (const pedido of pedidos) {
    if (normalizarEstadoPedido(pedido) === 'cancelled') continue;
    for (const item of itemsFromPedido(pedido)) {
      const nombre = String(item?.nombre || '').trim();
      const cantidad = Number(item?.cantidad) || 0;
      if (!nombre || cantidad <= 0) continue;
      counts.set(nombre, (counts.get(nombre) || 0) + cantidad);
    }
  }
  return [...counts.entries()]
    .map(([nombre, cantidad]) => ({ nombre, cantidad }))
    .sort((a, b) => b.cantidad - a.cantidad || a.nombre.localeCompare(b.nombre, 'es'))
    .slice(0, 8);
}

function normalizeLiveLanggraphState(value) {
  const raw = String(value || '').toLowerCase();
  if (['idle', 'farewell'].includes(raw)) return 'idle';
  if (['listening', 'listen', 'vad_listening'].includes(raw)) return 'listening';
  if (['processing', 'thinking', 'taking_order', 'greeting', 'confirming', 'confirming_order'].includes(raw)) return 'processing';
  if (['responding', 'speaking', 'playing', 'delivering'].includes(raw)) return 'responding';
  if (['navigating', 'navigation', 'moving'].includes(raw)) return 'navigating';
  return null;
}

function mapLiveMessageToLanggraphState(message) {
  if (!message) return null;
  if (message.type === 'audio_lab_metrics') {
    return normalizeLiveLanggraphState(message.snapshot?.conversation_state);
  }
  if (message.type === 'audio_lab_event') {
    const name = message.event?.name;
    if (name === 'vad_listening') return 'listening';
    if (name === 'vad_processing' || name === 'asr_final') return 'processing';
    if (name === 'llm_response' || name === 'tts_sent') return 'responding';
  }
  if (message.type === 'dialogue_state') {
    return normalizeLiveLanggraphState(message.state) || 'responding';
  }
  if (message.type === 'navigate' || message.type === 'orchestrator_action' && message.action === 'ir_a_lugar') return 'navigating';
  if (message.type === 'voice_state') return normalizeLiveLanggraphState(message.state);
  return null;
}

function formatDateTime(value) {
  if (!value) return 'Sin fecha';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Sin fecha';
  return new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function formatMesa(value) {
  const raw = String(value || '').trim().toUpperCase().replace(/^MESA\s*/, '').replace(/^M(?=\d)/, '');
  return /^([1-9]|1[0-2])$/.test(raw) ? `M${Number(raw)}` : (value || '—');
}

export default function AdminDashboard() {
  const [tab, setTab] = useState('overview');
  const { token } = useAuth();
  const adminHeaders = useMemo(() => (token ? { Authorization: `Bearer ${token}` } : {}), [token]);
  const pedidos = useApi('/api/admin/orders/summary', { interval: 5000, headers: adminHeaders });
  const cocina = useApi('/api/cocina/cola', { interval: 5000, headers: adminHeaders });
  const robot = useApi('/api/robot/estado', { interval: 3000 });
  const menu = useApi('/api/menu', { interval: 30000 });
  const ui = useWebSocket('/ws/ui', token);
  const [pedidoFilter, setPedidoFilter] = useState('todos');
  const [pedidoSort, setPedidoSort] = useState('newest');
  const [deleteConfirmId, setDeleteConfirmId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
  const [langgraphState, setLanggraphState] = useState('idle');
  const [clock, setClock] = useState(new Date().toLocaleTimeString());

  const [cart, setCart] = useState([]);
  const [activeCat, setActiveCat] = useState('plato');
  const [mesaNuevo, setMesaNuevo] = useState('M1');
  const [confirmando, setConfirmando] = useState(false);
  const [mensaje, setMensaje] = useState('');

  const menuItems = useMemo(() => menu.data?.data || FALLBACK_MENU, [menu.data]);
  const filteredItems = useMemo(() => menuItems.filter(i => i.categoria === activeCat), [menuItems, activeCat]);
  const totalCart = useMemo(() => cart.reduce((s, i) => s + i.precio * i.cantidad, 0), [cart]);
  const itemCount = useMemo(() => cart.reduce((s, i) => s + i.cantidad, 0), [cart]);

  function addToCart(item) {
    setCart(c => {
      const found = c.find(i => i.nombre === item.nombre);
      return found
        ? c.map(i => i.nombre === item.nombre ? { ...i, cantidad: i.cantidad + 1 } : i)
        : [...c, { ...item, cantidad: 1 }];
    });
  }

  function removeFromCart(nombre) {
    setCart(c => c.filter(i => i.nombre !== nombre));
  }

  function updateCantidad(nombre, delta) {
    setCart(c => c.map(i => {
      if (i.nombre !== nombre) return i;
      const nueva = i.cantidad + delta;
      return nueva > 0 ? { ...i, cantidad: nueva } : i;
    }).filter(i => i.cantidad > 0));
  }

  async function confirmarPedido() {
    if (cart.length === 0) return;
    setConfirmando(true);
    try {
      const res = await fetch('/api/pedidos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...adminHeaders },
        body: JSON.stringify({
          mesa: mesaNuevo,
          table_id: mesaNuevo,
          platos: cart,
          items: cart,
          subtotal: totalCart,
          total: totalCart,
          mode: 'admin',
          status: 'sent_to_kitchen',
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setMensaje(`Error: ${err.error || res.statusText}`);
        setConfirmando(false);
        return;
      }
      setCart([]);
      setMensaje('¡Pedido enviado a cocina!');
      setTimeout(() => setMensaje(''), 3000);
    } catch (e) {
      setMensaje(`Error de red: ${e.message}`);
    }
    setConfirmando(false);
  }

  useEffect(() => {
    const t = setInterval(() => setClock(new Date().toLocaleTimeString()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const liveFromApi = normalizeLiveLanggraphState(robot.data?.langgraph_estado);
    if (liveFromApi) setLanggraphState(liveFromApi);
  }, [robot.data]);

  useEffect(() => {
    const next = mapLiveMessageToLanggraphState(ui.data);
    if (!next) return;
    setLanggraphState(next);
    if (next === 'navigating') {
      const timer = setTimeout(() => setLanggraphState('idle'), 2500);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [ui.data]);

  useEffect(() => {
    const type = ui.data?.type;
    if (!['nuevo_pedido', 'pedido_actualizado', 'table_status_changed', 'table_available', 'table_visit_closed', 'draft_order_moved', 'session_closed'].includes(type)) return;
    pedidos.reload();
    cocina.reload();
  }, [ui.data?.event_id, ui.data?.type]);

  const pedidosData = pedidos.data?.data || [];
  const pedidosOperativos = useMemo(() => {
    const current = [
      ...(cocina.data?.enviados || []),
      ...(cocina.data?.en_preparacion || []),
      ...(cocina.data?.listos || []),
    ];
    return current
      .filter((pedido, index, all) => all.findIndex(candidate => candidate.id === pedido.id) === index)
      .sort((a, b) => new Date(fechaPedido(a) || 0).getTime() - new Date(fechaPedido(b) || 0).getTime());
  }, [cocina.data]);
  const operationalIds = useMemo(() => new Set(pedidosOperativos.map(pedido => String(pedido.id))), [pedidosOperativos]);

  const pedidosFiltrados = useMemo(() => {
    const filtered = pedidoFilter === 'todos'
      ? pedidosData.filter(pedido => !operationalIds.has(String(pedido.id)))
      : pedidosData.filter((pedido) => {
        if (operationalIds.has(String(pedido.id))) return false;
        const status = normalizarEstadoPedido(pedido);
        if (pedidoFilter === 'pendiente') return ['draft', 'confirmed'].includes(status);
        return status === pedidoFilter;
      });
    const statusOrder = { draft: 0, confirmed: 1, preparing: 2, ready: 3, delivered: 4, cancelled: 5 };
    const timestamp = (pedido) => {
      const value = fechaPedido(pedido);
      const time = value ? new Date(value).getTime() : NaN;
      return Number.isFinite(time) ? time : 0;
    };
    return [...filtered].sort((a, b) => {
      if (pedidoSort === 'mesa') {
        return formatMesa(a.table_id || a.mesa).localeCompare(formatMesa(b.table_id || b.mesa), 'es', { numeric: true });
      }
      if (pedidoSort === 'estado') {
        return (statusOrder[normalizarEstadoPedido(a)] ?? 99) - (statusOrder[normalizarEstadoPedido(b)] ?? 99);
      }
      const delta = timestamp(a) - timestamp(b);
      return pedidoSort === 'oldest' ? delta : -delta;
    });
  }, [pedidosData, operationalIds, pedidoFilter, pedidoSort]);

  const ventasHoy = Number(pedidos.data?.total_amount || 0);
  const ventasPorHora = pedidos.data?.ventas_por_hora || [];
  const productosMasSolicitados = pedidos.data?.productos_mas_solicitados || [];

  async function borrarDraft(pedido) {
    if (pedido?.status !== 'draft') return;
    setDeletingId(pedido.id);
    setDeleteError(null);
    try {
      const response = await fetch(`/api/admin/pedidos/${encodeURIComponent(pedido.id)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setDeleteConfirmId(null);
      pedidos.reload();
    } catch (error) {
      setDeleteError(error.message);
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="h-screen flex flex-col bg-chipi-bg text-text-primary overflow-hidden" style={{ fontFamily: "'Segoe UI', system-ui, sans-serif" }}>
      <header className="shrink-0 h-14 px-6 glass border-b border-chipi-border flex items-center justify-between z-20">
        <div className="flex items-center gap-3">
          <span className="text-xl">⚙️</span>
          <h1 className="text-lg font-bold neon-text-purple tracking-tight">Admin</h1>
        </div>
        <div className="flex items-center gap-4 text-[10px] text-text-secondary">
          <span className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${pedidos.loading ? 'bg-neon-amber animate-pulse' : 'bg-neon-green'}`} />
            {pedidos.loading ? 'Sincronizando...' : 'Datos en vivo'}
          </span>
          <span className="font-mono text-neon-cyan">{clock}</span>
        </div>
      </header>

      <nav className="shrink-0 flex gap-2 px-6 py-3 border-b border-chipi-border flex-wrap">
        {[
          { id: 'overview', label: '📊 Overview' },
          { id: 'analytics', label: '📈 Analítica real' },
          { id: 'carta', label: '🍽️ Carta' },
          { id: 'pedidos', label: '🗂️ Historial y datos' },
          { id: 'mapa', label: '🗺️ Mapa' },
          { id: 'personalidad', label: '🎭 Personalidad' },
          { id: 'menu', label: '📋 Menú' },
          { id: 'hardware', label: 'Hardware' },
          { id: 'ros2', label: 'ROS 2 / Flujo' },
          { id: 'waiter', label: 'Asistencia' },
          { id: 'seguridad', label: 'Seguridad menú' },
          { id: 'sessions', label: 'Sesiones' },
          { id: 'tables', label: 'Mesas' },
          { id: 'memory', label: 'Memoria' },
          { id: 'speech', label: 'Voz / TTS' },
        ].map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-5 py-2.5 rounded-xl text-sm font-semibold border transition-all ${tab === t.id ? 'nav-active' : 'text-text-secondary hover:text-text-primary'}`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="flex-1 overflow-y-auto p-6">
        {tab === 'overview' && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <MetricCard label="Pedidos Hoy" value={pedidos.data?.order_count ?? 0} color="#22D3EE" />
              <MetricCard label="Ventas" value={`S/ ${ventasHoy.toFixed(2)}`} color="#10B981" />
              <MetricCard label="Batería" value={`${robot.data?.bateria ?? '—'}%`} color="#F59E0B" />
              <MetricCard label="Estado LangGraph" value={langgraphState} color="#A855F7" />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="glass rounded-2xl border border-chipi-border p-5">
                <h3 className="text-xs font-bold text-text-secondary mb-4 uppercase tracking-wider">Latencia IA (ms)</h3>
                {Array.isArray(robot.data?.latencia_historial) && robot.data.latencia_historial.length > 0 ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={robot.data.latencia_historial}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#ffffff08" />
                      <XAxis dataKey="t" stroke="#606070" fontSize={11} />
                      <YAxis stroke="#606070" fontSize={11} />
                      <Tooltip contentStyle={{ backgroundColor: '#13121c', border: '1px solid #00f0ff30', borderRadius: '12px', color: '#f0f0f5' }} />
                      <Line type="monotone" dataKey="llm" stroke="#22D3EE" strokeWidth={2} dot={false} name="LLM" />
                      <Line type="monotone" dataKey="tts" stroke="#34D399" strokeWidth={2} dot={false} name="TTS" />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <EmptyData message="Sin historial real de latencia todavía" />
                )}
              </div>

              <div className="glass rounded-2xl border border-chipi-border p-5">
                <h3 className="text-xs font-bold text-text-secondary mb-4 uppercase tracking-wider">Ventas por hora</h3>
                {ventasPorHora.some(point => point.ventas > 0) ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={ventasPorHora}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#ffffff08" />
                      <XAxis dataKey="h" stroke="#606070" fontSize={11} />
                      <YAxis stroke="#606070" fontSize={11} />
                      <Tooltip contentStyle={{ backgroundColor: '#13121c', border: '1px solid #00f0ff30', borderRadius: '12px', color: '#f0f0f5' }} />
                      <Bar dataKey="ventas" fill="#A855F7" radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <EmptyData message="Sin ventas reales por hora todavía" />
                )}
              </div>
            </div>

            <div className="glass rounded-2xl border border-chipi-border p-5">
              <h3 className="text-xs font-bold text-text-secondary mb-4 uppercase tracking-wider">Productos más solicitados</h3>
              {productosMasSolicitados.length > 0 ? (
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={productosMasSolicitados} layout="vertical" margin={{ left: 8, right: 24 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#ffffff08" />
                    <XAxis type="number" allowDecimals={false} stroke="#606070" fontSize={11} />
                    <YAxis type="category" dataKey="nombre" width={150} stroke="#606070" fontSize={11} tickLine={false} />
                    <Tooltip contentStyle={{ backgroundColor: '#13121c', border: '1px solid #00f0ff30', borderRadius: '12px', color: '#f0f0f5' }} />
                    <Bar dataKey="cantidad" fill="#22D3EE" radius={[0, 6, 6, 0]} name="Unidades" />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <EmptyData message="Sin pedidos reales para calcular popularidad" />
              )}
            </div>

            <div className="glass rounded-2xl border border-chipi-border p-5">
              <h3 className="text-xs font-bold text-text-secondary mb-4 uppercase tracking-wider">Estado LangGraph</h3>
              <div className="flex gap-3 flex-wrap">
                {LANGGRAPH_STATES.map(s => (
                  <div key={s.key} className={`flex items-center gap-2 px-4 py-2 rounded-xl border transition-opacity ${langgraphState === s.key ? 'opacity-100 ring-1 ring-white/10' : 'opacity-45'}`} style={{ borderColor: `${s.color}30`, background: `${s.color}10` }}>
                    <span className="w-2 h-2 rounded-full" style={{ background: s.color, boxShadow: `0 0 8px ${s.color}` }} />
                    <span className="text-xs font-medium" style={{ color: s.color }}>{s.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {tab === 'analytics' && <AnalyticsPanel token={token} />}

        {tab === 'carta' && (
          <div className="flex gap-6 h-[calc(100vh-140px)]">
            <div className="flex-1 flex flex-col min-w-0">
              <div className="flex items-center justify-between mb-4">
                <div className="flex gap-2">
                  {CATEGORIAS.map(cat => {
                    const cfg = CATEGORIA_CONFIG[cat];
                    const active = activeCat === cat;
                    return (
                      <button
                        key={cat}
                        onClick={() => setActiveCat(cat)}
                        className={`px-4 py-2 rounded-xl text-sm font-semibold border transition-all ${active ? 'nav-active' : 'text-text-secondary hover:text-text-primary border-transparent'}`}
                        style={active ? { borderColor: `${cfg.color}60`, color: cfg.color, background: `${cfg.color}15` } : {}}
                      >
                        {cfg.label}
                      </button>
                    );
                  })}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-secondary">Mesa:</span>
                  <input
                    type="text"
                    value={mesaNuevo}
                    onChange={(e) => setMesaNuevo(e.target.value)}
                    className="w-20 px-3 py-2 rounded-xl bg-chipi-card border border-chipi-border text-sm text-center font-mono font-bold text-neon-cyan focus:outline-none focus:border-neon-cyan"
                    placeholder="M1"
                  />
                </div>
              </div>

              {mensaje && (
                <div className="mb-4 px-4 py-2 rounded-xl bg-neon-green/10 border border-neon-green/30 text-neon-green text-sm font-semibold">
                  {mensaje}
                </div>
              )}

              <div className="flex-1 overflow-y-auto grid grid-cols-2 lg:grid-cols-3 gap-3 content-start">
                {filteredItems.map((item, i) => {
                  const cfg = CATEGORIA_CONFIG[item.categoria];
                  return (
                    <button
                      key={item.nombre}
                      onClick={() => addToCart(item)}
                      className="relative rounded-2xl p-4 flex flex-col items-start text-left min-h-[110px] transition-all hover:scale-[1.02] active:scale-95 border text-left"
                      style={{
                        background: cfg.gradient,
                        borderColor: `${cfg.color}25`,
                        animation: 'fadeInUp 0.35s ease-out forwards',
                        animationDelay: `${i * 60}ms`,
                        opacity: 0,
                      }}
                    >
                      <span className="text-sm font-bold text-white/90 leading-tight">{item.nombre}</span>
                      <span className="text-xs text-white/60 mt-1">{item.desc}</span>
                      <div className="mt-auto w-full flex justify-between items-center pt-2">
                        <span className="text-base font-bold font-mono" style={{ color: cfg.color }}>S/ {item.precio}</span>
                        <span className="w-7 h-7 rounded-full flex items-center justify-center text-sm font-bold" style={{ background: `${cfg.color}30`, color: cfg.color }}>+</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="w-80 shrink-0 glass rounded-2xl border border-chipi-border p-4 flex flex-col">
              <div className="flex items-center justify-between mb-4 shrink-0">
                <h2 className="text-sm font-bold text-text-primary flex items-center gap-2">
                  <span>🛒</span> Pedido
                </h2>
                <span className="text-xs text-text-dim bg-chipi-bg px-2 py-1 rounded-full border border-chipi-border">{itemCount} items</span>
              </div>

              <div className="flex-1 overflow-y-auto space-y-2 min-h-0">
                {cart.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-text-dim gap-2">
                    <span className="text-3xl opacity-30">🛒</span>
                    <p className="text-xs">Selecciona platos del menú</p>
                  </div>
                ) : (
                  cart.map(item => (
                    <div key={item.nombre} className="flex justify-between items-center glass rounded-xl p-2.5 border border-chipi-border">
                      <div className="min-w-0">
                        <span className="text-xs font-medium block truncate">{item.nombre}</span>
                        <span className="text-[10px] text-neon-amber font-mono">S/ {item.precio}</span>
                      </div>
                      <div className="flex items-center gap-1 shrink-0 ml-2">
                        <button onClick={() => updateCantidad(item.nombre, -1)} className="w-6 h-6 rounded-lg bg-chipi-bg border border-chipi-border text-text-secondary hover:text-text-primary text-xs">−</button>
                        <span className="w-6 text-center text-xs font-bold">{item.cantidad}</span>
                        <button onClick={() => updateCantidad(item.nombre, 1)} className="w-6 h-6 rounded-lg bg-chipi-bg border border-chipi-border text-text-secondary hover:text-text-primary text-xs">+</button>
                        <button onClick={() => removeFromCart(item.nombre)} className="w-6 h-6 rounded-lg bg-chipi-bg border border-chipi-border text-neon-rose hover:bg-neon-rose/10 text-xs ml-1">✕</button>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {cart.length > 0 && (
                <div className="shrink-0 pt-3 border-t border-chipi-border space-y-3 mt-3">
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-text-secondary">Total</span>
                    <span className="text-xl font-bold neon-text-amber font-mono">S/ {totalCart}</span>
                  </div>
                  <button
                    onClick={confirmarPedido}
                    disabled={confirmando}
                    className="w-full py-3 rounded-xl font-bold text-sm btn-primary disabled:opacity-50"
                  >
                    {confirmando ? 'Enviando...' : 'Confirmar Pedido'}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'pedidos' && <HistoryDataPanel token={token} liveEvent={ui.data} />}

        {false && tab === 'pedidos' && (
          <div className="space-y-4">
            <section className="glass rounded-2xl border border-neon-cyan/30 p-4" aria-label="Pedidos operativos sincronizados con Cocina">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div>
                  <h2 className="text-sm font-bold text-neon-cyan">Operación actual · misma cola que Cocina</h2>
                  <p className="text-[11px] text-text-dim">Solo pedidos de visitas activas en sent_to_kitchen, preparing o ready.</p>
                  {(cocina.data?.legacy_count || 0) > 0 && (
                    <span className="mt-1 inline-flex rounded-full border border-neon-amber/30 bg-neon-amber/10 px-2 py-0.5 text-[10px] text-neon-amber" role="status">
                      Mantenimiento: {cocina.data.legacy_count} históricos fuera de la cola operativa
                    </span>
                  )}
                </div>
                <span className="text-[11px] font-mono text-text-secondary">{cocina.loading ? 'Sincronizando…' : `${pedidosOperativos.length} activos`}</span>
              </div>
              {cocina.error ? (
                <p className="rounded-lg border border-neon-rose/30 bg-neon-rose/10 px-3 py-2 text-xs text-neon-rose">No se pudo cargar la cola operativa de Cocina.</p>
              ) : pedidosOperativos.length === 0 ? (
                <p className="rounded-lg border border-dashed border-chipi-border px-3 py-4 text-center text-xs text-text-dim">No hay pedidos operativos en la cola actual.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[680px] text-xs">
                    <thead>
                      <tr className="border-b border-chipi-border text-text-dim">
                        <th className="text-left p-2">Mesa</th>
                        <th className="text-left p-2">Pedido</th>
                        <th className="text-left p-2">Estado</th>
                        <th className="text-left p-2">Total</th>
                        <th className="text-left p-2">Fecha y hora</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pedidosOperativos.map(pedido => (
                        <tr key={pedido.id} className="border-b border-chipi-border/60">
                          <td className="p-2 font-semibold text-neon-cyan">{formatMesa(pedido.table_id || pedido.mesa)}</td>
                          <td className="p-2 text-text-secondary">{itemsFromPedido(pedido).map(item => `${item.nombre} ×${item.cantidad || 1}`).join(', ') || 'Sin productos'}</td>
                          <td className="p-2"><StatusBadge estado={pedido.status || pedido.estado} /></td>
                          <td className="p-2 font-mono text-neon-amber">S/ {Number(pedido.total || 0).toFixed(2)}</td>
                          <td className="p-2 text-text-dim whitespace-nowrap">{formatDateTime(fechaPedido(pedido))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            <div className="flex flex-wrap items-center gap-2">
              {[
                ['todos', 'Todos'],
                ['draft', 'Borradores'],
                ['pendiente', 'Pendientes'],
                ['confirmed', 'Confirmados'],
                ['preparing', 'Preparando'],
                ['ready', 'Listos'],
                ['delivered', 'Entregados'],
                ['cancelled', 'Cancelados'],
              ].map(([f, label]) => (
                <button
                  key={f}
                  onClick={() => setPedidoFilter(f)}
                  className={`px-4 py-2 rounded-xl text-xs font-semibold border transition-all ${pedidoFilter === f ? 'nav-active' : 'text-text-secondary hover:text-text-primary border-transparent'}`}
                >
                  {label}
                </button>
              ))}
              <label className="ml-auto flex items-center gap-2 text-xs text-text-secondary">
                <span>Ordenar</span>
                <select
                  value={pedidoSort}
                  onChange={(event) => setPedidoSort(event.target.value)}
                  className="rounded-xl border border-chipi-border bg-chipi-card px-3 py-2 text-xs text-text-primary outline-none focus:border-neon-cyan"
                >
                  <option value="newest">Más recientes</option>
                  <option value="oldest">Más antiguos</option>
                  <option value="mesa">Mesa</option>
                  <option value="estado">Estado</option>
                </select>
              </label>
            </div>
            {deleteError && (
              <div className="flex items-center justify-between gap-3 rounded-xl border border-neon-rose/40 bg-neon-rose/10 px-4 py-3 text-sm text-neon-rose" role="alert">
                <span>No se pudo borrar el borrador: {deleteError}</span>
                <button onClick={() => setDeleteError(null)} className="text-xs underline">Cerrar</button>
              </div>
            )}
            <div>
              <h2 className="text-sm font-bold text-text-primary">Historial administrativo · fuera de la cola operativa</h2>
              <p className="text-[11px] text-text-dim">Los pedidos que siguen en Cocina se muestran arriba y no se repiten en este historial.</p>
            </div>
            <div className="glass rounded-2xl border border-chipi-border overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b border-chipi-border text-text-dim text-xs">
                    <th className="text-left p-3">Mesa</th>
                    <th className="text-left p-3">Platos</th>
                    <th className="text-left p-3">Total</th>
                    <th className="text-left p-3">Estado</th>
                    <th className="text-left p-3">Fecha y hora</th>
                    <th className="text-left p-3">Acción</th>
                  </tr>
                </thead>
                <tbody>
                  {pedidosFiltrados.slice(0, 100).map(p => (
                    <tr key={p.id} className="border-b border-chipi-border hover:bg-chipi-card transition-colors">
                      <td className="p-3 font-medium neon-text-cyan">{formatMesa(p.table_id || p.mesa)}</td>
                      <td className="p-3 text-text-secondary text-xs">{itemsFromPedido(p).map(pl => pl.nombre).join(', ')}</td>
                      <td className="p-3 neon-text-amber font-semibold font-mono">S/ {p.total}</td>
                      <td className="p-3"><StatusBadge estado={p.status || p.estado} /></td>
                      <td className="p-3 text-text-dim text-xs whitespace-nowrap">{formatDateTime(fechaPedido(p))}</td>
                      <td className="p-3">
                        {p.status === 'draft' ? (
                          deleteConfirmId === p.id ? (
                            <div className="flex items-center gap-2 whitespace-nowrap">
                              <span className="text-[10px] text-neon-rose">¿Borrar?</span>
                              <button
                                onClick={() => borrarDraft(p)}
                                disabled={deletingId === p.id}
                                className="rounded-lg border border-neon-rose/50 bg-neon-rose/15 px-2 py-1 text-[10px] font-bold text-neon-rose disabled:opacity-50"
                              >
                                {deletingId === p.id ? 'Borrando...' : 'Sí'}
                              </button>
                              <button onClick={() => setDeleteConfirmId(null)} className="rounded-lg border border-chipi-border px-2 py-1 text-[10px] text-text-secondary">No</button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setDeleteConfirmId(p.id)}
                              className="rounded-lg border border-neon-rose/40 bg-neon-rose/10 px-2.5 py-1.5 text-[10px] font-bold text-neon-rose hover:bg-neon-rose/20"
                            >
                              Borrar draft
                            </button>
                          )
                        ) : (
                          <span className="text-[10px] text-text-dim">Historial protegido</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {pedidosFiltrados.length === 0 && (
                    <tr>
                      <td colSpan={6} className="p-8 text-center text-text-dim text-xs">No hay pedidos para mostrar</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'mapa' && (
          <div className="h-[calc(100vh-140px)]">
            <RosMap />
          </div>
        )}
        {tab === 'personalidad' && <PersonalidadPanel />}
        {tab === 'menu' && <MenuEditorPanel />}
        {tab === 'hardware' && <HardwareControlPanel />}
        {tab === 'ros2' && <Ros2DeliveryPanel liveEvent={ui.data} />}
        {tab === 'waiter' && <WaiterAssistancePanel token={token} liveEvent={ui.data} />}
        {tab === 'seguridad' && <SafetyOrdersPanel liveEvent={ui.data} />}
        {tab === 'sessions' && <SessionsPanel />}
        {tab === 'tables' && <TablesPanel token={token} liveEvent={ui.data} />}
        {tab === 'memory' && <MemoryPanel token={token} liveEvent={ui.data} />}
        {tab === 'speech' && <SpeechDiagnosticsPanel liveEvent={ui.data} />}
      </main>
    </div>
  );
}

function MetricCard({ label, value, color }) {
  return (
    <div className="glass rounded-2xl border border-chipi-border p-5 flex flex-col gap-1">
      <span className="text-[10px] text-text-secondary uppercase tracking-wider font-semibold">{label}</span>
      <span className="text-2xl font-bold font-mono" style={{ color, textShadow: `0 0 10px ${color}60` }}>{value}</span>
    </div>
  );
}

function EmptyData({ message }) {
  return (
    <div className="flex h-[200px] items-center justify-center rounded-xl border border-dashed border-chipi-border px-4 text-center text-xs text-text-dim">
      {message}
    </div>
  );
}

const ESTADO_MAP = {
  draft: { key: 'pendiente', label: 'Borrador', color: '#F43F5E', bg: '#F43F5E20' },
  pending_confirmation: { key: 'pendiente', label: 'Pendiente', color: '#F43F5E', bg: '#F43F5E20' },
  confirmed: { key: 'pendiente', label: 'Confirmado', color: '#F43F5E', bg: '#F43F5E20' },
  sent_to_kitchen: { key: 'pendiente', label: 'En cocina', color: '#F43F5E', bg: '#F43F5E20' },
  preparing: { key: 'preparando', label: 'Preparando', color: '#F59E0B', bg: '#F59E0B20' },
  ready: { key: 'listo', label: 'Listo', color: '#10B981', bg: '#10B98120' },
  delivered: { key: 'entregado', label: 'Entregado', color: '#60A5FA', bg: '#60A5FA20' },
  cancelled: { key: 'pendiente', label: 'Cancelado', color: '#64748B', bg: '#64748B20' },
  confirmado: { key: 'pendiente', label: 'Confirmado', color: '#F43F5E', bg: '#F43F5E20' },
  cancelado: { key: 'pendiente', label: 'Cancelado', color: '#64748B', bg: '#64748B20' },
  provisional: { key: 'pendiente', label: 'Pendiente', color: '#F43F5E', bg: '#F43F5E20' },
  en_preparacion: { key: 'preparando', label: 'Preparando', color: '#F59E0B', bg: '#F59E0B20' },
  listo: { key: 'listo', label: 'Listo', color: '#10B981', bg: '#10B98120' },
  entregado: { key: 'entregado', label: 'Entregado', color: '#60A5FA', bg: '#60A5FA20' },
};

function StatusBadge({ estado }) {
  const cfg = ESTADO_MAP[estado] || ESTADO_MAP.provisional;
  return (
    <span className="px-2.5 py-1 rounded-lg text-[10px] font-bold border" style={{ color: cfg.color, background: cfg.bg, borderColor: `${cfg.color}40` }}>
      {cfg.label}
    </span>
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
