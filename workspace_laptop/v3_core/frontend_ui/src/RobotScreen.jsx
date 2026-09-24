import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useWebSocket, useApi } from './hooks.js';
import EmotionFace from './components/EmotionFace.jsx';
import VoiceAsrButton from './components/VoiceAsrButton.jsx';
import MesaSelector from './components/MesaSelector.jsx';
import ItemSafetyEditor from './components/ItemSafetyEditor.jsx';
import MemoryPanel from './components/MemoryPanel.jsx';
import { UIBridge } from './generative-ui/UIBridge.jsx';

const CATEGORIAS = ['plato', 'bebida', 'postre'];

const CATEGORIA_CONFIG = {
  plato: { label: 'Platos', color: '#22D3EE', gradient: 'linear-gradient(145deg, #22D3EE20, #22D3EE05)' },
  bebida: { label: 'Bebidas', color: '#F59E0B', gradient: 'linear-gradient(145deg, #F59E0B20, #F59E0B05)' },
  postre: { label: 'Postres', color: '#F43F5E', gradient: 'linear-gradient(145deg, #F43F5E20, #F43F5E05)' },
};

const EMPTY_MENU_FILTERS = Object.freeze({
  max_price: null,
  vegetarian: false,
  vegan: false,
  allergen: null,
  available: true,
  query: null,
});

function activeFiltersCount(f) {
  if (!f) return 0;
  let n = 0;
  if (f.max_price != null) n++;
  if (f.vegetarian) n++;
  if (f.vegan) n++;
  if (f.allergen) n++;
  if (f.query) n++;
  return n;
}
function activeFiltersList(f) {
  if (!f) return [];
  const out = [];
  if (f.max_price != null) out.push(`Hasta S/ ${f.max_price}`);
  if (f.vegetarian) out.push('Vegetariano');
  if (f.vegan) out.push('Vegano');
  if (f.allergen) out.push(`Sin ${f.allergen}`);
  if (f.query) out.push(`“${f.query}”`);
  return out;
}

const FALLBACK_MENU = [
  { nombre: 'Lomo Saltado', precio: 25, categoria: 'plato', desc: 'Carne + papas' },
  { nombre: 'Ceviche', precio: 22, categoria: 'plato', desc: 'Pescado fresco' },
  { nombre: 'Pollo Brasa', precio: 30, categoria: 'plato', desc: '1/4 con papas' },
  { nombre: 'Tallarines', precio: 20, categoria: 'plato', desc: 'Verduras salteadas' },
  { nombre: 'Inca Kola', precio: 5, categoria: 'bebida', desc: '500ml' },
  { nombre: 'Chicha Morada', precio: 4, categoria: 'bebida', desc: 'Vaso grande' },
  { nombre: 'Helado Artesanal', precio: 8, categoria: 'postre', desc: 'Vainilla' },
  { nombre: 'Torta de Chocolate', precio: 12, categoria: 'postre', desc: 'Porción' },
];

const LANGGRAPH_STATES = [
  { key: 'idle', label: 'Inactivo', color: '#64748B' },
  { key: 'listening', label: 'Escuchando', color: '#22D3EE' },
  { key: 'processing', label: 'Procesando', color: '#A855F7' },
  { key: 'awaiting_confirmation', label: 'Por confirmar', color: '#F59E0B' },
  { key: 'confirmed', label: 'Confirmado', color: '#10B981' },
  { key: 'completed', label: 'Completado', color: '#34D399' },
];

const MESA_KEY = 'chipi_mesa_actual';
const VOICE_SESSION_KEY = 'uchino_voice_session_id';
const SESSION_TOKEN_KEY = 'uchino_session_access_token';
const ROBOT_ID = 'uchino-01';

function sessionReadHeaders() {
  try {
    const token = sessionStorage.getItem(SESSION_TOKEN_KEY);
    return token ? { 'X-Session-Token': token } : {};
  } catch {
    return {};
  }
}

const SESSION_PHASE_LABELS = {
  unassigned: 'Esperando asignación',
  initializing: 'Iniciando atención',
  assigned: 'Atención asignada',
  choosing_mode: 'Seleccionando modo',
  active: 'Sesión activa',
  completing: 'Cerrando',
  closed: 'Atención terminada',
  expired: 'Sesión expirada',
  available: 'Disponible para nueva atención',
};

const SESSION_SCOPED_WS_EVENTS = new Set([
  'session_started',
  'session_assigned_to_table',
  'session_mode_required',
  'session_mode_selected',
  'session_completing',
  'session_closed',
  'session_expired',
  'session_timeout_warning',
  'session_recovery_failed',
  'robot_available_for_attention',
  'menu_navigation',
  'waiter_assistance',
  'waiter_assistance_updated',
]);

const DELIVERY_STATES = new Set([
  'navigating_to_table',
  'going_to_kitchen',
  'picking_up',
  'going_to_table',
  'delivering',
  'returning',
]);

const ROBOT_STATE_LABELS = {
  available: { label: 'Disponible', color: '#10B981' },
  attending: { label: 'Atendiendo', color: '#22D3EE' },
  assigned: { label: 'Asignado', color: '#A855F7' },
  navigating_to_table: { label: 'Navegando a mesa', color: '#F59E0B' },
  arrived_at_table: { label: 'Llegó a mesa', color: '#22D3EE' },
  going_to_kitchen: { label: 'En camino a cocina', color: '#F59E0B' },
  picking_up: { label: 'Recogiendo pedido', color: '#F43F5E' },
  going_to_table: { label: 'Llevando a mesa', color: '#22D3EE' },
  delivering: { label: 'Entregando', color: '#10B981' },
  returning: { label: 'Regresando', color: '#64748B' },
  idle: { label: 'Inactivo', color: '#64748B' },
};

const OPTIONS_CONFIG = [
  { key: 'ver_pedido', label: 'Ver pedido', icon: '📋', color: '#F59E0B' },
  { key: 'ver_menu', label: 'Ver menú', icon: '🍽️', color: '#22D3EE' },
  { key: 'cambiar_modo', label: 'Cambiar modo', icon: '🔄', color: '#A855F7' },
  { key: 'cambiar_mesa', label: 'Cambiar mesa', icon: '🪑', color: '#22D3EE' },
  { key: 'cancelar_pedido', label: 'Cancelar pedido', icon: '❌', color: '#F43F5E' },
  { key: 'cancelar_atencion', label: 'Cancelar atención', icon: '🚪', color: '#F43F5E' },
  { key: 'solicitar_mesero', label: 'Solicitar mesero', icon: '🔔', color: '#F59E0B' },
];

function normalizeMesa(value) {
  const raw = String(value || '').trim().toUpperCase().replace(/^MESA\s*/, '').replace(/^M(?=\d)/, '');
  return /^([1-9]|1[0-2])$/.test(raw) ? `M${Number(raw)}` : '';
}

function cleanVisibleTranscript(value) {
  return String(value || '')
    .replace(/\*\*/g, '')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
}

function modifierPrice(item, menuItems) {
  const menuItem = menuItems.find(candidate => candidate.id && item.product_id && candidate.id === item.product_id)
    || menuItems.find(candidate => candidate.nombre === item.nombre);
  const options = Array.isArray(menuItem?.modificadores_disponibles) ? menuItem.modificadores_disponibles : [];
  return (item.modificaciones || []).reduce((sum, modifier) => {
    const configured = options.find(option => String(option.id || option.nombre) === String(modifier.id || modifier.nombre));
    return sum + Number(configured?.precio_adicional || 0);
  }, 0);
}

function itemLineKey(item, index) {
  return item.item_id || item.line_id || `${item.nombre}-${index}`;
}

