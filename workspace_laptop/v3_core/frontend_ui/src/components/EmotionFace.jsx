const EMOTION_CONFIG = {
  feliz: {
    color: '#fbbf24',
    text: '\u00a1Qu\u00e9 alegr\u00eda!',
    animClass: 'animate-eye-happy',
  },
  emocionado: {
    color: '#f59e0b',
    text: '\u00a1Emocionado!',
    animClass: 'animate-eye-celebrate',
  },
  pensando: {
    color: '#a855f7',
    text: 'Pensando...',
    animClass: 'animate-eye-think',
  },
  sorprendido: {
    color: '#fbbf24',
    text: '\u00a1Wow!',
    animClass: 'animate-eye-surprise',
  },
  'gui\u00f1o': {
    color: '#f43f5e',
    text: '\u00a1Entendido!',
    animClass: '',
  },
  triste: {
    color: '#6b7fa3',
    text: 'Lo siento...',
    animClass: 'animate-eye-sad',
  },
  celebrando: {
    color: '#fbbf24',
    text: '\u00a1Celebrando!',
    animClass: 'animate-eye-celebrate',
  },
  saludando: {
    color: '#34d399',
    text: '\u00a1Hola!',
    animClass: 'animate-eye-greet',
  },
  escuchando: {
    color: '#22d3ee',
    text: 'Te escucho...',
    animClass: 'animate-eye-listen',
  },
};

