import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../AuthContext.jsx';

const DEFAULT_ARM_POSITIONS = {
  left: { dof1: 0.35, dof2: 0.8 },
  right: { dof1: -0.35, dof2: 0.8 },
};

const ACTIONS = [
  { id: 'start', label: 'Iniciar entrega', endpoint: '/api/admin/ros2/entrega/iniciar' },
  { id: 'kitchen', label: 'Confirmar llegada a cocina', endpoint: '/api/admin/ros2/entrega/confirmar-cocina' },
  { id: 'pickup', label: 'Confirmar bandeja recogida', endpoint: '/api/admin/ros2/entrega/confirmar-recogida' },
  { id: 'table', label: 'Confirmar llegada a mesa', endpoint: '/api/admin/ros2/entrega/confirmar-mesa' },
  { id: 'finish', label: 'Finalizar entrega', endpoint: '/api/admin/ros2/entrega/finalizar' },
  { id: 'cancel', label: 'Cancelar simulación', endpoint: '/api/admin/ros2/entrega/cancelar' },
];

const STATE_FOR_ACTION = {
  kitchen: 'going_to_kitchen',
  pickup: 'picking_up',
  table: 'going_to_table',
  finish: 'delivering',
};

function formatTimestamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('es-PE');
}

function statusClasses(status) {
  if (status === 'current') return 'border-neon-amber/60 bg-neon-amber/10 text-neon-amber';
  if (status === 'completed') return 'border-neon-green/50 bg-neon-green/10 text-neon-green';
  if (status === 'cancelled') return 'border-neon-rose/50 bg-neon-rose/10 text-neon-rose';
  return 'border-chipi-border bg-black/10 text-text-dim';
}

function SectionTitle({ children, detail }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
      <h3 className="text-xs font-bold uppercase tracking-wider text-text-secondary">{children}</h3>
      {detail && <span className="text-[10px] text-text-dim">{detail}</span>}
    </div>
  );
}

function ArmInput({ label, value, onChange }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-[10px] text-text-secondary">
      <span>{label}</span>
      <input
        type="number"
        step="0.01"
        inputMode="decimal"
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full rounded-lg border border-chipi-border bg-chipi-bg px-2 py-2 text-xs text-text-primary outline-none focus:border-neon-cyan/70"
      />
    </label>
  );
}

