import { useState, useEffect } from 'react';
import { useAuth } from '../AuthContext';

const MEMORY_NAMES = [
  { key: 'episodic', label: 'Episódica', desc: 'Eventos pasados' },
  { key: 'semantic', label: 'Semántica', desc: 'Hechos y conocimiento' },
  { key: 'procedural', label: 'Procedural', desc: 'Habilidades y rutinas' },
  { key: 'working', label: 'De trabajo', desc: 'Contexto actual' },
  { key: 'person', label: 'De persona', desc: 'Perfiles de clientes' },
  { key: 'preference', label: 'De preferencias', desc: 'Gustos del cliente' },
  { key: 'spatial', label: 'Espacial', desc: 'Mapa y ubicación' },
];

function MemoryCard({ name, desc, status }) {
  const isActive = status === 'connected' || status === 'configured' || status === true;
  return (
    <div className="memory-card">
      <div className="memory-header">
        <h3 className="memory-title">{name}</h3>
        <span className={`memory-badge ${isActive ? 'badge-green' : 'badge-red'}`}>
          {isActive ? 'Activo' : 'Inactivo'}
        </span>
      </div>
      <p className="memory-desc">{desc}</p>
      <p className="memory-status">Estado: {status || 'desconocido'}</p>
    </div>
  );
}

export default function SieteMemorias() {
  const { token } = useAuth();
  const [memories, setMemories] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchMemories = async () => {
      try {
        const res = await fetch('/api/admin/memories', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setMemories(data.memories || data);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchMemories();
  }, [token]);

  if (loading) return <div className="panel-loading">Cargando memorias...</div>;
  if (error) return <div className="panel-error">Error: {error}</div>;

  return (
    <div className="siete-memorias">
      <div className="memories-grid">
        {MEMORY_NAMES.map(({ key, label, desc }) => (
          <MemoryCard
            key={key}
            name={label}
            desc={desc}
            status={memories[key]}
          />
        ))}
      </div>
    </div>
  );
}
