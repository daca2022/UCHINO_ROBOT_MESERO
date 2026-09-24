import { useState, useEffect } from 'react';
import { useAuth } from '../AuthContext';

function StatCard({ label, value, icon }) {
  return (
    <div className="stat-card">
      <div className="stat-icon">{icon}</div>
      <div className="stat-info">
        <span className="stat-label">{label}</span>
        <span className="stat-value">{value}</span>
      </div>
    </div>
  );
}

export default function ChromaStats() {
  const { token } = useAuth();
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await fetch('/api/admin/chroma-stats', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setStats(data);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchStats();
  }, [token]);

  if (loading) return <div className="panel-loading">Cargando ChromaDB...</div>;
  if (error) return <div className="panel-error">Datos no disponibles — endpoint en desarrollo</div>;
  if (!stats) return <p className="no-data">Sin datos de ChromaDB.</p>;

  return (
    <div className="chroma-stats">
      <div className="stats-grid">
        <StatCard
          label="Total vectores"
          value={stats.totalVectors || stats.total_vectors || stats.count || 'N/A'}
          icon="📊"
        />
        <StatCard
          label="Colecciones activas"
          value={stats.collections || stats.activeCollections || stats.active_collections || 'N/A'}
          icon="📁"
        />
        <StatCard
          label="Última inserción"
          value={stats.lastInsertion || stats.last_insertion || stats.last_insert || 'N/A'}
          icon="🕐"
        />
      </div>
    </div>
  );
}
