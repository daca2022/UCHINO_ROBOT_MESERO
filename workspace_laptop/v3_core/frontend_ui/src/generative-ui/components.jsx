import { useEffect } from 'react';

/* ──────────────────────────────────────────────
 * Componentes generativos para la pantalla táctil
 * Renderizados por el LLM via render_ui tool
 * ────────────────────────────────────────────── */

// ── Dish Card (showDish) ──────────────────────
function DishCard({ nombre, precio, descripcion, imagen, delivery, categoria }) {
  return (
    <div className="animate-pop bg-[#0a0a1a] rounded-2xl p-5 border border-[#00f0ff30] shadow-[0_0_30px_rgba(0,240,255,0.15)] flex flex-col items-center gap-3 max-w-xs mx-auto">
      <div className="w-20 h-20 rounded-full bg-[#0d0d20] border-2 border-[#00f0ff] flex items-center justify-center text-4xl">
        {imagen ? (
          <img src={imagen} alt={nombre} className="w-full h-full rounded-full object-cover" />
        ) : (
          MENU_ICONS[categoria] || '🍽️'
        )}
      </div>
      <h2 className="text-lg font-bold neon-text-cyan text-center">{nombre}</h2>
      {descripcion && <p className="text-xs text-[#8888aa] text-center">{descripcion}</p>}
      <div className="flex gap-4 text-sm">
        <span className="neon-text-amber font-bold text-xl">S/ {precio}</span>
        {delivery !== undefined && (
          <span className="text-[#8888aa]">+ delivery S/ {delivery}</span>
        )}
      </div>
      {(delivery !== undefined) && (
        <div className="text-sm neon-text-green font-semibold">
          Total: S/ {precio + delivery}
        </div>
      )}
    </div>
  );
}

