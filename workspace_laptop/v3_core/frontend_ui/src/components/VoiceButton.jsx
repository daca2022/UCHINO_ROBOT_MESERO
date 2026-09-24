import { useEffect, useRef, useState } from 'react';
import { VoiceClient } from '../voiceClient.js';

export default function VoiceButton({ onMessage, sessionId, mesa }) {
  const [state, setState] = useState('idle'); // idle | connecting | listening | processing | playing | error
  const [error, setError] = useState(null);
  const clientRef = useRef(null);

  useEffect(() => {
    return () => {
      if (clientRef.current) {
        clientRef.current.stop();
      }
    };
  }, []);

  const start = async () => {
    setError(null);
    setState('connecting');
    try {
      const client = new VoiceClient({ sessionId, mesa });
      client.addEventListener('connected', () => setState('listening'));
      client.addEventListener('disconnected', () => setState('idle'));
      client.addEventListener('error', (e) => {
        setError('Error de conexión');
        setState('error');
      });
      client.addEventListener('response_chunk', () => {
        setState('processing');
      });
      client.addEventListener('response_start', () => setState('playing'));
      client.addEventListener('response_end', () => setState('listening'));
      client.addEventListener('message', (e) => {
        if (onMessage) onMessage(e.detail);
      });
      clientRef.current = client;
      await client.start();
    } catch (e) {
      setError(e.message || 'No se pudo acceder al micrófono');
      setState('error');
    }
  };

  const stop = async () => {
    if (clientRef.current) {
      await clientRef.current.stop();
      clientRef.current = null;
    }
    setState('idle');
  };

  const toggle = () => {
    if (state === 'idle' || state === 'error') {
      start();
    } else {
      stop();
    }
  };

  const label = {
    idle: '🎤 Hablar con Uchino',
    connecting: '⏳ Conectando...',
    listening: '🔴 Escuchando (click para parar)',
    processing: '🧠 Pensando...',
    playing: '🔊 Reproduciendo...',
    error: '⚠️ Reintentar',
  }[state];

  const color = {
    idle: 'bg-cyan-600 hover:bg-cyan-500',
    connecting: 'bg-yellow-600',
    listening: 'bg-red-600 animate-pulse',
    processing: 'bg-purple-600',
    playing: 'bg-green-600',
    error: 'bg-red-700',
  }[state];

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={toggle}
        className={`${color} text-white text-xs font-semibold px-3 py-1.5 rounded-full shadow-lg transition-all whitespace-nowrap`}
        disabled={state === 'connecting'}
      >
        {label}
      </button>
      {error && (
        <p className="text-red-400 text-xs">{error}</p>
      )}
    </div>
  );
}
