// SVG icon components for each category (inline, no emoji font needed)
function CategoryIcon({ letter, bgColor, size }) {
  const s = size || 48;
  return (
    <svg width={s} height={s} viewBox="0 0 48 48">
      <circle cx="24" cy="24" r="22" fill={bgColor} opacity="0.9"/>
      <text x="24" y="24" textAnchor="middle" dominantBaseline="central"
        fill="white" fontSize="22" fontWeight="bold" fontFamily="sans-serif">
        {letter}
      </text>
    </svg>
  );
}

const CATEGORY_STYLES = {
  platos: {
    gradient: 'linear-gradient(135deg, #92400e 0%, #78350f 100%)',
    border: '#b4530960',
    letter: 'P',
    bg: '#b45309',
    shadow: '0 4px 15px rgba(146, 64, 14, 0.4)',
  },
  bebidas: {
    gradient: 'linear-gradient(135deg, #0e7490 0%, #155e75 100%)',
    border: '#06b6d460',
    letter: 'B',
    bg: '#0ea5e9',
    shadow: '0 4px 15px rgba(14, 116, 144, 0.4)',
  },
  postres: {
    gradient: 'linear-gradient(135deg, #be185d 0%, #9d174d 100%)',
    border: '#e11d4860',
    letter: 'Po',
    bg: '#e11d48',
    shadow: '0 4px 15px rgba(190, 24, 93, 0.4)',
  },
  entradas: {
    gradient: 'linear-gradient(135deg, #15803d 0%, #166534 100%)',
    border: '#22c55e60',
    letter: 'E',
    bg: '#22c55e',
    shadow: '0 4px 15px rgba(21, 128, 61, 0.4)',
  },
  sopas: {
    gradient: 'linear-gradient(135deg, #a16207 0%, #854d0e 100%)',
    border: '#eab30860',
    letter: 'S',
    bg: '#eab308',
    shadow: '0 4px 15px rgba(161, 98, 7, 0.4)',
  },
};

const DEFAULT_STYLE = {
  gradient: 'linear-gradient(135deg, #6b21a8 0%, #581c87 100%)',
  border: '#a855f760',
  letter: 'M',
  bg: '#a855f7',
  shadow: '0 4px 15px rgba(107, 33, 168, 0.4)',
};

export default function MenuView({ items = [], onItemClick }) {
  if (!items.length) {
    return (
      <div className="flex-1 flex items-center justify-center text-[#a89b8c] text-sm">
        <div className="text-center">
          <div className="flex justify-center mb-2">
            <svg width="40" height="40" viewBox="0 0 40 40" className="animate-bounce">
              <rect x="8" y="6" width="24" height="28" rx="3" fill="#f59e0b" opacity="0.6"/>
              <line x1="12" y1="14" x2="28" y2="14" stroke="white" strokeWidth="2" opacity="0.8"/>
              <line x1="12" y1="20" x2="25" y2="20" stroke="white" strokeWidth="2" opacity="0.8"/>
              <line x1="12" y1="26" x2="22" y2="26" stroke="white" strokeWidth="2" opacity="0.8"/>
            </svg>
          </div>
          <p>Cargando menu...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-3 grid grid-cols-2 gap-3 content-start">
      {items.map((item, i) => {
        const style = CATEGORY_STYLES[item.categoria] || DEFAULT_STYLE;
        return (
          <button
            key={item.nombre}
            onClick={() => onItemClick?.(item.nombre)}
            className="rounded-2xl overflow-hidden flex flex-col items-center transition-all duration-200 hover:scale-[1.03] active:scale-[0.97] min-h-[120px] justify-center gap-1.5 opacity-0"
            style={{
              background: style.gradient,
              border: `1px solid ${style.border}`,
              boxShadow: style.shadow,
              animation: 'fadeInUp 0.3s ease-out forwards',
              animationDelay: `${i * 60}ms`,
            }}
          >
            <CategoryIcon letter={style.letter} bgColor={style.bg} size={52} />
            <span className="text-xs font-semibold text-center leading-tight text-white/90 px-2">
              {item.nombre}
            </span>
            <span className="text-sm font-bold text-amber-200">
              S/ {item.precio}.00
            </span>
          </button>
        );
      })}
    </div>
  );
}