function RobotEyes({ emotion, color }) {
  const eyeColor = color || '#fbbf24';
  const pupilColor = '#1a1520';

  switch (emotion) {
    case 'feliz':
    case 'emocionado':
      return (
        <svg viewBox="0 0 200 120" className="w-40 h-24">
          <g className="animate-eye-happy">
            <ellipse cx="60" cy="60" rx="28" ry="22" fill={eyeColor} opacity="0.9"/>
            <ellipse cx="60" cy="64" rx="14" ry="8" fill={pupilColor} opacity="0.7"/>
            <ellipse cx="140" cy="60" rx="28" ry="22" fill={eyeColor} opacity="0.9"/>
            <ellipse cx="140" cy="64" rx="14" ry="8" fill={pupilColor} opacity="0.7"/>
          </g>
          <ellipse cx="52" cy="50" rx="6" ry="4" fill="white" opacity="0.6"/>
          <ellipse cx="132" cy="50" rx="6" ry="4" fill="white" opacity="0.6"/>
        </svg>
      );

    case 'pensando':
      return (
        <svg viewBox="0 0 200 120" className="w-40 h-24">
          <g className="animate-eye-think">
            <circle cx="60" cy="55" r="24" fill={eyeColor} opacity="0.85"/>
            <circle cx="66" cy="48" r="10" fill={pupilColor} opacity="0.7"/>
            <circle cx="140" cy="55" r="24" fill={eyeColor} opacity="0.85"/>
            <circle cx="146" cy="48" r="10" fill={pupilColor} opacity="0.7"/>
          </g>
          <circle cx="54" cy="44" r="5" fill="white" opacity="0.5"/>
          <circle cx="134" cy="44" r="5" fill="white" opacity="0.5"/>
        </svg>
      );

    case 'sorprendido':
      return (
        <svg viewBox="0 0 200 120" className="w-40 h-24">
          <g className="animate-eye-surprise">
            <circle cx="60" cy="60" r="30" fill={eyeColor} opacity="0.9"/>
            <circle cx="60" cy="60" r="14" fill={pupilColor} opacity="0.6"/>
            <circle cx="140" cy="60" r="30" fill={eyeColor} opacity="0.9"/>
            <circle cx="140" cy="60" r="14" fill={pupilColor} opacity="0.6"/>
          </g>
          <circle cx="50" cy="48" r="6" fill="white" opacity="0.6"/>
          <circle cx="130" cy="48" r="6" fill="white" opacity="0.6"/>
        </svg>
      );

    case 'gui\u00f1o':
      return (
        <svg viewBox="0 0 200 120" className="w-40 h-24">
          <circle cx="60" cy="55" r="24" fill={eyeColor} opacity="0.9"/>
          <circle cx="64" cy="50" r="10" fill={pupilColor} opacity="0.7"/>
          <circle cx="52" cy="44" r="5" fill="white" opacity="0.5"/>
          <path d="M 120 55 Q 140 42 160 55" stroke={eyeColor} strokeWidth="6" fill="none" strokeLinecap="round" opacity="0.9"/>
          <path d="M 126 52 Q 140 46 154 52" stroke={pupilColor} strokeWidth="2" fill="none" strokeLinecap="round" opacity="0.4"/>
        </svg>
      );

    case 'triste':
      return (
        <svg viewBox="0 0 200 120" className="w-40 h-24">
          <g className="animate-eye-sad">
            <ellipse cx="60" cy="62" rx="26" ry="20" fill={eyeColor} opacity="0.7"/>
            <ellipse cx="58" cy="68" rx="10" ry="8" fill={pupilColor} opacity="0.5"/>
            <ellipse cx="140" cy="62" rx="26" ry="20" fill={eyeColor} opacity="0.7"/>
            <ellipse cx="138" cy="68" rx="10" ry="8" fill={pupilColor} opacity="0.5"/>
          </g>
          <ellipse cx="52" cy="54" rx="5" ry="3" fill="white" opacity="0.3"/>
          <ellipse cx="132" cy="54" rx="5" ry="3" fill="white" opacity="0.3"/>
        </svg>
      );

    case 'celebrando':
      return (
        <svg viewBox="0 0 200 120" className="w-40 h-24">
          <g className="animate-eye-celebrate">
            <circle cx="60" cy="55" r="26" fill={eyeColor} opacity="0.9"/>
            <circle cx="60" cy="55" r="12" fill={pupilColor} opacity="0.6"/>
            <circle cx="140" cy="55" r="26" fill={eyeColor} opacity="0.9"/>
            <circle cx="140" cy="55" r="12" fill={pupilColor} opacity="0.6"/>
          </g>
          <circle cx="50" cy="44" r="6" fill="white" opacity="0.6"/>
          <circle cx="130" cy="44" r="6" fill="white" opacity="0.6"/>
        </svg>
      );

    case 'saludando':
      return (
        <svg viewBox="0 0 200 120" className="w-40 h-24">
          <g className="animate-eye-greet">
            <circle cx="60" cy="55" r="24" fill={eyeColor} opacity="0.9"/>
            <circle cx="62" cy="52" r="10" fill={pupilColor} opacity="0.7"/>
            <circle cx="140" cy="55" r="24" fill={eyeColor} opacity="0.9"/>
            <circle cx="142" cy="52" r="10" fill={pupilColor} opacity="0.7"/>
          </g>
          <circle cx="52" cy="44" r="5" fill="white" opacity="0.5"/>
          <circle cx="132" cy="44" r="5" fill="white" opacity="0.5"/>
        </svg>
      );

    case 'escuchando':
      return (
        <svg viewBox="0 0 200 120" className="w-40 h-24">
          <g className="animate-eye-listen">
            <circle cx="60" cy="55" r="24" fill={eyeColor} opacity="0.85"/>
            <circle cx="60" cy="55" r="11" fill={pupilColor} opacity="0.65"/>
            <circle cx="140" cy="55" r="24" fill={eyeColor} opacity="0.85"/>
            <circle cx="140" cy="55" r="11" fill={pupilColor} opacity="0.65"/>
          </g>
          <circle cx="52" cy="46" r="5" fill="white" opacity="0.5"/>
          <circle cx="132" cy="46" r="5" fill="white" opacity="0.5"/>
        </svg>
      );

    default:
      return (
        <svg viewBox="0 0 200 120" className="w-40 h-24">
          <circle cx="60" cy="55" r="24" fill={eyeColor} opacity="0.9"/>
          <circle cx="62" cy="52" r="10" fill={pupilColor} opacity="0.7"/>
          <circle cx="140" cy="55" r="24" fill={eyeColor} opacity="0.9"/>
          <circle cx="142" cy="52" r="10" fill={pupilColor} opacity="0.7"/>
          <circle cx="52" cy="44" r="5" fill="white" opacity="0.5"/>
          <circle cx="132" cy="44" r="5" fill="white" opacity="0.5"/>
        </svg>
      );
  }
}

