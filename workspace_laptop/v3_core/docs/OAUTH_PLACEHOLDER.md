# Google OAuth — Placeholder de Implementacion

> **ESTADO:** PLACEHOLDER — No implementado aun.
> **FECHA:** 2026-06-02
> **RESPONSABLE:** Pendiente de asignar

---

## Que es OAuth

OAuth 2.0 es un estandar abierto de autorizacion que permite a aplicaciones obtener acceso limitado a cuentas de usuarios sin exponer sus credenciales. En lugar de pedir usuario y contraseña directamente, la aplicacion redirige al usuario al proveedor de identidad (Google), quien autentica y devuelve un token de acceso.

### Por que Google

Google es el proveedor elegido por las siguientes razones:

- La mayoria de usuarios del equipo UTEC ya tienen cuenta Google institucional.
- Google maneja la seguridad de credenciales, rotacion de contraseñas y verificacion en dos pasos.
- El flujo OAuth de Google esta bien documentado y probado a escala.
- Reduce la carga de mantener un sistema propio de registro, recuperacion de contraseña y gestion de sesiones.

---

## Pasos de Configuracion en Google Cloud Console

### 1. Crear un proyecto en Google Cloud Console

1. Ir a [console.cloud.google.com](https://console.cloud.google.com/)
2. Crear un nuevo proyecto (ej: `uchino-robot-mesero`)
3. Anotar el **Project ID**

### 2. Configurar la pantalla de consentimiento (OAuth Consent Screen)

1. Navegar a **APIs & Services > OAuth consent screen**
2. Seleccionar tipo **External** (usuarios fuera de la organizacion)
3. Completar campos obligatorios:
   - **App name:** Uchino Robot Mesero
   - **User support email:** correo del equipo UTEC
   - **Developer contact email:** mismo correo
4. Agregar scopes minimos:
   - `.../auth/userinfo.email`
   - `.../auth/userinfo.profile`
5. Agregar dominios autorizados (si aplica)
6. Guardar y publicar (o mantener en **Testing** para desarrollo)

### 3. Crear credenciales OAuth 2.0

1. Navegar a **APIs & Services > Credentials**
2. Click en **Create Credentials > OAuth client ID**
3. Tipo de aplicacion: **Web application**
4. Configurar:
   - **Name:** Uchino Admin OAuth
   - **Authorized JavaScript origins:** `http://localhost:3005`, `http://localhost:5173` (desarrollo) + dominio de produccion
   - **Authorized redirect URIs:** `http://localhost:3005/api/auth/google/callback` (ajustar al endpoint real)
5. Copiar **Client ID** y **Client Secret**

---

## Variables de Entorno Requeridas

Agregar a `v3_core/.env`:

```env
# Google OAuth 2.0
GOOGLE_CLIENT_ID=tu-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=tu-client-secret
GOOGLE_REDIRECT_URI=http://localhost:3005/api/auth/google/callback
```

**Nunca commitear estos valores.** El archivo `.env` ya esta en `.gitignore`.

Para referencia de nombres de variables (sin valores), ver `v3_core/shared/credentials/CREDENTIALS.md`.

---

## Flujo de Login

```
┌──────────┐     1. Click "Login con Google"     ┌─────────────┐
│  Frontend│ ──────────────────────────────────► │  Frontend   │
│  (React) │                                     │  (React)    │
└──────────┘                                     └──────┬──────┘
                                                       │
                                                       │ 2. Redirige a Google
                                                       │    (authorization URL)
                                                       ▼
                                               ┌───────────────┐
                                               │    Google     │
                                               │  (auth page)  │
                                               └───────┬───────┘
                                                       │
                                                       │ 3. Usuario autoriza
                                                       │    Google redirige a callback
                                                       │    con ?code=AUTH_CODE
                                                       ▼
┌──────────┐     5. JWT propio devuelto      ┌──────────────┐
│ Frontend │ ◄────────────────────────────── │  Backend     │
│  (React) │                                 │  (Node.js)   │
└──────────┘                                 └──────┬───────┘
                                                   │
                                                   │ 4. POST /api/auth/google/callback
                                                   │    con { code }
                                                   │    Backend verifica con Google
                                                   │    Google devuelve userinfo
                                                   │    Backend crea/valida usuario
                                                   │    Backend genera JWT propio
                                                   ▼
```

### Detalle paso a paso

1. **Frontend:** El usuario hace click en "Login con Google".
2. **Frontend:** Se redirige al endpoint de autorizacion de Google con `client_id`, `redirect_uri`, `scope`, y `response_type=code`.
3. **Google:** El usuario inicia sesion y autoriza los permisos solicitados.
4. **Google:** Redirige al `redirect_uri` con un codigo de autorizacion (`?code=...`).
5. **Backend:** El frontend envia el codigo al backend via `POST /api/auth/google/callback`.
6. **Backend:** El backend intercambia el codigo por un access token con Google (server-to-server).
7. **Google:** Devuelve el access token y datos del usuario (email, nombre, foto).
8. **Backend:** El backend busca o crea el usuario en la base de datos, genera un JWT propio, y lo devuelve al frontend.
9. **Frontend:** Almacena el JWT y redirige al dashboard de admin.

---

## Libreria Recomendada

### Frontend (React)

```
@react-oauth/google
```

- Repositorio: [github.com/MomenSherif/react-oauth](https://github.com/MomenSherif/react-oauth)
- Compatible con React 19.
- Proporciona componentes `<GoogleLogin>` y `<GoogleOAuthProvider>`.
- Peso minimo, sin dependencias pesadas.

### Backend (Node.js)

```
google-auth-library
```

- Paquete oficial de Google para Node.js.
- Permite verificar tokens de Google y obtener datos del usuario.
- Ya es dependencia comun en proyectos Google Cloud.

---

## Estructura de Archivos Esperada (Post-Implementacion)

```
v3_core/
├── frontend_ui/src/
│   ├── admin/
│   │   ├── GoogleOAuthButton.jsx    ← Ya existe (placeholder actual)
│   │   └── GoogleOAuthCallback.jsx  ← Pagina de callback (pendiente)
│   └── main-admin.jsx               ← Envolver con <GoogleOAuthProvider>
│
├── backend_api/src/
│   └── routes/
│       └── auth.mjs                 ← Endpoint /api/auth/google/callback (pendiente)
│
└── .env                             ← GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
```

---

## Notas

- Este documento es un **placeholder de planificacion**. Ningun codigo de OAuth ha sido implementado.
- El componente `GoogleOAuthButton.jsx` actual muestra un boton **deshabilitado** con un mensaje informativo.
- La implementacion real requiere aprobacion del equipo y configuracion previa en Google Cloud Console.
- Considerar agregar **rate limiting** al endpoint de callback para prevenir abuso.
- Considerar **CSRF protection** en el flujo de OAuth.
