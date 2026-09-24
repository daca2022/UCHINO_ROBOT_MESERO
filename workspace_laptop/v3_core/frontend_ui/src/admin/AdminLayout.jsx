import { useState } from 'react';
import { useAuth } from './AuthContext';
import SpeechDiagnosticsPanel from './panels/SpeechDiagnosticsPanel.jsx';
import './admin-theme.css';

const TABS = [
  { id: 'estado', label: 'Estado General' },
  { id: 'memorias', label: '7 Memorias' },
  { id: 'memorias-avanzadas', label: 'Memorias Avanzadas' },
  { id: 'llm-metrics', label: 'LLM Metrics' },
  { id: 'robot-control', label: 'Robot Control' },
  { id: 'hardware-control', label: 'Hardware Control' },
  { id: 'speech', label: 'Voz / TTS' },
];

export default function AdminLayout() {
  const { user, logout } = useAuth();
  const [activeTab, setActiveTab] = useState(TABS[0].id);

  return (
    <div className="admin-layout">
      <header className="admin-header">
        <span className="admin-header-title">Uchino Admin</span>
        <div className="admin-header-right">
          <span className="admin-user">{user}</span>
          <button className="admin-logout-btn" onClick={logout}>
            Cerrar Sesión
          </button>
        </div>
      </header>
      <div className="admin-body">
        <nav className="admin-sidebar">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              className={`admin-tab ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <main className="admin-content">
          <h2>{TABS.find((t) => t.id === activeTab)?.label}</h2>
          {activeTab === 'speech' ? <SpeechDiagnosticsPanel /> : (
            <p className="admin-placeholder">
              Contenido de {TABS.find((t) => t.id === activeTab)?.label} — próximamente
            </p>
          )}
        </main>
      </div>
    </div>
  );
}
