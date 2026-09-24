/**
 * GoogleOAuthButton — Stub placeholder.
 * 
 * Google OAuth login NO está implementado aún.
 * Este componente muestra un botón deshabilitado para
 * recordar que esta funcionalidad está planificada.
 * 
 * Implementación futura: usar @react-oauth/google.
 * @see docs/OAUTH_PLACEHOLDER.md
 */

export default function GoogleOAuthButton() {
  return (
    <div style={{ marginTop: '1rem', padding: '0.75rem', border: '1px dashed #9ca3af', borderRadius: '8px', background: '#f9fafb' }}>
      <button
        disabled
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '0.5rem 1rem',
          border: '1px solid #d1d5db',
          borderRadius: '6px',
          background: '#e5e7eb',
          color: '#6b7280',
          cursor: 'not-allowed',
          fontSize: '0.9rem',
          fontFamily: 'system-ui, sans-serif',
          width: '100%',
          justifyContent: 'center'
        }}
        title="Google OAuth en desarrollo"
      >
        <span style={{ fontSize: '1.2rem' }}>G</span>
        Login con Google
      </button>
      <p style={{ margin: '0.5rem 0 0 0', fontSize: '0.75rem', color: '#9ca3af', textAlign: 'center' }}>
        ⚠️ Próximamente — Google OAuth en desarrollo.
      </p>
    </div>
  );
}
