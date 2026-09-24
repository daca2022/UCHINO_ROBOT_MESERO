import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../AuthContext.jsx';

function ControlRow({ label, description, children }) {
  return (
    <div className="glass rounded-2xl border border-chipi-border p-5 flex flex-col md:flex-row md:items-center md:justify-between gap-4">
      <div className="min-w-0">
        <h3 className="text-sm font-bold text-text-primary">{label}</h3>
        <p className="text-xs text-text-secondary mt-1">{description}</p>
      </div>
      <div className="flex items-center gap-3 shrink-0">{children}</div>
    </div>
  );
}

function StatusPill({ active, children }) {
  const color = active ? '#10B981' : '#F59E0B';
  return (
    <span
      className="px-3 py-1 rounded-lg border text-[11px] font-bold"
      style={{ color, borderColor: `${color}55`, background: `${color}18` }}
    >
      {children}
    </span>
  );
}

export default function HardwareControl() {
  const { token } = useAuth();
  const [state, setState] = useState(null);
  const [provider, setProvider] = useState('');
  const [volume, setVolume] = useState(50);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  const headers = useMemo(() => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  }), [token]);

  async function loadHardware() {
    try {
      const res = await fetch('/api/admin/hardware', { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setState(data);
      setProvider(data.llm?.active || '');
      setVolume(data.audio?.audio_volume ?? 50);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }

  useEffect(() => {
    loadHardware();
    const timer = setInterval(loadHardware, 5000);
    return () => clearInterval(timer);
  }, [headers]);

  async function changeProvider(nextProvider) {
    setProvider(nextProvider);
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch('/api/admin/hardware/llm-provider', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ provider: nextProvider }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setState((current) => ({
        ...current,
        llm: { active: data.active.name, providers: data.providers },
      }));
      setMessage(`Modelo activo: ${data.active.name}`);
    } catch (e) {
      setError(e.message);
      await loadHardware();
    } finally {
      setBusy(false);
    }
  }

  async function changeVolume(nextVolume) {
    const parsed = Number(nextVolume);
    setVolume(parsed);
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch('/api/admin/hardware/audio-volume', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ volume: parsed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setState((current) => ({ ...current, audio: data }));
      setMessage(data.message);
    } catch (e) {
      setError(e.message);
      await loadHardware();
    } finally {
      setBusy(false);
    }
  }

  const providers = state?.llm?.providers || [];
  const connectedClients = state?.audio?.connected_robot_clients || 0;

  return (
    <div className="space-y-4 max-w-4xl">
      {message && (
        <div className="rounded-xl border border-neon-green/30 bg-neon-green/10 px-4 py-3 text-sm font-semibold text-neon-green">
          {message}
        </div>
      )}
      {error && (
        <div className="rounded-xl border border-neon-rose/30 bg-neon-rose/10 px-4 py-3 text-sm font-semibold text-neon-rose">
          {error}
        </div>
      )}

      <ControlRow
        label="Modelo LLM activo"
        description="Cambia el proveedor usado por el backend para las siguientes respuestas."
      >
        <select
          value={provider}
          onChange={(e) => changeProvider(e.target.value)}
          disabled={busy || providers.length === 0}
          className="min-w-64 rounded-xl bg-chipi-card border border-chipi-border px-4 py-2 text-sm text-text-primary focus:outline-none focus:border-neon-cyan disabled:opacity-50"
        >
          {providers.length === 0 && <option value="">Sin proveedores</option>}
          {providers.map((item) => (
            <option key={item.name} value={item.name}>
              {item.name}
            </option>
          ))}
        </select>
      </ControlRow>

      <ControlRow
        label="Volumen ESP32 audio"
        description="Envía el nivel al ESP32 de audio por WebSocket; si no está conectado queda guardado para la próxima conexión."
      >
        <input
          type="range"
          min="0"
          max="100"
          value={volume}
          onChange={(e) => changeVolume(e.target.value)}
          disabled={busy}
          className="w-44 accent-cyan-400 disabled:opacity-50"
        />
        <span className="w-12 text-right font-mono text-sm font-bold text-neon-cyan">{volume}%</span>
        <StatusPill active={connectedClients > 0}>
          {connectedClients > 0 ? `${connectedClients} ESP32 conectado` : 'ESP32 no conectado'}
        </StatusPill>
      </ControlRow>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="glass rounded-2xl border border-chipi-border p-5">
          <span className="text-[10px] text-text-secondary uppercase tracking-wider font-semibold">Transporte audio</span>
          <p className="mt-2 text-lg font-bold text-text-primary">{state?.audio?.transport || 'websocket'}</p>
        </div>
        <div className="glass rounded-2xl border border-chipi-border p-5">
          <span className="text-[10px] text-text-secondary uppercase tracking-wider font-semibold">Clientes robot</span>
          <p className="mt-2 text-lg font-bold text-neon-amber font-mono">{connectedClients}</p>
        </div>
        <div className="glass rounded-2xl border border-chipi-border p-5">
          <span className="text-[10px] text-text-secondary uppercase tracking-wider font-semibold">Último envío</span>
          <p className="mt-2 text-xs font-mono text-text-secondary">{state?.audio?.last_volume_sent_at || 'Sin envío'}</p>
        </div>
      </div>
    </div>
  );
}
