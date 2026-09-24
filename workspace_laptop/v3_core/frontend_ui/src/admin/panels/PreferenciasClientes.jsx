import { useState, useEffect } from 'react';
import { useAuth } from '../AuthContext';

export default function PreferenciasClientes() {
  const { token } = useAuth();
  const [preferences, setPreferences] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchPreferences = async () => {
      try {
        const res = await fetch('/api/admin/client-preferences', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setPreferences(data.preferences || data);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchPreferences();
  }, [token]);

  if (loading) return <div className="panel-loading">Cargando preferencias...</div>;
  if (error) return <div className="panel-error">Datos no disponibles — endpoint en desarrollo</div>;
  if (!preferences || preferences.length === 0) {
    return <p className="no-data">No hay preferencias registradas.</p>;
  }

  return (
    <div className="preferencias-clientes">
      <div className="table-container">
        <table className="data-table">
          <thead>
            <tr>
              <th>Cliente</th>
              <th>Preferencias</th>
              <th>Visitas</th>
            </tr>
          </thead>
          <tbody>
            {preferences.map((pref, i) => (
              <tr key={i}>
                <td>{pref.cliente || pref.client || pref.nombre || pref.name || '—'}</td>
                <td>{pref.preferencias || pref.preferences || '—'}</td>
                <td>{pref.visitas || pref.visits || 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
