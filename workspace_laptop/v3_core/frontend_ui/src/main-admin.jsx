import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import AdminDashboard from './AdminDashboard.jsx';
import Login from './admin/Login.jsx';
import { AuthProvider, useAuth } from './admin/AuthContext.jsx';

function AdminApp() {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <AdminDashboard /> : <Login />;
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <AdminApp />
    </AuthProvider>
  </React.StrictMode>
);
