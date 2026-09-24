import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter, Routes, Route } from 'react-router-dom';
import './index.css';
import RobotScreen from './RobotScreen.jsx';
import CocinaKDS from './CocinaKDS.jsx';
import { AuthProvider } from './admin/AuthContext.jsx';
import Login from './admin/Login.jsx';
import { ProtectedRoute } from './admin/ProtectedRoute.jsx';
import AdminLayout from './admin/AdminLayout.jsx';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <HashRouter>
        <Routes>
          <Route path="/robot" element={<RobotScreen />} />
          <Route path="/cocina" element={<CocinaKDS />} />
          <Route path="/admin/login" element={<Login />} />
          <Route path="/admin/*" element={
            <ProtectedRoute>
              <AdminLayout />
            </ProtectedRoute>
          } />
          <Route path="*" element={<RobotScreen />} />
        </Routes>
      </HashRouter>
    </AuthProvider>
  </React.StrictMode>
);
