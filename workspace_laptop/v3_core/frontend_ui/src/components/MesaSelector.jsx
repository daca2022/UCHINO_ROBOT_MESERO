import { useState, useEffect, useRef } from 'react';
import { useApi } from '../hooks.js';

export default function MesaSelector({ currentMesa, onSelect, onClose, liveEvent }) {
  const mesas = useApi('/api/mesas', { interval: 60000 });
  const list = Array.isArray(mesas.data?.data) ? mesas.data.data : [];
  const [busyTable, setBusyTable] = useState(null);
  const lastVersionsRef = useRef(new Map());

  useEffect(() => {
    const incomingTables = mesas.data?.data || [];
    incomingTables.forEach(table => {
      const version = Number(table.version || 0);
      if (version > (lastVersionsRef.current.get(table.table_id) || 0)) lastVersionsRef.current.set(table.table_id, version);
    });
  }, [mesas.data]);

  useEffect(() => {
    if (!(liveEvent?.type?.startsWith('table_') || liveEvent?.type === 'additional_order_started')) return;
    const tableId = liveEvent.table_id || liveEvent.table?.table_id;
    const version = Number(liveEvent.version || liveEvent.table?.version || 0);
    const previousVersion = tableId ? (lastVersionsRef.current.get(tableId) || 0) : 0;
    if (tableId && version > 0 && version <= previousVersion) return;
    if (tableId && version > 0) lastVersionsRef.current.set(tableId, version);
    mesas.reload();
  }, [liveEvent]);

  function statusLabel(status) {
    return {
      available: 'Disponible',
      occupied: 'Ocupada',
      ordering: 'Pidiendo',
      order_confirmed: 'Confirmada',
      preparing: 'Preparando',
      ready: 'Lista',
      delivery_in_progress: 'En entrega',
      served: 'Atendida',
      closed: 'Cerrada',
    }[status] || 'Ocupada';
  }

  function isAvailable(table) {
    return table.enabled !== false && ['available', 'closed'].includes(table.status);
  }

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="glass rounded-2xl p-6 border border-chipi-border max-w-2xl w-full mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-center mb-4">
          <h2 className="text-2xl font-bold neon-text-cyan mb-1">Selecciona tu mesa</h2>
          <p className="text-xs text-text-secondary">
            Toca el número de tu mesa. {currentMesa && `Actual: Mesa ${currentMesa}`}
          </p>
        </div>
        {mesas.loading && !mesas.data && <p className="rounded-xl border border-chipi-border bg-chipi-card/60 p-4 text-center text-xs text-text-secondary">Cargando disponibilidad real de mesas...</p>}
        {mesas.error && (
          <div className="rounded-xl border border-neon-rose/40 bg-neon-rose/10 p-4 text-center text-xs text-neon-rose" role="alert">
            No se pudo cargar la disponibilidad de mesas. <button onClick={mesas.reload} className="font-bold underline">Reintentar</button>
          </div>
        )}
        {!mesas.loading && !mesas.error && list.length === 0 && <p className="rounded-xl border border-chipi-border bg-chipi-card/60 p-4 text-center text-xs text-text-secondary">No hay mesas habilitadas para seleccionar.</p>}
        {list.length > 0 && <div className="grid grid-cols-4 gap-3">
          {list.map(rawTable => {
            const table = typeof rawTable === 'string'
              ? { table_id: String(rawTable).startsWith('M') ? String(rawTable) : `M${rawTable}`, status: 'available', enabled: true }
              : rawTable;
            const mesa = table.table_id;
            const available = isAvailable(table);
            return (
              <button
                key={mesa}
                onClick={() => available ? onSelect(mesa, 'initial', table) : setBusyTable(table)}
                className={`aspect-square rounded-xl text-xl font-bold transition-all active:scale-95 border-2 flex flex-col items-center justify-center gap-1 ${
                  currentMesa === mesa
                    ? 'bg-neon-cyan/30 border-neon-cyan text-white shadow-lg'
                    : available
                      ? 'bg-white/5 border-white/10 text-text-primary hover:bg-neon-cyan/20 hover:border-neon-cyan/50'
                      : 'bg-neon-amber/10 border-neon-amber/30 text-neon-amber/80'
                }`}
                aria-label={`Mesa ${mesa}, ${statusLabel(table.status)}`}
              >
                <span>{mesa}</span>
                <span className="text-[9px] font-semibold leading-none">{statusLabel(table.status)}</span>
              </button>
            );
          })}
        </div>}
        {busyTable && (
          <div className="mt-4 rounded-xl border border-neon-amber/40 bg-neon-amber/10 p-3 text-center">
            <p className="text-xs font-semibold text-neon-amber">{busyTable.table_id} tiene una visita activa.</p>
            <p className="mt-1 text-[10px] text-text-secondary">Continúa la visita o inicia un pedido adicional.</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                onClick={() => onSelect(busyTable.table_id, 'continue', busyTable)}
                className="rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-2 py-2 text-[10px] font-bold text-neon-cyan"
              >
                Continuar visita
              </button>
              <button
                onClick={() => onSelect(busyTable.table_id, 'additional', busyTable)}
                className="rounded-lg border border-neon-amber/40 bg-neon-amber/10 px-2 py-2 text-[10px] font-bold text-neon-amber"
              >
                Pedido adicional
              </button>
            </div>
          </div>
        )}
        <div className="mt-4 text-center">
          <button
            onClick={onClose}
            className="text-xs text-text-secondary hover:text-text-primary"
          >
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