// ── Menu List (showMenu) ──────────────────────
function MenuListView({ categoria, platos }) {
  return (
    <div className="animate-pop bg-[#0a0a1a] rounded-2xl p-5 border border-[#00f0ff30] max-h-full overflow-y-auto">
      <div className="flex items-center gap-3 mb-4">
        <span className="text-2xl">{MENU_ICONS[categoria] || '📋'}</span>
        <h2 className="text-lg font-bold neon-text-cyan">{categoria || 'Menú'}</h2>
      </div>
      <div className="space-y-3">
        {(platos || []).map((p, i) => (
          <div key={i} className="flex justify-between items-center py-2 border-b border-[#00f0ff20]">
            <div>
              <div className="text-sm font-medium">{p.nombre}</div>
              {p.descripcion && <div className="text-xs text-[#8888aa]">{p.descripcion}</div>}
            </div>
            <span className="neon-text-amber font-semibold">S/ {p.precio}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Order Summary (showOrder) ──────────────────
function OrderSummary({ platos, total, nota }) {
  return (
    <div className="animate-pop bg-[#0a0a1a] rounded-2xl p-5 border border-[#ffd70030] shadow-[0_0_30px_rgba(255,215,0,0.1)]">
      <h2 className="text-lg font-bold neon-text-amber mb-4">🧾 Tu Pedido</h2>
      <div className="space-y-2 mb-4">
        {(platos || []).map((p, i) => (
          <div key={i} className="flex justify-between text-sm">
            <span>{p.nombre} <span className="text-[#8888aa]">x{p.cantidad}</span></span>
            <span>S/ {p.precio * p.cantidad}</span>
          </div>
        ))}
      </div>
      {nota && <p className="text-xs text-[#8888aa] mb-3">📝 {nota}</p>}
      <div className="flex justify-between pt-3 border-t border-[#ffd70030] neon-text-amber font-bold text-lg">
        <span>Total</span>
        <span>S/ {total}</span>
      </div>
    </div>
  );
}

// ── Total / Payment (showTotal) ────────────────
function TotalCard({ subtotal, delivery, total, metodo_pago }) {
  return (
    <div className="animate-pop bg-[#0a0a1a] rounded-2xl p-5 border border-[#00ff9d30] shadow-[0_0_30px_rgba(0,255,157,0.1)]">
      <h2 className="text-lg font-bold neon-text-green mb-4">💰 Cuenta</h2>
      <div className="space-y-2 text-sm">
        <div className="flex justify-between"><span>Subtotal</span><span>S/ {subtotal}</span></div>
        {delivery !== undefined && (
          <div className="flex justify-between"><span>Delivery</span><span>S/ {delivery}</span></div>
        )}
        <div className="flex justify-between pt-3 border-t border-[#00ff9d30] neon-text-green font-bold text-lg">
          <span>Total</span>
          <span>S/ {total}</span>
        </div>
        {metodo_pago && (
          <p className="text-xs text-[#8888aa] text-center pt-2">Pago: {metodo_pago}</p>
        )}
      </div>
    </div>
  );
}

// ── Alert (showAlert) ──────────────────────────
const ALERT_STYLES = {
  info: { border: '#00f0ff30', glow: 'rgba(0,240,255,0.15)', text: 'neon-text-cyan' },
  warning: { border: '#ffd70030', glow: 'rgba(255,215,0,0.15)', text: 'neon-text-amber' },
  error: { border: '#ff444430', glow: 'rgba(255,68,68,0.15)', text: 'text-red-400' },
  success: { border: '#00ff9d30', glow: 'rgba(0,255,157,0.15)', text: 'neon-text-green' },
};
const ALERT_ICONS = { info: 'ℹ️', warning: '⚠️', error: '❌', success: '✅' };

function AlertBanner({ mensaje, tipo }) {
  const style = ALERT_STYLES[tipo] || ALERT_STYLES.info;
  return (
    <div
      className="animate-pop bg-[#0a0a1a] rounded-2xl p-5 border text-center"
      style={{ borderColor: style.border, boxShadow: `0 0 30px ${style.glow}` }}
    >
      <div className="text-4xl mb-3">{ALERT_ICONS[tipo] || 'ℹ️'}</div>
      <p className={`text-sm font-medium ${style.text}`}>{mensaje}</p>
    </div>
  );
}

// ── Greeting (showGreeting) ────────────────────
function GreetingCard({ mensaje, nombre_cliente }) {
  return (
    <div className="animate-pop bg-[#0a0a1a] rounded-2xl p-6 border border-[#00f0ff30] text-center flex flex-col items-center gap-3">
      <span className="text-6xl animate-bounce">👋</span>
      {nombre_cliente && (
        <h2 className="text-2xl font-bold neon-text-cyan">¡{nombre_cliente}!</h2>
      )}
      <p className="text-sm text-[#e0e0ff]">{mensaje || 'Bienvenido a la Cafetería UTEC'}</p>
    </div>
  );
}

// ── Renderer por componente ────────────────────
const RENDERERS = {
  showDish: DishCard,
  showMenu: MenuListView,
  showOrder: OrderSummary,
  showTotal: TotalCard,
  showAlert: AlertBanner,
  showGreeting: GreetingCard,
};

// ── Overlay que envuelve el componente ─────────
export function GenerativeOverlay({ component, props, onDismiss }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 15000); // auto-dismiss after 15s
    const handleTap = (e) => {
      if (e.target.closest('[data-overlay]')) onDismiss();
    };
    window.addEventListener('click', handleTap);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('click', handleTap);
    };
  }, [onDismiss]);

  const Component = RENDERERS[component];
  if (!Component) return null;

  return (
    <div
      data-overlay
      className="absolute inset-0 z-50 flex items-center justify-center bg-[#050510]/80 backdrop-blur-sm p-6"
      onClick={onDismiss}
    >
      <div className="w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <Component {...props} />
        <button
          onClick={onDismiss}
          className="block mx-auto mt-4 text-xs text-[#8888aa] hover:text-white transition-colors"
        >
          Toca para cerrar ✕
        </button>
      </div>
    </div>
  );
}

const MENU_ICONS = { platos: '🍖', bebidas: '🥤', postres: '🍰' };
