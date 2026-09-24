const STATUS_CONFIG = {
  idle: {
    label: 'En espera',
    icon: '⏸️',
    color: '#8888aa',
    glow: '#8888aa',
    description: 'Robot listo para atender',
  },
  listening: {
    label: 'Escuchando',
    icon: '🎤',
    color: '#00f0ff',
    glow: '#00f0ff',
    description: 'Procesando tu voz...',
  },
  speaking: {
    label: 'Hablando',
    icon: '🔊',
    color: '#00ff9d',
    glow: '#00ff9d',
    description: 'Respondiendo...',
  },
  thinking: {
    label: 'Pensando',
    icon: '🧠',
    color: '#bf00ff',
    glow: '#bf00ff',
    description: 'Analizando...',
  },
};

function ListeningWave() {
  return (
    <div className="flex items-center gap-0.5 h-8">
      {[4, 8, 12, 8, 4].map((h, i) => (
        <span
          key={i}
          className="w-1 rounded-full inline-block"
          style={{
            height: `${h}px`,
            backgroundColor: '#00f0ff',
            boxShadow: '0 0 6px #00f0ff80',
            animation: `listenBar 0.6s ease-in-out ${i * 0.1}s infinite alternate`,
          }}
        />
      ))}
    </div>
  );
}

function ThinkingSpinner() {
  return (
    <div className="relative w-10 h-10">
      <div
        className="absolute inset-0 rounded-full border-2 border-transparent border-t-[#bf00ff]"
        style={{ animation: 'spin 1s linear infinite' }}
      />
      <div
        className="absolute inset-1 rounded-full border-2 border-transparent border-t-[#bf00ff]/60"
        style={{ animation: 'spin 1.5s linear infinite reverse' }}
      />
    </div>
  );
}

function SpeakingPulse() {
  return (
    <div className="flex items-center gap-1">
      <span
        className="w-2 h-2 rounded-full inline-block"
        style={{
          backgroundColor: '#00ff9d',
          boxShadow: '0 0 10px #00ff9d',
          animation: 'speakPulse 0.5s ease-in-out infinite alternate',
        }}
      />
      <span
        className="w-2 h-2 rounded-full inline-block"
        style={{
          backgroundColor: '#00ff9d',
          boxShadow: '0 0 10px #00ff9d',
          animation: 'speakPulse 0.5s ease-in-out 0.15s infinite alternate',
        }}
      />
      <span
        className="w-2 h-2 rounded-full inline-block"
        style={{
          backgroundColor: '#00ff9d',
          boxShadow: '0 0 10px #00ff9d',
          animation: 'speakPulse 0.5s ease-in-out 0.3s infinite alternate',
        }}
      />
    </div>
  );
}

export default function StatusPanel({ status = 'idle' }) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.idle;

  const indicator = (() => {
    switch (status) {
      case 'listening':
        return <ListeningWave />;
      case 'thinking':
        return <ThinkingSpinner />;
      case 'speaking':
        return <SpeakingPulse />;
      default:
        return (
          <div
            className="w-3 h-3 rounded-full"
            style={{
              backgroundColor: config.color,
              boxShadow: `0 0 8px ${config.glow}`,
            }}
          />
        );
    }
  })();

  return (
    <div
      className="flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-300"
      style={{
        background: `linear-gradient(135deg, ${config.color}08, ${config.color}04)`,
        border: `1px solid ${config.color}20`,
        boxShadow: `0 0 12px ${config.glow}10`,
      }}
    >
      <div className="flex items-center justify-center w-10 h-10 shrink-0">
        {indicator}
      </div>

      <div className="flex flex-col min-w-0">
        <span
          className="text-sm font-semibold"
          style={{ color: config.color, textShadow: `0 0 6px ${config.glow}40` }}
        >
          {config.label}
        </span>
        <span className="text-xs text-[#8888aa] truncate">{config.description}</span>
      </div>

      <span className="text-xl ml-auto opacity-70">{config.icon}</span>
    </div>
  );
}
