import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import CocinaKDS from './CocinaKDS.jsx';
import { AuthProvider } from './admin/AuthContext.jsx';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <CocinaKDS />
    </AuthProvider>
  </React.StrictMode>
);
