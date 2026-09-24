import { useEffect, useState } from 'react';
import { useAuth } from '../AuthContext.jsx';

function itemsOf(order) {
  if (Array.isArray(order.items)) return order.items;
  if (Array.isArray(order.platos)) return order.platos;
  return [];
}

function dateText(value) {
  if (!value) return 'Sin hora';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Sin hora' : new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export default function SafetyOrdersPanel({ liveEvent }) {
  const { token } = useAuth();
  const [orders, setOrders] = useState([]);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState('');

  async function load() {
    try {
      const headers = { Authorization: `Bearer ${token}` };
      const [ordersResponse, eventsResponse] = await Promise.all([
        fetch('/api/admin/seguridad/pedidos', { headers }),
        fetch('/api/admin/seguridad/eventos?limit=40', { headers }),
      ]);
      if (!ordersResponse.ok || !eventsResponse.ok) throw new Error('No se pudo cargar el panel de seguridad');
      const orderBody = await ordersResponse.json();
      const eventBody = await eventsResponse.json();
      setOrders(orderBody.data || []);
      setEvents(eventBody.data || []);
      setError('');
    } catch (loadError) {
      setError(loadError.message);
    }
  }

  useEffect(() => { void load(); }, [token]);
  useEffect(() => {
    if (liveEvent?.type === 'order_safety_event') void load();
  }, [liveEvent]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div><p className="text-[10px] uppercase tracking-wider text-neon-rose">Seguridad operativa</p><h2 className="text-xl font-bold text-text-primary">Alergias, restricciones y observaciones</h2></div>
        <button onClick={() => void load()} className="rounded-xl border border-neon-cyan/40 px-3 py-2 text-xs font-semibold text-neon-cyan">Reintentar</button>
      </div>
      {error && <div className="rounded-xl border border-neon-rose/50 bg-neon-rose/10 p-3 text-xs text-neon-rose" role="alert">{error}</div>}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <section className="glass rounded-2xl border border-chipi-border p-4">
          <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-text-secondary">Pedidos con revisión especial</h3>
          <div className="space-y-3">
            {orders.map(order => <article key={order.id} className="rounded-xl border border-neon-rose/40 bg-neon-rose/5 p-3"><div className="flex justify-between gap-2 text-xs"><strong className="text-neon-cyan">Mesa {order.mesa || order.table_id || '—'}</strong><time className="text-text-dim">{dateText(order.timestamp)}</time></div><p className="mt-1 text-xs text-text-primary">{itemsOf(order).map(item => `${item.nombre} ×${item.cantidad || 1}`).join(', ')}</p>{order.declared_allergies?.length > 0 && <p className="mt-1 text-xs font-bold text-neon-rose">Alergias: {order.declared_allergies.join(', ')}</p>}{order.special_warning && <p className="mt-1 text-[11px] text-neon-amber">{order.special_warning}</p>}<p className="mt-1 text-[10px] text-text-dim">Confirmación especial: {order.special_confirmation?.decision || 'pendiente'}</p></article>)}
            {orders.length === 0 && <p className="text-xs text-text-dim">No hay pedidos con alertas registrados.</p>}
          </div>
        </section>
        <section className="glass rounded-2xl border border-chipi-border p-4">
          <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-text-secondary">Eventos trazables</h3>
          <div className="max-h-[420px] overflow-y-auto space-y-2">
            {events.map(event => <div key={event.id || `${event.event}-${event.timestamp}`} className="rounded-lg border border-chipi-border px-3 py-2 text-xs"><div className="flex justify-between gap-2"><span className="font-semibold text-neon-cyan">{event.event}</span><time className="text-text-dim">{dateText(event.timestamp)}</time></div><p className="mt-1 text-text-secondary">Mesa {event.mesa || '—'} · origen {event.source || 'backend'}</p></div>)}
            {events.length === 0 && <p className="text-xs text-text-dim">Todavía no hay eventos de seguridad.</p>}
          </div>
        </section>
      </div>
    </div>
  );
}