function ThinkingDots() {
  return (
    <div className="flex gap-1.5 items-center">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-2.5 h-2.5 rounded-full inline-block"
          style={{
            backgroundColor: '#a855f7',
            animation: `thinkPulse 1.4s ease-in-out ${i * 0.2}s infinite`,
            boxShadow: '0 0 10px #a855f780',
          }}
        />
      ))}
    </div>
  );
}

function PartyEmoji() {
  const stars = [
    { x: 0, y: 10, size: 24, delay: 0 },
    { x: 40, y: 0, size: 30, delay: 0.15 },
    { x: 80, y: 10, size: 24, delay: 0.3 },
  ];
  return (
    <svg width="120" height="48" viewBox="0 0 120 48" className="inline-block">
      {stars.map((s, i) => (
        <text
          key={i}
          x={s.x}
          y={s.y + s.size * 0.8}
          fontSize={s.size}
          fill={['#fbbf24', '#f43f5e', '#22d3ee'][i]}
          style={{ animation: `partyPop 0.6s ease-out ${s.delay}s both` }}
        >
          {'\u2605'}
        </text>
      ))}
    </svg>
  );
}

function SadRain() {
  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden">
      {Array.from({ length: 6 }).map((_, i) => (
        <span
          key={i}
          className="absolute"
          style={{
            left: `${10 + i * 16}%`,
            top: '-10%',
          }}
        >
          <svg width="16" height="24" viewBox="0 0 16 24"
            style={{ animation: `rainDrop ${1.5 + i * 0.3}s linear ${i * 0.4}s infinite` }}
          >
            <ellipse cx="8" cy="16" rx="4" ry="8" fill="#6b7fa3" opacity="0.3"/>
          </svg>
        </span>
      ))}
    </div>
  );
}

export default function EmotionFace({ emotion = 'feliz', size = '7xl' }) {
  const config = EMOTION_CONFIG[emotion] || EMOTION_CONFIG.feliz;

  const faceContent = (() => {
    switch (emotion) {
      case 'pensando':
        return <ThinkingDots />;
      case 'celebrando':
        return (
          <div className="relative">
            <RobotEyes emotion={emotion} color={config.color} />
            <PartyEmoji />
          </div>
        );
      case 'gui\u00f1o':
        return <RobotEyes emotion="gui\u00f1o" color={config.color} />;
      case 'triste':
        return (
          <div className="relative">
            <RobotEyes emotion="triste" color={config.color} />
            <SadRain />
          </div>
        );
      case 'emocionado':
        return (
          <div className="relative">
            <RobotEyes emotion="emocionado" color={config.color} />
            <span className="absolute animate-ping" style={{ right: -20, top: -10 }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="#fbbf24">
                <polygon points="12,2 15,9 22,9 16,14 18,22 12,17 6,22 8,14 2,9 9,9" />
              </svg>
            </span>
          </div>
        );
      default:
        return <RobotEyes emotion={emotion} color={config.color} />;
    }
  })();

  return (
    <div className="flex flex-col items-center justify-center gap-4 relative">
      <div className="relative animate-face-float">
        {faceContent}
      </div>

      <p
        className="text-sm max-w-xs text-center transition-all duration-300"
        style={{ color: config.color, textShadow: `0 0 8px ${config.color}60` }}
      >
        {config.text}
      </p>

      <div
        className="absolute inset-0 rounded-full opacity-10 blur-3xl pointer-events-none"
        style={{
          background: `radial-gradient(circle, ${config.color} 0%, transparent 70%)`,
        }}
      />
    </div>
  );
}
