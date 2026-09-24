import { useEffect, useState } from 'react';

function InfoCard({ label, value }) {
  return (
    <div className="info-card">
      <span className="info-label">{label}</span>
      <span className="info-value">{value}</span>
    </div>
  );
}

export default function RobotControl() {
  const [estado, setEstado] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    async function cargar() {
      try {
        const res = await fetch('/api/robot/estado');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (alive) {
          setEstado(data);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e.message);
      }
    }
    cargar();
    const timer = setInterval(cargar, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const posicion = estado?.posicion
    ? `${estado.posicion.x ?? 0}, ${estado.posicion.y ?? 0}, ${estado.posicion.theta ?? 0}`
    : 'RPi5 no conectada';

  return (
    <div className="robot-control">
      {error && (
        <div className="wip-banner">
          <span className="wip-badge">RPi5 no conectada: {error}</span>
        </div>
      )}
      <div className="info-grid">
        <InfoCard label="Posición" value={posicion} />
        <InfoCard label="Batería" value={estado?.bateria !== undefined ? `${estado.bateria}%` : 'RPi5 no conectada'} />
        <InfoCard label="Estado" value={estado?.estado || 'RPi5 no conectada'} />
        <InfoCard label="Recorrido activo" value={estado?.recorrido_activo || 'Sin recorrido'} />
      </div>
    </div>
  );
}