export default function RobotScreen() {
  const [mode, setMode] = useState('catalog');
  const [cart, setCart] = useState([]);
  const [emotion, setEmotion] = useState('saludando');
  const [transcript, setTranscript] = useState('');
  const [lastSpeechResponse, setLastSpeechResponse] = useState(null);
  const [langState, setLangState] = useState('idle');
  const [voiceTranscript, setVoiceTranscript] = useState('');
  const [activeCat, setActiveCat] = useState('plato');
  const [showCartDetail, setShowCartDetail] = useState(false);
  const [mesa, setMesa] = useState('');
  const [showMesaModal, setShowMesaModal] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceState, setVoiceState] = useState('idle');
  const [activeOrder, setActiveOrder] = useState(null);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const [finishPrompt, setFinishPrompt] = useState(false);
  const [interactionMode, setInteractionMode] = useState(null);
  const [modePromptOpen, setModePromptOpen] = useState(false);
  const [waiterRequest, setWaiterRequest] = useState(null);
  const [visitId, setVisitId] = useState(null);
  const [guestCount, setGuestCount] = useState(null);
  const [partyPromptOpen, setPartyPromptOpen] = useState(false);
  const [safetyContext, setSafetyContext] = useState({ declared_allergies: [], allergy_conflicts: [], special_warning: '', requires_special_confirmation: false });
  const [safetyEditorItem, setSafetyEditorItem] = useState(null);
  const [safetyEditorError, setSafetyEditorError] = useState('');
  const [highlightedProductId, setHighlightedProductId] = useState(null);
  const [menuFilters, setMenuFilters] = useState({
    max_price: null,
    vegetarian: false,
    vegan: false,
    allergen: null,
    available: true,
    query: null,
  });
  const voiceSessionIdRef = useRef(null);
  const presentationShownRef = useRef(false);
  const draftQueueRef = useRef(Promise.resolve());
  const pendingInteractionModeRef = useRef(null);
  const modeSelectionTouchedRef = useRef(false);
  const lastUiSequenceRef = useRef(0);
  const robotBootstrapInFlightRef = useRef(null);
  const robotBootstrapClaimedRef = useRef(null);
  const robotConnectionTokenRef = useRef(null);

  const [sessionPhase, setSessionPhase] = useState(null);
  const asrStoppedRef = useRef(false);
  const canonicalRecoveryRef = useRef(null);

  // HRI multimodal: robot state, staff mode, options modal, proactive messages
  const [robotStateWs, setRobotStateWs] = useState(null);
  const [isStaffMode, setIsStaffMode] = useState(false);
  const [showOptionsModal, setShowOptionsModal] = useState(false);
  const [proactiveMessages, setProactiveMessages] = useState([]);
  const proactiveTimerRef = useRef(null);

  const ws = useWebSocket('/ws/ui');
  const menu = useApi('/api/menu', { interval: 30000 });
  const robotState = useApi('/api/robot/estado', { interval: 5000 });
  const observationAllowlist = useApi('/api/asr/observation-allowlist', { interval: 60000 });

  useEffect(() => {
    if (!ws.connected) lastUiSequenceRef.current = 0;
  }, [ws.connected]);

  useEffect(() => {
    if (!ws.connected) {
      robotConnectionTokenRef.current = null;
      return;
    }
    ws.send({
      type: 'robot_register',
      robot_id: ROBOT_ID,
    });
  }, [ws.connected, ws.send]);

  // Fase 6: navegación de menú sincronizada por WebSocket.
  // Cuando el backend emite un evento `menu_navigation`, /robot aplica la
  // acción a su estado visual sin recargar la página.
  const [menuNavigation, setMenuNavigation] = useState(null);
  const [sessionSnapshot, setSessionSnapshot] = useState(null);

  const resetSessionScopedUi = useCallback(() => {
    setMode('catalog');
    setActiveCat('plato');
    setMenuNavigation(null);
    setMenuFilters({ ...EMPTY_MENU_FILTERS });
    setHighlightedProductId(null);
    setShowOptionsModal(false);
    setShowMesaModal(false);
    setSafetyEditorItem(null);
    setSafetyEditorError('');
    setProactiveMessages([]);
    setLastSpeechResponse(null);
    if (proactiveTimerRef.current) {
      clearTimeout(proactiveTimerRef.current);
      proactiveTimerRef.current = null;
    }
    presentationShownRef.current = false;
    pendingInteractionModeRef.current = null;
    modeSelectionTouchedRef.current = false;
  }, []);
  useEffect(() => {
    if (!ws?.data) return;
    if (ws.data.type === 'menu_navigation') {
      const currentSessionId = voiceSessionIdRef.current || getVoiceSessionId();
      if (!currentSessionId || !ws.data.session_id || ws.data.session_id !== currentSessionId) return;
      setMenuNavigation(ws.data);
    }
  }, [ws?.data]);
  useEffect(() => {
    if (!menuNavigation) return;
    const action = menuNavigation.action;
    if (action === 'show_menu' || action === 'return_to_menu' || action === 'clear_filter') {
      setActiveCat(null);
    } else if (action === 'show_category' && menuNavigation.category) {
      const cat = String(menuNavigation.category).toLowerCase();
      // Acepta singular o plural.
      const canon = ['plato', 'bebida', 'postre'].includes(cat) ? cat
        : ['platos', 'comida', 'comidas'].includes(cat) ? 'plato'
        : ['bebidas'].includes(cat) ? 'bebida'
        : ['postres', 'dulces'].includes(cat) ? 'postre'
        : null;
      if (canon) setActiveCat(canon);
    }
    // show_products / show_recommendations / highlight_product no cambian
    // la categoría activa; sólo resaltan productos vía highlightedProductId.
    if (menuNavigation.highlight_product_id) {
      setHighlightedProductId(menuNavigation.highlight_product_id);
    } else if (action === 'show_menu' || action === 'return_to_menu' || action === 'clear_filter') {
      setHighlightedProductId(null);
    }
    if (menuNavigation.filters) {
      setMenuFilters(prev => ({ ...prev, ...menuNavigation.filters }));
    }
  }, [menuNavigation]);

  // Cierre correctivo Fase 6: sincronizar menu_state al cargar sesión
  // (cubre el caso en que la página carga con sesión ya activa y filtros
  // aplicados por voz en una sesión anterior).
  useEffect(() => {
    if (sessionSnapshot?.menu_state) {
      const ms = sessionSnapshot.menu_state;
      if (ms.active_category && ['plato', 'bebida', 'postre'].includes(ms.active_category)) {
        setActiveCat(ms.active_category);
      } else if (ms.active_category === null && ms.last_navigation) {
        setActiveCat(null);
      }
      if (ms.highlighted_product_id) setHighlightedProductId(ms.highlighted_product_id);
      if (ms.menu_filters) setMenuFilters(prev => ({ ...prev, ...ms.menu_filters }));
    }
  }, [sessionSnapshot?.menu_state?.last_navigation_at]);

  useEffect(() => {
    if (mode !== 'delivery') return;
    const currentState = robotStateWs?.new_state || robotStateWs?.state || robotStateWs?.robot_state;
    if (!currentState || !DELIVERY_STATES.has(currentState)) {
      setMode('catalog');
    }
  }, [robotStateWs, mode]);

  const menuItems = useMemo(() => menu.data?.data || FALLBACK_MENU, [menu.data]);
  const filteredItems = useMemo(() => {
    let items = menuItems;
    if (activeCat) items = items.filter(i => i.categoria === activeCat);
    if (menuFilters.max_price != null) items = items.filter(i => Number(i.precio) <= menuFilters.max_price);
    if (menuFilters.vegetarian) items = items.filter(i => i.restricciones?.vegetariano);
    if (menuFilters.vegan) items = items.filter(i => i.restricciones?.vegano);
    if (menuFilters.allergen) {
      const al = String(menuFilters.allergen).toLowerCase();
      items = items.filter(i => !(i.alergenos || []).map(a => String(a).toLowerCase()).includes(al));
    }
    if (menuFilters.query) {
      const q = String(menuFilters.query).toLowerCase();
      items = items.filter(i => String(i.nombre || '').toLowerCase().includes(q));
    }
    return items;
  }, [menuItems, activeCat, menuFilters]);
  const observations = useMemo(() => observationAllowlist.data?.data || [], [observationAllowlist.data]);

  const total = useMemo(() => cart.reduce((s, i) => s + (i.precio + modifierPrice(i, menuItems)) * i.cantidad, 0), [cart, menuItems]);
  const itemCount = useMemo(() => cart.reduce((s, i) => s + i.cantidad, 0), [cart]);
  const orderConfirmed = ['confirmed', 'completed'].includes(langState)
    || activeOrder?.order_status === 'sent_to_kitchen';
  const orderStateLabel = orderConfirmed
    ? 'confirmado'
    : awaitingConfirmation || langState === 'awaiting_confirmation'
      ? 'por confirmar'
      : cart.length > 0
        ? 'borrador'
        : langState;

  const interactionModeLabel = interactionMode === 'voice'
    ? 'Voz'
    : interactionMode === 'screen'
      ? 'Pantalla'
      : interactionMode === 'human_waiter'
        ? 'Mesero'
      : 'Sin seleccionar';

  const canonicalSessionId = voiceSessionIdRef.current || getVoiceSessionId();
  const robotStateKey = robotState.data?.state || robotState.data?.robot_state || robotStateWs?.new_state || robotStateWs?.state;
  const hasAssignedAttention = Boolean(
    mesa
    && canonicalSessionId
    && !['unassigned', 'available', 'closed', 'expired'].includes(sessionPhase)
    && (['initializing', 'assigned', 'choosing_mode', 'active', 'completing'].includes(sessionPhase)
      || (robotState.data?.current_session_id === canonicalSessionId && robotStateKey !== 'available')),
  );

  useEffect(() => {
    if (!ws.data) return;
    const currentSessionId = voiceSessionIdRef.current || getVoiceSessionId();
    const incomingSequence = Number(ws.data.sequence);
    if (Number.isFinite(incomingSequence) && incomingSequence <= lastUiSequenceRef.current) return;
    if (Number.isFinite(incomingSequence)) lastUiSequenceRef.current = incomingSequence;
    const isSessionStartAfterRelease = ws.data.type === 'session_started'
      && ['closed', 'expired', 'available'].includes(sessionPhase);
    const isOtherRobotEvent = ws.data.robot_id && ws.data.robot_id !== ROBOT_ID;
    if (SESSION_SCOPED_WS_EVENTS.has(ws.data.type)
      && !isOtherRobotEvent
      && ws.data.session_id
      && currentSessionId
      && ws.data.session_id !== currentSessionId
      && !isSessionStartAfterRelease) {
      return;
    }
    if (SESSION_SCOPED_WS_EVENTS.has(ws.data.type) && isOtherRobotEvent) return;
    if (ws.data.type === 'robot_state_changed'
      && ws.data.new_state !== 'available'
      && ws.data.session_id !== currentSessionId) return;
    if (ws.data.type === 'emotion') {
      setEmotion(ws.data.emotion || 'saludando');
      if (ws.data.text) {
        setTranscript(ws.data.text);
        setMode('voice');
      }
    }
    if (ws.data.type === 'menu') setMode('catalog');
    if (ws.data.type === 'langgraph_state') setLangState(ws.data.state || 'idle');
    if (ws.data.type === 'transcript') setTranscript(ws.data.text || '');
    if (ws.data.type === 'asr_text') {
      setTranscript(`🎤 "${ws.data.text}"`);
      setMode('voice');
    }
    if (ws.data.type === 'chipi_response') {
      const displayText = ws.data.display_text || ws.data.text;
      setTranscript(displayText);
      setLastSpeechResponse({
        session_id: ws.data.session_id || currentSessionId,
        display_text: displayText,
        speech_text: ws.data.speech_text || null,
        speech_segments: ws.data.speech_segments || [],
      });
      setMode('voice');
    }
    if (ws.data.type === 'asr_pedido_draft' && ws.data.session_id === getVoiceSessionId()) {
      applyOrderState(ws.data);
      if (Array.isArray(ws.data.products) && ws.data.products.length > 0) setMode('pedido');
    }
    if (ws.data.type === 'waiter_assistance' || ws.data.type === 'waiter_assistance_updated') {
      const request = ws.data.request || ws.data;
      const waiterEvent = ws.data.event || request.event || ws.data.type;
      const requestSession = request.session_id || ws.data.session_id;
      const requestTable = normalizeMesa(request.table_id || request.mesa);
      const requestVisit = request.visit_id || ws.data.visit_id || null;
      const requestRobot = request.robot_id || ws.data.robot_id || null;
      const expired = request.expires_at && new Date(request.expires_at).getTime() <= Date.now();
      const matchesCurrentAttention = requestSession === currentSessionId
        && requestTable === mesa
        && (!visitId || !requestVisit || requestVisit === visitId)
        && (!requestRobot || requestRobot === ROBOT_ID);
      if (matchesCurrentAttention && request.status === 'pending' && !expired) {
        setWaiterRequest(request);
      } else if (matchesCurrentAttention
        && (request.status === 'attended' || request.status === 'expired' || request.status === 'cancelled'
          || waiterEvent === 'waiter_assistance_updated')) {
        setWaiterRequest(null);
      }
    }
    if (ws.data.type === 'session_started') {
      resetSessionScopedUi();
      setSessionPhase('initializing');
      asrStoppedRef.current = false;
      const sid = ws.data.session_id;
      if (sid) {
        try {
          const previousSid = sessionStorage.getItem(VOICE_SESSION_KEY);
          if (previousSid && previousSid !== sid) sessionStorage.removeItem(SESSION_TOKEN_KEY);
        } catch {}
        voiceSessionIdRef.current = sid;
        try { sessionStorage.setItem(VOICE_SESSION_KEY, sid); } catch {}
      }
      if (ws.data.mesa) setMesa(ws.data.mesa);
      if (ws.data.visit_id || ws.data.visitId) setVisitId(ws.data.visit_id || ws.data.visitId);
      if (ws.data.guest_count) setGuestCount(Number(ws.data.guest_count));
      setWaiterRequest(null);
      requestRobotBootstrap(sid);
    }
    if (ws.data.type === 'robot_registered'
      && ws.data.robot_id === ROBOT_ID
      && ws.data.robot_connection_token) {
      robotConnectionTokenRef.current = ws.data.robot_connection_token;
      requestRobotBootstrap(robotState.data?.current_session_id || voiceSessionIdRef.current || null);
    }
    if (ws.data.type === 'robot_registration_rejected') {
      setTranscript('Esta pantalla de Uchino ya tiene otra conexión activa.');
    }
    if (ws.data.type === 'robot_bootstrap_rejected') {
      setTranscript('No pude enlazar la atención asignada a esta pantalla.');
    }
    if (ws.data.type === 'robot_session_bootstrap'
      && ws.data.robot_id === ROBOT_ID
      && ws.data.session_id
      && ws.data.robot_bootstrap_token) {
      void claimRobotBootstrap(
        ws.data.session_id,
        ws.data.robot_bootstrap_token,
        ws.data.robot_connection_token,
      );
    }
    if (ws.data.type === 'session_assigned_to_table') {
      setSessionPhase('assigned');
      if (ws.data.mesa) setMesa(ws.data.mesa);
    }
    if (ws.data.type === 'session_mode_required') {
      const eventGuestCount = Number(ws.data.guest_count || guestCount || 0) || null;
      setSessionPhase(eventGuestCount ? 'choosing_mode' : 'assigned');
      setPartyPromptOpen(!eventGuestCount);
      setModePromptOpen(Boolean(eventGuestCount));
    }
    if (ws.data.type === 'session_mode_selected') {
      setSessionPhase('active');
      asrStoppedRef.current = false;
      setModePromptOpen(false);
      setPartyPromptOpen(false);
    }
    if (ws.data.type === 'session_completing') {
      setSessionPhase('completing');
    }
    if (ws.data.type === 'session_closed' || ws.data.type === 'session_expired') {
      setSessionPhase(ws.data.type === 'session_expired' ? 'expired' : 'closed');
      setVoiceActive(false);
      setVoiceState('idle');
      setInteractionMode(null);
      setModePromptOpen(false);
      asrStoppedRef.current = true;
      setSessionSnapshot(null);
      setCart([]);
      setActiveOrder(null);
      setWaiterRequest(null);
      setMesa('');
      setVisitId(null);
      setGuestCount(null);
      voiceSessionIdRef.current = null;
      robotBootstrapInFlightRef.current = null;
      robotBootstrapClaimedRef.current = null;
      try {
        sessionStorage.removeItem(VOICE_SESSION_KEY);
        sessionStorage.removeItem(SESSION_TOKEN_KEY);
        localStorage.removeItem(MESA_KEY);
      } catch {}
      resetSessionScopedUi();
      setTranscript(ws.data.type === 'session_expired'
        ? 'La sesión expiró por inactividad. Estoy disponible para una nueva atención.'
        : 'La atención terminó. Estoy disponible para una nueva atención.');
    }
    if (ws.data.type === 'robot_available_for_attention') {
      setSessionPhase('available');
      setVoiceActive(false);
      setVoiceState('idle');
      setInteractionMode(null);
      setModePromptOpen(false);
      asrStoppedRef.current = true;
      setSessionSnapshot(null);
      setCart([]);
      setActiveOrder(null);
      setWaiterRequest(null);
      setMesa('');
      setVisitId(null);
      setGuestCount(null);
      voiceSessionIdRef.current = null;
      robotBootstrapClaimedRef.current = null;
      try {
        sessionStorage.removeItem(VOICE_SESSION_KEY);
        sessionStorage.removeItem(SESSION_TOKEN_KEY);
        localStorage.removeItem(MESA_KEY);
      } catch {}
      resetSessionScopedUi();
      setTranscript('Estoy disponible para una nueva atención.');
    }
    if (ws.data.type === 'session_timeout_warning') {
      setTranscript('\u23F0 La sesi\u00F3n est\u00E1 por expirar por inactividad. \u00BFNecesitas m\u00E1s tiempo?');
    }
    if (ws.data.type === 'session_recovery_failed') {
      setSessionPhase(null);
      asrStoppedRef.current = true;
      voiceSessionIdRef.current = null;
      setMesa('');
      setVisitId(null);
      setGuestCount(null);
      setWaiterRequest(null);
      try { sessionStorage.removeItem(VOICE_SESSION_KEY); localStorage.removeItem(MESA_KEY); } catch {}
      try { sessionStorage.removeItem(SESSION_TOKEN_KEY); } catch {}
      resetSessionScopedUi();
    }
    if (ws.data.type === 'robot_state_changed') {
      setRobotStateWs(ws.data);
      const incomingState = ws.data.new_state || ws.data.state || ws.data.robot_state;
      if (DELIVERY_STATES.has(incomingState) && mode !== 'delivery') {
        setMode('delivery');
      }
    }
    if (ws.data.type === 'proactive_message' && (ws.data.rendered_text || ws.data.text)) {
      const displayText = ws.data.rendered_text || ws.data.text;
      const prefix = ws.data.source === 'system' ? '🤖 ' : '💬 ';
      setProactiveMessages(prev => {
        const next = [...prev, { text: `${prefix}${displayText}`, ts: Date.now() }];
        return next.slice(-5);
      });
      setTranscript(`${prefix}${displayText}`);
      if (proactiveTimerRef.current) clearTimeout(proactiveTimerRef.current);
      proactiveTimerRef.current = setTimeout(() => setProactiveMessages([]), 30000);
    }
    if (ws.data.type === 'staff_mode_changed') {
      setIsStaffMode(Boolean(ws.data.enabled ?? ws.data.staff_mode ?? ws.data.is_staff));
    }
  }, [ws.data, resetSessionScopedUi]);

  useEffect(() => {
    let active = true;
    async function initSession() {
      try {
        const stored = sessionStorage.getItem(VOICE_SESSION_KEY);
        if (stored) {
          try {
            const recovery = await postJson(`/api/sessions/${stored}/recover`);
            if (recovery.ok && recovery.session) {
              if (!active) return;
              voiceSessionIdRef.current = stored;
              if (recovery.session.session_access_token) {
                try { sessionStorage.setItem(SESSION_TOKEN_KEY, recovery.session.session_access_token); } catch {}
              }
              setSessionSnapshot(recovery.session);
              setMesa(normalizeMesa(recovery.session.mesa));
              setVisitId(recovery.session.visit_id || null);
              setGuestCount(recovery.session.guest_count || null);
              setInteractionMode(recovery.session.interaction_mode || null);
              setSessionPhase(recovery.session.session_status === 'active' ? 'active' : 'assigned');
              setPartyPromptOpen(!recovery.session.guest_count);
              setModePromptOpen(Boolean(recovery.session.guest_count && !recovery.session.interaction_mode));
              const draft = await fetch(`/api/asr/session/${encodeURIComponent(stored)}`, { cache: 'no-store', headers: sessionReadHeaders() });
              if (draft.ok) applyOrderState(await draft.json());
              return;
            }
          } catch {}
          try {
            sessionStorage.removeItem(VOICE_SESSION_KEY);
            sessionStorage.removeItem(SESSION_TOKEN_KEY);
          } catch {}
        }
      } catch {}
      if (!active) return;
      voiceSessionIdRef.current = null;
      setSessionSnapshot(null);
      setSessionPhase('available');
      resetSessionScopedUi();
      setMesa('');
      setVisitId(null);
      setGuestCount(null);
      setInteractionMode(null);
      setModePromptOpen(false);
      setPartyPromptOpen(false);
      try {
        sessionStorage.removeItem(VOICE_SESSION_KEY);
        sessionStorage.removeItem(SESSION_TOKEN_KEY);
        localStorage.removeItem(MESA_KEY);
      } catch {}
      setTranscript('Estoy disponible. Esperando que el personal me asigne una mesa.');
    }
    initSession();
    return () => { active = false; };
  }, [resetSessionScopedUi]);

  useEffect(() => {
    const snapshot = robotState.data;
    if (!snapshot) return;
    const canonicalId = snapshot.current_session_id || null;
    const currentId = voiceSessionIdRef.current || getVoiceSessionId();
    if (!canonicalId || snapshot.state === 'available') {
      if (Object.prototype.hasOwnProperty.call(snapshot, 'is_staff')) {
        setIsStaffMode(Boolean(snapshot.is_staff));
      }
      setVoiceActive(false);
      setVoiceState('idle');
      setInteractionMode(null);
      setAwaitingConfirmation(false);
      setFinishPrompt(false);
      setSessionSnapshot(null);
      setCart([]);
      setActiveOrder(null);
      setWaiterRequest(null);
      setMesa('');
      setVisitId(null);
      setGuestCount(null);
      setModePromptOpen(false);
      setPartyPromptOpen(false);
      setSafetyContext({ declared_allergies: [], allergy_conflicts: [], special_warning: '', requires_special_confirmation: false });
      voiceSessionIdRef.current = null;
      canonicalRecoveryRef.current = null;
      robotBootstrapInFlightRef.current = null;
      robotBootstrapClaimedRef.current = null;
      asrStoppedRef.current = true;
      try {
        sessionStorage.removeItem(VOICE_SESSION_KEY);
        sessionStorage.removeItem(SESSION_TOKEN_KEY);
        localStorage.removeItem(MESA_KEY);
      } catch {}
      setSessionPhase('available');
      resetSessionScopedUi();
      return;
    }
    if (currentId === canonicalId || canonicalRecoveryRef.current === canonicalId) return;
    canonicalRecoveryRef.current = canonicalId;
    (async () => {
      try {
        const recovery = await postJson(`/api/sessions/${canonicalId}/recover`);
        if (!recovery.ok || !recovery.session) throw new Error('Sesión no recuperable');
        voiceSessionIdRef.current = canonicalId;
        if (recovery.session.session_access_token) {
          try { sessionStorage.setItem(SESSION_TOKEN_KEY, recovery.session.session_access_token); } catch {}
        }
        try { sessionStorage.setItem(VOICE_SESSION_KEY, canonicalId); } catch {}
        setSessionSnapshot(recovery.session);
        setMesa(normalizeMesa(recovery.session.mesa || snapshot.current_mesa));
        setVisitId(recovery.session.visit_id || snapshot.current_visit_id || null);
        setGuestCount(recovery.session.guest_count || null);
        setSessionPhase(recovery.session.session_status === 'active' ? 'active' : 'assigned');
        setPartyPromptOpen(!recovery.session.guest_count);
        setModePromptOpen(Boolean(recovery.session.guest_count && !recovery.session.interaction_mode));
        const draft = await fetch(`/api/asr/session/${encodeURIComponent(canonicalId)}`, { cache: 'no-store', headers: sessionReadHeaders() });
        if (draft.ok) applyOrderState(await draft.json());
      } catch {
        canonicalRecoveryRef.current = null;
        try {
          sessionStorage.removeItem(VOICE_SESSION_KEY);
          sessionStorage.removeItem(SESSION_TOKEN_KEY);
        } catch {}
        setSessionPhase('available');
        setMesa('');
        setVisitId(null);
        setGuestCount(null);
        setModePromptOpen(false);
        setPartyPromptOpen(false);
      }
    })();
  }, [robotState.data?.current_session_id, robotState.data?.state, robotState.data?.changed_at, resetSessionScopedUi]);

  useEffect(() => {
    const handlers = [
      { name: 'chipi-emotion', fn: (e) => { setEmotion(e.detail.emotion); if (e.detail.text) { setTranscript(e.detail.text); setMode('voice'); } } },
      { name: 'chipi-navigate', fn: (e) => { if (e.detail.section) setMode(e.detail.section); } },
      { name: 'chipi-add-to-cart', fn: (e) => { if (e.detail.item) addToCart(e.detail.item); if (e.detail.platos) e.detail.platos.forEach(p => addToCart(p)); } },
    ];
    handlers.forEach(h => window.addEventListener(h.name, h.fn));
    return () => handlers.forEach(h => h.fn && window.removeEventListener(h.name, h.fn));
  }, [mesa, activeOrder, langState]);

  async function postJson(url, body) {
    let sessionToken = null;
    try { sessionToken = sessionStorage.getItem(SESSION_TOKEN_KEY); } catch {}
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(sessionToken ? { 'X-Session-Token': sessionToken } : {}) },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  function requestRobotBootstrap(sessionId = null) {
    if (!ws.connected || !robotConnectionTokenRef.current) return;
    ws.send({
      type: 'robot_bootstrap_request',
      robot_id: ROBOT_ID,
      ...(sessionId ? { session_id: sessionId } : {}),
    });
  }

  async function claimRobotBootstrap(sessionId, bootstrapToken, robotConnectionToken = robotConnectionTokenRef.current) {
    if (!sessionId || !bootstrapToken) return;
    const currentSessionId = voiceSessionIdRef.current || getVoiceSessionId();
    if (currentSessionId && currentSessionId !== sessionId) return;
    if (robotBootstrapClaimedRef.current === sessionId) return;
    if (robotBootstrapInFlightRef.current) return;
    if (!robotConnectionToken) return;
    robotBootstrapInFlightRef.current = sessionId;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/robot-bootstrap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          robot_id: ROBOT_ID,
          bootstrap_token: bootstrapToken,
          robot_connection_token: robotConnectionToken,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.session) throw new Error(data.error || `HTTP ${response.status}`);
      const session = data.session;
      if (voiceSessionIdRef.current && voiceSessionIdRef.current !== session.session_id) return;
      robotBootstrapClaimedRef.current = session.session_id;
      voiceSessionIdRef.current = session.session_id;
      try {
        sessionStorage.setItem(VOICE_SESSION_KEY, session.session_id);
        if (session.session_access_token) sessionStorage.setItem(SESSION_TOKEN_KEY, session.session_access_token);
      } catch {}
      setSessionSnapshot(session);
      setMesa(normalizeMesa(session.mesa));
      setVisitId(session.visit_id || null);
      setGuestCount(session.guest_count || null);
      setInteractionMode(session.interaction_mode || null);
      setSessionPhase(session.session_status === 'active' ? 'active' : 'assigned');
      setPartyPromptOpen(!session.guest_count);
      setModePromptOpen(Boolean(session.guest_count && !session.interaction_mode));
      asrStoppedRef.current = false;
      const draft = await fetch(`/api/asr/session/${encodeURIComponent(session.session_id)}`, {
        cache: 'no-store',
        headers: sessionReadHeaders(),
      });
      if (draft.ok) applyOrderState(await draft.json());
    } catch (error) {
      if (voiceSessionIdRef.current && voiceSessionIdRef.current !== sessionId) return;
      setTranscript(`No pude enlazar la atención asignada: ${error.message}`);
      setSessionPhase('available');
    } finally {
      if (robotBootstrapInFlightRef.current === sessionId) robotBootstrapInFlightRef.current = null;
    }
  }

  async function stopSpeech() {
    try {
      await postJson('/api/tts/stop', { session_id: getVoiceSessionId() });
      setVoiceState('idle');
      setLangState('idle');
    } catch (error) {
      setTranscript(`No pude detener la voz: ${error.message}`);
    }
  }

  async function repeatSpeech() {
    const sessionId = getVoiceSessionId();
    if (!sessionId) return;
    try {
      const data = await postJson('/api/tts/repeat', { session_id: sessionId });
      const displayText = data.display_text || data.text;
      if (displayText) setTranscript(`🤖 Uchino: ${displayText}`);
      setVoiceState('playing');
    } catch (error) {
      setTranscript(`No pude repetir la respuesta: ${error.message}`);
    }
  }

  function applyOrderState(data) {
    if (!data) return;
    if (data.session && typeof data.session === 'object') {
      setSessionSnapshot(data.session);
    } else if (data.menu_state) {
      setSessionSnapshot(previous => ({ ...(previous || {}), ...data }));
    }
    const order = data.order || null;
    const products = Array.isArray(data.products) && data.products.length > 0
      ? data.products
      : Array.isArray(data.draft_items) ? data.draft_items
      : Array.isArray(order?.items) ? order.items : Array.isArray(order?.platos) ? order.platos : null;
    if (products) {
      setCart(products.map(item => ({
        ...item,
        cantidad: Math.max(1, Number(item.cantidad) || 1),
        precio: Number(item.precio) || 0,
      })));
      setShowCartDetail(products.length > 0);
    }
    if (data.mesa) {
      const normalized = normalizeMesa(data.mesa);
      if (normalized) {
        setMesa(normalized);
        try { localStorage.setItem(MESA_KEY, normalized); } catch {}
      }
    }
    if (data.visit_id || data.visit?.visit_id) setVisitId(data.visit_id || data.visit.visit_id);
    if (data.guest_count !== undefined && data.guest_count !== null) setGuestCount(Number(data.guest_count));
    if (data.order_id || order?.id) {
      setActiveOrder({
        ...(order || {}),
        order_id: data.order_id || order.id,
        order_status: data.order_status || order?.status,
      });
    } else if (data.state === 'idle' && (data.cancelled || data.new_order)) {
      setActiveOrder(null);
      setCart([]);
    }
    if (data.state) {
      setLangState(data.state);
      setAwaitingConfirmation(data.state === 'awaiting_confirmation');
    }
    if (Object.prototype.hasOwnProperty.call(data, 'interaction_mode')) {
      setInteractionMode(data.interaction_mode || null);
      setModePromptOpen(!data.interaction_mode);
    }
    if (data.waiter_request) {
      const request = data.waiter_request;
      const requestTable = normalizeMesa(request.table_id || request.mesa);
      const requestSession = request.session_id || null;
      const requestVisit = request.visit_id || null;
      if (request.status === 'pending'
        && requestTable === mesa
        && requestSession === getVoiceSessionId()
        && (!visitId || !requestVisit || requestVisit === visitId)
        && (!request.expires_at || new Date(request.expires_at).getTime() > Date.now())) {
        setWaiterRequest(request);
      }
    }
    if (order?.declared_allergies || order?.allergy_conflicts || order?.special_warning) {
      setSafetyContext(previous => ({
        ...previous,
        declared_allergies: order.declared_allergies || previous.declared_allergies,
        allergy_conflicts: order.allergy_conflicts || previous.allergy_conflicts,
        special_warning: order.special_warning || previous.special_warning,
        requires_special_confirmation: Boolean(order.requires_special_confirmation),
      }));
    }
    if (data.declared_allergies || data.allergy_conflicts || data.special_warning) {
      setSafetyContext(previous => ({
        ...previous,
        declared_allergies: data.declared_allergies || previous.declared_allergies,
        allergy_conflicts: data.allergy_conflicts || previous.allergy_conflicts,
        special_warning: data.special_warning || '',
        requires_special_confirmation: Boolean(data.requires_special_confirmation),
      }));
    }
  }

  function enqueueDraftChange(items, text) {
    const request = draftQueueRef.current
      .catch(() => {})
      .then(async () => {
        if (!mesa) {
          setShowMesaModal(true);
          return null;
        }
        setLangState('processing');
        const data = await postJson('/api/asr/draft', {
          session_id: getVoiceSessionId(),
          mesa,
          items,
          text,
          source: 'tablet',
          interaction_mode: interactionMode || 'screen',
        });
        applyOrderState(data);
        setTranscript(data.text || 'Pedido actualizado.');
        setMode('catalog');
        return data;
      });
    draftQueueRef.current = request.catch((error) => {
      setLangState(activeOrder ? 'awaiting_confirmation' : 'idle');
      setTranscript(`No pude actualizar el pedido: ${error.message}`);
      return null;
    });
    return request;
  }

  async function onMesaSelected(mesaValue, selectionMode = 'initial', tableInfo = null) {
    const normalized = normalizeMesa(mesaValue);
    if (!normalized) return;
    const pendingMode = pendingInteractionModeRef.current;

    try {
      const currentSessionId = getVoiceSessionId();
      const changingActiveAttention = Boolean(currentSessionId && mesa && normalized !== mesa);
      if (changingActiveAttention && orderConfirmed) {
        setShowMesaModal(false);
        try {
          const waiter = await postJson(`/api/sessions/${encodeURIComponent(currentSessionId)}/waiter-assistance`, { source: 'robot_screen' });
          setWaiterRequest(waiter.request || null);
          setTranscript(`El pedido ya está confirmado para ${mesa}. Solicité la atención de un mesero; la mesa no se modificó.`);
        } catch (error) {
          setTranscript(`El pedido ya está confirmado para ${mesa} y no se puede mover. No pude solicitar al mesero: ${error.message}`);
        }
        return;
      }
      if (changingActiveAttention) {
        const moveMessage = cart.length > 0
          ? `Tienes un pedido en borrador para ${mesa}. ¿Deseas moverlo a ${normalized}?`
          : `La atención está asociada a ${mesa}. ¿Deseas moverla a ${normalized}?`;
        const confirmedMove = window.confirm(moveMessage);
        if (!confirmedMove) return;
        await postJson(`/api/sessions/${encodeURIComponent(currentSessionId)}/move-table`, {
          mesa: normalized,
          order_id: activeOrder?.order_id || activeOrder?.id || null,
          source: 'robot_screen',
        });
        const movedResponse = await fetch(`/api/asr/session/${encodeURIComponent(currentSessionId)}`, { cache: 'no-store', headers: sessionReadHeaders() });
        const movedState = await movedResponse.json().catch(() => ({}));
        if (!movedResponse.ok) throw new Error(movedState.error || `HTTP ${movedResponse.status}`);
        applyOrderState(movedState);
        setMesa(normalized);
        try { localStorage.setItem(MESA_KEY, normalized); } catch {}
        setVisitId(movedState.visit_id || movedState.session?.visit_id || visitId);
        setSessionPhase('assigned');
        setShowMesaModal(false);
        setTranscript(cart.length > 0 ? `Pedido movido a ${normalized}.` : `Atención movida a ${normalized}.`);
        return;
      }
      const startPayload = {
        robot_id: 'uchino-01',
        mesa: normalized,
        source: selectionMode === 'additional' ? 'additional_order' : 'manual',
        ...(selectionMode === 'additional' ? { additional_order: true } : {}),
        ...(selectionMode === 'continue' ? { continue_visit: true } : {}),
      };
      const startData = await postJson('/api/sessions/start', startPayload);
      voiceSessionIdRef.current = startData.session_id;
      if (startData.session_access_token) {
        try { sessionStorage.setItem(SESSION_TOKEN_KEY, startData.session_access_token); } catch {}
      }
      try { sessionStorage.setItem(VOICE_SESSION_KEY, startData.session_id); } catch {}
      const currentVisitId = startData.visit?.visit_id || startData.session?.visit_id || tableInfo?.visit?.visit_id || null;
      const existingGuestCount = Number(startData.visit?.guest_count || startData.session?.guest_count || tableInfo?.visit?.guest_count || 0) || null;
      setVisitId(currentVisitId);
      setGuestCount(existingGuestCount);
      setSessionPhase('assigned');

      const asrData = await postJson('/api/asr/session', {
        session_id: startData.session_id,
        mesa: normalized,
        visit_id: currentVisitId,
        robot_id: 'uchino-01',
        ...(existingGuestCount ? { guest_count: existingGuestCount } : {}),
        present: !presentationShownRef.current,
      });

      applyOrderState(asrData);
      setMesa(normalized);
      try { localStorage.setItem(MESA_KEY, normalized); } catch {}
      setShowMesaModal(false);
      setPartyPromptOpen(!existingGuestCount);
      setModePromptOpen(Boolean(existingGuestCount && !asrData.interaction_mode));
      setMode('catalog');
      setTranscript(existingGuestCount
        ? 'La mesa está lista. Elige cómo prefieres realizar tu pedido.'
        : 'Antes de comenzar, ¿cuántas personas son en la mesa?');
      if (pendingMode && existingGuestCount) pendingInteractionModeRef.current = pendingMode;
    } catch (error) {
      setTranscript(`No pude guardar la mesa: ${error.message}`);
    }
  }

  async function confirmPartySize(count) {
    const numericCount = Number(count);
    const sid = getVoiceSessionId();
    if (!sid || !Number.isInteger(numericCount) || numericCount < 1) return;
    try {
      const data = await postJson(`/api/sessions/${encodeURIComponent(sid)}/party-size`, { guest_count: numericCount });
      const nextSession = data.session || {};
      setGuestCount(numericCount);
      setVisitId(nextSession.visit_id || visitId);
      setPartyPromptOpen(false);
      setModePromptOpen(true);
      setSessionPhase('choosing_mode');
      setTranscript('Gracias. Ahora elige voz, pantalla o atención de un mesero.');
    } catch (error) {
      setTranscript(`No pude registrar el tamaño del grupo: ${error.message}`);
    }
  }

  const openMesaSelector = useCallback(() => {
    if (!isStaffMode) {
      setTranscript('La asignación de mesa la realiza el personal desde Administración.');
      return;
    }
    setShowMesaModal(true);
  }, [isStaffMode]);

  async function runStaffCommand(command) {
    const token = localStorage.getItem('admin_token');
    if (!token) {
      setTranscript('Se requiere autenticación de Administración para controlar el robot.');
      return;
    }
    try {
      const response = await fetch('/api/admin/robot-command', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ command }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      setTranscript(command === 'pause' ? 'Robot pausado por el personal.'
        : command === 'resume' ? 'Robot reanudado.'
          : 'Emergencia detenida por el personal.');
    } catch (error) {
      setTranscript(`No pude ejecutar el comando del robot: ${error.message}`);
    }
  }

  function getVoiceSessionId() {
    if (voiceSessionIdRef.current) return voiceSessionIdRef.current;
    try {
      const sid = sessionStorage.getItem(VOICE_SESSION_KEY);
      if (sid) {
        voiceSessionIdRef.current = sid;
        return sid;
      }
    } catch {}
    return null;
  }

  function startVoiceSession(mesaOverride = mesa) {
    if (asrStoppedRef.current) {
      setTranscript('La sesi\u00F3n ha terminado. Inicia un nuevo pedido para continuar.');
      return null;
    }
    modeSelectionTouchedRef.current = true;
    const sid = getVoiceSessionId();
    if (!sid) {
      setTranscript('Espera un momento... iniciando sesi\u00F3n.');
      return null;
    }
    const presentationRequested = !presentationShownRef.current;
    if (!mesaOverride) {
      pendingInteractionModeRef.current = 'voice';
      setShowMesaModal(true);
      return sid;
    }
    if (!guestCount) {
      pendingInteractionModeRef.current = 'voice';
      setPartyPromptOpen(true);
      setModePromptOpen(false);
      setTranscript('Antes de hablar, dime cuántas personas son en la mesa.');
      return sid;
    }
    setInteractionMode('voice');
    setModePromptOpen(false);
    setVoiceActive(true);
    setFinishPrompt(false);
    setMode('voice');
    setLangState('listening');
    setEmotion('escuchando');
    if (presentationRequested) {
      presentationShownRef.current = true;
      setTranscript('Hola, soy Uchino. Te escucho. \u00BFQu\u00E9 te gustar\u00EDa ordenar?');
    } else {
      setTranscript('Te escucho. \u00BFQu\u00E9 deseas agregar o cambiar?');
    }
    void postJson('/api/asr/session', {
      session_id: sid,
      mesa: mesaOverride,
      visit_id: visitId,
      robot_id: ROBOT_ID,
      guest_count: guestCount,
      interaction_mode: 'voice',
      present: presentationRequested,
      listening: true,
    })
      .then(data => {
        applyOrderState(data);
        if (presentationRequested && !data.presentation_required) {
          setTranscript('Te escucho. \u00BFQu\u00E9 deseas agregar o cambiar?');
        }
      })
      .catch(() => {});
    void postJson(`/api/sessions/${sid}/mode`, { mode: 'voice' }).catch(() => {});
    return sid;
  }

  function startPartyVoiceSession() {
    if (asrStoppedRef.current) {
      setTranscript('La sesión ha terminado. Inicia una nueva atención para continuar.');
      return null;
    }
    const sid = getVoiceSessionId();
    if (!sid || !mesa) {
      setTranscript('Espera a que la mesa quede asignada antes de responder por voz.');
      return null;
    }
    setVoiceActive(true);
    setVoiceState('listening');
    setLangState('listening');
    setEmotion('escuchando');
    setMode('voice');
    setTranscript('Te escucho. ¿Cuántas personas son en la mesa?');
    void postJson('/api/asr/session', {
      session_id: sid,
      mesa,
      visit_id: visitId,
      robot_id: ROBOT_ID,
      present: false,
      listening: true,
    }).catch(error => setTranscript(`No pude activar el micrófono: ${error.message}`));
    return sid;
  }

  function selectInteractionMode(nextMode) {
    modeSelectionTouchedRef.current = true;
    if (!guestCount) {
      pendingInteractionModeRef.current = nextMode;
      setPartyPromptOpen(true);
      setModePromptOpen(false);
      setTranscript('Antes de comenzar, ¿cuántas personas son en la mesa?');
      return;
    }
    if (nextMode === 'voice') {
      startVoiceSession();
      return;
    }
    if (!mesa) {
      pendingInteractionModeRef.current = nextMode;
      setShowMesaModal(true);
      return;
    }
    setInteractionMode(nextMode);
    setModePromptOpen(false);
    if (nextMode === 'human_waiter') {
      void postJson('/api/asr/session', {
        session_id: getVoiceSessionId(),
        mesa,
        visit_id: visitId,
        robot_id: ROBOT_ID,
        guest_count: guestCount,
        interaction_mode: 'human_waiter',
      }).then(() => postJson('/api/asr/process', {
        session_id: getVoiceSessionId(),
        mesa,
        source: 'tablet',
        interaction_mode: 'human_waiter',
        user_text: 'Llama a un mesero',
      })).then(data => {
        applyOrderState(data);
        setTranscript(data.text || 'De acuerdo. He solicitado la atención de un mesero para esta mesa.');
        setMode('catalog');
      }).catch(error => setTranscript(`No pude solicitar al mesero: ${error.message}`));
      return;
    }
    void postJson('/api/asr/session', {
      session_id: getVoiceSessionId(),
      mesa,
      visit_id: visitId,
      robot_id: ROBOT_ID,
      guest_count: guestCount,
      interaction_mode: nextMode,
    }).then(data => {
      applyOrderState(data);
      setMode('catalog');
    }).catch(error => setTranscript(`No pude cambiar el modo: ${error.message}`));
  }

  async function finalizarConversacion() {
    setVoiceActive(false);
    const hasDraft = cart.length > 0 && (!activeOrder || activeOrder.order_status === 'draft' || awaitingConfirmation);
    if (hasDraft) {
      setFinishPrompt(true);
      setAwaitingConfirmation(true);
      setLangState('awaiting_confirmation');
      setTranscript('¿Deseas conservar, confirmar o cancelar tu pedido?');
      setMode('pedido');
      return;
    }
    if (activeOrder?.order_status === 'sent_to_kitchen' || ['confirmed', 'completed'].includes(langState)) {
      await completarSesionVoz();
      setMode('pedido');
      return;
    }
    setTranscript('Conversación finalizada.');
    setLangState('completed');
    setMode('catalog');
  }

  async function completarSesionVoz() {
    const sid = voiceSessionIdRef.current;
    if (!sid) return;
    try {
      const data = await postJson('/api/asr/complete', { session_id: sid });
      applyOrderState(data);
    } catch {
      setLangState('completed');
    }
    setVoiceActive(false);
    setVoiceState('idle');
  }

  async function confirmarPorBoton() {
    const sid = getVoiceSessionId();
    if (!sid) return;
    try {
      const data = safetyContext.requires_special_confirmation
        ? await postJson('/api/asr/process', { session_id: sid, mesa, source: 'tablet', user_text: 'Confírmalo de todas formas' })
        : await postJson('/api/asr/confirm', { session_id: sid });
      applyOrderState(data);
      setFinishPrompt(false);
      setTranscript(data.text || '¡Pedido confirmado!');
      setEmotion('celebrando');
      setShowCartDetail(false);
      await completarSesionVoz();
      setMode('pedido');
    } catch (e) {
      console.error('[RobotScreen] Error al confirmar:', e);
      setTranscript(`No pude confirmar el pedido: ${e.message}`);
    }
  }

  async function cancelarPorBoton() {
    const sid = voiceSessionIdRef.current;
    if (!sid) return;
    try {
      const data = await postJson('/api/asr/cancel', { session_id: sid });
      applyOrderState(data);
    } catch (error) {
      setTranscript(`No pude cancelar el pedido: ${error.message}`);
      return;
    }
    setVoiceActive(false);
    setAwaitingConfirmation(false);
    setTranscript('Pedido cancelado.');
    setEmotion('saludando');
    setShowCartDetail(false);
    setFinishPrompt(false);
    setSafetyContext({ declared_allergies: [], allergy_conflicts: [], special_warning: '', requires_special_confirmation: false });
    try {
      await postJson(`/api/sessions/${encodeURIComponent(sid)}/close`, { reason: 'user_cancelled_order', source: 'robot_screen' });
    } catch (error) {
      setTranscript(`El borrador se canceló, pero no pude cerrar la atención: ${error.message}`);
      return;
    }
    voiceSessionIdRef.current = null;
    setMesa('');
    setVisitId(null);
    setGuestCount(null);
    setWaiterRequest(null);
    try { sessionStorage.removeItem(VOICE_SESSION_KEY); localStorage.removeItem(MESA_KEY); } catch {}
    setSessionPhase('available');
    setMode('catalog');
  }

  async function cancelarAtencion() {
    const sid = getVoiceSessionId();
    try {
      if (sid) await postJson('/api/asr/cancel', { session_id: sid });
    } catch (error) {
      setTranscript(`No pude cancelar la atención: ${error.message}`);
      return;
    }
    try {
      if (sid) await postJson(`/api/sessions/${sid}/close`, { reason: 'user_cancelled_attention', source: 'robot_screen' });
    } catch (error) {
      setTranscript(`La atención sigue activa; no pude cerrarla: ${error.message}`);
      return;
    }
    setVoiceActive(false);
    setVoiceState('idle');
    setAwaitingConfirmation(false);
    setCart([]);
    setActiveOrder(null);
    setInteractionMode(null);
    setModePromptOpen(false);
    setPartyPromptOpen(false);
    setFinishPrompt(false);
    asrStoppedRef.current = true;
    voiceSessionIdRef.current = null;
    setMesa('');
    setVisitId(null);
    setGuestCount(null);
    setWaiterRequest(null);
    try { sessionStorage.removeItem(VOICE_SESSION_KEY); localStorage.removeItem(MESA_KEY); } catch {}
    setSessionPhase('available');
    setTranscript('Atención cancelada. Estoy disponible para una nueva atención.');
    setEmotion('saludando');
    setMode('catalog');
  }

  function isOptionDisabled(key) {
    switch (key) {
      case 'ver_pedido': return cart.length === 0;
      case 'cambiar_mesa': return !mesa || !isStaffMode;
      case 'cancelar_pedido': return orderConfirmed || cart.length === 0;
      case 'solicitar_mesero': return interactionMode === 'human_waiter';
      default: return false;
    }
  }

  function handleOptionAction(key) {
    setShowOptionsModal(false);
    switch (key) {
      case 'ver_pedido':
        setMode('pedido');
        setShowCartDetail(true);
        break;
      case 'ver_menu':
        setMode('catalog');
        break;
      case 'cambiar_modo':
        setModePromptOpen(true);
        break;
      case 'cambiar_mesa':
        openMesaSelector();
        break;
      case 'cancelar_pedido':
        cancelarPorBoton();
        break;
      case 'cancelar_atencion':
        cancelarAtencion();
        break;
      case 'solicitar_mesero':
        selectInteractionMode('human_waiter');
        break;
    }
  }

  function addToCart(plato) {
    if (['confirmed', 'completed'].includes(langState)) {
      setTranscript('Este pedido ya está confirmado. Pulsa “Nuevo pedido” para continuar.');
      return;
    }
    return enqueueDraftChange(
      [{ nombre: plato.nombre, cantidad: 1 }],
      `Agrega ${plato.nombre}`,
    );
  }

  function removeFromCart(nombre) {
    return enqueueDraftChange(
      [{ nombre, cantidad: 1 }],
      `Quita ${nombre}`,
    );
  }

  async function applyItemSafety(operation) {
    if (!safetyEditorItem) return;
    try {
      const data = await postJson('/api/asr/item-safety', {
        session_id: getVoiceSessionId(),
        item_id: safetyEditorItem.item_id,
        ...operation,
      });
      applyOrderState(data);
      setSafetyEditorError('');
      setSafetyEditorItem(null);
    } catch (error) {
      setSafetyEditorError(error.message);
    }
  }

  async function confirmar() {
    if (cart.length === 0) return;
    try {
      const data = safetyContext.requires_special_confirmation
        ? await postJson('/api/asr/process', { session_id: getVoiceSessionId(), mesa, source: 'tablet', user_text: 'Confírmalo de todas formas' })
        : await postJson('/api/asr/confirm', { session_id: getVoiceSessionId() });
      applyOrderState(data);
      setAwaitingConfirmation(false);
      setShowCartDetail(false);
      setEmotion('celebrando');
      setTranscript(data.text || '¡Pedido confirmado!');
      setLangState('confirmed');
      await completarSesionVoz();
      setMode('pedido');
    } catch (e) {
      console.error('[RobotScreen] Network error:', e.message);
      setTranscript(`No pude confirmar el pedido: ${e.message}`);
      setMode('voice');
    }
  }

  async function nuevoPedido() {
    try {
      const sid = getVoiceSessionId();
      const currentMesa = mesa;
      const currentVisitId = visitId;
      const currentGuestCount = guestCount;
      if (!currentMesa) {
        setShowMesaModal(true);
        setTranscript('Selecciona una mesa para comenzar una nueva atenci\u00F3n.');
        return;
      }
      if (sid) {
        try { await postJson(`/api/sessions/${sid}/close`, { reason: 'user_requested_new_order', source: 'robot_screen' }); } catch {}
      }
      voiceSessionIdRef.current = null;
      try { sessionStorage.removeItem(VOICE_SESSION_KEY); } catch {}
      const data = await postJson('/api/sessions/start', {
        robot_id: 'uchino-01',
        mesa: currentMesa,
        source: 'additional_order',
        additional_order: true,
        ...(currentVisitId ? { visit_id: currentVisitId } : {}),
        ...(currentGuestCount ? { guest_count: currentGuestCount } : {}),
      });
      voiceSessionIdRef.current = data.session_id;
      if (data.session_access_token) {
        try { sessionStorage.setItem(SESSION_TOKEN_KEY, data.session_access_token); } catch {}
      }
      try { sessionStorage.setItem(VOICE_SESSION_KEY, data.session_id); } catch {}
      asrStoppedRef.current = false;
      resetSessionScopedUi();
      setCart([]);
      setActiveOrder(null);
      setAwaitingConfirmation(false);
      setFinishPrompt(false);
      setLangState('idle');
      setVoiceActive(false);
      setVoiceState('idle');
      setInteractionMode(null);
      setVisitId(data.visit?.visit_id || currentVisitId);
      setGuestCount(Number(data.visit?.guest_count || currentGuestCount || 0) || null);
      setModePromptOpen(true);
      setPartyPromptOpen(false);
      setSafetyContext({ declared_allergies: [], allergy_conflicts: [], special_warning: '', requires_special_confirmation: false });
      setSessionPhase('choosing_mode');
      setTranscript('Pedido nuevo iniciado. \u00BFQu\u00E9 modo de atenci\u00F3n prefieres?');
      setMode('catalog');
    } catch (error) {
      setTranscript(`No pude iniciar un pedido nuevo: ${error.message}`);
    }
  }

  function conservarDraft() {
    setFinishPrompt(false);
    setVoiceActive(false);
    setAwaitingConfirmation(true);
    setLangState('awaiting_confirmation');
    setTranscript('Pedido conservado. Puedes confirmarlo cuando quieras.');
    setMode('pedido');
  }

  function handleVoiceMessage(msg) {
    if (msg.type === 'voice_stop') {
      void finalizarConversacion();
      return;
    }
    if (msg.type === 'user_text' && msg.text) {
      setVoiceTranscript(`🗣️ ${msg.text}`);
      setTranscript(`Tú: ${msg.text}`);
      setMode('voice');
      setLangState('processing');
      setVoiceState('processing');
      return;
    }
    if (msg.type === 'asr_response') {
      const displayText = msg.display_text || msg.text;
      if (displayText) setTranscript(`🤖 Uchino: ${displayText}`);
      if (displayText) {
        setLastSpeechResponse({
          session_id: msg.session_id || getVoiceSessionId(),
          display_text: displayText,
          speech_text: msg.speech_text || null,
          speech_segments: msg.speech_segments || [],
        });
      }
      applyOrderState(msg);
      if (msg.intent === 'set_party_size' && Number(msg.guest_count) > 0) {
        setGuestCount(Number(msg.guest_count));
        setPartyPromptOpen(false);
        setModePromptOpen(true);
        setSessionPhase('choosing_mode');
        setVoiceActive(false);
        setVoiceState('idle');
        setLangState('idle');
        setMode('catalog');
        setTranscript('Gracias. Ahora elige voz, pantalla o atención de un mesero.');
        return;
      }
      if (msg.additional_order_started && msg.session_id) {
        voiceSessionIdRef.current = msg.session_id;
        try { sessionStorage.setItem(VOICE_SESSION_KEY, msg.session_id); } catch {}
        setActiveOrder(null);
        setCart([]);
        setAwaitingConfirmation(false);
        setInteractionMode('voice');
        setSessionPhase('active');
        setVoiceActive(true);
        setVoiceState('listening');
        setLangState('listening');
        setMode('voice');
      } else if (msg.new_order) {
        setEmotion('saludando');
        setVoiceActive(false);
        setAwaitingConfirmation(false);
        setVoiceState('idle');
        setLangState('idle');
        setTranscript(msg.text || 'Pedido nuevo iniciado.');
        setMode('catalog');
      } else if (msg.confirmed || msg.state === 'confirmed' || msg.order_status === 'sent_to_kitchen') {
        setEmotion('celebrando');
        setAwaitingConfirmation(false);
        setVoiceState('playing');
        void completarSesionVoz();
      } else if (msg.cancelled) {
        setEmotion('saludando');
        setVoiceActive(false);
        setAwaitingConfirmation(false);
        setVoiceState('idle');
        setMode('catalog');
      } else if (msg.state === 'awaiting_confirmation') {
        setEmotion('pensando');
        setShowCartDetail(true);
        setMode('pedido');
      } else {
        setEmotion('feliz');
        setMode('voice');
      }
      return;
    }
    if (msg.type === 'asr_error' && msg.text) {
      setTranscript(`⚠️ ${msg.text}`);
      setLangState('listening');
      setMode('voice');
      setVoiceState('idle');
      return;
    }
    if (msg.type === 'voice_state' && msg.state) {
      setVoiceState(msg.state);
      if (msg.state === 'listening') {
        setEmotion('escuchando');
        setLangState('listening');
      } else if (msg.state === 'idle') {
        if (langState !== 'completed') setLangState('idle');
      } else if (msg.state === 'processing') {
        setEmotion('pensando');
        setLangState('processing');
      } else if (msg.state === 'playing') {
        setLangState('processing');
      }
    }
  }

  return (
    <div className="w-full h-full bg-chipi-bg text-text-primary flex flex-col overflow-hidden select-none relative" style={{ fontFamily: "'Segoe UI', system-ui, sans-serif" }}>
      {/* Overlay generativo: el LLM puede renderizar componentes (platos, alertas, etc) sobre la UI */}
      <UIBridge />
      {showMesaModal && (
        <MesaSelector
          currentMesa={mesa}
          onSelect={onMesaSelected}
          onClose={() => setShowMesaModal(false)}
          liveEvent={ws.data}
        />
      )}
      <header className="shrink-0 min-h-14 sm:min-h-12 px-2 sm:px-4 py-1.5 flex items-center gap-1.5 sm:gap-2 glass border-b border-chipi-border z-20 overflow-hidden">
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-base sm:text-lg font-bold neon-text-cyan tracking-tight">UCHINO</span>
          <span className="hidden sm:inline text-[10px] text-text-dim font-medium mt-1">v3.0</span>
        </div>
        <div className="ml-auto flex items-center justify-end gap-1.5 sm:gap-3 min-w-0">
          <div className="hidden sm:flex items-center gap-1.5 text-[10px] text-text-secondary shrink-0">
            <BatteryIcon pct={robotState.data?.bateria ?? 85} />
            <span>{robotState.data?.bateria ?? 85}%</span>
          </div>
          <div className={`w-2 h-2 rounded-full shrink-0 ${ws.connected ? 'bg-neon-green glow-pulse-green' : 'bg-neon-rose'}`} title={ws.connected ? 'WebSocket conectado' : 'WebSocket desconectado'} />
          {!hasAssignedAttention && (
            <span className="max-w-36 truncate px-2 py-0.5 rounded bg-neon-green/15 text-neon-green text-[10px] font-semibold border border-neon-green/30 shrink-0">
              Robot Disponible
            </span>
          )}
          {hasAssignedAttention && mesa && (
            <span className="max-w-16 truncate px-2 py-0.5 rounded bg-neon-cyan/15 text-neon-cyan text-[10px] font-semibold border border-neon-cyan/30 shrink-0">
              Mesa {mesa}
            </span>
          )}
          {hasAssignedAttention && guestCount && (
            <span className="hidden sm:inline-flex max-w-20 truncate px-2 py-0.5 rounded bg-neon-amber/15 text-neon-amber text-[10px] font-semibold border border-neon-amber/30 shrink-0" title={`${guestCount} comensales`}>
              👥 {guestCount}
            </span>
          )}
          {hasAssignedAttention && sessionPhase && SESSION_PHASE_LABELS[sessionPhase] && (
            <span className={`max-w-32 truncate px-2 py-0.5 rounded text-[10px] font-semibold border shrink-0 ${
              sessionPhase === 'active' ? 'bg-neon-green/15 text-neon-green border-neon-green/30' :
              sessionPhase === 'completing' || sessionPhase === 'expired' ? 'bg-neon-rose/15 text-neon-rose border-neon-rose/30' :
              sessionPhase === 'available' ? 'bg-neon-green/15 text-neon-green border-neon-green/30' :
              sessionPhase === 'closed' ? 'bg-neon-purple/15 text-neon-purple border-neon-purple/30' :
              'bg-neon-cyan/15 text-neon-cyan border-neon-cyan/30'
            }`}>
              {partyPromptOpen
                ? 'Registrando comensales'
                : robotStateKey === 'assigned'
                  ? `En camino a ${mesa || 'la mesa'}`
                  : robotStateKey === 'navigating_to_table'
                    ? `En camino a ${mesa || 'la mesa'}`
                    : robotStateKey === 'arrived_at_table'
                      ? `Llegó a ${mesa || 'la mesa'}`
                  : sessionPhase === 'active' && mesa
                    ? `Atendiendo ${mesa}`
                    : SESSION_PHASE_LABELS[sessionPhase]}
            </span>
          )}
          <span className={`hidden sm:inline-flex px-2 py-0.5 rounded text-[10px] font-semibold border shrink-0 ${
            isStaffMode
              ? 'bg-neon-amber/15 text-neon-amber border-neon-amber/30'
              : 'bg-neon-green/15 text-neon-green border-neon-green/30'
          }`}>
            {isStaffMode ? '🔒 Staff' : '👤 Cliente'}
          </span>
          {hasAssignedAttention && interactionMode && (
            <button
              onClick={() => setModePromptOpen(true)}
              className="hidden md:inline-flex max-w-28 min-h-10 items-center truncate px-2 py-2 rounded bg-neon-purple/15 text-neon-purple text-[10px] font-semibold border border-neon-purple/30 shrink-0"
              title="Cambiar modo de atención"
            >
              Modo {interactionModeLabel}
            </button>
          )}
          {hasAssignedAttention && (
            <>
              {!(modePromptOpen && !interactionMode) && !partyPromptOpen && (
                <VoiceAsrButton
                  mesa={mesa}
                  sessionId={getVoiceSessionId()}
                  active={voiceActive}
                  onStartRequest={startVoiceSession}
                  onMessage={handleVoiceMessage}
                />
              )}
              {mode !== 'catalog' && (
                <button onClick={() => setMode('catalog')} className="btn-primary min-h-10 px-3 py-2 rounded text-[10px] shrink-0">
                  Menú
                </button>
              )}
              <button
                onClick={() => setShowOptionsModal(true)}
                className="min-h-10 px-3 py-2 rounded text-[10px] font-semibold border border-neon-purple/40 text-neon-purple bg-neon-purple/10 hover:bg-neon-purple/20 transition-all shrink-0"
              >
                Opciones
              </button>
            </>
          )}
        </div>
      </header>

      <main className="flex-1 relative overflow-hidden">
        {safetyEditorItem && (
          <ItemSafetyEditor
            item={safetyEditorItem}
            menuItem={menuItems.find(candidate => candidate.id === safetyEditorItem.product_id) || menuItems.find(candidate => candidate.nombre === safetyEditorItem.nombre)}
            allowlist={observations}
            onApply={applyItemSafety}
            onClose={() => { setSafetyEditorItem(null); setSafetyEditorError(''); }}
          />
        )}
        {safetyEditorError && (
          <div className="absolute top-2 left-3 right-3 z-50 rounded-xl border border-neon-rose/50 bg-chipi-card px-3 py-2 text-center text-[11px] text-neon-rose" role="alert">
            {safetyEditorError}
          </div>
        )}
        {hasAssignedAttention && waiterRequest && waiterRequest.status === 'pending' && (
          <div className="absolute top-2 left-3 right-3 z-20 rounded-xl border border-neon-amber/50 bg-chipi-card/95 px-3 py-2 text-center text-[11px] text-neon-amber shadow-lg" role="status">
            Solicitud de mesero registrada para {waiterRequest.table_id || waiterRequest.mesa}. Esperando atención.
          </div>
        )}
        {!hasAssignedAttention && mode !== 'delivery' && (
          <section className="absolute inset-0 z-30 flex items-center justify-center p-4" aria-label="Robot disponible">
            <div className="glass w-full max-w-md rounded-2xl border border-neon-green/40 bg-chipi-card/95 p-5 text-center shadow-2xl">
              <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full border border-neon-green/40 bg-neon-green/10 text-3xl">👀</div>
              <h1 className="text-lg font-bold text-neon-green">Estoy disponible</h1>
              <p className="mt-2 text-xs leading-relaxed text-text-secondary">Esperando que el personal me asigne una mesa para comenzar la atención.</p>
              {isStaffMode ? (
                <button onClick={openMesaSelector} className="mt-4 min-h-11 w-full rounded-xl border border-neon-cyan/50 bg-neon-cyan/10 px-4 py-3 text-sm font-bold text-neon-cyan hover:bg-neon-cyan/20">Asignar mesa</button>
              ) : (
                <p className="mt-4 rounded-xl border border-chipi-border px-4 py-3 text-xs text-text-secondary">La asignación la realiza el personal desde Administración.</p>
              )}
            </div>
          </section>
        )}
        {hasAssignedAttention && partyPromptOpen && (
          <section className="absolute inset-0 z-40 flex items-center justify-center bg-black/45 p-3" aria-label="Tamaño del grupo">
            <div className="glass w-full max-w-md max-h-[calc(100vh-1.5rem)] overflow-y-auto rounded-2xl border border-neon-cyan/40 bg-chipi-card/98 p-4 shadow-2xl">
              <p className="text-[10px] uppercase tracking-wider text-neon-cyan font-semibold">Antes de comenzar</p>
              <h1 className="mt-1 text-base font-bold text-text-primary">¿Cuántas personas son en la mesa?</h1>
              <p className="mt-1 text-xs text-text-secondary">Selecciona el tamaño del grupo. No modifica cantidades del pedido.</p>
              <div className="mt-4 grid grid-cols-4 gap-2">
                {Array.from({ length: 12 }, (_, index) => index + 1).map(count => (
                  <button key={count} onClick={() => void confirmPartySize(count)} className="min-h-10 rounded-xl border border-neon-cyan/35 bg-neon-cyan/10 text-sm font-bold text-neon-cyan hover:bg-neon-cyan/20">{count}</button>
                ))}
                <button onClick={() => void confirmPartySize(13)} className="col-span-4 min-h-10 rounded-xl border border-neon-amber/40 bg-neon-amber/10 text-sm font-bold text-neon-amber hover:bg-neon-amber/20">Más de 12</button>
              </div>
              <div className="mt-3 flex items-center justify-between gap-3 border-t border-chipi-border pt-3">
                <span className="text-[10px] text-text-secondary">También puedes responder hablando.</span>
                <VoiceAsrButton
                  mesa={mesa}
                  sessionId={getVoiceSessionId()}
                  active={voiceActive}
                  interactionMode={null}
                  onStartRequest={startPartyVoiceSession}
                  onMessage={handleVoiceMessage}
                />
              </div>
            </div>
          </section>
        )}
        {hasAssignedAttention && modePromptOpen && !partyPromptOpen && (
          <section className="absolute top-2 left-3 right-3 z-40 rounded-2xl border border-neon-cyan/40 bg-chipi-card/98 p-4 shadow-2xl" aria-label="Selección del modo de atención">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div className="min-w-0">
                <p className="text-[10px] uppercase tracking-wider text-neon-cyan font-semibold">Modo de atención</p>
                <h1 className="text-sm sm:text-base font-bold text-text-primary leading-tight">¿Cómo prefieres realizar tu pedido?</h1>
                <p className="mt-1 text-xs text-text-secondary">Por voz, mediante la pantalla o con la atención de un mesero.</p>
              </div>
              {interactionMode && (
                <button onClick={() => setModePromptOpen(false)} className="shrink-0 rounded-lg border border-chipi-border px-2 py-1 text-[10px] text-text-secondary hover:text-text-primary" aria-label="Cerrar selección de modo">Cerrar</button>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <button onClick={() => selectInteractionMode('voice')} className="rounded-xl border border-neon-cyan/50 bg-neon-cyan/10 px-3 py-3 text-left text-xs font-bold text-neon-cyan hover:bg-neon-cyan/20">Pedir por voz</button>
              <button onClick={() => selectInteractionMode('screen')} className="rounded-xl border border-neon-purple/50 bg-neon-purple/10 px-3 py-3 text-left text-xs font-bold text-neon-purple hover:bg-neon-purple/20">Usar pantalla</button>
              <button onClick={() => selectInteractionMode('human_waiter')} className="rounded-xl border border-neon-amber/50 bg-neon-amber/10 px-3 py-3 text-left text-xs font-bold text-neon-amber hover:bg-neon-amber/20">Solicitar mesero</button>
            </div>
            {!mesa && <p className="mt-2 text-xs text-text-secondary">Primero seleccionaremos una mesa para asociar la sesión.</p>}
          </section>
        )}
        {showOptionsModal && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setShowOptionsModal(false)}>
            <div className="glass rounded-2xl p-4 border border-chipi-border max-w-md w-full mx-4 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-bold neon-text-purple">Opciones</h2>
                <button onClick={() => setShowOptionsModal(false)} className="rounded-lg border border-chipi-border px-2 py-1 text-[10px] text-text-secondary hover:text-text-primary">Cerrar</button>
              </div>
              <div className="grid grid-cols-1 gap-2">
                {OPTIONS_CONFIG.map(opt => {
                  const disabled = isOptionDisabled(opt.key);
                  return (
                    <button
                      key={opt.key}
                      onClick={() => !disabled && handleOptionAction(opt.key)}
                      disabled={disabled}
                      className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left text-xs font-semibold transition-all ${
                        disabled
                          ? 'border-chipi-border/30 bg-chipi-card/30 text-text-dim cursor-not-allowed opacity-50'
                          : 'border-chipi-border bg-chipi-card/60 hover:bg-chipi-card/80'
                      }`}
                      style={!disabled ? { borderColor: `${opt.color}40`, color: opt.color } : {}}
                    >
                      <span className="text-base">{opt.icon}</span>
                      <span>{opt.label}</span>
                    </button>
                  );
                })}
              </div>
              <MemoryPanel
                sessionId={getVoiceSessionId()}
                mesa={mesa}
                memoryEvent={ws.data?.type === 'memory_event' ? ws.data : null}
                onOrderChanged={(data) => {
                  if (data.products) setCart(data.products);
                  setShowCartDetail(true);
                  setMode('pedido');
                }}
              />
            </div>
          </div>
        )}
        <div className={`absolute inset-0 flex flex-col transition-all duration-500 ${hasAssignedAttention && mode === 'catalog' && !modePromptOpen && !partyPromptOpen ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-8 pointer-events-none'} ${modePromptOpen || partyPromptOpen ? 'pt-72 sm:pt-40' : ''}`}>
          <div className={`shrink-0 flex gap-2 px-3 ${modePromptOpen ? 'pt-2 pb-1' : 'pt-3 pb-2'}`}>            {CATEGORIAS.map(cat => {
              const cfg = CATEGORIA_CONFIG[cat];
              const active = activeCat === cat;
              return (
                <button
                  key={cat}
                  onClick={() => setActiveCat(cat)}
                  className={`flex-1 rounded-xl font-semibold transition-all border ${modePromptOpen ? 'py-2 text-xs' : 'py-3 text-sm'} ${active ? 'border-opacity-50' : 'border-transparent opacity-60'}`}
                  style={{
                    background: active ? `${cfg.color}20` : '#ffffff08',
                    borderColor: active ? `${cfg.color}60` : 'transparent',
                    color: active ? cfg.color : '#a0a0b8',
                    boxShadow: active ? `0 0 12px ${cfg.color}30` : 'none',
                  }}
                >
                  {cfg.label}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => {
                setActiveCat(null);
                setMenuFilters({ max_price: null, vegetarian: false, vegan: false, allergen: null, available: true, query: null });
                setHighlightedProductId(null);
                // Sincroniza con el backend para limpiar el menu_state
                if (getVoiceSessionId()) {
                  postJson('/api/asr/process', {
                    session_id: getVoiceSessionId(),
                    mesa,
                    user_text: 'Quita los filtros',
                    suppress_tts: true,
                  }).catch(() => {});
                }
              }}
              aria-label="Quitar todos los filtros"
              className={`shrink-0 rounded-xl font-semibold border transition-all px-3 ${modePromptOpen ? 'py-2 text-xs' : 'py-3 text-sm'} border-neon-rose/40 text-neon-rose/90 bg-neon-rose/10 hover:bg-neon-rose/20`}
            >
              ✕ Quitar filtros
            </button>
          </div>

          {activeFiltersCount(menuFilters) > 0 && (
            <div className="shrink-0 flex flex-wrap gap-1 px-3 pb-1" data-testid="active-filters">
              {activeFiltersList(menuFilters).map((label) => (
                <span key={label} className="rounded-full border border-neon-amber/50 bg-neon-amber/15 px-2 py-0.5 text-[10px] font-semibold text-neon-amber">
                  {label}
                </span>
              ))}
            </div>
          )}

          <div className={`flex-1 min-h-0 overflow-y-auto px-3 pb-4 grid grid-cols-2 content-start ${modePromptOpen ? 'gap-2' : 'gap-3'}`}>
            {filteredItems.map((item, i) => {
              const cfg = CATEGORIA_CONFIG[item.categoria];
              const isHighlighted = highlightedProductId && item.id === highlightedProductId;
              return (
                <button
                  key={item.nombre}
                  onClick={() => addToCart(item)}
                  data-product-id={item.id}
                  className={`relative rounded-2xl flex flex-col items-start text-left transition-all active:scale-95 border ${modePromptOpen ? 'p-2 min-h-[64px]' : 'p-3 min-h-[88px]'} ${isHighlighted ? 'ring-2 ring-neon-amber shadow-lg' : ''}`}
                  style={{
                    background: cfg.gradient,
                    borderColor: isHighlighted ? '#fbbf24' : `${cfg.color}25`,
                    animation: isHighlighted ? 'fadeInUp 0.35s ease-out forwards, highlightPulse 1.5s ease-in-out infinite' : 'fadeInUp 0.35s ease-out forwards',
                    animationDelay: `${i * 60}ms`,
                    opacity: 0,
                  }}
                >
                  <span className="text-[11px] font-bold text-white/90 leading-tight">{item.nombre}</span>
                  {item.etiqueta_promocional && (
                    <span className="absolute top-1 right-1 rounded-full bg-neon-amber/90 px-1.5 py-0.5 text-[8px] font-bold text-chipi-bg uppercase tracking-wide">{item.etiqueta_promocional}</span>
                  )}
                  <span className="text-[10px] text-text-secondary mt-0.5">{item.desc}</span>
                  <div className="mt-auto w-full flex justify-between items-center">
                    <span className="text-sm font-bold font-mono" style={{ color: cfg.color }}>S/ {item.precio}</span>
                    <span className={`${modePromptOpen ? 'w-7 h-7' : 'w-6 h-6'} rounded-full flex items-center justify-center text-xs font-bold`} style={{ background: `${cfg.color}30`, color: cfg.color }}>+</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className={`absolute inset-0 flex flex-col items-center justify-center p-4 pb-4 transition-all duration-500 ${hasAssignedAttention && mode === 'voice' ? 'opacity-100 translate-x-0' : mode === 'catalog' ? 'opacity-0 translate-x-8 pointer-events-none' : 'opacity-0 scale-95 pointer-events-none'}`}>
          <div className="absolute top-3 left-0 right-0 flex flex-wrap justify-center gap-1 px-2 max-h-12 overflow-y-auto">
            {LANGGRAPH_STATES.map(s => (
              <div key={s.key} className={`px-2 py-0.5 rounded-full text-[9px] font-semibold border transition-all ${langState === s.key ? 'opacity-100' : 'opacity-30'}`}
                style={{ borderColor: `${s.color}50`, color: s.color, background: `${s.color}15` }}
              >
                {s.label}
              </div>
            ))}
          </div>

          <div className="flex-1 flex items-center justify-center w-full">
            <EmotionFace emotion={emotion} />
          </div>

          <div className="w-full max-w-md">
            <div className="glass rounded-2xl p-3 border border-chipi-border">
              <p className="text-xs text-text-secondary text-center leading-relaxed min-h-[2.5rem]">
                {cleanVisibleTranscript(transcript) || 'Esperando instrucciones...'}
              </p>
            </div>
            {lastSpeechResponse && hasAssignedAttention && (
              <div className="mt-2 flex justify-center gap-2">
                <button type="button" onClick={() => void stopSpeech()} className="min-h-9 rounded-lg border border-neon-rose/40 bg-neon-rose/10 px-3 py-2 text-[10px] font-semibold text-neon-rose hover:bg-neon-rose/20">Detener voz</button>
                <button type="button" onClick={() => void repeatSpeech()} className="min-h-9 rounded-lg border border-neon-cyan/40 bg-neon-cyan/10 px-3 py-2 text-[10px] font-semibold text-neon-cyan hover:bg-neon-cyan/20">Repetir respuesta</button>
              </div>
            )}
          </div>
        </div>

        <div className={`absolute inset-0 flex flex-col p-4 transition-all duration-500 ${hasAssignedAttention && mode === 'pedido' ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-8 pointer-events-none'}`}>
          <div className="flex items-center justify-between mb-3">
            <div className="min-w-0">
              <h2 className="text-sm font-bold neon-text-amber">Tu Pedido {orderConfirmed ? <span className="ml-2 text-[10px] text-neon-green">Enviado a cocina</span> : awaitingConfirmation && <span className="ml-2 text-[10px] text-neon-amber animate-pulse">Esperando confirmación</span>}</h2>
              <p className="mt-1 text-[10px] text-text-secondary">Mesa {mesa || '—'} · Estado: <span className="capitalize text-text-primary">{orderStateLabel}</span></p>
            </div>
            <span className="shrink-0 text-xs text-text-secondary">{itemCount} {itemCount === 1 ? 'producto' : 'productos'}</span>
            <button onClick={() => setMode('voice')} className="min-h-10 rounded-lg px-2 py-2 text-xs text-text-secondary hover:text-text-primary">← Volver a voz</button>
          </div>
          {(safetyContext.special_warning || safetyContext.declared_allergies?.length > 0 || safetyContext.allergy_conflicts?.length > 0) && (
            <div className="mb-2 shrink-0 rounded-xl border border-neon-rose/60 bg-neon-rose/10 px-3 py-2 text-[10px] leading-tight text-neon-rose" role="alert">
              <span className="font-bold">Advertencia de seguridad:</span> {safetyContext.special_warning || (safetyContext.declared_allergies?.length > 0 ? `Alergia declarada: ${safetyContext.declared_allergies.join(', ')}` : 'Existe un conflicto con un alérgeno declarado.')}
            </div>
          )}
          <div className="flex-1 overflow-y-auto space-y-2">
            {cart.map((item, index) => (
              <div key={itemLineKey(item, index)} className={`glass rounded-xl p-2.5 border ${orderConfirmed ? 'border-neon-green/60' : awaitingConfirmation ? 'border-neon-amber/60' : 'border-chipi-border'}`}>
                <div className="flex justify-between items-center gap-2">
                  <div className="min-w-0">
                    <span className="text-xs font-medium">{item.nombre}</span>
                    <span className="text-xs text-text-secondary ml-2">x{item.cantidad}</span>
                    {(item.modificaciones || []).length > 0 && <p className="mt-0.5 text-[10px] text-neon-cyan">{item.modificaciones.map(modifier => modifier.nombre).join(', ')}</p>}
                    {(item.observaciones || []).length > 0 && <p className="mt-0.5 text-[10px] text-neon-amber">Nota: {item.observaciones.join('; ')}</p>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs font-bold neon-text-amber font-mono">S/ {((item.precio + modifierPrice(item, menuItems)) * item.cantidad).toFixed(2)}</span>
                    {!orderConfirmed && <button onClick={() => { setSafetyEditorError(''); setSafetyEditorItem(item); }} className="rounded-md border border-neon-cyan/40 px-1.5 py-1 text-[10px] text-neon-cyan">Editar</button>}
                    {!awaitingConfirmation && !orderConfirmed && (
                      <button onClick={() => removeFromCart(item.nombre)} className="text-neon-rose text-xs px-1.5 py-0.5 rounded hover:bg-neon-rose/10">✕</button>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {cart.length === 0 && <p className="text-xs text-text-dim text-center py-8">El carrito está vacío</p>}
          </div>
          <div className="mt-3 pt-3 border-t border-chipi-border flex items-center justify-between">
            <span className="text-xs text-text-secondary">Total</span>
            <span className="text-lg font-bold neon-text-amber font-mono">S/ {total.toFixed(2)}</span>
          </div>
          {cart.length > 0 && !awaitingConfirmation && !orderConfirmed && (
            <div className="text-[10px] text-text-dim mt-1 text-center">
              Estado: <span className="text-neon-amber">borrador</span>
            </div>
          )}
          {orderConfirmed ? (
            <div className="mt-3 space-y-2">
              <p className="text-xs text-neon-green text-center">El pedido permanece guardado aunque cierres la conversación.</p>
              <button onClick={nuevoPedido} className="w-full py-3 rounded-xl font-bold text-sm btn-primary">
                Nuevo pedido
              </button>
            </div>
          ) : awaitingConfirmation ? (
            finishPrompt ? (
              <div className="mt-3 grid grid-cols-3 gap-2">
                <button onClick={conservarDraft} className="py-3 rounded-xl font-bold text-sm bg-neon-cyan/20 text-neon-cyan border border-neon-cyan/50 hover:bg-neon-cyan/30">Conservar</button>
                <button onClick={confirmarPorBoton} className="py-3 rounded-xl font-bold text-sm bg-emerald-600 text-white border border-emerald-500 hover:bg-emerald-500">{safetyContext.requires_special_confirmation ? 'Confirmar con advertencia' : 'Confirmar'}</button>
                <button onClick={cancelarPorBoton} className="py-3 rounded-xl font-bold text-sm bg-neon-rose/20 text-neon-rose border border-neon-rose/50 hover:bg-neon-rose/30">Cancelar</button>
              </div>
            ) : (
              <div className="mt-3 grid grid-cols-3 gap-2">
                <button onClick={cancelarPorBoton} className="py-3 rounded-xl font-bold text-sm bg-neon-rose/20 text-neon-rose border border-neon-rose/50 hover:bg-neon-rose/30">Cancelar</button>
                <button onClick={() => { setAwaitingConfirmation(false); setMode('voice'); setTranscript('¿Qué quieres cambiar?'); }} className="py-3 rounded-xl font-bold text-sm bg-neon-cyan/20 text-neon-cyan border border-neon-cyan/50 hover:bg-neon-cyan/30">Modificar</button>
                <button onClick={confirmarPorBoton} className="py-3 rounded-xl font-bold text-sm bg-emerald-600 text-white border border-emerald-500 hover:bg-emerald-500">{safetyContext.requires_special_confirmation ? 'Confirmar con advertencia' : 'Confirmar'}</button>
              </div>
            )
          ) : (
            <button onClick={confirmar} disabled={cart.length === 0} className="mt-3 w-full py-3 rounded-xl font-bold text-sm btn-primary disabled:opacity-30 disabled:cursor-not-allowed">
              {voiceActive ? 'Confirma por voz' : 'Confirmar Pedido'}
            </button>
          )}
          {!awaitingConfirmation && !orderConfirmed && (
            <button onClick={() => setMode('catalog')} className="mt-2 w-full py-2 rounded-xl text-xs text-text-secondary hover:text-text-primary transition-colors">
              {voiceActive ? 'Volver a escuchar' : 'Seguir comprando'}
            </button>
          )}
        </div>

        {mode === 'delivery' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center p-4 transition-all duration-500">
            <div className="w-full max-w-md space-y-4">
              <div className="text-center">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-neon-amber/20 border-2 border-neon-amber/50 animate-pulse">
                  <span className="text-3xl">🚗</span>
                </div>
                <h2 className="mt-3 text-lg font-bold neon-text-amber">
                  {ROBOT_STATE_LABELS[robotStateWs?.new_state || robotStateWs?.state || robotStateWs?.robot_state]?.label || 'En movimiento'}
                </h2>
                <p className="mt-1 text-xs text-text-secondary">
                  {robotStateWs?.message || 'El robot está en camino'}
                </p>
              </div>
              {mesa && (
                <div className="glass rounded-xl p-3 border border-chipi-border">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-text-secondary">Mesa destino:</span>
                    <span className="font-bold text-neon-cyan">{mesa}</span>
                  </div>
                  {cart.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-chipi-border/50">
                      <p className="text-[10px] text-text-secondary mb-1">Pedido:</p>
                      <div className="space-y-0.5">
                        {cart.slice(0, 3).map((item, i) => (
                          <div key={i} className="flex justify-between text-[10px]">
                            <span className="text-text-primary">{item.nombre} ×{item.cantidad}</span>
                            <span className="text-neon-amber font-mono">S/ {((item.precio + modifierPrice(item, menuItems)) * item.cantidad).toFixed(2)}</span>
                          </div>
                        ))}
                        {cart.length > 3 && <p className="text-[10px] text-text-dim">+{cart.length - 3} más</p>}
                      </div>
                      <div className="mt-2 pt-2 border-t border-chipi-border/50 flex justify-between text-xs font-bold">
                        <span className="text-text-secondary">Total:</span>
                        <span className="neon-text-amber font-mono">S/ {total.toFixed(2)}</span>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {isStaffMode && (
                <div className="grid grid-cols-3 gap-2">
                  <button onClick={() => void runStaffCommand('pause')} className="py-2 rounded-xl text-[10px] font-semibold bg-neon-amber/20 text-neon-amber border border-neon-amber/50 hover:bg-neon-amber/30">
                    Pausar
                  </button>
                  <button onClick={() => void runStaffCommand('resume')} className="py-2 rounded-xl text-[10px] font-semibold bg-neon-green/20 text-neon-green border border-neon-green/50 hover:bg-neon-green/30">
                    Reanudar
                  </button>
                  <button onClick={() => void runStaffCommand('emergency')} className="py-2 rounded-xl text-[10px] font-semibold bg-neon-rose/20 text-neon-rose border border-neon-rose/50 hover:bg-neon-rose/30">
                    Emergencia
                  </button>
                </div>
              )}
              {proactiveMessages.length > 0 && (
                <div className="glass rounded-xl p-3 border border-chipi-border max-h-24 overflow-y-auto">
                  {proactiveMessages.map((msg, i) => (
                    <p key={i} className="text-[10px] text-text-secondary leading-relaxed">{msg.text}</p>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {hasAssignedAttention && mode !== 'pedido' && (
        <div className={`shrink-0 h-14 ml-2 mr-20 mb-2 min-w-0 glass rounded-xl border px-2.5 py-2 transition-all ${showCartDetail && cart.length > 0 ? 'border-neon-amber/70 ring-1 ring-neon-amber/30' : 'border-chipi-border'}`}>
          <div className="flex items-center gap-2 min-w-0">
            <div className="min-w-0 flex-1 overflow-hidden">
              <div className="flex items-center gap-1.5 text-[10px] leading-tight">
                <span className="font-semibold text-neon-cyan shrink-0">Mesa {mesa || '—'}</span>
                {guestCount && <span className="font-semibold text-neon-amber shrink-0">· 👥 {guestCount}</span>}
                <span className="text-text-dim shrink-0">·</span>
                <span className="truncate text-text-secondary">
                  {cart.length > 0 ? cart.map(item => `${item.nombre} ×${item.cantidad}`).join(' · ') : 'Sin productos'}
                </span>
              </div>
              <div className="flex items-center gap-2 text-[10px] leading-tight mt-0.5">
                <span className="text-text-dim">{itemCount} {itemCount === 1 ? 'producto' : 'productos'}</span>
                <span className="text-text-dim">·</span>
                <span className="font-mono font-semibold text-neon-amber">S/ {total.toFixed(2)}</span>
                <span className="text-text-dim">·</span>
                <span className="text-text-secondary capitalize">{orderStateLabel}</span>
                {interactionMode && <button onClick={() => setModePromptOpen(true)} className="ml-auto min-h-8 shrink-0 rounded-lg border border-neon-purple/30 px-2 py-1 text-xs text-neon-purple hover:bg-neon-purple/10">Cambiar modo</button>}
              </div>
            </div>
            {['available', 'closed', 'expired'].includes(sessionPhase) ? (
              <button
                onClick={nuevoPedido}
                aria-label="Nuevo pedido"
                className="btn-primary min-h-10 shrink-0 rounded-lg px-3 py-2 text-xs font-bold"
              >
                Nuevo pedido
              </button>
            ) : (
              <button
                onClick={() => setMode('pedido')}
                disabled={cart.length === 0}
                className="btn-amber min-h-10 shrink-0 rounded-lg px-3 py-2 text-xs font-bold disabled:cursor-not-allowed disabled:opacity-40"
              >
                Ver pedido
              </button>
            )}
          </div>
        </div>
      )}

      {hasAssignedAttention && <button
        onClick={openMesaSelector}
        className={`absolute ${mode === 'pedido' ? 'bottom-32' : 'bottom-2'} right-2 z-30 w-14 h-14 rounded-full flex flex-col items-center justify-center text-[9px] font-bold transition-all active:scale-95 border ${
          mesa ? 'text-neon-cyan border-neon-cyan/40 bg-neon-cyan/15 hover:bg-neon-cyan/25' : 'text-neon-rose border-neon-rose/40 bg-neon-rose/15 hover:bg-neon-rose/25 animate-pulse'
        }`}
        style={{
          boxShadow: mesa ? '0 0 10px rgba(34, 211, 238, 0.25)' : '0 0 10px rgba(244, 63, 94, 0.25)'
        }}
        title={mesa ? `Mesa actual: ${mesa}` : 'Selecciona tu mesa'}
      >
        <span className="text-sm leading-none">🪑</span>
        <span className="text-[7px] uppercase tracking-tighter leading-none mt-0.5">
          {mesa ? `Mesa ${mesa}` : 'Mesa'}
        </span>
      </button>}
    </div>
  );
}

function BatteryIcon({ pct }) {
  const color = pct > 50 ? '#00ff9d' : pct > 20 ? '#ffb800' : '#ff4d6d';
  return (
    <svg width="14" height="8" viewBox="0 0 14 8" fill="none">
      <rect x="0.5" y="0.5" width="11" height="7" rx="1" stroke={color} strokeOpacity="0.6" fill="none" />
      <rect x="1" y="1" width={Math.max(0, (pct / 100) * 10)} height="6" rx="0.5" fill={color} fillOpacity="0.8" />
      <path d="M12.5 2.5v3" stroke={color} strokeOpacity="0.6" strokeWidth="1" strokeLinecap="round" />
    </svg>
  );
}
