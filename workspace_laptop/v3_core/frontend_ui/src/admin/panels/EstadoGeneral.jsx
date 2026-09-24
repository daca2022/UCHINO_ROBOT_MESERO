import { useState, useEffect } from 'react';
import { useAuth } from '../AuthContext';

const SERVICES = [
  { key: 'docker', label: 'Docker', icon: '🐳' },
  { key: 'backend', label: 'Backend API', icon: '⚙️' },
  { key: 'orchestrator', label: 'Orchestrator', icon: '🧠' },
  { key: 'pipeline', label: 'Audio Pipeline', icon: '🎙️' },
  { key: 'stt', label: 'STT (Whisper)', icon: '👂' },
];

function StatusCard({ icon, label, status }) {
  const isUp = status === 'up' || status === true;
  return (
    <div className="status-card">
      <div className="status-icon">{icon}</div>
      <div className="status-info">
        <span className="status-label">{label}</span>
        <span className={`status-badge ${isUp ? 'badge-green' : 'badge-red'}`}>
          {isUp ? '🟢 Activo' : '🔴 Inactivo'}
        </span>
      </div>
    </div>
  );
}

export default function EstadoGeneral() {
  const { token } = useAuth();
  const [services, setServices] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/admin/status', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setServices(data.services || data);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchStatus();
  }, [token]);

  if (loading) return <div className="panel-loading">Cargando estado...</div>;
  if (error) return <div className="panel-error">Error: {error}</div>;

  return (
    <div className="estado-general">
      <div className="status-grid">
        {SERVICES.map(({ key, label, icon }) => (
          <StatusCard
            key={key}
            icon={icon}
            label={label}
            status={services[key]}
          />
        ))}
      </div>
    </div>
  );
}
