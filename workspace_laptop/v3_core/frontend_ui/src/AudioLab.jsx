import React, { useEffect, useMemo, useState } from 'react';
import { useApi, useWebSocket } from './hooks.js';

function formatDb(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)} dBFS` : '--';
}

function formatTime(value) {
  if (!value) return '--';
  try {
    return new Date(value).toLocaleTimeString();
  } catch {
    return value;
  }
}

function levelFromDb(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, ((value + 80) / 80) * 100));
}

function StatusPill({ label, ok, value }) {
  return (
    <div className={`rounded-md border px-3 py-2 ${ok ? 'neon-border-green' : 'neon-border-rose'}`}>
      <div className="text-[11px] uppercase tracking-wide text-[#A0A0B8]">{label}</div>
      <div className={`text-sm font-semibold ${ok ? 'neon-text-green' : 'neon-text-rose'}`}>{value}</div>
    </div>
  );
}

function Meter({ label, db, peak, accent = '#22D3EE' }) {
  const width = `${levelFromDb(db)}%`;
  const peakWidth = `${levelFromDb(peak)}%`;
  return (
    <div className="rounded-md border border-white/10 bg-[#13121C] p-3">
      <div className="mb-2 flex items-center justify-between text-sm">
        <span className="text-[#F0F0F5]">{label}</span>
        <span className="text-[#A0A0B8]">{formatDb(db)} / pico {formatDb(peak)}</span>
      </div>
      <div className="relative h-4 overflow-hidden rounded bg-black/40">
        <div className="absolute inset-y-0 left-0 rounded" style={{ width, background: accent, opacity: 0.7 }} />
        <div className="absolute inset-y-0 left-0 rounded border-r-2 border-white/80" style={{ width: peakWidth }} />
      </div>
    </div>
  );
}

function Card({ title, subtitle, children, className = '' }) {
  return (
    <section className={`rounded-lg border border-white/8 bg-[#13121C] p-4 ${className}`}>
      <div className="mb-3">
        <h2 className="text-base font-semibold text-[#F0F0F5]">{title}</h2>
        {subtitle ? <p className="mt-1 text-sm text-[#A0A0B8]">{subtitle}</p> : null}
      </div>
      {children}
    </section>
  );
}

