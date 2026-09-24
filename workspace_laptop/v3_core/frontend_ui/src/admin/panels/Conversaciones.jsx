import { useState, useEffect } from 'react';
import { useAuth } from '../AuthContext';

export default function Conversaciones() {
  const { token } = useAuth();
  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    const fetchConversations = async () => {
      try {
        const res = await fetch('/api/admin/conversations', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setConversations(data.conversations || data);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    fetchConversations();
  }, [token]);

  const filtered = conversations.filter((conv) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      (conv.timestamp || '').toLowerCase().includes(q) ||
      (conv.usuario || conv.user || '').toLowerCase().includes(q) ||
      (conv.mensaje || conv.message || '').toLowerCase().includes(q) ||
      (conv.emocion || conv.emotion || '').toLowerCase().includes(q)
    );
  });

  if (loading) return <div className="panel-loading">Cargando conversaciones...</div>;
  if (error) return <div className="panel-error">Datos no disponibles — {error}</div>;

  return (
    <div className="conversaciones">
      <div className="search-bar">
        <input
          type="text"
          placeholder="Buscar por usuario, mensaje, emoción..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="search-input"
        />
      </div>

      {filtered.length === 0 ? (
        <p className="no-data">No hay conversaciones{search ? ' que coincidan' : ''}.</p>
      ) : (
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Usuario</th>
                <th>Mensaje</th>
                <th>Emoción</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((conv, i) => (
                <tr key={i}>
                  <td>{conv.timestamp || '—'}</td>
                  <td>{conv.usuario || conv.user || '—'}</td>
                  <td>{conv.mensaje || conv.message || '—'}</td>
                  <td>
                    <span className={`emotion-badge emotion-${(conv.emocion || conv.emotion || '').toLowerCase()}`}>
                      {conv.emocion || conv.emotion || '—'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
