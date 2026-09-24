import { useEffect, useRef, useState, useCallback } from 'react';

const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
const HAS_SR = !!SR;

function getClientId() {
  const KEY = 'chipi_client_id';
  try {
    let cid = localStorage.getItem(KEY);
    if (!cid) {
      cid = (crypto?.randomUUID?.() || `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
      localStorage.setItem(KEY, cid);
    }
    return cid;
  } catch {
    return `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

const LANG_LABELS = {
  idle: 'Inactivo',
  listening: 'Escuchando',
  processing: 'Procesando',
  playing: 'Respondiendo',
  error: 'Error',
};

const LANG_COLORS = {
  idle: '#64748B',
  listening: '#22D3EE',
  processing: '#A855F7',
  playing: '#10B981',
  error: '#F43F5E',
};

export default function VoiceAsrButton({ mesa, sessionId, active, onStartRequest, onMessage, interactionMode = 'voice' }) {
  const [state, setState] = useState('idle');
  const [error, setError] = useState(null);
  const [interim, setInterim] = useState('');
  const recogRef = useRef(null);
  const busyRef = useRef(false);
  const clientIdRef = useRef(getClientId());
  const lastSendTextRef = useRef('');
  const ttsMuteRef = useRef(false);
  const sessionClosedRef = useRef(false);
  const requestAbortRef = useRef(null);
  const sessionContextRef = useRef({ sessionId, active });
  const previousSessionIdRef = useRef(sessionId);

  const emit = useCallback((msg) => {
    if (onMessage) onMessage(msg);
  }, [onMessage]);

  useEffect(() => {
    if (previousSessionIdRef.current !== sessionId) {
      requestAbortRef.current?.abort();
      requestAbortRef.current = null;
      sessionClosedRef.current = false;
      lastSendTextRef.current = '';
      previousSessionIdRef.current = sessionId;
    }
    sessionContextRef.current = { sessionId, active };
    if (!active) {
      requestAbortRef.current?.abort();
      requestAbortRef.current = null;
    }
  }, [active, sessionId]);

  useEffect(() => {
    let mounted = true;
    let intervalId = null;
    function startRecognition() {
      if (!mounted || !active || sessionClosedRef.current || ttsMuteRef.current || busyRef.current || !HAS_SR) return;
      setState('listening');
      emit({ type: 'voice_state', state: 'listening' });
      try {
        if (!recogRef.current) recogRef.current = new SR();
        recogRef.current.lang = 'es-PE';
        recogRef.current.continuous = false;
        recogRef.current.interimResults = true;
        recogRef.current.maxAlternatives = 1;
        recogRef.current.onresult = (ev) => {
          let finalTxt = '';
          let interimTxt = '';
          for (let i = ev.resultIndex; i < ev.results.length; i++) {
            const t = ev.results[i][0].transcript;
            if (ev.results[i].isFinal) finalTxt += t;
            else interimTxt += t;
          }
          if (interimTxt) setInterim(interimTxt);
          if (finalTxt) {
            setInterim('');
            try { recogRef.current.stop(); } catch {}
            if (!ttsMuteRef.current) sendToAsr(finalTxt.trim());
          }
        };
        recogRef.current.onerror = (ev) => {
          if (ev.error === 'no-speech') {
            setState('listening');
            emit({ type: 'voice_state', state: 'listening' });
            setTimeout(() => {
              if (mounted && active && !sessionClosedRef.current && !ttsMuteRef.current) {
                try { recogRef.current.start(); } catch {}
              }
            }, 300);
            return;
          }
          console.warn('[VoiceAsr] error:', ev.error);
          setError(`Mic: ${ev.error}`);
          setState('error');
          emit({ type: 'voice_state', state: 'error' });
        };
        recogRef.current.onend = () => {
          if (mounted && active && !sessionClosedRef.current && !ttsMuteRef.current && !busyRef.current && state === 'listening') {
            setTimeout(() => {
              if (mounted && active && !sessionClosedRef.current && !ttsMuteRef.current && !busyRef.current) {
                try { recogRef.current.start(); } catch {}
              }
            }, 150);
          }
        };
        recogRef.current.start();
      } catch (e) {
        console.warn('[VoiceAsr] start failed:', e.message);
      }
    }
    function checkTts() {
      if (!mounted) return;
      fetch('/api/tts/status', { cache: 'no-store' })
        .then(r => r.json())
        .then(s => {
          ttsMuteRef.current = !!s.speaking;
          if (!active || sessionClosedRef.current) return;
          if (s.speaking) {
            if (recogRef.current && state === 'listening') {
              try { recogRef.current.stop(); } catch {}
            }
            setState('playing');
            emit({ type: 'voice_state', state: 'playing' });
          } else if (!busyRef.current && (state === 'playing' || (state === 'idle' && active))) {
            startRecognition();
          }
        })
        .catch(() => {
          ttsMuteRef.current = false;
          if (active && !sessionClosedRef.current && !busyRef.current) {
            setError('No se pudo consultar TTS; el micrófono continúa disponible.');
            startRecognition();
          }
        });
    }
    if (active && !sessionClosedRef.current) {
      checkTts();
      intervalId = setInterval(checkTts, 400);
    } else {
      if (recogRef.current) {
        try { recogRef.current.stop(); } catch {}
        recogRef.current = null;
      }
      if (!active) sessionClosedRef.current = false;
      setState('idle');
      emit({ type: 'voice_state', state: 'idle' });
    }
    return () => {
      mounted = false;
      if (intervalId) clearInterval(intervalId);
    };
  }, [active, state, emit]);

  async function sendToAsr(text) {
    if (!text || busyRef.current) return;
    if (text === lastSendTextRef.current) return;
    lastSendTextRef.current = text;
    busyRef.current = true;
    const requestSessionId = sessionId;
    const controller = new AbortController();
    requestAbortRef.current = controller;
    setState('processing');
    emit({ type: 'user_text', text });

    try {
      let sessionToken = null;
      try { sessionToken = sessionStorage.getItem('uchino_session_access_token'); } catch {}
      const res = await fetch('/api/asr/process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(sessionToken ? { 'X-Session-Token': sessionToken } : {}) },
        body: JSON.stringify({
          user_text: text,
          session_id: requestSessionId,
          source: 'browser_microphone',
          ...(interactionMode ? { interaction_mode: interactionMode } : {}),
          mesa: mesa || null,
          client_id: clientIdRef.current,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const currentContext = sessionContextRef.current;
      if (controller.signal.aborted
        || !currentContext.active
        || currentContext.sessionId !== requestSessionId) {
        emit({ type: 'late_response_rejected', session_id: requestSessionId, reason: 'voice_session_changed' });
        return;
      }
      emit({
        type: 'asr_response',
        text: data.text,
        display_text: data.display_text,
        speech_text: data.speech_text,
        speech_segments: data.speech_segments,
        sanitization: data.sanitization,
        session_id: data.session_id,
        state: data.state,
        mesa: data.mesa,
        order_id: data.order_id,
        order_status: data.order_status,
        interaction_mode: data.interaction_mode,
        intent: data.intent,
        guest_count: data.guest_count,
        decision: data.decision,
        waiter_request: data.waiter_request,
        products: data.products,
        order: data.order,
        confirmed: data.confirmed,
        cancelled: data.cancelled,
        new_order: data.new_order,
        model: data.model,
        paid: data.paid,
      });
      const closesSession = data.confirmed || data.new_order || data.state === 'completed' || data.order_status === 'sent_to_kitchen';
      if (closesSession) {
        sessionClosedRef.current = true;
        setState('idle');
      } else {
        setState(ttsMuteRef.current ? 'playing' : 'listening');
      }
      setTimeout(() => { lastSendTextRef.current = ''; }, 2000);
    } catch (e) {
      if (e.name === 'AbortError') return;
      console.error('[VoiceAsr] error:', e);
      setError(e.message || 'Error al procesar');
      emit({ type: 'asr_error', text: e.message });
      setState('error');
    } finally {
      busyRef.current = false;
      if (requestAbortRef.current === controller) requestAbortRef.current = null;
    }
  }

  function handleClick() {
    if (!HAS_SR) {
      setError('Tu navegador no soporta Speech Recognition. Usa Chrome o Edge.');
      setState('error');
      return;
    }
    if (!mesa) {
      setError('Selecciona tu mesa primero');
      setState('error');
      return;
    }
    if (!active) {
      sessionClosedRef.current = false;
      onStartRequest && onStartRequest();
    } else {
      emit({ type: 'voice_stop' });
    }
  }

  const label = active
    ? (state === 'listening' ? 'Escuchando' : 'Finalizar')
    : (HAS_SR ? 'Pedir por voz' : 'Sin Speech API');

  const color = active
    ? (state === 'listening' ? 'bg-red-600 animate-pulse' : state === 'processing' ? 'bg-purple-600' : state === 'playing' ? 'bg-emerald-600' : 'bg-slate-600')
    : (mesa ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-slate-500 cursor-not-allowed');

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={handleClick}
        disabled={!HAS_SR || (!mesa && !active)}
        className={`min-h-10 min-w-[8.5rem] px-3 py-2 rounded-lg text-xs font-semibold text-white transition-all ${color}`}
        aria-label={active ? 'Finalizar conversación por voz' : 'Iniciar pedido por voz'}
        title={HAS_SR ? (active ? 'Finalizar conversación por voz' : 'Iniciar pedido por voz') : 'Tu navegador no soporta reconocimiento de voz'}
      >
        {label}
      </button>
      {active && (
        <span
          className="text-[11px] font-mono"
          style={{ color: LANG_COLORS[state] || '#a0a0b8' }}
        >
          {state === 'listening' ? 'Toca para finalizar' : (LANG_LABELS[state] || state)}
        </span>
      )}
      {interim && state === 'listening' && (
        <span className="text-[10px] text-text-dim italic max-w-[14rem] truncate">"{interim}"</span>
      )}
      {error && state === 'error' && (
        <span className="text-[10px] text-neon-rose max-w-[14rem]">{error}</span>
      )}
    </div>
  );
}
