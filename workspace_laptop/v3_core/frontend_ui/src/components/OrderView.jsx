export default function OrderView({ items = [], onConfirm, onCancel }) {
  const total = items.reduce((sum, i) => sum + (i.precio || 0) * (i.cantidad || 1), 0);
  const isEmpty = items.length === 0;

  return (
    <div className="flex-1 flex flex-col p-4">
      <div className="flex items-center justify-between mb-4 shrink-0">
        <h2 className="text-base font-semibold text-[#e0e0ff] flex items-center gap-2">
          <span className="text-xl">🛒</span>
          Tu Pedido
        </h2>
        {!isEmpty && (
          <span className="text-xs text-[#8888aa] bg-[#0a0a1a] px-2 py-1 rounded-full border border-[#00f0ff20]">
            {items.length} {items.length === 1 ? 'item' : 'items'}
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {isEmpty ? (
          <div className="flex flex-col items-center justify-center h-full text-[#555577] gap-3">
            <span className="text-5xl opacity-30">🛒</span>
            <p className="text-sm">Tu carrito está vacío</p>
            <p className="text-xs text-[#555577]/60">Selecciona platos del menú</p>
          </div>
        ) : (
          <div className="space-y-1">
            {items.map((item, i) => (
              <div
                key={item.nombre || i}
                className={
                  'flex justify-between items-center py-3 px-3 rounded-lg ' +
                  'border-b border-[#00f0ff10] last:border-0 ' +
                  'hover:bg-[#0d0d20]/50 transition-colors ' +
                  'animate-[fadeInUp_0.3s_ease-out_forwards]'
                }
                style={{ animationDelay: `${i * 50}ms` }}
              >
                <div className="flex items-center gap-3">
                  <span className="text-lg">
                    {item.categoria === 'bebidas' ? '🥤' : item.categoria === 'postres' ? '🍰' : '🍖'}
                  </span>
                  <div>
                    <span className="text-sm text-[#e0e0ff]">{item.nombre}</span>
                    <span className="text-[#8888aa] text-xs ml-2 bg-[#0a0a1a] px-1.5 py-0.5 rounded">
                      x{item.cantidad || 1}
                    </span>
                  </div>
                </div>
                <span className="neon-text-amber font-semibold text-sm">
                  S/ {(item.precio || 0) * (item.cantidad || 1)}.00
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {!isEmpty && (
        <div className="shrink-0 pt-3 border-t border-[#00f0ff20] space-y-3">
          <div className="flex justify-between items-center text-sm">
            <span className="text-[#8888aa]">Total</span>
            <span className="neon-text-amber font-bold text-xl">S/ {total}.00</span>
          </div>

          <div className="flex gap-3">
            <button
              onClick={onCancel}
              className={
                'flex-1 py-3 rounded-xl text-sm font-medium transition-all duration-200 ' +
                'bg-[#0a0a1a] hover:bg-[#ff333320] text-[#ff5555] ' +
                'border border-[#ff333330] hover:border-[#ff333360] ' +
                'hover:shadow-[0_0_12px_rgba(255,50,50,0.2)] active:scale-[0.98]'
              }
            >
              Cancelar
            </button>
            <button
              onClick={onConfirm}
              className={
                'flex-1 py-3 rounded-xl text-sm font-semibold transition-all duration-200 ' +
                'bg-[#00ff9d] hover:bg-[#00e68a] text-[#050510] ' +
                'active:scale-[0.98] ' +
                'shadow-[0_0_15px_rgba(0,255,157,0.4)] hover:shadow-[0_0_25px_rgba(0,255,157,0.6)]'
              }
            >
              Confirmar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