export default function AudioLab() {
  const { data: apiData, loading } = useApi('/api/audio-lab/status', { interval: 1500 });
  const { data: wsData, connected: wsConnected, send } = useWebSocket('/ws/ui');
  const [snapshot, setSnapshot] = useState(null);
  const [volume, setVolume] = useState(70);
  const [eventFeed, setEventFeed] = useState([]);
  const [toneBusy, setToneBusy] = useState(false);
  const [volumeBusy, setVolumeBusy] = useState(false);

  useEffect(() => {
    if (apiData?.snapshot) {
      setSnapshot(apiData.snapshot);
      setEventFeed(apiData.snapshot.events || []);
      const hwVolume = apiData.snapshot.hardware?.audio_volume;
      if (Number.isFinite(hwVolume)) setVolume(hwVolume);
    }
  }, [apiData]);

  useEffect(() => {
    if (!wsData) return;
    if (wsData.type === 'audio_lab_metrics' && wsData.snapshot) {
      setSnapshot(wsData.snapshot);
      setEventFeed(wsData.snapshot.events || []);
      const hwVolume = wsData.snapshot.hardware?.audio_volume;
      if (Number.isFinite(hwVolume)) setVolume(hwVolume);
    }
    if (wsData.type === 'audio_lab_event' && wsData.event) {
      setEventFeed((prev) => {
        const next = [...prev, wsData.event];
        return next.slice(-40);
      });
    }
  }, [wsData]);

  useEffect(() => {
    if (!wsConnected) return;
    send({ type: 'ping' });
  }, [wsConnected, send]);

  const telemetry = snapshot?.telemetry || {};
  const uplink = snapshot?.uplink || {};
  const services = apiData?.services || {};
  const hardware = snapshot?.hardware || {};
  const conversationState = snapshot?.conversation_state || 'IDLE';
  const asrAvailable = !!services?.asr?.whisper && !uplink.backendPcmBypassed;

  const statusCards = useMemo(() => ([
    { label: 'ESP32', ok: !!snapshot?.esp32?.connected, value: snapshot?.esp32?.connected ? 'conectado' : 'desconectado' },
    { label: 'Transporte', ok: !!snapshot?.esp32?.connected, value: hardware.transport || '--' },
    { label: 'WS UI', ok: wsConnected, value: wsConnected ? 'streaming' : 'caído' },
    { label: 'ASR', ok: asrAvailable, value: uplink.backendPcmBypassed ? 'bypass' : (services?.asr?.whisper ? 'activo' : 'inactivo') },
    { label: 'TTS', ok: !!services?.tts?.python_ready, value: services?.tts?.python_ready ? 'listo' : 'cargando' },
    { label: 'Orchestrator', ok: !!services?.orchestrator?.url, value: services?.orchestrator?.url ? 'configurado' : 'sin ruta' },
    { label: 'LLM', ok: !!services?.llm?.primary, value: services?.llm?.onFallback ? 'fallback' : 'primario' },
  ]), [asrAvailable, hardware.transport, services, snapshot?.esp32?.connected, uplink.backendPcmBypassed, wsConnected]);

  async function postJson(url, body = {}) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${resp.status}`);
    }
    return resp.json();
  }

  async function handleTone(mode) {
    setToneBusy(true);
    try {
      await postJson('/api/esp32/test-tone', { mode, durationMs: 1200, frequencyHz: mode === 'stereo' ? 880 : 660, volumePct: 35 });
    } finally {
      setToneBusy(false);
    }
  }

  async function handleVolume(nextVolume) {
    setVolumeBusy(true);
    try {
      await postJson('/api/esp32/volume', { volume: nextVolume });
    } finally {
      setVolumeBusy(false);
    }
  }

  async function handleReset() {
    await postJson('/api/audio-lab/reset');
  }

  return (
    <main className="min-h-screen overflow-auto bg-[#0B0A10] px-4 py-4 text-[#F0F0F5]">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4">
        <header className="flex flex-col gap-3 rounded-lg border border-cyan-400/20 bg-[#13121C] p-4 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="text-xs uppercase tracking-[0.24em] text-[#22D3EE]">Uchino Audio Lab</div>
            <h1 className="mt-2 text-2xl font-semibold text-white">Prueba de micros, parlantes y pipeline</h1>
            <p className="mt-2 max-w-3xl text-sm text-[#A0A0B8]">
              Vista de diagnóstico para el ESP32 de audio. Muestra telemetría L/R, VAD, ASR, respuesta, volumen y eventos del pipeline real.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
            {statusCards.map((card) => (
              <StatusPill key={card.label} {...card} />
            ))}
          </div>
        </header>

        <section className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
          <div className="grid gap-4">
            <Card title="Entrada de micrófonos" subtitle="Niveles RMS/pico reportados por el ESP32. Si ambos están planos, el problema está antes del backend.">
              <div className="grid gap-3 md:grid-cols-2">
                <Meter label="Micrófono izquierdo" db={telemetry.mic_left_rms_db} peak={telemetry.mic_left_peak_db} accent="#22D3EE" />
                <Meter label="Micrófono derecho" db={telemetry.mic_right_rms_db} peak={telemetry.mic_right_peak_db} accent="#A855F7" />
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <div className="rounded-md border border-white/10 bg-black/20 p-3">
                  <div className="text-[11px] uppercase tracking-wide text-[#A0A0B8]">Dirección estimada</div>
                  <div className="mt-1 text-xl font-semibold text-white">{Number.isFinite(telemetry.doa_deg) ? `${telemetry.doa_deg.toFixed(1)}°` : '--'}</div>
                </div>
                <div className="rounded-md border border-white/10 bg-black/20 p-3">
                  <div className="text-[11px] uppercase tracking-wide text-[#A0A0B8]">PCM frames</div>
                  <div className="mt-1 text-xl font-semibold text-white">{uplink.pcmFrames ?? 0}</div>
                </div>
                <div className="rounded-md border border-white/10 bg-black/20 p-3">
                  <div className="text-[11px] uppercase tracking-wide text-[#A0A0B8]">Último frame</div>
                  <div className="mt-1 text-xl font-semibold text-white">{uplink.lastFrameType ?? telemetry.last_rx_type ?? '--'}</div>
                </div>
              </div>
            </Card>

            <Card title="Salida a parlantes" subtitle="Control de volumen y nivel detectado en la reproducción enviada al ESP32.">
              <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
                <div>
                  <label className="mb-2 block text-sm text-[#A0A0B8]">Volumen remoto: {volume}%</label>
                  <input
                    className="w-full accent-cyan-400"
                    type="range"
                    min="0"
                    max="100"
                    value={volume}
                    onChange={(e) => setVolume(Number(e.target.value))}
                    onMouseUp={() => handleVolume(volume)}
                    onTouchEnd={() => handleVolume(volume)}
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <button className="btn-primary rounded-md px-3 py-2 text-sm" disabled={volumeBusy} onClick={() => { setVolume(70); handleVolume(70); }}>70%</button>
                  <button className="btn-amber rounded-md px-3 py-2 text-sm" disabled={volumeBusy} onClick={() => { setVolume(0); handleVolume(0); }}>mute</button>
                </div>
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <Meter label="Speaker RMS" db={telemetry.speaker_rms_db} peak={telemetry.speaker_peak_db} accent="#10B981" />
                <div className="rounded-md border border-white/10 bg-black/20 p-3">
                  <div className="mb-2 text-sm text-[#A0A0B8]">Pruebas directas</div>
                  <div className="flex flex-wrap gap-2">
                    <button className="btn-primary rounded-md px-3 py-2 text-sm" disabled={toneBusy} onClick={() => handleTone('mono')}>tono mono</button>
                    <button className="btn-primary rounded-md px-3 py-2 text-sm" disabled={toneBusy} onClick={() => handleTone('stereo')}>tono estéreo</button>
                    <button className="btn-green rounded-md px-3 py-2 text-sm" onClick={handleReset}>limpiar métricas</button>
                  </div>
                </div>
              </div>
            </Card>

            <Card title="Estado de conversación" subtitle="Esto te dice si la tubería realmente está oyendo, transcribiendo y contestando, o si solo está repitiendo audio viejo.">
              <div className="grid gap-3 md:grid-cols-3">
                <div className="rounded-md border border-white/10 bg-black/20 p-3">
                  <div className="text-[11px] uppercase tracking-wide text-[#A0A0B8]">VAD</div>
                  <div className="mt-1 text-xl font-semibold text-white">{conversationState}</div>
                </div>
                <div className="rounded-md border border-white/10 bg-black/20 p-3">
                  <div className="text-[11px] uppercase tracking-wide text-[#A0A0B8]">TTS chunks</div>
                  <div className="mt-1 text-xl font-semibold text-white">{snapshot?.tts?.chunks ?? 0}</div>
                </div>
                <div className="rounded-md border border-white/10 bg-black/20 p-3">
                  <div className="text-[11px] uppercase tracking-wide text-[#A0A0B8]">TTS duración</div>
                  <div className="mt-1 text-xl font-semibold text-white">{snapshot?.tts?.durationMs ?? 0} ms</div>
                </div>
              </div>
              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                <div className="rounded-md border border-white/10 bg-black/20 p-3">
                  <div className="mb-2 text-sm text-[#A0A0B8]">ASR parcial</div>
                  <div className="min-h-20 rounded border border-white/10 bg-black/30 p-3 text-sm text-white/90">{snapshot?.last_asr_partial || 'Sin buffer activo'}</div>
                </div>
                <div className="rounded-md border border-white/10 bg-black/20 p-3">
                  <div className="mb-2 text-sm text-[#A0A0B8]">ASR final</div>
                  <div className="min-h-20 rounded border border-white/10 bg-black/30 p-3 text-sm text-white/90">{snapshot?.last_asr_final || 'Sin frase confirmada'}</div>
                </div>
              </div>
              <div className="mt-3 rounded-md border border-white/10 bg-black/20 p-3">
                <div className="mb-2 text-sm text-[#A0A0B8]">Respuesta generada</div>
                <div className="min-h-24 rounded border border-white/10 bg-black/30 p-3 text-sm text-white/90">{snapshot?.last_response_text || 'Aún no hay respuesta nueva'}</div>
              </div>
            </Card>
          </div>

          <div className="grid gap-4">
            <Card title="Conexión y tiempos" subtitle="Sirve para descartar si el backend ve al ESP32 y si la telemetría sigue viva.">
              <div className="space-y-3 text-sm">
                <div className="flex justify-between gap-3"><span className="text-[#A0A0B8]">ESP32</span><span>{snapshot?.esp32?.connected ? 'conectado' : 'desconectado'}</span></div>
                <div className="flex justify-between gap-3"><span className="text-[#A0A0B8]">Ruta</span><span>{snapshot?.esp32?.transportPath || '--'}</span></div>
                <div className="flex justify-between gap-3"><span className="text-[#A0A0B8]">IP remota</span><span>{snapshot?.esp32?.remoteAddress || '--'}</span></div>
                <div className="flex justify-between gap-3"><span className="text-[#A0A0B8]">Conectó</span><span>{formatTime(snapshot?.esp32?.lastConnectedAt)}</span></div>
                <div className="flex justify-between gap-3"><span className="text-[#A0A0B8]">Desconectó</span><span>{formatTime(snapshot?.esp32?.lastDisconnectedAt)}</span></div>
                <div className="flex justify-between gap-3"><span className="text-[#A0A0B8]">Telemetría</span><span>{formatTime(telemetry.receivedAt)}</span></div>
                <div className="flex justify-between gap-3"><span className="text-[#A0A0B8]">Volumen backend</span><span>{hardware.audio_volume ?? '--'}%</span></div>
                <div className="flex justify-between gap-3"><span className="text-[#A0A0B8]">TCP sinks</span><span>{hardware.connected_tcp_sinks ?? 0}</span></div>
                <div className="flex justify-between gap-3"><span className="text-[#A0A0B8]">Clientes ESP32</span><span>{hardware.connected_esp32_clients ?? 0}</span></div>
                <div className="flex justify-between gap-3"><span className="text-[#A0A0B8]">Clientes browser</span><span>{hardware.connected_browser_voice_clients ?? 0}</span></div>
                <div className="flex justify-between gap-3"><span className="text-[#A0A0B8]">PCM a ASR</span><span>{uplink.backendPcmBypassed ? 'bypass' : 'activo'}</span></div>
                <div className="flex justify-between gap-3"><span className="text-[#A0A0B8]">PCM bytes</span><span>{uplink.pcmBytes ?? 0}</span></div>
              </div>
            </Card>

            <Card title="Servicios" subtitle="Estado resumido para saber si el problema está en IA o ya en hardware.">
              <div className="grid gap-2">
                <StatusPill label="DB" ok={services?.databases?.overall !== false} value={services?.databases?.overall === false ? 'degradado' : 'ok'} />
                <StatusPill label="Whisper" ok={!!services?.asr?.whisper} value={services?.asr?.whisper ? 'listo' : 'caído'} />
                <StatusPill label="Piper" ok={!!services?.tts?.piper} value={services?.tts?.piper ? 'listo' : 'caído'} />
                <StatusPill label="TTS Python" ok={!!services?.tts?.python_ready} value={services?.tts?.python_ready ? 'listo' : 'iniciando'} />
                <StatusPill label="Visión" ok={!!services?.vision?.available} value={services?.vision?.mockMode ? 'mock' : 'activa'} />
              </div>
              <div className="mt-3 text-xs text-[#606070]">
                {loading ? 'actualizando...' : `latencia ${apiData?.latency_ms ?? '--'} ms`}
              </div>
            </Card>

            <Card title="Timeline" subtitle="Secuencia de eventos para validar si entra audio, se detecta silencio, sale ASR y luego TTS.">
              <div className="max-h-[34rem] space-y-2 overflow-auto pr-1">
                {eventFeed.length === 0 ? (
                  <div className="rounded-md border border-white/10 bg-black/20 p-3 text-sm text-[#A0A0B8]">Sin eventos todavía.</div>
                ) : [...eventFeed].slice().reverse().map((event) => (
                  <div key={event.id} className="rounded-md border border-white/10 bg-black/20 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-medium text-white">{event.name}</div>
                      <div className="text-[11px] text-[#A0A0B8]">{formatTime(event.at)}</div>
                    </div>
                    <pre className="mt-2 overflow-auto whitespace-pre-wrap text-xs text-[#A0A0B8]">{JSON.stringify(event.detail || {}, null, 2)}</pre>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </section>
      </div>
    </main>
  );
}