export default function Ros2DeliveryPanel({ liveEvent }) {
  const { token } = useAuth();
  const [snapshot, setSnapshot] = useState(null);
  const [selectedOrderId, setSelectedOrderId] = useState('');
  const [armPositions, setArmPositions] = useState(DEFAULT_ARM_POSITIONS);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);

  const headers = useMemo(() => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  }), [token]);

  const loadSnapshot = useCallback(async (silent = false) => {
    if (!token) return;
    if (!silent) setLoading(true);
    try {
      const response = await fetch('/api/admin/ros2/estado', { headers });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setSnapshot(body);
      setError(null);
      setSelectedOrderId((current) => body.active_order_id || current || body.ready_orders?.[0]?.id || '');
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [headers, token]);

  useEffect(() => {
    loadSnapshot();
    const timer = setInterval(() => loadSnapshot(true), 2000);
    return () => clearInterval(timer);
  }, [loadSnapshot]);

  useEffect(() => {
    if (liveEvent?.type === 'ros2_event') loadSnapshot(true);
  }, [liveEvent, loadSnapshot]);

  const activeState = snapshot?.state || 'idle';
  const readyOrders = snapshot?.ready_orders || [];
  const selectedOrder = readyOrders.find((order) => order.id === selectedOrderId) || null;
  const events = snapshot?.events || [];
  const latestSpeech = events.find((event) => event.topic === '/uchino/speech/text')?.payload?.text;
  const canStart = Boolean(selectedOrder)
    && ['idle', 'delivered', 'cancelled'].includes(activeState)
    && !busy;

  function updateArmPosition(side, dof, value) {
    setArmPositions((current) => ({
      ...current,
      [side]: { ...current[side], [dof]: value },
    }));
  }

  async function runAction(action) {
    if (action.id === 'start' && !canStart) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const body = action.id === 'start'
        ? { order_id: selectedOrderId, arm_positions: armPositions }
        : {
          order_id: snapshot?.active_order_id,
          simulation_id: snapshot?.active?.simulation_id,
        };
      const response = await fetch(action.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      const next = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(next.error || `HTTP ${response.status}`);
      setSnapshot(next);
      setSelectedOrderId(next.active_order_id || selectedOrderId);
      setMessage(`${action.label}: listo`);
    } catch (actionError) {
      setError(actionError.message);
    } finally {
      setBusy(false);
    }
  }

  function actionDisabled(action) {
    if (busy) return true;
    if (action.id === 'start') return !canStart;
    if (action.id === 'cancel') return !snapshot?.active || ['idle', 'delivered', 'cancelled'].includes(activeState);
    return STATE_FOR_ACTION[action.id] !== activeState;
  }

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[10px] uppercase tracking-[0.2em] text-neon-cyan">Admin / operación</p>
          <h2 className="mt-1 text-xl font-bold text-text-primary">ROS 2 / Flujo del robot</h2>
          <p className="mt-1 max-w-3xl text-xs text-text-secondary">
            Monitor de tópicos y entrega simulada con avance manual. El pedido seleccionado debe estar listo en cocina.
          </p>
        </div>
        <span className="rounded-lg border border-neon-amber/60 bg-neon-amber/10 px-3 py-2 text-[11px] font-bold text-neon-amber">
          Modo simulación · ROS 2 real no disponible
        </span>
      </div>

      {error && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-neon-rose/50 bg-neon-rose/10 p-3 text-xs text-neon-rose">
          <span>{error}</span>
          <button type="button" onClick={() => loadSnapshot()} className="rounded-lg border border-neon-rose/50 px-3 py-1.5 font-semibold hover:bg-neon-rose/10">
            Reintentar
          </button>
        </div>
      )}
      {message && <div className="rounded-xl border border-neon-green/40 bg-neon-green/10 p-3 text-xs text-neon-green">{message}</div>}

      <div className="grid min-w-0 grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
        <div className="min-w-0 space-y-5">
          <div className="glass min-w-0 rounded-2xl border border-chipi-border p-4 sm:p-5">
            <SectionTitle detail={loading ? 'Sincronizando…' : `Estado: ${activeState}`}>Control de entrega</SectionTitle>
            <div className="grid min-w-0 grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(180px,0.42fr)]">
              <label className="flex min-w-0 flex-col gap-1 text-[10px] text-text-secondary">
                <span>Pedido listo</span>
                <select
                  value={selectedOrderId}
                  onChange={(event) => setSelectedOrderId(event.target.value)}
                  disabled={busy || !['idle', 'delivered', 'cancelled'].includes(activeState)}
                  className="min-w-0 rounded-lg border border-chipi-border bg-chipi-bg px-2 py-2 text-xs text-text-primary outline-none focus:border-neon-cyan/70 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <option value="">Selecciona un pedido listo</option>
                  {readyOrders.map((order) => (
                    <option key={order.id} value={order.id}>
                      {order.id.slice(0, 8)} · {order.mesa} · S/ {order.total.toFixed(2)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="rounded-lg border border-chipi-border bg-black/10 px-3 py-2 text-[10px] text-text-secondary">
                <span className="block text-text-dim">Pedido activo</span>
                <strong className="mt-1 block break-all text-text-primary">{snapshot?.active_order_id || 'ninguno'}</strong>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {ACTIONS.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  onClick={() => runAction(action)}
                  disabled={actionDisabled(action)}
                  className={`min-h-11 rounded-xl border px-3 py-2 text-left text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${action.id === 'cancel' ? 'border-neon-rose/40 text-neon-rose hover:bg-neon-rose/10' : action.id === 'start' || action.id === 'finish' ? 'border-neon-green/50 text-neon-green hover:bg-neon-green/10' : 'border-neon-cyan/40 text-neon-cyan hover:bg-neon-cyan/10'}`}
                >
                  {action.label}
                  <span className="mt-0.5 block text-[9px] font-normal text-text-dim">
                    {action.id === 'start' ? 'Solo pedido ready' : action.id === 'cancel' ? 'Cierra sin cambiar el pedido' : `Requiere ${STATE_FOR_ACTION[action.id] || 'selección'}`}
                  </span>
                </button>
              ))}
            </div>

            {snapshot?.active?.state === 'picking_up' && (
              <div className="mt-4 rounded-xl border border-neon-amber/40 bg-neon-amber/10 p-3 text-xs text-neon-amber">
                Simulación de recogida: espera configurada de {snapshot.pickup_wait_seconds} segundos. La confirmación manual puede avanzar la demostración; el temporizador no es la autoridad.
              </div>
            )}
          </div>

          <div className="glass min-w-0 rounded-2xl border border-chipi-border p-4 sm:p-5">
            <SectionTitle detail="2 grados de libertad por brazo">Posiciones configurables</SectionTitle>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-chipi-border p-3">
                <p className="mb-2 text-[11px] font-bold text-text-primary">Brazo izquierdo</p>
                <div className="grid grid-cols-2 gap-2">
                  <ArmInput label="DOF 1" value={armPositions.left.dof1} onChange={(value) => updateArmPosition('left', 'dof1', value)} />
                  <ArmInput label="DOF 2" value={armPositions.left.dof2} onChange={(value) => updateArmPosition('left', 'dof2', value)} />
                </div>
              </div>
              <div className="rounded-xl border border-chipi-border p-3">
                <p className="mb-2 text-[11px] font-bold text-text-primary">Brazo derecho</p>
                <div className="grid grid-cols-2 gap-2">
                  <ArmInput label="DOF 1" value={armPositions.right.dof1} onChange={(value) => updateArmPosition('right', 'dof1', value)} />
                  <ArmInput label="DOF 2" value={armPositions.right.dof2} onChange={(value) => updateArmPosition('right', 'dof2', value)} />
                </div>
              </div>
            </div>
          </div>

          <div className="glass min-w-0 rounded-2xl border border-chipi-border p-4 sm:p-5">
            <SectionTitle>Timeline</SectionTitle>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
              {(snapshot?.timeline || []).map((step) => (
                <div key={step.state} className={`min-w-0 rounded-xl border p-3 ${statusClasses(step.status)}`}>
                  <span className="block text-[9px] uppercase tracking-wider opacity-70">{step.status}</span>
                  <span className="mt-1 block text-[11px] font-semibold leading-tight">{step.label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="min-w-0 space-y-5">
          <div className="glass min-w-0 rounded-2xl border border-chipi-border p-4 sm:p-5">
            <SectionTitle detail={snapshot?.publisher || 'simulated'}>Estado del publicador</SectionTitle>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div><span className="block text-[10px] text-text-dim">modo</span><strong className="text-neon-amber">{snapshot?.mode || 'simulation'}</strong></div>
              <div><span className="block text-[10px] text-text-dim">ROS 2 real</span><strong className="text-neon-rose">{snapshot?.real_available ? 'disponible' : 'no disponible'}</strong></div>
              <div><span className="block text-[10px] text-text-dim">rosbridge</span><strong className="text-text-primary">{snapshot?.rosbridge ? 'conectado' : 'no conectado'}</strong></div>
              <div><span className="block text-[10px] text-text-dim">eventos</span><strong className="text-text-primary">{events.length}</strong></div>
            </div>
            {latestSpeech && (
              <div className="mt-4 rounded-xl border border-neon-cyan/30 bg-neon-cyan/5 p-3">
                <span className="block text-[10px] uppercase tracking-wider text-neon-cyan">Última voz simulada</span>
                <p className="mt-1 text-xs leading-relaxed text-text-primary">{latestSpeech}</p>
              </div>
            )}
          </div>

          <div className="glass min-w-0 rounded-2xl border border-chipi-border p-4 sm:p-5">
            <SectionTitle detail={`${snapshot?.topics?.length || 0} tópicos permitidos`}>Catálogo de tópicos</SectionTitle>
            <div className="space-y-2">
              {(snapshot?.topics || []).map((topic) => (
                <div key={topic.topic} className="min-w-0 rounded-xl border border-chipi-border p-3">
                  <code className="block break-all text-[10px] text-neon-cyan">{topic.topic}</code>
                  <span className="mt-1 block break-all text-[10px] text-text-secondary">{topic.message_type}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="glass min-w-0 rounded-2xl border border-chipi-border p-4 sm:p-5">
            <SectionTitle detail={`${Math.min(events.length, 20)} recientes`}>Publicaciones</SectionTitle>
            <div className="space-y-3">
              {events.slice(0, 20).map((event) => (
                <article key={event.id} className="min-w-0 rounded-xl border border-chipi-border bg-black/10 p-3">
                  <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                    <code className="min-w-0 break-all text-[10px] text-neon-cyan">{event.topic}</code>
                    <span className={`shrink-0 rounded-md border px-2 py-1 text-[9px] font-bold ${event.publication_state === 'simulated' ? 'border-neon-amber/40 text-neon-amber' : event.publication_state === 'failed' ? 'border-neon-rose/40 text-neon-rose' : 'border-neon-green/40 text-neon-green'}`}>
                      {event.publication_state}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-1 gap-1 text-[10px] text-text-dim sm:grid-cols-2">
                    <span className="break-all">tipo: {event.message_type}</span>
                    <span>hora: {formatTimestamp(event.timestamp)}</span>
                    <span className="break-all">origen: {event.origin}</span>
                  </div>
                  <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-chipi-bg p-2 text-[10px] leading-relaxed text-text-secondary">{JSON.stringify(event.payload, null, 2)}</pre>
                </article>
              ))}
              {!events.length && <p className="rounded-xl border border-dashed border-chipi-border p-5 text-center text-xs text-text-dim">Aún no hay publicaciones simuladas.</p>}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
