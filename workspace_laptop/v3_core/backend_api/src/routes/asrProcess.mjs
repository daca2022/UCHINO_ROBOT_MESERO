/**
 * asrProcess.mjs — FASE 4: Endpoint de Procesamiento ASR → Pedido Oral
 *
 * POST /api/asr/process
 *
 * Flujo:
 *   ASR final text → OrderSessionManager → Fase3Orchestrator (LLM pagado)
 *   → parse function call → validar productos → crear pedido draft
 *   → confirmación determinística → enviar a cocina
 *
 * Reglas:
 * - Cada sesión mantiene su propio estado (session_id como clave)
 * - La mesa debe llegar normalizada desde la sesión, el selector táctil o el texto del usuario.
 * - Confirmación determinística: cuando state=awaiting_confirmation y usuario confirma
 * - Sesiones completamente aisladas
 */

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { adminAuth } from '../middleware/adminAuth.mjs';
import { SessionState, normalizeMesa } from '../application/OrderSessionManager.mjs';
import { classifyIntent, Intent, InteractionMode } from '../application/IntentClassifier.mjs';
import { classifyMemoryIntent, MemoryIntent } from '../application/MemoryIntentRules.mjs';
import { applyDraftIntent } from '../application/OrderDraftOperations.mjs';
import {
    addModifierToItems,
    addNoteToItems,
    deriveSafetyContext,
    findConfiguredModifier,
    listCulinaryObservations,
    menuQuery,
    normalizeSafetyText,
    removeModifierFromItems,
    removeNoteFromItems,
} from '../application/Fase5Safety.mjs';
import { sanitizeForSpeech, speechPayload } from '../application/SpeechTextSanitizer.mjs';
import { MenuNavigationService, canonCategoria } from '../application/MenuNavigationService.mjs';
import { fetchSalesByProduct } from '../application/MenuPopularityRepository.mjs';
import { isStaleSession } from '../application/SessionActivityPolicy.mjs';

function extractMesa(text) {
    const match = String(text || '').match(/\bmesa\s*(?:n[uú]mero\s*)?(\d{1,2})\b/i);
    if (!match) return null;
    try {
        return normalizeMesa(match[1]);
    } catch (error) {
        error.code ||= 'INVALID_TABLE';
        throw error;
    }
}

function normalizeRequestedMesa(value) {
    try {
        return normalizeMesa(value);
    } catch (error) {
        error.code ||= 'INVALID_TABLE';
        throw error;
    }
}

async function moveSessionTableIfNeeded({ session, requestedMesa, source = 'asr', tableService, orderSessionManager, memoryService }) {
    if (!session?.mesa || session.mesa === requestedMesa) return session;
    if (['confirmed', 'completed'].includes(session.state)) {
        const error = new Error('La mesa no puede cambiar después de confirmar el pedido.');
        error.code = 'TABLE_LOCKED';
        throw error;
    }
    if (tableService?.moveDraftOrder && session.visit_id) {
        await tableService.moveDraftOrder({
            sessionId: session.session_id,
            orderId: session.active_order_id || null,
            targetTableId: requestedMesa,
            source,
        });
        return orderSessionManager.get(session.session_id) || session;
    }
    if (session.active_order_id && memoryService?.pedidoRepo?.update) {
        await memoryService.pedidoRepo.update(session.active_order_id, { mesa: requestedMesa, table_id: requestedMesa });
    }
    orderSessionManager.updateMesa(session.session_id, requestedMesa);
    return orderSessionManager.get(session.session_id) || session;
}

function orderItems(order) {
    return Array.isArray(order?.items) ? order.items : Array.isArray(order?.platos) ? order.platos : [];
}

function orderSummary(items) {
    return items.map(item => `${item.cantidad || 1} ${item.nombre}`).join(', ');
}

function canonicalCategory(value) {
    const normalized = String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
    if (['plato', 'platos', 'comida', 'comidas'].includes(normalized)) return 'platos';
    if (['bebida', 'bebidas'].includes(normalized)) return 'bebidas';
    if (['postre', 'postres'].includes(normalized)) return 'postres';
    return normalized;
}

function buildFase6MenuService({ orderSessionManager, memoryService, pool }) {
    const menu = orderSessionManager.getMenu();
    return new MenuNavigationService({
        menu,
        memoryService,
        fetchSales: pool ? (period) => fetchSalesByProduct(pool, period) : null,
        period: '30d',
    });
}

async function handleFase6ReadOnly(res, session, classification, ctx) {
    const { sendToUI, loadActiveOrder, deterministicDecision, jsonWithTts, localTtsPlayer,
        orderSessionManager, orderSummary, currentTurn, t0, Intent } = ctx;
    const utterance = ctx.user_text || '';
    const menuService = buildFase6MenuService({
        orderSessionManager,
        memoryService: ctx.memoryService,
        pool: ctx.pool,
    });
    const declaredAllergies = session.declared_allergies || [];
    const dietaryRestrictions = session.dietary_restrictions || [];
    const rememberedPreferences = session.profile_id && ctx.temporaryMemoryService
        ? (await ctx.temporaryMemoryService.summary({ sessionId: session.session_id, profileId: session.profile_id }).catch(() => null))?.preferences || []
        : [];
    const order = await loadActiveOrder(session);
    const intent = classification.intent;
    const entities = classification.entities || {};
    let response = '';
    let navigation = null;
    let extra = {};
    let result = 'read_only';

    if (intent === Intent.RETURN_TO_MENU) {
        const all = menuService.filterMenu({});
        response = 'Volvimos al menú completo. ¿Qué categoría quieres revisar?';
        navigation = {
            type: 'menu_navigation',
            session_id: session.session_id,
            mesa: session.mesa,
            action: 'show_menu',
            category: null,
            product_ids: all.map(item => item.id).filter(Boolean),
            highlight_product_id: null,
            filters: {},
            timestamp: new Date().toISOString(),
        };
    } else if (intent === Intent.CLEAR_MENU_FILTER) {
        const all = menuService.filterMenu({});
        response = 'Quité los filtros. Aquí tienes el menú completo.';
        navigation = {
            type: 'menu_navigation',
            session_id: session.session_id,
            mesa: session.mesa,
            action: 'show_menu',
            category: null,
            product_ids: all.map(item => item.id).filter(Boolean),
            highlight_product_id: null,
            filters: {},
            timestamp: new Date().toISOString(),
        };
    } else if (intent === Intent.SEARCH_PRODUCT || intent === Intent.LIST_PRODUCTS) {
        const query = sanitizeQuery(entities.query || entities.read_only ? '' : '');
        const matches = query ? menuService.searchProducts(query, { limit: 8 }) : menuService.filterMenu({}).slice(0, 8);
        const summary = matches.length === 0
            ? 'No encontré coincidencias con tu búsqueda.'
            : `Encontré ${matches.length} opciones. Te las muestro en pantalla.`;
        response = summary;
        navigation = {
            type: 'menu_navigation',
            session_id: session.session_id,
            mesa: session.mesa,
            action: 'show_products',
            category: null,
            product_ids: matches.map(item => item.id).filter(Boolean),
            highlight_product_id: matches[0]?.id || null,
            filters: query ? { query } : {},
            timestamp: new Date().toISOString(),
        };
        extra = { matches: matches.map(item => ({ id: item.id, nombre: item.nombre, precio: item.precio })) };
    } else if (intent === Intent.QUERY_PRICE || intent === Intent.QUERY_AVAILABILITY
            || intent === Intent.QUERY_PRODUCT_DETAILS) {
        const target = entities.product || entities.nombre || extractMentionedProduct(utterance || '');
        const product = target ? menuService.findProductByName(target) : null;
        if (!product) {
            response = 'No encuentro ese producto en el menú. ¿Quieres que te muestre la lista?';
            result = 'no_results';
        } else if (intent === Intent.QUERY_AVAILABILITY && product.disponible === false) {
            response = `${product.nombre} no está disponible por ahora.`;
            result = 'unavailable';
        } else if (intent === Intent.QUERY_PRICE) {
            response = `${product.nombre} cuesta ${formatPrice(product.precio)}.`;
        } else {
            response = product.disponible === false
                ? `${product.nombre} no está disponible ahora mismo.`
                : `${product.nombre} está disponible y cuesta ${formatPrice(product.precio)}.`;
        }
        navigation = {
            type: 'menu_navigation',
            session_id: session.session_id,
            mesa: session.mesa,
            action: 'highlight_product',
            category: canonCategoria(product?.categoria) || null,
            product_ids: product ? [product.id] : [],
            highlight_product_id: product?.id || null,
            filters: {},
            timestamp: new Date().toISOString(),
        };
        extra = { product: product ? { id: product.id, nombre: product.nombre, precio: product.precio, disponible: product.disponible } : null };
    } else if (intent === Intent.QUERY_POPULAR_PRODUCTS) {
        const resultData = await menuService.popular({
            period: entities.period || '30d',
            limit: 3,
            category: entities.category,
            declaredAllergies,
            dietaryRestrictions,
        });
        if (resultData.data.length === 0) {
            response = 'Todavía no tengo datos de ventas en los registros disponibles.';
            result = 'no_results';
        } else {
            const names = resultData.data.map(item => item.nombre).join(', ');
            const sampleNote = resultData.small_sample ? ' La muestra es pequeña todavía.' : '';
            response = `Lo más pedido en los últimos ${resultData.period} es: ${names}.${sampleNote}`;
        }
        navigation = {
            type: 'menu_navigation',
            session_id: session.session_id,
            mesa: session.mesa,
            action: 'show_recommendations',
            category: entities.category ? canonCategoria(entities.category) : null,
            product_ids: resultData.data.map(item => item.id).filter(Boolean),
            highlight_product_id: resultData.data[0]?.id || null,
            filters: { source: 'sales_analytics', period: resultData.period },
            timestamp: new Date().toISOString(),
        };
        extra = { reasons: resultData.data.map((item, i) => ({
            product_id: item.id, source: 'sales_analytics', period: resultData.period, position: i + 1,
        })), sample_size: resultData.sample_size, small_sample: resultData.small_sample };
    } else if (intent === Intent.QUERY_AFFORDABLE_PRODUCTS) {
        const priceFilter = menuService.extractPriceFilter(utterance || '');
        const max = entities.max_price || priceFilter.max;
        const items = menuService.filterMenu({ maxPrice: max });
        if (items.length === 0) {
            response = max
                ? `No encontré opciones disponibles por menos de ${formatPrice(max)}.`
                : 'No encontré opciones económicas en este momento.';
            result = 'no_results';
        } else {
            response = `Las opciones más económicas${max ? ` por debajo de ${formatPrice(max)}` : ''} son: ${items.slice(0, 3).map(item => `${item.nombre} (${formatPrice(item.precio)})`).join(', ')}.`;
        }
        navigation = {
            type: 'menu_navigation',
            session_id: session.session_id,
            mesa: session.mesa,
            action: 'show_products',
            category: null,
            product_ids: items.map(item => item.id).filter(Boolean),
            highlight_product_id: items[0]?.id || null,
            filters: max ? { max_price: max } : {},
            timestamp: new Date().toISOString(),
        };
        extra = { max_price: max, count: items.length };
    } else if (intent === Intent.QUERY_RECOMMENDATION) {
        const recommendation = await menuService.recommend({
            category: entities.category,
            maxPrice: entities.max_price,
            period: '30d',
            limit: 3,
            declaredAllergies,
            dietaryRestrictions,
        });
        const rejected = recommendation.data.length === 0
            && declaredAllergies.length + dietaryRestrictions.length > 0;
        if (rejected) {
            response = 'No tengo opciones recomendadas que sean seguras para tus alergias o restricciones. Puedo mostrarte el menú completo o llamar a un mesero.';
            result = 'allergy_blocked';
        } else if (recommendation.data.length === 0) {
            response = 'No tengo recomendaciones en este momento. Te muestro el menú.';
            result = 'no_results';
        } else {
            const names = recommendation.data.map(item => item.nombre).join(', ');
            response = `Te recomiendo: ${names}. Los puedes ver resaltados en pantalla.`;
            if (rememberedPreferences.length > 0) response += ` También tengo presente que declaraste: ${rememberedPreferences.join(', ')}. ¿Deseas aplicar alguna a tu pedido?`;
        }
        navigation = {
            type: 'menu_navigation',
            session_id: session.session_id,
            mesa: session.mesa,
            action: 'show_recommendations',
            category: entities.category ? canonCategoria(entities.category) : null,
            product_ids: recommendation.data.map(item => item.id).filter(Boolean),
            highlight_product_id: recommendation.data[0]?.id || null,
            filters: {},
            timestamp: new Date().toISOString(),
        };
        extra = { reasons: recommendation.reasons, sample_size: recommendation.sample_size, small_sample: recommendation.small_sample, memory_preferences_considered: rememberedPreferences, memory_preferences_applied: false };
    } else if (intent === Intent.COMPARE_PRODUCTS) {
        // Extrae los productos MENCIONADOS por el usuario (no el menú completo).
        // "Cuál es más barato, el ceviche o el lomo saltado?" → ['ceviche', 'lomo saltado']
        // Si no se pueden extraer al menos 2, fallback a los primeros del menú.
        const mentioned = extractMentionedProductsForCompare(utterance, orderSessionManager.getMenu());
        let compareIds = [];
        if (mentioned.length >= 2) {
            compareIds = mentioned
                .map(name => menuService.findProductByName(name))
                .filter(Boolean)
                .map(p => p.id);
        }
        if (compareIds.length < 2) {
            const candidates = menuService.filterMenu({}).slice(0, 4);
            compareIds = candidates.slice(0, 2).map(p => p.id);
        }
        const comparison = menuService.compareProducts(compareIds);
        if (!comparison || comparison.data.length < 2) {
            response = 'Necesito al menos dos productos para comparar.';
            result = 'no_results';
        } else {
            const cheapest = comparison.comparison.cheapest;
            const expensive = comparison.comparison.most_expensive;
            if (comparison.data.length === 2 && cheapest.id === expensive.id) {
                response = `${cheapest.nombre} y ${expensive.nombre} cuestan igual: ${formatPrice(cheapest.precio)}.`;
            } else {
                response = `Entre ${comparison.data.map(p => p.nombre).join(' y ')}, lo más económico es ${cheapest.nombre} a ${formatPrice(cheapest.precio)}.`;
            }
        }
        navigation = {
            type: 'menu_navigation',
            session_id: session.session_id,
            mesa: session.mesa,
            action: 'show_products',
            category: null,
            product_ids: comparison?.data?.map(item => item.id).filter(Boolean) || [],
            highlight_product_id: comparison?.comparison?.cheapest?.id || null,
            filters: { source: 'comparison' },
            timestamp: new Date().toISOString(),
        };
    } else {
        response = 'No entendí la consulta. ¿Quieres ver el menú, una categoría o recomendaciones?';
        result = 'no_results';
    }

    if (navigation && typeof sendToUI === 'function') {
        sendToUI(navigation);
    }

    // Cierre correctivo Fase 6: persistir menu_state en la sesión y
    // emitir eventos de auditoría estructurados en pedido_eventos.
    if (navigation && navigation.action && ctx.recordSafety) {
        try {
            orderSessionManager.updateMenuNavigation(session.session_id, {
                action: navigation.action,
                category: navigation.category,
                product_ids: navigation.product_ids,
                highlight_product_id: navigation.highlight_product_id,
                filters: navigation.filters,
            });
        } catch (e) { /* no fatal */ }
        const auditMap = {
            'show_menu': 'menu_requested',
            'show_category': 'category_shown',
            'show_products': 'product_searched',
            'highlight_product': 'product_highlighted',
            'show_recommendations': 'recommendation_generated',
            'return_to_menu': 'menu_requested',
            'clear_filter': 'menu_filter_applied',
        };
        const eventName = auditMap[navigation.action] || 'menu_requested';
        ctx.recordSafety(eventName, session, order, {}, {}, {
            action: navigation.action,
            category: navigation.category || null,
            product_ids: (navigation.product_ids || []).slice(0, 10),
            highlight_product_id: navigation.highlight_product_id || null,
            filters: navigation.filters || {},
            recommendation_source: (navigation.filters && navigation.filters.source) || null,
            period: (navigation.filters && navigation.filters.period) || null,
            result: result,
        }).catch(() => {});
    }

    orderSessionManager.recordConversation(session.session_id, { intent, response, ambiguous: result === 'no_results' });
    return jsonWithTts(res, localTtsPlayer, {
        text: response,
        ...statePayload(session, order),
        decision: deterministicDecision(classification, { previousState: session.state, nextState: session.state, result }),
        navigation,
        extra,
        turn_id: currentTurn,
        latencyMs: Date.now() - t0,
    });
}

function sanitizeQuery(value) {
    return String(value || '')
        .replace(/^\s*(?:busca|buscar|tienen|hay algo de|hay|muestra|ver|ensename|ensename|ens[eé]ñame)\b/i, '')
        .replace(/[¿?¡!]/g, '')
        .trim();
}

function extractMentionedProduct(text) {
    if (!text) return null;
    const norm = normalizeSafetyText(text);
    if (!norm) return null;
    const cleaned = norm
        .replace(/^.*?(?:cu[aá]nto cuesta|cu[aá]nto vale|precio de|precio del|esta disponible|hay stock|tienen)\s+/u, '')
        .replace(/\??$/u, '')
        .trim();
    return cleaned || null;
}

/**
 * Extrae los nombres de productos mencionados en una comparación.
 * "Cuál es más barato, el ceviche o el lomo saltado?" → ['Ceviche', 'Lomo Saltado']
 * Usa la lista real del menú como vocabulario; si un nombre no matchea
 * exactamente, hace match por prefijo de palabra.
 */
function extractMentionedProductsForCompare(text, menu = []) {
    if (!text) return [];
    const norm = normalizeSafetyText(text);
    if (!norm) return [];
    const stripped = norm
        .replace(/^.*?(?:cual es mas barato|cual cuesta menos|compara|comparar)\s*/u, '')
        .replace(/^.*?(?:entre|de)\s+/u, m => m)
        .replace(/\?$/u, '')
        .trim();
    if (!stripped) return [];
    // Separa por ' o ', ' y ', comas
    const parts = stripped.split(/\s*(?:,| o | y | versus | vs )\s*/u).map(s => s.trim()).filter(Boolean);
    // Para cada parte, quita artículos y pronombres
    const cleanedParts = parts.map(p => p
        .replace(/^(?:el|la|lo|los|las|un|una|unos|unas)\s+/u, '')
        .replace(/\?$/u, '')
        .trim())
        .filter(Boolean);
    // Resuelve cada parte contra el menú: match exacto o por prefijo único.
    const resolved = [];
    for (const part of cleanedParts) {
        const exact = menu.find(item => normalizeSafetyText(item.nombre) === part);
        if (exact) { resolved.push(exact.nombre); continue; }
        // Match por primera palabra: "lomo" matchea "Lomo Saltado" si es único.
        const firstWord = part.split(/\s+/u)[0];
        if (!firstWord || firstWord.length < 3) continue;
        const candidates = menu.filter(item => normalizeSafetyText(item.nombre).split(/\s+/u)[0] === firstWord);
        if (candidates.length === 1) resolved.push(candidates[0].nombre);
        else if (candidates.length > 1) {
            // Si dos candidatos comparten la primera palabra, intentar match más largo.
            const longer = part.split(/\s+/u).slice(0, 2).join(' ');
            const cand2 = menu.filter(item => normalizeSafetyText(item.nombre).startsWith(longer));
            if (cand2.length === 1) resolved.push(cand2[0].nombre);
        }
    }
    return resolved;
}

/**
 * Pre-clasificador: convierte referencias a la lista visible
 * ("Agrega esa", "Agrega el primero", "Quiero el postre que mostraste")
 * en clasificaciones `ADD_PRODUCT` o `REQUEST_CLARIFICATION` según
 * el estado del menú persistido de la sesión.
 *
 * Solo se activa cuando el texto contiene un verbo de compra
 * (agrega/quiero/pon/dame/...) Y una referencia visible (esa/ese/eso,
 * primero/segundo/tercero, el postre que mostraste, etc.).
 *
 * Si el resolver produce exactamente 1 producto: ADD_PRODUCT con
 * `entities.products` poblado y `mutates_order: true`.
 * Si produce varios: REQUEST_CLARIFICATION con `ambiguous_visible_reference`.
 * Si no hay match: REQUEST_CLARIFICATION con `not_found`.
 * Si el texto NO es una referencia visible, devuelve la clasificación
 * base sin tocar nada.
 */
function preResolveVisibleReference({ text, base, session, orderSessionManager, menuService }) {
    if (!text || !base || !session) return base;
    const norm = normalizeSafetyText(text);
    if (!norm) return base;

    // 1) Detectar verbo de compra
    const buyVerbs = /\b(?:agrega|agregar|anade|añade|pon|poner|dame|quiero|pedir|pedime|ordena|suma)\b/u;
    if (!buyVerbs.test(norm)) return base;

    // 2) Detectar referencia visible: deícticos, ordinales, "el X que mostraste"
    const hasDeictic = /\b(?:esa|ese|eso)\b/u.test(norm);
    const hasOrdinal = /\b(?:el primero|la primera|el segundo|la segunda|el tercero|la tercera)\b/u.test(norm);
    const hasShowed = /\b(?:el|la|lo)\s+(plato|bebida|postre|postres|bebidas|platos)\s+que\s+(?:mostraste|mostro|viste|ensenaste)\b/u.test(norm);
    const hasPriceRef = /\b(?:el|la)\s+de\s+(?:\d+|diez|veinte|treinta|cuarenta|cincuenta)\b/u.test(norm);
    const hasPartialName = /\b(?:el|la|lo)\s+([a-záéíóúñ]{3,})\b/u.test(norm);
    if (!hasDeictic && !hasOrdinal && !hasShowed && !hasPriceRef && !hasPartialName) return base;

    // 3) Resolver contra el estado del menú de la sesión
    const menuState = orderSessionManager.getMenuState(session.session_id);
    if (!menuState || (!menuState.visible_product_ids?.length && !menuState.highlighted_product_id)) {
        return base;
    }
    const resolved = menuService.resolveSessionReference(norm, menuState);

    if (resolved.product) {
        // Construir una clasificación ADD_PRODUCT sintética
        return {
            ...base,
            intent: Intent.ADD_PRODUCT,
            confidence: 0.99,
            mutates_order: true,
            requires_clarification: false,
            entities: {
                ...(base.entities || {}),
                products: [{
                    id: resolved.product.id,
                    nombre: resolved.product.nombre,
                    categoria: resolved.product.categoria,
                    precio: resolved.product.precio,
                    cantidad: 1,
                }],
                quantity: 1,
                quantity_mode: 'total',
                source: 'visible_reference',
                visible_reference: {
                    kind: hasDeictic ? 'deictic' : (hasOrdinal ? 'ordinal' : (hasShowed ? 'showed' : 'name')),
                    product_id: resolved.product.id,
                },
            },
        };
    }

    if (resolved.ambiguous) {
        // NO mutar; devolver clarificación con lista de candidatos
        return {
            ...base,
            intent: Intent.REQUEST_CLARIFICATION,
            confidence: 0.92,
            mutates_order: false,
            requires_clarification: true,
            entities: {
                ...(base.entities || {}),
                candidates: resolved.candidates.map(c => ({
                    id: c.id, nombre: c.nombre, precio: c.precio, categoria: c.categoria,
                })),
                reason: 'ambiguous_visible_reference',
            },
        };
    }

    if (resolved.out_of_range) {
        return {
            ...base,
            intent: Intent.REQUEST_CLARIFICATION,
            confidence: 0.95,
            mutates_order: false,
            requires_clarification: true,
            entities: {
                ...(base.entities || {}),
                reason: 'out_of_range',
                requested: resolved.requested,
                available: resolved.max,
            },
        };
    }

    // not_found: dejar que la clasificación base siga su curso
    return base;
}

function formatPrice(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    return `${n % 1 === 0 ? n : n.toFixed(2)} soles`;
}

function statePayload(session, order = null) {
    return {
        session_id: session.session_id,
        session_status: session.session_status || null,
        closed_at: session.closed_at || null,
        close_reason: session.close_reason || null,
        order_id: session.active_order_id,
        order_status: order?.status || (session.state === SessionState.AWAITING_CONFIRMATION ? 'draft' : null),
        total: order?.total ?? null,
        state: session.state,
        mesa: session.mesa,
        visit_id: session.visit_id || null,
        robot_id: session.robot_id || session.assignment?.robot_id || null,
        guest_count: session.guest_count || null,
        interaction_mode: session.interaction_mode || null,
        mode_prompt_required: !session.interaction_mode,
        has_memory_profile: Boolean(session.profile_id),
        memory_consent: session.memory_consent || null,
        consecutive_ambiguities: session.consecutive_ambiguities || 0,
        declared_allergies: session.declared_allergies || [],
        dietary_restrictions: session.dietary_restrictions || [],
        allergy_conflicts: session.allergy_conflicts || [],
        incomplete_information: session.incomplete_information || [],
        special_warning: session.special_warning || '',
        requires_special_confirmation: Boolean(session.requires_special_confirmation),
        special_confirmation: session.special_confirmation || {},
        products: orderItems(order).length > 0 ? orderItems(order) : session.draft_items || [],
        // Cierre correctivo Fase 6: estado visual del menú por sesión.
        menu_state: session.menu_state || { active_category: null, visible_product_ids: [], highlighted_product_id: null, menu_filters: {}, last_navigation: null, last_navigation_at: null },
        order,
    };
}

/**
 * Las rutas ASR mutantes solo aceptan la sesión emitida por
 * SessionLifecycleService cuando se ejecuta el backend completo. Los
 * harnesses de las fases anteriores montan este router sin lifecycle y
 * conservan su contrato de pruebas aislado.
 */
function requireAsrSessionAccess({ sessionId, session, req, res, sessionLifecycle }) {
    if (!sessionLifecycle) return true;
    const lifecycleSession = sessionLifecycle.get(sessionId);
    const expectedToken = String(session?.session_access_token || lifecycleSession?.session_access_token || '');
    const suppliedToken = String(req.get('x-session-token') || '');
    if (!lifecycleSession || !session || !expectedToken || suppliedToken !== expectedToken) {
        res.status(401).json({ error: 'Token de sesión requerido.', code: 'SESSION_ACCESS_REQUIRED' });
        return false;
    }
    return true;
}

export function clarificationResponse({ text = '', hasDraft = false, reason = null } = {}) {
    const normalized = String(text || '').toLowerCase();
    const editCue = reason === 'edit'
        || /\b(?:agrega|añade|anade|quita|elimina|cambia|reemplaza|modifica|cantidad|uno|otro)\b/u.test(normalized);
    if (hasDraft && editCue) {
        return '¿Qué producto o cantidad deseas modificar? También puedes decir “por pantalla” o “mesero”.';
    }
    return 'Puedo mostrarte el menú, precios, ingredientes o ayudarte a elegir. ¿Qué te gustaría saber?';
}

/**
 * Helper: Habla una respuesta si localTtsPlayer está disponible.
 * No bloquea la respuesta HTTP.
 */
function speakResponse(localTtsPlayer, text, context = {}) {
    const speechPlayback = context.speechPlayback || localTtsPlayer?.speechPlayback;
    const prepared = speechPlayback?.prepare
        ? speechPlayback.prepare(text, {
            source: context.source || 'asr_http',
            sessionId: context.sessionId || null,
            orderId: context.orderId || null,
            mesa: context.mesa || null,
        })
        : sanitizeForSpeech(text, { source: context.source || 'asr_http' });
    if (!prepared?.speechText || prepared.speechText.length < 5) return prepared;
    if (context.play === false) return prepared;
    if (speechPlayback?.speak) {
        speechPlayback.speak(prepared, {
            sanitized: true,
            allowClosedSession: context.allowClosedSession === true,
            source: context.source || 'asr_http',
            sessionId: context.sessionId || null,
            orderId: context.orderId || null,
            mesa: context.mesa || null,
            emotion: context.emotion || 'feliz',
        });
    } else if (localTtsPlayer?.isReady) {
        localTtsPlayer.speak(prepared.speechText, { emotion: context.emotion || 'feliz' });
    }
    return prepared;
}

/**
 * Wrapper: envía JSON y luego reproduce TTS si hay texto.
 */
function jsonWithTts(res, localTtsPlayer, data) {
    const prepared = data?.text
        ? speakResponse(localTtsPlayer, data.text, {
            sessionId: data.session_id,
            orderId: data.order_id,
            mesa: data.mesa,
            source: data.speech_source || 'asr_http',
            allowClosedSession: data.confirmed === true && data.order_status === 'sent_to_kitchen',
            play: res.locals?.suppressTts !== true,
        })
        : null;
    const responseData = data && prepared ? { ...data, ...speechPayload(prepared) } : data;
    if (res.locals?.suppressTts !== true) {
        // `speakResponse` already enqueues through the shared playback service.
    }
    if (responseData !== undefined) {
        return res.json(responseData);
    }
    return res.json();
}

function jsonWithSpeech(res, localTtsPlayer, data) {
    if (!data?.text) return res.json(data);
    const prepared = speakResponse(localTtsPlayer, data.text, {
        sessionId: data.session_id,
        orderId: data.order_id,
        mesa: data.mesa,
        source: data.speech_source || 'asr_http',
        play: false,
    });
    return res.json({ ...data, ...speechPayload(prepared) });
}

export function createAsrProcessRouter(fase3Orchestrator, orderSessionManager, memoryService, sendToUI, localTtsPlayer, waiterAssistanceService = null, safetyService = null, pool = null, sessionLifecycle = null, tableService = null, temporaryMemoryService = null, speechPlayback = null) {
    const router = Router();
    const sessionLocks = new Map();
    if (localTtsPlayer && speechPlayback) localTtsPlayer.speechPlayback = speechPlayback;

    async function acquireSessionLock(sessionId) {
        const previous = sessionLocks.get(sessionId) || Promise.resolve();
        let release;
        const current = new Promise(resolve => { release = resolve; });
        sessionLocks.set(sessionId, current);
        await previous.catch(() => {});
        let released = false;
        return () => {
            if (released) return;
            released = true;
            release();
            if (sessionLocks.get(sessionId) === current) sessionLocks.delete(sessionId);
        };
    }

    async function withSessionLock(sessionId, task) {
        const release = await acquireSessionLock(sessionId);
        try {
            return await task();
        } finally {
            release();
        }
    }

    function syncLifecycleMode(session, mode) {
        if (!sessionLifecycle || !session || !mode || session.session_status !== 'initializing') return;
        sessionLifecycle.setInteractionMode(session.session_id, mode);
    }

    function rejectStaleSession(res, session) {
        if (!isStaleSession(session)) return false;
        res.status(410).json({
            error: `Sesión ${session.session_status}`,
            code: 'STALE_SESSION',
            ...statePayload(session),
        });
        return true;
    }

    function restoreTurnState(session, previousState) {
        if ([SessionState.CONFIRMED, SessionState.COMPLETED].includes(session.state)) return;
        const hasDraft = Boolean(session.active_order_id && session.draft_items?.length);
        const nextState = hasDraft || previousState === SessionState.AWAITING_CONFIRMATION
            ? SessionState.AWAITING_CONFIRMATION
            : SessionState.LISTENING;
        orderSessionManager.setState(session.session_id, nextState);
    }

    async function upsertDraft(session, items, { source = 'voice', clientId } = {}) {
        if (!session.mesa) throw new Error('mesa es obligatoria para crear el pedido');
        if (!Array.isArray(items) || items.length === 0) throw new Error('El draft debe tener al menos un producto');

        const safety = safetyService?.derive(items, orderSessionManager.getMenu(), session)
            || deriveSafetyContext(items, orderSessionManager.getMenu(), session.declared_allergies, session.dietary_restrictions);
        Object.assign(session, safety);
        const total = orderSessionManager.calculateTotal(items);
        const payload = {
            mesa: session.mesa,
            table_id: session.mesa,
            platos: items,
            items,
            subtotal: total,
            total,
            status: 'draft',
            mode: source === 'tablet' ? 'tablet' : 'voice',
            // `client_id` identifica el transporte/browser legacy; nunca es
            // identidad personal. Solo un profile_id con consentimiento puede
            // enlazar memoria temporal con un pedido.
            cliente_id: session.profile_id || null,
            notas: `Pedido ${source === 'tablet' ? 'táctil' : 'por voz'} (sesión: ${session.session_id})`,
            timestamp: new Date().toISOString(),
            session_id: session.session_id,
            declared_allergies: safety.declared_allergies,
            dietary_restrictions: safety.dietary_restrictions,
            allergy_conflicts: safety.allergy_conflicts,
            special_warning: safety.special_warning,
            requires_special_confirmation: safety.requires_special_confirmation,
            special_confirmation: session.special_confirmation || {},
        };

        let order;
        if (session.active_order_id) {
            order = await memoryService.pedidoRepo.update(session.active_order_id, payload);
            if (!order) throw new Error(`Pedido no encontrado: ${session.active_order_id}`);
        } else {
            payload.id = randomUUID();
            order = await memoryService.crearPedido(payload);
            orderSessionManager.setOrderDraft(session.session_id, order.id, items);
        }

        if (tableService) {
            order = await tableService.attachOrder({ order, session, source });
        }

        session.draft_items = orderItems(order);
        session.state = SessionState.AWAITING_CONFIRMATION;
        if (sendToUI) {
            sendToUI({ type: 'pedido_actualizado', pedido: order });
            sendToUI({
                type: 'asr_pedido_draft',
                session_id: session.session_id,
                order_id: order.id,
                mesa: session.mesa,
                products: orderItems(order),
                declared_allergies: safety.declared_allergies,
                allergy_conflicts: safety.allergy_conflicts,
                special_warning: safety.special_warning,
                requires_special_confirmation: safety.requires_special_confirmation,
            });
        }
        return order;
    }

    async function applyMemoryIntent(session, classification, { source = 'voice' } = {}) {
        if (!temporaryMemoryService) {
            return { text: 'La memoria temporal no está disponible en este momento.', code: 'MEMORY_UNAVAILABLE' };
        }
        const profileId = session.profile_id || temporaryMemoryService.getBoundProfileId(session.session_id);
        const entities = classification.entities || {};
        if (classification.intent === MemoryIntent.CONSENT) {
            if (entities.consent === 'disabled') {
                if (profileId) await temporaryMemoryService.forget({ sessionId: session.session_id, profileId, scope: 'all' });
                orderSessionManager.setMemoryProfile(session.session_id, { profileId: null, consent: 'disabled' });
                return { text: 'De acuerdo. No guardaré memoria personal de esta atención.', result: 'memory_disabled' };
            }
            if (profileId) await temporaryMemoryService.forget({ sessionId: session.session_id, profileId, scope: 'all' });
            const profile = await temporaryMemoryService.createProfile({
                sessionId: session.session_id,
                consent: entities.consent || 'session_only',
                source: 'user_confirmed',
                visitId: session.visit_id,
                tableId: session.mesa,
            });
            orderSessionManager.setMemoryProfile(session.session_id, { profileId: profile.profile_id, consent: profile.consent_status });
            const phrase = profile.consent_status === 'temporary' ? 'durante el periodo elegido' : 'solo durante esta atención';
            return { text: `Entendido. Solo guardaré datos que declares explícitamente ${phrase}.`, result: 'memory_consent_updated' };
        }

        if (classification.intent === MemoryIntent.IDENTIFY) {
            let activeProfileId = profileId;
            if (!activeProfileId) {
                const profile = await temporaryMemoryService.createProfile({
                    sessionId: session.session_id,
                    displayName: entities.name,
                    consent: 'session_only',
                    source: 'user_declared',
                    visitId: session.visit_id,
                    tableId: session.mesa,
                });
                activeProfileId = profile.profile_id;
                orderSessionManager.setMemoryProfile(session.session_id, { profileId: activeProfileId, consent: profile.consent_status });
            } else {
                await temporaryMemoryService.remember({ sessionId: session.session_id, profileId: activeProfileId, memoryType: 'name', value: entities.name, source: 'user_declared', visitId: session.visit_id, tableId: session.mesa });
            }
            const retentionText = session.memory_consent === 'temporary' ? 'durante el periodo elegido' : 'solo durante esta atención';
            return { text: `Mucho gusto, ${entities.name}. Lo usaré ${retentionText}; puedes decirme “no guardes mi nombre” cuando quieras olvidarlo.`, result: 'name_recorded' };
        }

        if (classification.intent === MemoryIntent.UPDATE_NAME) {
            if (!profileId) return { text: 'Puedo actualizar tu nombre, pero primero dime si lo guardo solo durante esta atención o temporalmente.', result: 'memory_consent_required', code: 'MEMORY_CONSENT_REQUIRED' };
            await temporaryMemoryService.remember({ sessionId: session.session_id, profileId, memoryType: 'name', value: entities.name, source: 'user_declared', visitId: session.visit_id, tableId: session.mesa });
            return { text: `Entendido, actualizaré tu nombre a ${entities.name}.`, result: 'name_updated' };
        }

        if (classification.intent === MemoryIntent.FORGET) {
            const scope = entities.scope || 'all';
            if (profileId) await temporaryMemoryService.forget({ sessionId: session.session_id, profileId, scope });
            if (scope === 'all') orderSessionManager.setMemoryProfile(session.session_id, { profileId: null, consent: 'disabled' });
            const labels = { name: 'tu nombre', companion: 'tus acompañantes', preference: 'tus preferencias', allergy: 'tus alergias', restriction: 'tus restricciones', last_confirmed_order: 'tu último pedido' };
            return { text: `He olvidado ${labels[scope] || 'la memoria personal'}${scope === 'all' ? ' asociada a esta atención' : ''}. Tus pedidos operativos permanecen intactos.`, result: scope === 'all' ? 'memory_forgotten' : 'memory_item_forgotten' };
        }

        if (classification.intent === MemoryIntent.RETENTION_QUERY) {
            const policy = await temporaryMemoryService.getPolicy();
            const labels = { session_only: 'solo durante esta atención', '1d': '24 horas', '7d': '7 días', '30d': '30 días', disabled: 'no se conserva memoria persistente' };
            return { text: `La política actual conserva la memoria temporal durante ${labels[policy.retention_policy] || policy.retention_policy}. Puedes pedir que no guarde nada.`, result: 'retention_read' };
        }

        if ([MemoryIntent.UNSAFE_QUERY, MemoryIntent.CLARIFICATION].includes(classification.intent)) {
            return { text: classification.intent === MemoryIntent.UNSAFE_QUERY
                ? 'No puedo consultar datos de otra persona, una mesa o todos los perfiles. Solo uso una memoria vinculada explícitamente a esta sesión.'
                : '¿Qué dato deseas guardar u olvidar: tu nombre, una preferencia, una alergia o tu último pedido?', result: 'memory_clarification_required' };
        }

        if (classification.intent === MemoryIntent.QUERY) {
            if (!profileId) return { text: 'No tengo memoria personal guardada para esta atención.', result: 'memory_empty' };
            const summary = await temporaryMemoryService.summary({ sessionId: session.session_id, profileId });
            const parts = [];
            if (summary.name) parts.push(`tu nombre es ${summary.name}`);
            if (summary.preferences.length) parts.push(`prefieres ${summary.preferences.join(', ')}`);
            if (summary.companions.length) parts.push(`vienes con ${summary.companions.join(', ')}`);
            if (summary.allergies.length) parts.push('tienes alergias declaradas que deberás confirmar nuevamente');
            return { text: parts.length ? `Recuerdo que ${parts.join('; ')}.` : 'No tengo preferencias personales guardadas.', result: 'memory_read' };
        }

        if (classification.intent === MemoryIntent.CONFIRM_RECOVERED_ALLERGY || classification.intent === MemoryIntent.REJECT_RECOVERED_ALLERGY) {
            if (!profileId) return { text: 'No hay una alergia temporal recuperada para confirmar.', result: 'allergy_recovery_empty' };
            const summary = await temporaryMemoryService.summary({ sessionId: session.session_id, profileId });
            const allergies = summary.allergies.filter(item => item.requires_reconfirmation).map(item => item.value).filter(Boolean);
            if (allergies.length === 0) return { text: 'No hay una alergia temporal pendiente de confirmación.', result: 'allergy_recovery_empty' };
            if (classification.intent === MemoryIntent.REJECT_RECOVERED_ALLERGY) {
                await temporaryMemoryService.rejectRecoveredAllergies({ sessionId: session.session_id, profileId, allergies });
                return { text: 'No aplicaré la alergia recuperada a esta atención. Si necesitas eliminarla de la memoria, di “olvida mis alergias”.', result: 'allergy_recovery_rejected' };
            }
            await temporaryMemoryService.confirmRecoveredAllergies({ sessionId: session.session_id, profileId, allergies });
            session.declared_allergies = [...new Set([...(session.declared_allergies || []), ...allergies])];
            const safety = deriveSafetyContext(session.draft_items || [], orderSessionManager.getMenu(), session.declared_allergies, session.dietary_restrictions);
            Object.assign(session, safety);
            const order = session.active_order_id ? await upsertDraft(session, session.draft_items, { source }) : null;
            return { text: `Confirmado. Aplicaré a esta atención la alerta declarada sobre ${allergies.join(', ')}.`, result: 'allergy_recovery_confirmed', order };
        }

        if (classification.intent === MemoryIntent.LAST_ORDER || classification.intent === MemoryIntent.REORDER) {
            if (!profileId) return { text: 'No tengo un perfil temporal asociado para buscar pedidos anteriores.', result: 'memory_profile_required' };
            const lastOrder = await temporaryMemoryService.getLastConfirmedOrder({ sessionId: session.session_id, profileId });
            if (!lastOrder?.items?.length) return { text: 'No encuentro un pedido anterior válido para esta memoria.', result: 'last_order_empty' };
            const menu = orderSessionManager.getMenu();
            const items = [];
            for (const saved of lastOrder.items) {
                const candidate = menu.find(item => String(item.id) === String(saved.product_id))
                    || menu.find(item => String(item.nombre).toLowerCase() === String(saved.nombre).toLowerCase());
                if (!candidate || candidate.disponible === false || candidate.disponibilidad === false) continue;
                items.push({ ...candidate, cantidad: Math.max(1, Number(saved.cantidad) || 1), modificaciones: saved.modificaciones || [] });
            }
            if (items.length === 0) return { text: 'El pedido anterior ya no está disponible completo; no cambiaré tu carrito.', result: 'last_order_unavailable' };
            if (classification.intent === MemoryIntent.LAST_ORDER) {
                return { text: `Tu último pedido fue: ${orderSummary(items)}. Si quieres repetirlo, di “repite mi último pedido”.`, result: 'last_order_read' };
            }
            const { order } = await applyDraft(session, items, 'Repite mi último pedido', { source, clientId: session.profile_id || null, alreadyLocked: true });
            return { text: `He agregado el pedido anterior: ${orderSummary(orderItems(order))}. Revisa el carrito antes de confirmar.`, order, result: 'last_order_reordered' };
        }

        const typeByIntent = {
            [MemoryIntent.COMPANION]: ['companion', entities.companion],
            [MemoryIntent.PREFERENCE]: [entities.preference_type === 'interaction_mode' ? 'interaction_mode' : 'preference', entities.preference_type === 'interaction_mode' ? { preference_type: 'interaction_mode', value: entities.preference } : { preference_type: entities.preference_type || 'general', value: entities.preference }],
            [MemoryIntent.FAVORITE]: ['favorite_product', entities.favorite_product],
            [MemoryIntent.ALLERGY]: ['allergy', entities.allergy],
        };
        const memory = typeByIntent[classification.intent];
        if (memory) {
            let activeProfileId = profileId;
            if (!activeProfileId && entities.remember_consent === 'temporary') {
                const profile = await temporaryMemoryService.createProfile({ sessionId: session.session_id, consent: 'temporary', source: 'user_declared', visitId: session.visit_id, tableId: session.mesa });
                activeProfileId = profile.profile_id;
                orderSessionManager.setMemoryProfile(session.session_id, { profileId: activeProfileId, consent: profile.consent_status });
            }
            if (!activeProfileId) return { text: '¿Deseas que lo recuerde solo durante esta atención o temporalmente? Puedes decir “solo por esta sesión” o “recuérdame”.', result: 'memory_consent_required', code: 'MEMORY_CONSENT_REQUIRED' };
            await temporaryMemoryService.remember({ sessionId: session.session_id, profileId: activeProfileId, memoryType: memory[0], value: memory[1], source: 'user_declared', visitId: session.visit_id, tableId: session.mesa });
            if (memory[0] === 'allergy') return { text: 'Lo guardaré como una alergia declarada. En una nueva atención tendrás que confirmarla otra vez; no modifica ni confirma el pedido actual.', result: 'allergy_memory_recorded' };
            const rememberedText = entities.preference || entities.favorite_product || entities.companion || entities.allergy || String(memory[1]);
            const prefix = memory[0] === 'favorite_product' ? 'Tu plato favorito declarado será' : memory[0] === 'interaction_mode' ? 'Tu modo preferido declarado será' : 'Recordaré';
            return { text: `Entendido. ${prefix}: ${rememberedText}.`, result: 'memory_recorded' };
        }
        return { text: 'No pude resolver la solicitud de memoria.', result: 'memory_clarification_required' };
    }

    async function cancelDraft(session) {
        if (session.active_order_id && session.state !== SessionState.CONFIRMED && session.state !== SessionState.COMPLETED) {
            await memoryService.pedidoRepo.update(session.active_order_id, { status: 'cancelled' });
        }
        return orderSessionManager.cancelOrder(session.session_id);
    }

    async function cancelDraftSafely(session) {
        return withSessionLock(session.session_id, () => cancelDraft(session));
    }

    async function applyDraft(session, incomingItems, text, options) {
        const execute = async () => {
            const snapshot = {
                active_order_id: session.active_order_id,
                draft_items: (session.draft_items || []).map(item => ({ ...item })),
                state: session.state,
            };
            try {
                orderSessionManager.setState(session.session_id, SessionState.PROCESSING);
                const draft = orderSessionManager.mergeDraftItems(session.session_id, incomingItems, text);
                if (draft.items.length === 0) {
                    await cancelDraft(session);
                    return { draft, order: null };
                }
                const order = await upsertDraft(session, draft.items, options);
                return { draft, order };
            } catch (error) {
                session.active_order_id = snapshot.active_order_id;
                session.draft_items = snapshot.draft_items;
                session.state = snapshot.state;
                throw error;
            }
        };
        return options?.alreadyLocked ? execute() : withSessionLock(session.session_id, execute);
    }

    function deterministicDecision(classification, { previousState, nextState, result = 'not_applied', error = null } = {}) {
        return {
            intent: classification.intent,
            confidence: classification.confidence,
            entities: classification.entities,
            source: classification.source,
            mutates_order: classification.mutates_order,
            requires_clarification: classification.requires_clarification,
            previous_state: previousState,
            next_state: nextState,
            result,
            error,
        };
    }

    function canonicalizeClassificationProducts(classification) {
        const entities = { ...classification.entities };
        const candidates = [];
        if (Array.isArray(entities.products)) candidates.push(...entities.products);
        if (entities.source_product) candidates.push(entities.source_product);
        if (entities.target_product) candidates.push(entities.target_product);
        const { validos, invalidos, agotados } = orderSessionManager.validateProducts(candidates);
        const byName = new Map(validos.map(item => [String(item.nombre).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(), item]));
        const canonical = (item) => byName.get(String(item?.nombre || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()) || null;
        entities.products = (entities.products || []).map(canonical).filter(Boolean);
        if (entities.source_product) entities.source_product = canonical(entities.source_product);
        if (entities.target_product) entities.target_product = canonical(entities.target_product);
        return { entities, validos, invalidos, agotados };
    }

    async function applyDeterministicDraft(session, classification, options) {
        const execute = async () => {
            const snapshot = {
                active_order_id: session.active_order_id,
                draft_items: (session.draft_items || []).map(item => ({ ...item })),
                state: session.state,
            };
            try {
                orderSessionManager.setState(session.session_id, SessionState.EDITING_ORDER);
                const normalized = canonicalizeClassificationProducts(classification);
                if (normalized.invalidos.length > 0 || normalized.agotados.length > 0) {
                    orderSessionManager.setState(session.session_id, snapshot.state);
                    return {
                        order: await loadActiveOrder(session),
                        draft: null,
                        validation: normalized,
                    };
                }
                const applied = applyDraftIntent({
                    currentItems: session.draft_items || [],
                    intent: classification.intent,
                    entities: normalized.entities,
                });
                if (!applied.changed) {
                    orderSessionManager.setState(session.session_id, snapshot.state);
                    return { order: await loadActiveOrder(session), draft: applied, validation: normalized };
                }
                if (applied.items.length === 0) {
                    await cancelDraft(session);
                    return { order: null, draft: applied, validation: normalized };
                }
                const order = await upsertDraft(session, applied.items, options);
                const lastProduct = normalized.entities.target_product?.nombre
                    || normalized.entities.products?.at(-1)?.nombre
                    || null;
                orderSessionManager.recordConversation(session.session_id, {
                    intent: classification.intent,
                    productName: lastProduct,
                });
                return { order, draft: applied, validation: normalized };
            } catch (error) {
                session.active_order_id = snapshot.active_order_id;
                session.draft_items = snapshot.draft_items;
                session.state = snapshot.state;
                throw error;
            }
        };
        return options?.alreadyLocked ? execute() : withSessionLock(session.session_id, execute);
    }

    function safetyTarget(session, entities = {}) {
        if (entities.target?.all || entities.scope === 'all' && !entities.target?.nombre && !entities.target?.item_id && !entities.target?.ordinal) {
            return { all: true };
        }
        if (entities.target?.nombre || entities.target?.item_id || entities.target?.ordinal) return entities.target;
        if (entities.base_product) return { nombre: entities.base_product };
        if (session.draft_items?.length === 1) return { nombre: session.draft_items[0].nombre };
        return { candidates: (session.draft_items || []).map(item => item.nombre) };
    }

    function safetyMenuItem(target, session) {
        const item = target?.nombre
            ? orderSessionManager.resolveMenuItem(target.nombre)
            : target?.item_id
                ? session.draft_items.find(candidate => candidate.item_id === target.item_id)
                : target?.ordinal === 'first'
                    ? session.draft_items[0]
                    : target?.ordinal === 'second'
                        ? session.draft_items[1]
                        : null;
        return item?.nombre ? orderSessionManager.resolveMenuItem(item.nombre) || item : null;
    }

    async function recordSafety(event, session, order, previousState, nextState, metadata = {}) {
        if (!safetyService) return;
        await safetyService.record({
            event,
            sessionId: session.session_id,
            orderId: order?.id || session.active_order_id,
            mesa: session.mesa,
            actor: 'user',
            previousState,
            nextState,
            source: metadata.source || 'asr',
            metadata,
        });
    }

    async function applySafetyIntent(session, classification, options) {
        const entities = classification.entities || {};
        const previousItems = (session.draft_items || []).map(item => ({ ...item }));
        const previousSafety = {
            allergies: [...(session.declared_allergies || [])],
            restrictions: [...(session.dietary_restrictions || [])],
            conflicts: [...(session.allergy_conflicts || [])],
        };

        if (classification.intent === Intent.DECLARE_ALLERGY) {
            const allergen = String(entities.allergen || '').trim();
            if (!allergen) return { response: '¿A qué ingrediente o alérgeno debes evitar?', clarification: true };
            session.declared_allergies = [...new Set([...(session.declared_allergies || []), allergen])];
            const requestedProducts = Array.isArray(entities.requested_products) ? entities.requested_products : [];
            if (requestedProducts.length > 0) {
                orderSessionManager.mergeDraftItems(
                    session.session_id,
                    requestedProducts,
                    `Agrega ${requestedProducts.map(item => item.nombre).join(' y ')}`,
                );
            }
            const safety = deriveSafetyContext(session.draft_items || [], orderSessionManager.getMenu(), session.declared_allergies, session.dietary_restrictions);
            Object.assign(session, safety);
            const order = session.draft_items.length > 0 ? await upsertDraft(session, session.draft_items, options) : null;
            await recordSafety('allergy_declared', session, order, previousSafety, safety, { allergen });
            if (safety.allergy_conflicts.length > 0) {
                await recordSafety('allergen_conflict_detected', session, order, previousSafety, safety, { allergen, conflicts: safety.allergy_conflicts });
            }
            return {
                order,
                safety,
                response: safety.allergy_conflicts.length > 0
                    ? `He registrado tu alergia a ${allergen}.${requestedProducts.length ? ` Añadí ${requestedProducts.map(item => item.nombre).join(' y ')} al borrador.` : ''} ${safety.special_warning} Puedes quitar el producto o solicitar un mesero.`
                    : `He registrado tu alergia a ${allergen}. Revisaré los ingredientes registrados antes de confirmar.`,
            };
        }

        if (classification.intent === Intent.REMOVE_ALLERGY) {
            const allergen = String(entities.allergen || '').trim();
            session.declared_allergies = allergen
                ? (session.declared_allergies || []).filter(value => normalizeSafetyText(value) !== normalizeSafetyText(allergen))
                : [];
            const safety = deriveSafetyContext(session.draft_items || [], orderSessionManager.getMenu(), session.declared_allergies, session.dietary_restrictions);
            Object.assign(session, safety);
            const order = session.active_order_id ? await upsertDraft(session, session.draft_items, options) : null;
            await recordSafety('allergy_removed', session, order, previousSafety, safety, { allergen: allergen || null });
            return { order, safety, response: 'Actualicé las alergias declaradas para esta sesión.' };
        }

        if (classification.intent === Intent.DECLARE_DIETARY_RESTRICTION) {
            const restriction = String(entities.restriction || '').trim();
            session.dietary_restrictions = [...new Set([...(session.dietary_restrictions || []), restriction])];
            const safety = deriveSafetyContext(session.draft_items || [], orderSessionManager.getMenu(), session.declared_allergies, session.dietary_restrictions);
            Object.assign(session, safety);
            const order = session.active_order_id ? await upsertDraft(session, session.draft_items, options) : null;
            await recordSafety('dietary_restriction_declared', session, order, previousSafety, safety, { restriction });
            return { order, safety, response: `Registraré la restricción ${restriction}. Solo afirmaré compatibilidad cuando esté configurada en el menú.` };
        }

        if ([Intent.QUERY_INGREDIENTS, Intent.QUERY_ALLERGENS, Intent.QUERY_DIETARY_OPTIONS, Intent.QUERY_MODIFIER_OPTIONS].includes(classification.intent)) {
            const query = classification.intent === Intent.QUERY_INGREDIENTS
                ? menuQuery(orderSessionManager.getMenu(), {
                    productName: entities.product,
                    excludeIngredient: entities.exclude_ingredient,
                    category: entities.category,
                })
                : classification.intent === Intent.QUERY_DIETARY_OPTIONS
                    ? menuQuery(orderSessionManager.getMenu(), { restriction: entities.restriction, category: entities.category })
                    : classification.intent === Intent.QUERY_MODIFIER_OPTIONS
                        ? { type: 'modifiers', items: orderSessionManager.getMenu().filter(item => item.permite_modificadores !== false) }
                        : menuQuery(orderSessionManager.getMenu(), {
                            productName: entities.product,
                            allergen: entities.allergen,
                            safeForAllergen: entities.safe_for_allergen,
                        });
            const response = classification.intent === Intent.QUERY_MODIFIER_OPTIONS
                ? (query.items.length ? `Puedo revisar modificadores configurados para: ${query.items.map(item => item.nombre).join(', ')}.` : 'No hay modificadores configurados.')
                : entities.safety_question
                    ? 'No puedo afirmar que sea totalmente seguro ni garantizar ausencia de contaminación cruzada. Solo puedo mostrar la información registrada.'
                : safetyService?.describeQuery(query) || (query.items.length ? query.items.map(item => item.nombre).join(', ') : 'No tengo esa información registrada.');
            await recordSafety('ingredient_query', session, null, {}, {}, {
                product: entities.product || null,
                allergen: entities.allergen || null,
                restriction: entities.restriction || null,
                exclude_ingredient: entities.exclude_ingredient || null,
                query_type: query.type,
            });
            if (!query.complete && classification.intent !== Intent.QUERY_MODIFIER_OPTIONS) {
                await recordSafety('insufficient_ingredient_data', session, null, {}, {}, { product: entities.product || null });
            }
            // Fase 6: emitir navegación para que la pantalla sincronice.
            if (typeof sendToUI === 'function') {
                const navItems = Array.isArray(query.items) ? query.items : [];
                sendToUI({
                    type: 'menu_navigation',
                    session_id: session.session_id,
                    mesa: session.mesa,
                    action: 'show_products',
                    category: entities.category || null,
                    product_ids: navItems.map(item => item.id).filter(Boolean),
                    highlight_product_id: entities.product
                        ? (navItems.find(item => normalizeSafetyText(item.nombre) === normalizeSafetyText(entities.product))?.id || null)
                        : null,
                    filters: entities.restriction ? { restriction: entities.restriction } : {},
                    timestamp: new Date().toISOString(),
                });
                // Cierre correctivo Fase 6: persistir menu_state y auditar.
                try {
                    orderSessionManager.updateMenuNavigation(session_id, {
                        action: 'show_products',
                        category: entities.category || null,
                        product_ids: (Array.isArray(query.items) ? query.items : []).map(i => i.id).filter(Boolean),
                        highlight_product_id: entities.product
                            ? ((Array.isArray(query.items) ? query.items : []).find(i => normalizeSafetyText(i.nombre) === normalizeSafetyText(entities.product))?.id || null)
                            : null,
                        filters: entities.restriction ? { restriction: entities.restriction } : {},
                    });
                } catch (e) { /* no fatal */ }
                const auditType = classification.intent === Intent.QUERY_DIETARY_OPTIONS
                    ? 'recommendation_requested'
                    : classification.intent === Intent.QUERY_INGREDIENTS
                        ? 'product_details_requested'
                        : classification.intent === Intent.QUERY_ALLERGENS
                            ? 'product_details_requested'
                            : 'product_details_requested';
                recordSafety(auditType, session, null, {}, {}, {
                    action: 'show_products',
                    product: entities.product || null,
                    allergen: entities.allergen || null,
                    restriction: entities.restriction || null,
                    result: (Array.isArray(query.items) && query.items.length) ? 'found' : 'no_results',
                }).catch(() => {});
            }
            return { response, query, readOnly: true };
        }

        const target = safetyTarget(session, entities);
        if (!target.all && (target.candidates?.length > 1 || (!target.nombre && !target.item_id && !target.ordinal))) {
            return { clarification: true, response: '¿A cuál producto deseas aplicar esa modificación? No cambiaré nada hasta identificarlo.' };
        }

        if (classification.intent === Intent.ADD_ITEM_NOTE) {
            let workingItems = [...(session.draft_items || [])];
            // Si la observación llegó con un producto del menú que aún no
            // está en el draft (caso "Quiero un lomo saltado sin sal"),
            // se valida contra el menú real y se añade antes de aplicar
            // la nota. Esto evita que la nota se pierda cuando el cliente
            // combina producto + observación culinaria en la misma frase.
            if (target.nombre && entities.observation_only) {
                const inDraft = workingItems.some(it => normalizeSafetyText(it.nombre) === normalizeSafetyText(target.nombre));
                if (!inDraft) {
                    const validated = orderSessionManager.validateProducts([{ nombre: target.nombre, cantidad: entities.quantity || 1 }]);
                    if (validated.invalidos.length || validated.agotados.length) {
                        return { response: 'El producto ya no está disponible en el menú real.', clarification: true };
                    }
                    workingItems = [...workingItems, ...validated.validos];
                }
            }
            const applied = addNoteToItems(workingItems, target, entities.note, { scope: entities.scope || 'all' });
            if (!applied.changed) return { response: 'No encontré un producto inequívoco para guardar la observación.', clarification: true };
            const order = await upsertDraft(session, applied.items, options);
            await recordSafety('add_item_note', session, order, previousItems, applied.items, { note: entities.note, observation_id: entities.observation_id || null });
            return { order, response: `Guardé la observación para ${target.nombre || 'el producto indicado'}.` };
        }

        if (classification.intent === Intent.REMOVE_ITEM_NOTE) {
            const applied = removeNoteFromItems(session.draft_items || [], target, { scope: entities.scope || 'all' });
            if (!applied.changed) return { response: 'No encontré una observación en el producto indicado.', clarification: true };
            const order = await upsertDraft(session, applied.items, options);
            await recordSafety('modifier_removed', session, order, previousItems, applied.items, { kind: 'observation' });
            return { order, response: 'Quité la observación indicada.' };
        }

        if (classification.intent === Intent.REPLACE_ITEM_NOTE) {
            // Reemplazo entre observaciones culinarias de la allowlist
            // (ej. "cambia sin sal por poca sal"). Implementado como
            // remove + add sobre el mismo target.
            const removed = removeNoteFromItems(session.draft_items || [], target, { scope: entities.scope || 'all' });
            const baseItems = removed.changed ? removed.items : (session.draft_items || []);
            const applied = addNoteToItems(baseItems, target, entities.note, { scope: entities.scope || 'all' });
            if (!applied.changed) return { response: 'No pude registrar la nueva observación.', clarification: true };
            const order = await upsertDraft(session, applied.items, options);
            await recordSafety('note_replaced', session, order, previousItems, applied.items, { from_note_id: entities.from_note_id || null, note: entities.note });
            return { order, response: `Reemplacé la observación por "${entities.note}".` };
        }

        if (classification.intent === Intent.REPLACE_ITEM_MODIFIER) {
            let currentItems = [...(session.draft_items || [])];
            let applied;
            if (entities.variant_plan === 'first_normal_second_modifier') {
                if (currentItems.length === 1 && Number(currentItems[0].cantidad) >= 2) {
                    const source = currentItems[0];
                    currentItems = [
                        { ...source, cantidad: 1, item_id: source.item_id || randomUUID() },
                        { ...source, cantidad: 1, item_id: randomUUID() },
                    ];
                }
                const secondMenuItem = safetyMenuItem(entities.target || { ordinal: 'second' }, { ...session, draft_items: currentItems });
                const resolvedModifier = secondMenuItem
                    ? (safetyService?.resolveModifier(secondMenuItem, entities.modifier) || findConfiguredModifier(secondMenuItem, entities.modifier))
                    : null;
                if (!resolvedModifier) return { response: 'No tengo registrada esa modificación para el segundo producto.', clarification: true };
                const cleared = removeModifierFromItems(currentItems, entities.clear_target || { ordinal: 'first' }, null, { scope: 'all' });
                const second = addModifierToItems(cleared.items, entities.target || { ordinal: 'second' }, resolvedModifier, { scope: 'all' });
                applied = {
                    ...second,
                    items: second.items,
                    changed: cleared.changed || second.changed,
                    split: second.split,
                };
            } else if (entities.from_modifier) {
                const item = safetyMenuItem(target, session);
                const fromModifier = item
                    ? (safetyService?.resolveModifier(item, entities.from_modifier)
                        || findConfiguredModifier(item, entities.from_modifier)
                        || entities.from_modifier)
                    : entities.from_modifier;
                const toModifier = item
                    ? (safetyService?.resolveModifier(item, entities.modifier) || findConfiguredModifier(item, entities.modifier))
                    : null;
                if (!toModifier) return { response: 'No tengo registrada la nueva modificación para ese producto.', clarification: true };
                const removed = removeModifierFromItems(currentItems, target, fromModifier, { scope: entities.scope || 'all' });
                if (!removed.changed) return { response: 'No encontré la modificación anterior en el producto. No cambiaré el pedido.', clarification: true };
                applied = addModifierToItems(removed.items, target, toModifier, { scope: entities.scope || 'all' });
            } else {
                const source = session.draft_items?.[0];
                const copiedModifier = source?.modificaciones?.[0];
                if (!copiedModifier) return { response: 'No encontré una modificación anterior para copiar.', clarification: true };
                applied = addModifierToItems(currentItems, target, copiedModifier, { scope: entities.scope || 'second' });
            }
            if (!applied.changed) return { response: 'No encontré el producto de forma inequívoca.', clarification: true };
            const order = await upsertDraft(session, applied.items, options);
            await recordSafety('modifier_added', session, order, previousItems, applied.items, {
                copied_from: entities.variant_plan ? null : 'first',
                replaced: Boolean(entities.from_modifier),
                variant_plan: entities.variant_plan || null,
            });
            return { order, response: entities.variant_plan
                ? 'Dejé el primero normal y apliqué la modificación al segundo.'
                : entities.from_modifier
                    ? 'Reemplacé la modificación indicada por la nueva configuración.'
                    : 'Apliqué la misma modificación al producto indicado.' };
        }

        if (classification.intent === Intent.REMOVE_ITEM_MODIFIER) {
            const item = safetyMenuItem(target, session);
            const requested = entities.modifier && item ? (safetyService?.resolveModifier(item, entities.modifier) || entities.modifier) : entities.modifier;
            const applied = removeModifierFromItems(session.draft_items || [], target, requested?.cancel_last ? null : requested, { scope: entities.scope || 'all' });
            if (!applied.changed) return { response: 'No encontré esa modificación en el producto. El producto permanece sin cambios.', clarification: true };
            const order = await upsertDraft(session, applied.items, options);
            await recordSafety('modifier_removed', session, order, previousItems, applied.items, { modifier: requested || null });
            return { order, response: 'Quité la modificación sin eliminar el producto.' };
        }

        if (classification.intent === Intent.ADD_ITEM_MODIFIER) {
            const item = safetyMenuItem(target, session);
            if (!item) return { response: 'No encontré el producto indicado en el menú real.', clarification: true };
            const modifier = safetyService?.resolveModifier(item, entities.modifier) || findConfiguredModifier(item, entities.modifier);
            if (!modifier) {
                const requestedName = entities.modifier?.nombre || entities.modifier?.requested || 'solicitado';
                return {
                    changed: false,
                    response: `No tengo registrada la preparación “${requestedName}” para ${item.nombre}. Si la necesitas sí o sí, puedo llamar a un mesero humano para que la anote manualmente.`,
                    clarification: true,
                    suggest_human_waiter: true,
                };
            }
            let currentItems = [...(session.draft_items || [])];
            const matching = currentItems.some(candidate => normalizeSafetyText(candidate.nombre) === normalizeSafetyText(item.nombre));
            if (!matching) {
                const validated = orderSessionManager.validateProducts([{ nombre: item.nombre, cantidad: entities.quantity || 1 }]);
                if (validated.invalidos.length || validated.agotados.length) return { response: 'El producto ya no está disponible en el menú real.' };
                currentItems = [...currentItems, validated.validos[0]];
            }
            const applied = addModifierToItems(currentItems, { nombre: item.nombre }, modifier, {
                quantity: entities.scope === 'one' ? 1 : entities.quantity,
                scope: entities.scope || 'all',
            });
            if (!applied.changed) return { response: 'No pude identificar la unidad a modificar. No cambié el pedido.', clarification: true };
            const order = await upsertDraft(session, applied.items, options);
            await recordSafety(applied.split ? 'item_split_by_modifier' : 'modifier_added', session, order, previousItems, applied.items, { modifier });
            return { order, response: applied.split ? 'Separé las unidades: una con la modificación y otra normal.' : `Apliqué ${modifier.nombre} a ${item.nombre}.` };
        }

        return { response: 'No pude aplicar esa observación de forma segura.', clarification: true };
    }

    async function loadActiveOrder(session) {
        if (!session.active_order_id) return null;
        try {
            return await memoryService.pedidoRepo.findById(session.active_order_id);
        } catch {
            return null;
        }
    }

    async function confirmSession(session, { specialOverride = false, alreadyLocked = false } = {}) {
        const execute = async () => {
            try {
                if (session.requires_special_confirmation && !specialOverride
                    && session.special_confirmation?.decision !== 'confirmed') {
                    const error = new Error('Se requiere confirmación especial por alergia o información incompleta');
                    error.code = 'SPECIAL_CONFIRMATION_REQUIRED';
                    error.safety = {
                        warning: session.special_warning,
                        conflicts: session.allergy_conflicts,
                        incomplete_information: session.incomplete_information,
                    };
                    throw error;
                }
                if (specialOverride) {
                    session.special_confirmation = {
                        decision: 'confirmed',
                        timestamp: new Date().toISOString(),
                        session_id: session.session_id,
                    };
                }
                const claim = orderSessionManager.beginConfirmation(session.session_id);
                const orderId = session.active_order_id;
                const existing = await loadActiveOrder(session);
                if (!existing) throw new Error(`Pedido no encontrado: ${orderId}`);

                let order = existing;
                let sentNow = false;
                if (!claim.alreadyConfirmed && existing.status !== 'sent_to_kitchen') {
                    await orderSessionManager.refreshMenu();
                    const validation = orderSessionManager.validateProducts(session.draft_items || orderItems(existing));
                    if (validation.invalidos.length > 0 || validation.agotados.length > 0) {
                        const error = new Error('El menú cambió antes de confirmar el pedido');
                        error.code = 'MENU_CHANGED';
                        error.validation = validation;
                        throw error;
                    }
                    if (validation.invalid_modifiers?.length) {
                        const error = new Error('Hay modificadores que ya no están configurados en el menú');
                        error.code = 'MENU_CHANGED';
                        error.validation = validation;
                        throw error;
                    }
                    const canonicalItems = validation.validos;
                    const safety = safetyService?.derive(canonicalItems, orderSessionManager.getMenu(), session)
                        || deriveSafetyContext(canonicalItems, orderSessionManager.getMenu(), session.declared_allergies, session.dietary_restrictions);
                    Object.assign(session, safety);
                    if (safety.requires_special_confirmation && !specialOverride) {
                        const error = new Error('Se requiere confirmación especial por alergia o información incompleta');
                        error.code = 'SPECIAL_CONFIRMATION_REQUIRED';
                        error.safety = safety;
                        throw error;
                    }
                    const total = orderSessionManager.calculateTotal(canonicalItems);
                    order = await memoryService.pedidoRepo.update(orderId, {
                        items: canonicalItems,
                        platos: canonicalItems,
                        subtotal: total,
                        total,
                        session_id: session.session_id,
                        declared_allergies: safety.declared_allergies,
                        dietary_restrictions: safety.dietary_restrictions,
                        allergy_conflicts: safety.allergy_conflicts,
                        special_warning: safety.special_warning,
                        requires_special_confirmation: safety.requires_special_confirmation,
                        special_confirmation: session.special_confirmation || {},
                    });
                    if (!order) throw new Error(`Pedido no encontrado: ${orderId}`);
                    session.draft_items = orderItems(order);
                    order = await memoryService.pedidoRepo.update(orderId, { status: 'sent_to_kitchen' });
                    if (!order) throw new Error(`Pedido no encontrado: ${orderId}`);
                    if (tableService) {
                        order = await tableService.syncOrderStatus({ order, source: 'asr_confirmation' });
                    }
                    sentNow = true;
                    if (sendToUI) sendToUI({ type: 'nuevo_pedido', pedido: order });
                    if (specialOverride && safetyService) {
                        await safetyService.record({
                            event: 'allergy_order_confirmed',
                            sessionId: session.session_id,
                            orderId,
                            mesa: session.mesa,
                            actor: 'user',
                            source: 'asr',
                            nextState: { decision: 'confirmed', warning: safety.special_warning, conflicts: safety.allergy_conflicts },
                        });
                    }
                }
                return { order, alreadyConfirmed: claim.alreadyConfirmed, sentNow };
            } catch (error) {
                orderSessionManager.rollbackConfirmation(session.session_id);
                throw error;
            }
        };
        return alreadyLocked ? execute() : withSessionLock(session.session_id, execute);
    }

    // ── POST /api/asr/process ──────────────────────────────────
    router.post('/process', async (req, res) => {
        const t0 = Date.now();
        res.locals.suppressTts = req.body?.suppress_tts === true;
        try {
            const {
                user_text,
                session_id,
                turn_id,
                source,
                mesa,
                client_id,
                interaction_mode,
                conversation_history = [],
            } = req.body || {};

            if (!user_text || !session_id) {
                return res.status(400).json({ error: 'user_text y session_id son requeridos', code: 'MISSING_FIELDS' });
            }

            const authorizedSession = orderSessionManager.get(session_id);
            if (!requireAsrSessionAccess({ sessionId: session_id, session: authorizedSession, req, res, sessionLifecycle })) return;

            // Serializa todos los turnos que mutan una misma sesión. El
            // replay se consulta después de adquirir el lock, por lo que dos
            // POST simultáneos con el mismo turn_id no pueden ejecutar dos
            // veces la misma mutación.
            const releaseSessionLock = await acquireSessionLock(session_id);
            res.once('finish', releaseSessionLock);
            res.once('close', releaseSessionLock);

            const effectiveClientId = client_id || randomUUID();
            const existingSession = authorizedSession;
            if (rejectStaleSession(res, existingSession)) return;
            let session = orderSessionManager.getOrCreate(session_id, { clientId: effectiveClientId });
            const explicitTurnId = turn_id === undefined || turn_id === null ? null : String(turn_id);
            const replay = orderSessionManager.getTurnResult(session_id, explicitTurnId);
            if (replay) return res.json(replay);
            const originalJson = res.json.bind(res);
            res.json = payload => {
                if (explicitTurnId && payload?.session_id && payload?.turn_id) {
                    orderSessionManager.saveTurnResult(session_id, explicitTurnId, payload);
                }
                return originalJson(payload);
            };
            if (interaction_mode
                && [SessionState.CONFIRMED, SessionState.COMPLETED].includes(session.state)
                && session.interaction_mode !== interaction_mode) {
                return res.status(409).json({
                    error: 'El modo no puede cambiar después de confirmar el pedido',
                    code: 'ORDER_LOCKED',
                    ...statePayload(session),
                });
            }
            if (interaction_mode) {
                orderSessionManager.setInteractionMode(session_id, interaction_mode);
                syncLifecycleMode(session, interaction_mode);
            }
            const explicitMesa = extractMesa(user_text);
            const suppliedMesa = mesa ? normalizeRequestedMesa(mesa) : null;
            const requestedMesa = explicitMesa || session.mesa || suppliedMesa;
            if (!requestedMesa) {
                return res.status(400).json({
                    error: 'Selecciona una mesa antes de crear el pedido',
                    code: 'MISSING_TABLE',
                    session_id,
                });
            }
            const sessionWasLocked = [SessionState.CONFIRMED, SessionState.COMPLETED].includes(session.state);

            if (!session.mesa) {
                orderSessionManager.updateMesa(session_id, requestedMesa);
            } else if (session.mesa !== requestedMesa && !sessionWasLocked) {
                session = await moveSessionTableIfNeeded({
                    session,
                    requestedMesa,
                    source: source || 'asr_process',
                    tableService,
                    orderSessionManager,
                    memoryService,
                });
            } else if (session.mesa !== requestedMesa && sessionWasLocked) {
                return res.status(409).json({
                    error: 'La mesa no puede cambiar después de confirmar el pedido',
                    code: 'TABLE_LOCKED',
                    ...statePayload(session),
                });
            }

            const currentTurn = turn_id || orderSessionManager.nextTurn(session_id);
            const mesaOnly = explicitMesa && orderSessionManager.findMenuItemsInText(user_text).length === 0;

            if (mesaOnly) {
                const order = await loadActiveOrder(session);
                return jsonWithTts(res, localTtsPlayer, {
                    text: `Perfecto, tu pedido queda para la mesa ${session.mesa}.`,
                    ...statePayload(session, order),
                    turn_id: currentTurn,
                    latencyMs: Date.now() - t0,
                });
            }

            let memoryClassification = classifyMemoryIntent(user_text);
            if (!memoryClassification && session.profile_id && /^(?:si|sí|correcto|de acuerdo|no|rechazo|ya no|todavia no|todavía no)$/u.test(String(user_text).trim().toLowerCase())) {
                const recovered = await temporaryMemoryService?.summary({ sessionId: session.session_id, profileId: session.profile_id }).catch(() => null);
                if (recovered?.allergies?.some(item => item.requires_reconfirmation)) {
                    memoryClassification = /^(?:no|rechazo|ya no|todavia no|todavía no)$/u.test(String(user_text).trim().toLowerCase())
                        ? { intent: MemoryIntent.REJECT_RECOVERED_ALLERGY, confidence: 0.99, mutates_order: false, mutates_memory: false, requires_clarification: false, entities: { explicit: true }, source: 'deterministic_memory_context' }
                        : { intent: MemoryIntent.CONFIRM_RECOVERED_ALLERGY, confidence: 0.99, mutates_order: false, mutates_memory: false, requires_clarification: false, entities: { explicit: true }, source: 'deterministic_memory_context' };
                }
            }
            if (memoryClassification) {
                const providedSessionToken = String(req.get('x-session-token') || '');
                if (!session.session_access_token || !providedSessionToken || providedSessionToken !== session.session_access_token) {
                    return res.status(401).json({
                        error: 'Token de sesión requerido para acceder a memoria personal.',
                        code: 'SESSION_ACCESS_REQUIRED',
                        ...statePayload(session),
                    });
                }
                const previousState = session.state;
                try {
                    const memoryResult = await applyMemoryIntent(session, memoryClassification, { source: source === 'tablet' ? 'tablet' : 'voice' });
                    if (memoryResult.order) orderSessionManager.setState(session_id, SessionState.AWAITING_CONFIRMATION);
                    const nextState = session.state;
                    orderSessionManager.recordConversation(session_id, { intent: memoryClassification.intent, response: memoryResult.text });
                    return jsonWithTts(res, localTtsPlayer, {
                        text: memoryResult.text,
                        ...statePayload(session, memoryResult.order || await loadActiveOrder(session)),
                        decision: deterministicDecision(memoryClassification, { previousState, nextState, result: memoryResult.result, error: memoryResult.code || null }),
                        turn_id: currentTurn,
                        memory: true,
                        code: memoryResult.code,
                        latencyMs: Date.now() - t0,
                    });
                } catch (error) {
                    return res.status(error.code === 'MEMORY_CONSENT_REQUIRED' ? 409 : 400).json({
                        error: error.message,
                        code: error.code || 'MEMORY_PROCESSING_ERROR',
                        ...statePayload(session),
                    });
                }
            }

            const classification = (() => {
                const base = classifyIntent({
                    text: user_text,
                    menu: orderSessionManager.getMenu(),
                    draftItems: session.draft_items || [],
                    state: session.state,
                    interactionMode: session.interaction_mode,
                    lastProduct: session.last_product_name,
                });
                return preResolveVisibleReference({
                    text: user_text,
                    base,
                    session,
                    orderSessionManager,
                    menuService: buildFase6MenuService({ orderSessionManager, memoryService, pool }),
                });
            })();

            if (sessionWasLocked
                && [Intent.REJECT_CONFIRMATION, Intent.CANCEL_ORDER].includes(classification.intent)) {
                const order = await loadActiveOrder(session);
                const response = 'Tu pedido ya fue confirmado y está en cocina. No puedo deshacerlo desde esta sesión.';
                return jsonWithTts(res, localTtsPlayer, {
                    text: response,
                    ...statePayload(session, order),
                    turn_id: currentTurn,
                    order_status: order?.status || 'sent_to_kitchen',
                    already_confirmed: true,
                    decision: deterministicDecision(classification, {
                        previousState: session.state,
                        nextState: session.state,
                        result: 'order_locked',
                    }),
                    latencyMs: Date.now() - t0,
                });
            }

            if ([Intent.SELECT_INTERACTION_MODE, Intent.CHANGE_INTERACTION_MODE].includes(classification.intent)) {
                const previousState = session.state;
                if (classification.requires_clarification || !classification.entities.mode) {
                    orderSessionManager.setState(session_id, SessionState.AWAITING_CLARIFICATION);
                    const response = 'Puedes elegir una opción: pedir por voz, usar la pantalla o solicitar un mesero.';
                    orderSessionManager.recordConversation(session_id, { intent: classification.intent, response, ambiguous: true });
                    return jsonWithTts(res, localTtsPlayer, {
                        text: response,
                        ...statePayload(session),
                        decision: deterministicDecision(classification, { previousState, nextState: session.state, result: 'clarification_required' }),
                        turn_id: currentTurn,
                        latencyMs: Date.now() - t0,
                    });
                }
                const selectedMode = classification.entities.mode;
                if ([SessionState.CONFIRMED, SessionState.COMPLETED].includes(session.state)
                    && session.interaction_mode !== selectedMode) {
                    return res.status(409).json({
                        error: 'El modo no puede cambiar después de confirmar el pedido',
                        code: 'ORDER_LOCKED',
                        ...statePayload(session),
                    });
                }
                if ([SessionState.CONFIRMED, SessionState.COMPLETED].includes(session.state)) {
                    const response = 'Tu pedido ya fue confirmado y se conserva sin cambios. Pulsa “Nuevo pedido” para comenzar otro.';
                    return jsonWithTts(res, localTtsPlayer, {
                        text: response,
                        ...statePayload(session, await loadActiveOrder(session)),
                        decision: deterministicDecision(classification, { previousState, nextState: session.state, result: 'order_locked' }),
                        turn_id: currentTurn,
                        latencyMs: Date.now() - t0,
                    });
                }
                orderSessionManager.setInteractionMode(session_id, selectedMode);
                syncLifecycleMode(session, selectedMode);
                if (selectedMode === InteractionMode.VOICE) orderSessionManager.setState(session_id, SessionState.LISTENING);
                else if (selectedMode === InteractionMode.SCREEN) orderSessionManager.setState(session_id, SessionState.IDLE);
                const response = selectedMode === InteractionMode.VOICE
                    ? 'Perfecto, continuaremos por voz.'
                    : 'Perfecto, puedes realizar tu pedido desde la pantalla.';
                orderSessionManager.recordConversation(session_id, { intent: classification.intent, response });
                return jsonWithTts(res, localTtsPlayer, {
                    text: response,
                    intent: classification.intent,
                    ...statePayload(session),
                    decision: deterministicDecision(classification, { previousState, nextState: session.state, result: 'mode_selected' }),
                    turn_id: currentTurn,
                    latencyMs: Date.now() - t0,
                });
            }

            if (classification.intent === Intent.SET_PARTY_SIZE) {
                const previousState = session.state;
                const guestCount = classification.entities?.guest_count;
                if (!Number.isInteger(guestCount) || guestCount < 1) {
                    return res.status(400).json({ error: 'Indica un número positivo de personas.', code: 'INVALID_GUEST_COUNT' });
                }
                if (tableService && !session.visit_id) {
                    return res.status(409).json({
                        error: 'La visita de la mesa aún no está disponible para guardar el tamaño del grupo.',
                        code: 'VISIT_REQUIRED',
                        ...statePayload(session),
                    });
                }
                sessionLifecycle?.assertGuestCountChange?.(session_id, guestCount);
                let visit = null;
                if (tableService) visit = await tableService.setGuestCount(session.mesa, session.visit_id, guestCount);
                if (sessionLifecycle?.setGuestCount) sessionLifecycle.setGuestCount(session_id, guestCount);
                else orderSessionManager.setGuestCount(session_id, guestCount);
                session = orderSessionManager.get(session_id) || session;
                const response = `Perfecto, registraré ${guestCount} ${guestCount === 1 ? 'persona' : 'personas'} en la mesa ${session.mesa}.`;
                orderSessionManager.recordConversation(session_id, { intent: classification.intent, response });
                return jsonWithTts(res, localTtsPlayer, {
                    text: response,
                    intent: classification.intent,
                    ...statePayload(session),
                    visit,
                    decision: deterministicDecision(classification, { previousState, nextState: session.state, result: 'party_size_recorded' }),
                    turn_id: currentTurn,
                    latencyMs: Date.now() - t0,
                });
            }

            if (classification.intent === Intent.START_ADDITIONAL_ORDER) {
                const previousState = session.state;
                if (!tableService || !sessionLifecycle || !session.mesa) {
                    return res.status(409).json({
                        error: 'No hay una visita activa para iniciar un pedido adicional.',
                        code: 'NO_ACTIVE_VISIT',
                        ...statePayload(session, await loadActiveOrder(session)),
                    });
                }
                if (session.active_order_id && !sessionWasLocked) {
                    const response = 'Primero confirma o cancela el borrador actual antes de iniciar un pedido adicional.';
                    orderSessionManager.setState(session_id, SessionState.AWAITING_CONFIRMATION);
                    orderSessionManager.recordConversation(session_id, { intent: classification.intent, response, ambiguous: true });
                    return jsonWithTts(res, localTtsPlayer, {
                        text: response,
                        ...statePayload(session, await loadActiveOrder(session)),
                        decision: deterministicDecision(classification, { previousState, nextState: session.state, result: 'current_draft_requires_resolution' }),
                        turn_id: currentTurn,
                        latencyMs: Date.now() - t0,
                    });
                }

                const visitId = session.visit_id || (await tableService.getTable(session.mesa))?.current_visit_id;
                const visit = visitId ? await tableService.getVisit(session.mesa, visitId) : null;
                if (!visit || visit.status !== 'active') {
                    return res.status(409).json({
                        error: 'La mesa no tiene una visita activa para agregar un pedido.',
                        code: 'NO_ACTIVE_VISIT',
                        ...statePayload(session),
                    });
                }

                try {
                    const robotId = session.robot_id || session.assignment?.robot_id || 'uchino-01';
                    sessionLifecycle.close({
                        sessionId: session_id,
                        reason: 'additional_order_requested',
                        source: source || 'voice',
                        stopAudio: true,
                    });
                    const started = await tableService.startAdditionalOrder({
                        tableId: session.mesa,
                        robotId,
                        source: source || 'voice',
                    });
                    const nextSession = sessionLifecycle.setInteractionMode(started.session.session_id, InteractionMode.VOICE);
                    orderSessionManager.setState(nextSession.session_id, SessionState.LISTENING);
                    const response = `De acuerdo, inicié un pedido adicional para ${session.mesa}. ¿Qué deseas agregar?`;
                    orderSessionManager.recordConversation(nextSession.session_id, { intent: classification.intent, response });
                    sendToUI?.({
                        type: 'additional_order_session_started',
                        session_id: nextSession.session_id,
                        previous_session_id: session_id,
                        visit_id: visit.visit_id,
                        mesa: session.mesa,
                        source: source || 'voice',
                    });
                    return jsonWithTts(res, localTtsPlayer, {
                        text: response,
                        ...statePayload(nextSession),
                        previous_session_id: session_id,
                        visit_id: visit.visit_id,
                        additional_order_started: true,
                        decision: deterministicDecision(classification, {
                            previousState,
                            nextState: nextSession.state,
                            result: 'additional_session_started',
                        }),
                        turn_id: currentTurn,
                        latencyMs: Date.now() - t0,
                    });
                } catch (error) {
                    return res.status(error.code === 'ROBOT_BUSY' ? 409 : 400).json({
                        error: error.message,
                        code: error.code || 'ADDITIONAL_ORDER_ERROR',
                        ...statePayload(session),
                    });
                }
            }

            const safetyIntents = [
                Intent.ADD_ITEM_MODIFIER,
                Intent.REMOVE_ITEM_MODIFIER,
                Intent.REPLACE_ITEM_MODIFIER,
                Intent.ADD_ITEM_NOTE,
                Intent.REMOVE_ITEM_NOTE,
                Intent.REPLACE_ITEM_NOTE,
                Intent.DECLARE_ALLERGY,
                Intent.REMOVE_ALLERGY,
                Intent.DECLARE_DIETARY_RESTRICTION,
                Intent.QUERY_INGREDIENTS,
                Intent.QUERY_ALLERGENS,
                Intent.QUERY_MODIFIER_OPTIONS,
                Intent.CLARIFY_TARGET_ITEM,
            ];
            if (safetyIntents.includes(classification.intent)) {
                const previousState = session.state;
                if (sessionWasLocked && classification.mutates_order) {
                    return jsonWithTts(res, localTtsPlayer, {
                        text: 'Tu pedido ya está confirmado. No puedo cambiar sus observaciones.',
                        ...statePayload(session, await loadActiveOrder(session)),
                        decision: deterministicDecision(classification, { previousState, nextState: session.state, result: 'order_locked' }),
                        turn_id: currentTurn,
                        latencyMs: Date.now() - t0,
                    });
                }
                try {
                    const safetyResult = classification.intent === Intent.CLARIFY_TARGET_ITEM
                        ? { clarification: true, response: '¿A cuál producto deseas aplicar esa modificación? No cambiaré nada hasta identificarlo.' }
                        : await applySafetyIntent(session, classification, {
                            source: source === 'tablet' ? 'tablet' : 'voice',
                            clientId: effectiveClientId,
                        });
                    if (safetyResult.clarification) {
                        orderSessionManager.setState(session_id, SessionState.AWAITING_CLARIFICATION);
                        orderSessionManager.recordConversation(session_id, { intent: classification.intent, response: safetyResult.response, ambiguous: true });
                    } else {
                        orderSessionManager.recordConversation(session_id, { intent: classification.intent, response: safetyResult.response });
                    }
                    if (safetyResult.safety?.special_warning) {
                        await recordSafety('allergy_warning_presented', session, safetyResult.order, {}, safetyResult.safety, {
                            warning: safetyResult.safety.special_warning,
                        });
                    }
                    const order = safetyResult.order || await loadActiveOrder(session);
                    return jsonWithTts(res, localTtsPlayer, {
                        text: safetyResult.response,
                        ...statePayload(session, order),
                        safety_query: safetyResult.query || undefined,
                        decision: deterministicDecision(classification, {
                            previousState,
                            nextState: session.state,
                            result: safetyResult.clarification ? 'clarification_required' : safetyResult.readOnly ? 'read_only' : 'safety_updated',
                        }),
                        turn_id: currentTurn,
                        updated: safetyResult.changed !== false && !safetyResult.readOnly && !safetyResult.clarification,
                        latencyMs: Date.now() - t0,
                    });
                } catch (error) {
                    console.error(`[ASR:${session_id}] Error de seguridad Fase 5:`, error.message);
                    return res.status(error.code === 'ORDER_LOCKED' ? 409 : 400).json({
                        error: error.message,
                        code: error.code || 'SAFETY_ERROR',
                        ...statePayload(session, await loadActiveOrder(session)),
                    });
                }
            }

            if (!session.active_order_id
                && (classification.intent === Intent.CONFIRM_ORDER || orderSessionManager.isConfirmationPhrase(user_text))
                && classification.intent !== Intent.REJECT_CONFIRMATION) {
                const previousState = session.state;
                if (!session.interaction_mode) orderSessionManager.setState(session_id, SessionState.CHOOSING_INTERACTION_MODE);
                else orderSessionManager.setState(session_id, SessionState.IDLE);
                const response = session.interaction_mode
                    ? 'Todavía no hay un pedido para confirmar. Puedes pedir un producto o consultar el menú.'
                    : 'Primero elige cómo deseas realizar tu pedido: por voz, mediante la pantalla o con la atención de un mesero.';
                orderSessionManager.recordConversation(session_id, { intent: classification.intent, response });
                return jsonWithTts(res, localTtsPlayer, {
                    text: response,
                    ...statePayload(session),
                    decision: deterministicDecision(classification, { previousState, nextState: session.state, result: 'no_active_order' }),
                    turn_id: currentTurn,
                    latencyMs: Date.now() - t0,
                });
            }

            if (classification.intent === Intent.REQUEST_HUMAN_WAITER) {
                if (!waiterAssistanceService) {
                    return res.status(503).json({ error: 'Servicio de asistencia de mesero no disponible', code: 'WAITER_SERVICE_UNAVAILABLE' });
                }
                try {
                    const waiter = await waiterAssistanceService.request({
                        session_id,
                        mesa: session.mesa,
                        table_id: session.mesa,
                        visit_id: session.visit_id || null,
                        robot_id: session.robot_id || session.assignment?.robot_id || null,
                        origin: source === 'tablet' ? 'robot_screen' : 'voice',
                    });
                    const previousState = session.state;
                    orderSessionManager.setInteractionMode(session_id, InteractionMode.HUMAN_WAITER);
                    syncLifecycleMode(session, InteractionMode.HUMAN_WAITER);
                    const response = 'De acuerdo. He solicitado la atención de un mesero para esta mesa.';
                    orderSessionManager.recordConversation(session_id, { intent: classification.intent, response });
                    if (session.declared_allergies?.length || session.allergy_conflicts?.length) {
                        await recordSafety('human_waiter_requested_for_allergy', session, await loadActiveOrder(session), previousState, session.state, {
                            waiter_request_id: waiter.request?.id || null,
                            allergies: session.declared_allergies || [],
                            conflicts: session.allergy_conflicts || [],
                        });
                    }
                    return jsonWithTts(res, localTtsPlayer, {
                        text: response,
                        ...statePayload(session),
                        waiter_request: waiter.request,
                        decision: deterministicDecision(classification, {
                            previousState,
                            nextState: session.state,
                            result: waiter.created ? 'waiter_request_created' : 'waiter_request_reused',
                        }),
                        turn_id: currentTurn,
                        latencyMs: Date.now() - t0,
                    });
                } catch (error) {
                    return res.status(400).json({ error: error.message, code: 'WAITER_REQUEST_ERROR', session_id });
                }
            }

            if (orderSessionManager.isResetPhrase(user_text)) {
                if (sessionWasLocked) {
                    orderSessionManager.resetForNewOrder(session_id);
                    return jsonWithTts(res, localTtsPlayer, {
                        text: 'Claro, empezamos un pedido nuevo. ¿Qué deseas pedir?',
                        ...statePayload(session),
                        turn_id: currentTurn,
                        new_order: true,
                        latencyMs: Date.now() - t0,
                    });
                }
                await cancelDraft(session);
                return jsonWithTts(res, localTtsPlayer, {
                    text: 'Listo, cancelé todo el borrador. Empezamos un pedido nuevo cuando quieras.',
                    ...statePayload(session),
                    turn_id: currentTurn,
                    cancelled: true,
                    new_order: true,
                    latencyMs: Date.now() - t0,
                });
            }

            if (classification.intent === Intent.CANCEL_ORDER && !classification.entities.reset_all) {
                const previousState = session.state;
                if (!session.active_order_id) {
                    const response = 'No hay un pedido borrador para cancelar.';
                    return jsonWithTts(res, localTtsPlayer, {
                        text: response,
                        ...statePayload(session),
                        decision: deterministicDecision(classification, { previousState, nextState: session.state, result: 'nothing_to_cancel' }),
                        turn_id: currentTurn,
                        latencyMs: Date.now() - t0,
                    });
                }
                await cancelDraft(session);
                const response = 'Pedido cancelado. ¿Necesitas algo más?';
                return jsonWithTts(res, localTtsPlayer, {
                    text: response,
                    ...statePayload(session),
                    decision: deterministicDecision(classification, { previousState, nextState: session.state, result: 'draft_cancelled' }),
                    turn_id: currentTurn,
                    cancelled: true,
                    latencyMs: Date.now() - t0,
                });
            }

            const confirmationPhrase = classification.intent === Intent.CONFIRM_ORDER
                || classification.intent === Intent.CONFIRM_ALLERGY_ORDER
                || orderSessionManager.isConfirmPhrase(user_text, session_id)
                || (sessionWasLocked && orderSessionManager.isConfirmationPhrase(user_text));
            if (confirmationPhrase) {
                try {
                    const { order, alreadyConfirmed } = await confirmSession(session, {
                        specialOverride: classification.intent === Intent.CONFIRM_ALLERGY_ORDER,
                        alreadyLocked: true,
                    });
                    if (sessionLifecycle && !alreadyConfirmed) {
                        try { sessionLifecycle.closeAfterOrderConfirmed(session_id); }
                        catch (closeError) { console.warn('[ASR:process] session close failed:', closeError?.message); }
                    }
                    return jsonWithTts(res, localTtsPlayer, {
                        text: alreadyConfirmed
                            ? 'Tu pedido ya fue confirmado y está en cocina.'
                            : `¡Confirmado! Pedido enviado a cocina: ${orderSummary(orderItems(order))}.`,
                        ...statePayload(session, order),
                        turn_id: currentTurn,
                        order_status: 'sent_to_kitchen',
                        confirmed: true,
                        already_confirmed: alreadyConfirmed,
                        latencyMs: Date.now() - t0,
                    });
                } catch (err) {
                    orderSessionManager.rollbackConfirmation(session_id);
                    console.error(`[ASR:${session_id}] Error confirmando pedido:`, err.message);
                    const status = ['MENU_CHANGED', 'SPECIAL_CONFIRMATION_REQUIRED'].includes(err.code) ? 409 : 500;
                    return res.status(status).json({
                        error: err.code === 'SPECIAL_CONFIRMATION_REQUIRED'
                            ? `Antes de confirmar debes revisar esta advertencia: ${session.special_warning}`
                            : `No se pudo confirmar el pedido: ${err.message}`,
                        code: err.code || 'CONFIRM_ERROR',
                        validation: err.validation,
                        safety: err.safety,
                        ...statePayload(session, await loadActiveOrder(session)),
                    });
                }
            }

            if (classification.intent === Intent.REJECT_CONFIRMATION) {
                const previousState = session.state;
                const response = 'De acuerdo, todavía no lo envío. Puedes agregar, quitar o cambiar algo.';
                orderSessionManager.setState(session_id, session.draft_items?.length
                    ? SessionState.AWAITING_CONFIRMATION
                    : SessionState.IDLE);
                orderSessionManager.recordConversation(session_id, { intent: classification.intent, response });
                return jsonWithTts(res, localTtsPlayer, {
                    text: response,
                    ...statePayload(session, await loadActiveOrder(session)),
                    decision: deterministicDecision(classification, { previousState, nextState: session.state, result: 'confirmation_rejected' }),
                    turn_id: currentTurn,
                    latencyMs: Date.now() - t0,
                });
            }

            if (classification.intent === Intent.FINISH_CONVERSATION) {
                const previousState = session.state;
                if (session.state === SessionState.AWAITING_CONFIRMATION && session.active_order_id) {
                    const response = '¿Deseas conservar, confirmar o cancelar tu pedido?';
                    orderSessionManager.recordConversation(session_id, { intent: classification.intent, response });
                    return jsonWithTts(res, localTtsPlayer, {
                        text: response,
                        ...statePayload(session, await loadActiveOrder(session)),
                        decision: deterministicDecision(classification, { previousState, nextState: session.state, result: 'draft_close_confirmation_required' }),
                        turn_id: currentTurn,
                        latencyMs: Date.now() - t0,
                    });
                }
                if ([SessionState.CONFIRMED, SessionState.COMPLETED].includes(session.state)) {
                    if (session.state === SessionState.CONFIRMED) orderSessionManager.completeSession(session_id);
                    const response = 'Conversación cerrada. Tu pedido confirmado se conserva.';
                    return jsonWithTts(res, localTtsPlayer, {
                        text: response,
                        ...statePayload(session, await loadActiveOrder(session)),
                        decision: deterministicDecision(classification, { previousState, nextState: session.state, result: 'conversation_completed' }),
                        turn_id: currentTurn,
                        completed: true,
                        latencyMs: Date.now() - t0,
                    });
                }
            }

            if ([Intent.CONSULT_ORDER, Intent.CONSULT_MENU, Intent.SHOW_CATEGORY].includes(classification.intent)) {
                const order = await loadActiveOrder(session);
                const maxPrice = classification.entities && classification.entities.max_price;
                const products = classification.intent === Intent.CONSULT_ORDER
                    ? (session.draft_items || [])
                    : orderSessionManager.getMenu().filter(item => {
                        if (classification.entities.category
                            && canonicalCategory(item.categoria) !== canonicalCategory(classification.entities.category)) return false;
                        if (maxPrice != null && Number(item.precio) > Number(maxPrice)) return false;
                        return true;
                    });
                const response = classification.intent === Intent.CONSULT_ORDER
                    ? (products.length > 0 ? `Tu pedido tiene: ${orderSummary(products)}.` : 'Todavía no tienes productos en el pedido.')
                    : (() => {
                        if (products.length === 0) {
                            return maxPrice
                                ? `No encontré opciones en esta categoría por menos de ${maxPrice} soles.`
                                : 'El menú está vacío por ahora.';
                        }
                        const maxNames = 5;
                        const names = products.slice(0, maxNames).map(item => item.nombre);
                        const extra = products.length > maxNames ? ` y otras opciones que puedes ver en pantalla` : '';
                        return `En esta categoría tenemos: ${names.join(', ')}${extra}.`;
                    })();
                orderSessionManager.recordConversation(session_id, { intent: classification.intent, response });
                // Fase 6: emitir navegación de menú por WebSocket para que la
                // pantalla sincronice la categoría activa sin recargar.
                const navigation = {
                    type: 'menu_navigation',
                    session_id,
                    mesa: session.mesa,
                    action: classification.intent === Intent.SHOW_CATEGORY ? 'show_category' : 'show_menu',
                    category: classification.entities.category || null,
                    product_ids: products.map(item => item.id).filter(Boolean),
                    highlight_product_id: null,
                    filters: maxPrice != null ? { max_price: maxPrice } : {},
                    timestamp: new Date().toISOString(),
                };
                if (typeof sendToUI === 'function') {
                    sendToUI(navigation);
                }
                // Cierre correctivo Fase 6: persistir menu_state
                try {
                    orderSessionManager.updateMenuNavigation(session_id, {
                        action: navigation.action,
                        category: navigation.category,
                        product_ids: navigation.product_ids,
                        highlight_product_id: navigation.highlight_product_id,
                        filters: navigation.filters,
                    });
                } catch (e) { /* no fatal */ }
                const eventName = navigation.action === 'show_category' ? 'category_shown' : 'menu_requested';
                recordSafety(eventName, session, order, {}, {}, {
                    action: navigation.action,
                    category: navigation.category || null,
                    product_ids: (navigation.product_ids || []).slice(0, 10),
                    filters: navigation.filters || {},
                }).catch(() => {});
                return jsonWithTts(res, localTtsPlayer, {
                    text: response,
                    ...statePayload(session, order),
                    decision: deterministicDecision(classification, { previousState: session.state, nextState: session.state, result: 'read_only' }),
                    navigation,
                    turn_id: currentTurn,
                    latencyMs: Date.now() - t0,
                });
            }

            // ─── Fase 6: navegación avanzada + recomendaciones ───────────
            const readOnlyFase6Intents = new Set([
                Intent.QUERY_PRODUCT_DETAILS,
                Intent.QUERY_PRICE,
                Intent.QUERY_AVAILABILITY,
                Intent.QUERY_POPULAR_PRODUCTS,
                Intent.QUERY_AFFORDABLE_PRODUCTS,
                Intent.QUERY_RECOMMENDATION,
                Intent.COMPARE_PRODUCTS,
                Intent.RETURN_TO_MENU,
                Intent.CLEAR_MENU_FILTER,
                Intent.SEARCH_PRODUCT,
                Intent.LIST_PRODUCTS,
            ]);
            if (readOnlyFase6Intents.has(classification.intent)) {
                return await handleFase6ReadOnly(res, session, classification, {
                    sendToUI, loadActiveOrder, deterministicDecision, jsonWithTts, localTtsPlayer,
                    orderSessionManager, orderSummary, currentTurn, t0, Intent,
                    user_text, memoryService, temporaryMemoryService, pool,
                    recordSafety,
                });
            }

            if (classification.intent === Intent.REQUEST_CLARIFICATION) {
                const previousState = session.state;
                const repeatedClarification = session.last_intent === Intent.REQUEST_CLARIFICATION;
                const tooMany = (session.consecutive_ambiguities || 0) >= 1 || repeatedClarification;
                orderSessionManager.setState(session_id, SessionState.AWAITING_CLARIFICATION);

                // Cierre correctivo Fase 6: clarificaciones de referencia visible
                // ambigua usan el motivo `ambiguous_visible_reference` y listan
                // los candidatos para que el cliente aclare sin ambigüedad.
                const ent = classification.entities || {};
                let response;
                let decisionResult = tooMany ? 'fallback_offered' : 'clarification_required';
                if (ent.reason === 'ambiguous_visible_reference' && Array.isArray(ent.candidates) && ent.candidates.length > 1) {
                    const names = ent.candidates.slice(0, 3).map(c => c.nombre).join(', ');
                    const extra = ent.candidates.length > 3 ? ` u otras ${ent.candidates.length - 3} opciones` : '';
                    response = `Hay varios productos visibles: ${names}${extra}. ¿Cuál deseas agregar?`;
                    recordSafety('ambiguous_visible_reference', session, null, {}, {}, {
                        candidates: ent.candidates.map(c => ({ id: c.id, nombre: c.nombre })),
                        source: ent.reason,
                    }).catch(() => {});
                } else if (ent.reason === 'out_of_range') {
                    response = `Solo hay ${ent.available} producto${ent.available === 1 ? '' : 's'} visible${ent.available === 1 ? '' : 's'}. Pediste el número ${ent.requested}, que está fuera de rango.`;
                } else {
                    response = !tooMany
                        ? clarificationResponse({
                            text: user_text,
                            hasDraft: Boolean(session.active_order_id || session.draft_items?.length),
                            reason: ent.reason,
                        })
                        : repeatedClarification
                            ? ((session.clarification_count || 0) % 2 === 1
                                ? 'No quiero equivocarme. Puedes usar la pantalla o solicitar la atención de un mesero.'
                                : 'También puedes decir el producto y la cantidad exacta; no modificaré nada hasta entenderte.')
                            : 'No quiero equivocarme. Puedes usar la pantalla o solicitar la atención de un mesero.';
                }
                orderSessionManager.recordConversation(session_id, { intent: classification.intent, response, ambiguous: true });
                return jsonWithTts(res, localTtsPlayer, {
                    text: response,
                    ...statePayload(session, await loadActiveOrder(session)),
                    decision: deterministicDecision(classification, {
                        previousState,
                        nextState: session.state,
                        result: decisionResult,
                    }),
                    turn_id: currentTurn,
                    latencyMs: Date.now() - t0,
                });
            }

            if (orderSessionManager.isCancelPhrase(user_text) && session.state === SessionState.AWAITING_CONFIRMATION) {
                await cancelDraft(session);
                return jsonWithTts(res, localTtsPlayer, {
                    text: 'Pedido cancelado. ¿Necesitas algo más?',
                    ...statePayload(session),
                    turn_id: currentTurn,
                    cancelled: true,
                    latencyMs: Date.now() - t0,
                });
            }

            if ([Intent.ADD_PRODUCT, Intent.INCREMENT_QUANTITY, Intent.CHANGE_QUANTITY,
                Intent.REMOVE_PRODUCT, Intent.DECREMENT_QUANTITY, Intent.REPLACE_PRODUCT].includes(classification.intent)) {
                const previousState = session.state;
                if (sessionWasLocked) {
                    const order = await loadActiveOrder(session);
                    return jsonWithTts(res, localTtsPlayer, {
                        text: 'Tu pedido ya está confirmado. Pulsa “Nuevo pedido” para comenzar otro.',
                        ...statePayload(session, order),
                        decision: deterministicDecision(classification, { previousState, nextState: session.state, result: 'order_locked' }),
                        turn_id: currentTurn,
                        latencyMs: Date.now() - t0,
                    });
                }
                try {
                    const applied = await applyDeterministicDraft(session, classification, {
                        source: source === 'tablet' ? 'tablet' : 'voice',
                        clientId: effectiveClientId,
                        alreadyLocked: true,
                    });
                    if (applied.validation?.invalidos?.length > 0) {
                        const response = `No encuentro ${applied.validation.invalidos.join(', ')} en el menú actual.`;
                        return jsonWithTts(res, localTtsPlayer, {
                            text: response,
                            ...statePayload(session, applied.order),
                            validation: applied.validation,
                            decision: deterministicDecision(classification, { previousState, nextState: session.state, result: 'invalid_product' }),
                            turn_id: currentTurn,
                            latencyMs: Date.now() - t0,
                        });
                    }
                    if (applied.validation?.agotados?.length > 0) {
                        const response = `Lo siento, ${applied.validation.agotados.join(', ')} no está disponible en este momento.`;
                        return jsonWithTts(res, localTtsPlayer, {
                            text: response,
                            ...statePayload(session, applied.order),
                            validation: applied.validation,
                            decision: deterministicDecision(classification, { previousState, nextState: session.state, result: 'unavailable_product' }),
                            turn_id: currentTurn,
                            latencyMs: Date.now() - t0,
                        });
                    }
                    if (!applied.order) {
                        const response = 'Quité los productos indicados del borrador. ¿Deseas pedir algo más?';
                        return jsonWithTts(res, localTtsPlayer, {
                            text: response,
                            ...statePayload(session),
                            decision: deterministicDecision(classification, { previousState, nextState: session.state, result: 'draft_empty' }),
                            turn_id: currentTurn,
                            cancelled: true,
                            latencyMs: Date.now() - t0,
                        });
                    }
                    const summary = orderSummary(orderItems(applied.order));
                    const response = classification.entities.confirm_after_edit
                        ? `Listo, actualicé tu pedido: ${summary}. ¿Confirmamos ahora?`
                        : `Listo, ahora tengo: ${summary}. ¿Deseas agregar o cambiar algo más?`;
                    return jsonWithTts(res, localTtsPlayer, {
                        text: response,
                        ...statePayload(session, applied.order),
                        decision: deterministicDecision(classification, { previousState, nextState: session.state, result: applied.draft?.operation || 'draft_updated' }),
                        turn_id: currentTurn,
                        order_status: 'draft',
                        updated: true,
                        latencyMs: Date.now() - t0,
                    });
                } catch (error) {
                    console.error(`[ASR:${session_id}] Error guardando draft determinístico:`, error.message);
                    const status = error.code === 'ORDER_LOCKED' ? 409 : 500;
                    return jsonWithTts(res.status(status), localTtsPlayer, {
                        text: 'Hubo un error al guardar tu pedido. Intenta de nuevo.',
                        error: error.message,
                        code: 'ORDER_DRAFT_ERROR',
                    });
                }
            }

            if (sessionWasLocked) {
                const order = await loadActiveOrder(session);
                return jsonWithTts(res, localTtsPlayer, {
                    text: 'Tu pedido ya está confirmado. Pulsa “Nuevo pedido” para comenzar otro.',
                    ...statePayload(session, order),
                    turn_id: currentTurn,
                    latencyMs: Date.now() - t0,
                });
            }

            const previousState = session.state;
            orderSessionManager.setState(session_id, SessionState.PROCESSING);
            let llmResult;
            try {
                llmResult = await fase3Orchestrator.process({
                    user_text,
                    session_id,
                    turn_id: currentTurn,
                    mesa: session.mesa,
                    client_id: effectiveClientId,
                    conversation_history,
                    current_order: session.active_order_id
                        ? { id: session.active_order_id, state: previousState, items: session.draft_items || [] }
                        : {},
                });
            } catch (err) {
                restoreTurnState(session, previousState);
                console.error(`[ASR:${session_id}] LLM error:`, err.message);
                return res.status(502).json({
                    error: `Error del LLM: ${err.message}`,
                    code: 'LLM_ERROR',
                    session_id,
                    turn_id: currentTurn,
                    latencyMs: Date.now() - t0,
                });
            }

            // El LLM puede tardar más que el cierre de la atención. Nunca
            // aplicar ni reproducir una respuesta que regresó después de
            // cerrar, reemplazar o cambiar el estado de la sesión.
            const liveSessionAfterLlm = orderSessionManager.get(session_id);
            const lateResponse = !liveSessionAfterLlm
                || liveSessionAfterLlm !== session
                || isStaleSession(liveSessionAfterLlm)
                || liveSessionAfterLlm.state !== SessionState.PROCESSING;
            if (lateResponse) {
                sendToUI?.({
                    type: 'late_response_rejected',
                    session_id,
                    turn_id: currentTurn,
                    session_status: liveSessionAfterLlm?.session_status || 'missing',
                    reason: 'session_changed_during_llm',
                });
                const lateStatus = !liveSessionAfterLlm || isStaleSession(liveSessionAfterLlm) ? 410 : 409;
                return res.status(lateStatus).json({
                    error: 'La respuesta llegó después de cambiar o cerrar la atención.',
                    code: 'LATE_RESPONSE_REJECTED',
                    session_id,
                    turn_id: currentTurn,
                    ...statePayload(liveSessionAfterLlm || session),
                });
            }

            const functionCalls = llmResult.functionCalls || [];
            const allowLlmOrderMutation = classification.mutates_order === true;
            const registrar = allowLlmOrderMutation ? functionCalls.find(fc => fc.name === 'registrar_pedido') : null;
            const action = orderSessionManager.getDraftAction(user_text);
            const fallbackProducts = allowLlmOrderMutation && (action === 'remove' || action === 'change')
                ? orderSessionManager.findMenuItemsInText(user_text).map(item => ({ nombre: item.nombre, cantidad: 1 }))
                : [];
            const platos = registrar?.args?.platos || fallbackProducts;

            if (registrar || fallbackProducts.length > 0) {
                const { validos, invalidos, agotados } = orderSessionManager.validateProducts(platos);
                if (invalidos.length > 0 && action !== 'remove') {
                    restoreTurnState(session, previousState);
                    return jsonWithTts(res, localTtsPlayer, {
                        text: `No encuentro ${invalidos.join(', ')} en el menú actual. ¿Quieres ver qué tenemos disponible?`,
                        ...statePayload(session),
                        turn_id: currentTurn,
                        validation: { validos, invalidos, agotados },
                        latencyMs: Date.now() - t0,
                    });
                }
                if (agotados.length > 0) {
                    restoreTurnState(session, previousState);
                    return jsonWithTts(res, localTtsPlayer, {
                        text: `Lo siento, ${agotados.join(', ')} no está disponible en este momento.`,
                        ...statePayload(session),
                        turn_id: currentTurn,
                        validation: { validos, invalidos, agotados },
                        latencyMs: Date.now() - t0,
                    });
                }

                try {
                    const { draft, order } = await applyDraft(
                        session,
                        validos,
                        user_text,
                        { source: source === 'tablet' ? 'tablet' : 'voice', clientId: effectiveClientId, alreadyLocked: true },
                    );
                    if (!order) {
                        return jsonWithTts(res, localTtsPlayer, {
                            text: 'Quité los productos del borrador. ¿Deseas pedir algo más?',
                            ...statePayload(session),
                            turn_id: currentTurn,
                            cancelled: true,
                            latencyMs: Date.now() - t0,
                        });
                    }
                    const summary = orderSummary(orderItems(order));
                    const text = draft.action === 'remove'
                        ? `Listo, quité lo indicado. Ahora tengo: ${summary}. ¿Algo más o confirmamos?`
                        : draft.action === 'change'
                            ? `Listo, modifiqué tu pedido. Ahora tengo: ${summary}. ¿Algo más o confirmamos?`
                            : `Listo, tengo: ${summary}. ¿Te parece bien o quieres cambiar algo?`;
                    return jsonWithTts(res, localTtsPlayer, {
                        text,
                        ...statePayload(session, order),
                        turn_id: currentTurn,
                        order_status: 'draft',
                        model: llmResult.model,
                        paid: llmResult.paid,
                        latencyMs: Date.now() - t0,
                    });
                } catch (err) {
                    console.error(`[ASR:${session_id}] Error guardando draft:`, err.message);
                    const status = err.code === 'ORDER_LOCKED' ? 409 : 500;
                    return jsonWithTts(res.status(status), localTtsPlayer, {
                        text: 'Hubo un error al guardar tu pedido. Intenta de nuevo.',
                        error: err.message,
                        code: 'ORDER_DRAFT_ERROR',
                    });
                }
            }

            restoreTurnState(session, previousState);
            const order = await loadActiveOrder(session);
            return jsonWithTts(res, localTtsPlayer, {
                text: llmResult.text || '',
                ...statePayload(session, order),
                turn_id: currentTurn,
                functionCalls,
                model: llmResult.model,
                paid: llmResult.paid,
                latencyMs: Date.now() - t0,
            });
        } catch (err) {
            console.error('[ASR:FATAL] Error en /api/asr/process:', err.message);
            console.error(err.stack);
            if (err.code === 'INVALID_TABLE') {
                return res.status(400).json({ error: 'La mesa debe estar entre M1 y M12.', code: 'INVALID_TABLE' });
            }
            return res.status(500).json({ error: `Error interno: ${err.message}`, code: 'INTERNAL_ERROR' });
        }
    });

    // ── GET /api/asr/sessions — ver sesiones activas ────────────
    router.get('/sessions', adminAuth, (_req, res) => {
        const sessions = orderSessionManager.getAllSessions().map(({ session_access_token: _token, ...session }) => session);
        res.json({ data: sessions, count: sessions.length });
    });

    // ── GET /api/asr/observation-allowlist — allowlist culinaria ──
    // Devuelve la lista canónica y configurable de observaciones
    // culinarias controladas (sin sal, poca sal, salsa aparte, etc.)
    // para que el frontend consuma la misma fuente de verdad que el
    // backend. Ver `Fase5Safety.CULINARY_OBSERVATION_ALLOWLIST`.
    router.get('/observation-allowlist', (_req, res) => {
        res.json({ data: listCulinaryObservations(), count: listCulinaryObservations().length });
    });

    // ── POST /api/asr/session — crear sesión o cambiar mesa ─────
    router.post('/session', async (req, res) => {
        const { session_id, mesa, client_id, visit_id, robot_id, guest_count, present = false, listening = false, interaction_mode, mode } = req.body || {};
        if (!session_id || !mesa) return res.status(400).json({ error: 'session_id y mesa son requeridos' });
        try {
            const existingSession = orderSessionManager.get(session_id);
            if (!requireAsrSessionAccess({ sessionId: session_id, session: existingSession, req, res, sessionLifecycle })) return;
            if (rejectStaleSession(res, existingSession)) return;
            let session = orderSessionManager.getOrCreate(session_id, {
                clientId: client_id,
                visitId: visit_id,
                robotId: robot_id,
                guestCount: guest_count,
            });
            if (!session.mesa) {
                orderSessionManager.updateMesa(session_id, mesa);
            } else if (session.mesa !== normalizeMesa(mesa)) {
                session = await moveSessionTableIfNeeded({
                    session,
                    requestedMesa: normalizeMesa(mesa),
                    source: 'asr_session',
                    tableService,
                    orderSessionManager,
                    memoryService,
                });
            }
            if (guest_count !== null && guest_count !== undefined && guest_count !== '') {
                sessionLifecycle?.assertGuestCountChange?.(session_id, guest_count);
                if (tableService && session.visit_id) {
                    await tableService.setGuestCount(session.mesa, session.visit_id, guest_count);
                }
                if (sessionLifecycle?.setGuestCount) sessionLifecycle.setGuestCount(session_id, guest_count);
                else orderSessionManager.setGuestCount(session_id, guest_count);
                session = orderSessionManager.get(session_id) || session;
            }
            const requestedMode = interaction_mode || mode || (listening === true ? InteractionMode.VOICE : null);
            if (requestedMode) {
                orderSessionManager.setInteractionMode(session_id, requestedMode);
                syncLifecycleMode(session, requestedMode);
            }
            else if (!session.interaction_mode && session.state === SessionState.IDLE) orderSessionManager.setState(session_id, SessionState.CHOOSING_INTERACTION_MODE);
            const presentation_required = present === true
                ? orderSessionManager.markPresentationShown(session_id)
                : false;
            if (listening === true
                && !session.active_order_id
                && (!session.draft_items || session.draft_items.length === 0)
                && session.state !== SessionState.CONFIRMED
                && session.state !== SessionState.COMPLETED) {
                orderSessionManager.setState(session_id, SessionState.LISTENING);
            }
            let order = await loadActiveOrder(session);
            if (order && session.state === SessionState.AWAITING_CONFIRMATION) session.draft_items = orderItems(order);
            return res.json({ ...statePayload(session, order), presentation_required, updated: true });
        } catch (err) {
            const status = ['TABLE_LOCKED', 'ORDER_LOCKED'].includes(err.code) ? 409 : 400;
            return res.status(status).json({ error: err.message, code: err.code || 'SESSION_ERROR' });
        }
    });

    // ── GET /api/asr/session/:id — ver una sesión ──────────────
    router.get('/session/:id', (req, res) => {
        const session = orderSessionManager.get(req.params.id);
        if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });
        if (session.session_access_token && req.get('x-session-token') !== session.session_access_token) {
            return res.status(401).json({ error: 'Token de sesión requerido.', code: 'SESSION_ACCESS_REQUIRED' });
        }
        const { session_access_token: _token, ...safeSession } = session;
        res.json(safeSession);
    });

    // ── GET /api/asr/menu — ver menú actual ────────────────────
    router.get('/menu', (_req, res) => {
        res.json({ data: orderSessionManager.getMenu() });
    });

    // ── POST /api/asr/draft — voz y táctil comparten este draft ──
    router.post('/draft', async (req, res) => {
        const { session_id, client_id, mesa, items = [], text = '', source = 'tablet', interaction_mode } = req.body || {};
        if (!session_id || !Array.isArray(items)) {
            return res.status(400).json({ error: 'session_id e items son requeridos' });
        }
        try {
            const existingSession = orderSessionManager.get(session_id);
            if (!requireAsrSessionAccess({ sessionId: session_id, session: existingSession, req, res, sessionLifecycle })) return;
            if (rejectStaleSession(res, existingSession)) return;
            let session = orderSessionManager.getOrCreate(session_id, { clientId: client_id });
            if (interaction_mode
                && [SessionState.CONFIRMED, SessionState.COMPLETED].includes(session.state)
                && session.interaction_mode !== interaction_mode) {
                return res.status(409).json({ error: 'El modo no puede cambiar después de confirmar el pedido', code: 'ORDER_LOCKED', ...statePayload(session) });
            }
            if (!session.interaction_mode) {
                orderSessionManager.setInteractionMode(session_id, interaction_mode || (source === 'tablet' ? InteractionMode.SCREEN : InteractionMode.VOICE));
            }
            if (mesa && !session.mesa) {
                orderSessionManager.updateMesa(session_id, mesa);
            } else if (mesa && session.mesa !== normalizeMesa(mesa)) {
                session = await moveSessionTableIfNeeded({
                    session,
                    requestedMesa: normalizeMesa(mesa),
                    source,
                    tableService,
                    orderSessionManager,
                    memoryService,
                });
            }
            if (!session.mesa) return res.status(400).json({ error: 'mesa es obligatoria', code: 'MISSING_TABLE' });
            if ([SessionState.CONFIRMED, SessionState.COMPLETED].includes(session.state)) {
                return res.status(409).json({ error: 'El pedido ya fue confirmado', code: 'ORDER_LOCKED', ...statePayload(session) });
            }

            const { draft, order } = await applyDraft(session, items, text || 'Agrega productos', { source, clientId: client_id });
            if (!order) {
                return jsonWithSpeech(res, localTtsPlayer, { text: 'Pedido cancelado.', ...statePayload(session), cancelled: true });
            }
            return jsonWithSpeech(res, localTtsPlayer, {
                text: `Pedido actualizado: ${orderSummary(orderItems(order))}.`,
                ...statePayload(session, order),
                order_status: 'draft',
                updated: true,
            });
        } catch (err) {
            const status = err.code === 'ORDER_LOCKED' || err.code === 'TABLE_LOCKED' ? 409 : 400;
            return res.status(status).json({ error: err.message, code: err.code || 'DRAFT_ERROR' });
        }
    });

    router.post('/item-safety', async (req, res) => {
        const { session_id, item_id, operation, modifier_id, note, scope = 'all' } = req.body || {};
        if (!session_id || !item_id || !operation) return res.status(400).json({ error: 'session_id, item_id y operation son requeridos' });
        const session = orderSessionManager.get(session_id);
        if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });
        if (!requireAsrSessionAccess({ sessionId: session_id, session, req, res, sessionLifecycle })) return;
        if (rejectStaleSession(res, session)) return;
        if ([SessionState.CONFIRMED, SessionState.COMPLETED].includes(session.state)) {
            return res.status(409).json({ error: 'El pedido ya fue confirmado', code: 'ORDER_LOCKED', ...statePayload(session) });
        }
        const target = { item_id };
        const safeScope = ['all', 'one', 'first', 'second'].includes(scope) ? scope : 'all';
        const classification = operation === 'add_modifier'
            ? { intent: Intent.ADD_ITEM_MODIFIER, confidence: 1, mutates_order: true, requires_clarification: false, source: 'tablet', entities: { target, modifier: { id: modifier_id }, scope: safeScope } }
            : operation === 'remove_modifier'
                ? { intent: Intent.REMOVE_ITEM_MODIFIER, confidence: 1, mutates_order: true, requires_clarification: false, source: 'tablet', entities: { target, modifier: modifier_id ? { id: modifier_id } : null, scope: safeScope } }
                : operation === 'add_note'
                    ? { intent: Intent.ADD_ITEM_NOTE, confidence: 1, mutates_order: true, requires_clarification: false, source: 'tablet', entities: { target, note, scope: safeScope } }
                    : operation === 'remove_note'
                        ? { intent: Intent.REMOVE_ITEM_NOTE, confidence: 1, mutates_order: true, requires_clarification: false, source: 'tablet', entities: { target, scope: safeScope } }
                        : null;
        if (!classification) return res.status(400).json({ error: 'operation no soportada' });
        try {
            const result = await applySafetyIntent(session, classification, { source: 'tablet', clientId: session.client_id });
            if (result.clarification || result.changed === false) return res.status(409).json({ error: result.response, ...statePayload(session, result.order) });
            const order = result.order || await loadActiveOrder(session);
            return jsonWithSpeech(res, localTtsPlayer, { text: result.response, ...statePayload(session, order), updated: true });
        } catch (error) {
            return res.status(400).json({ error: error.message, code: error.code || 'ITEM_SAFETY_ERROR', ...statePayload(session) });
        }
    });

    // ── POST /api/asr/confirm — confirmar pedido desde botón ────
    router.post('/confirm', async (req, res) => {
        const { session_id } = req.body || {};
        if (!session_id) return res.status(400).json({ error: 'session_id required' });
        const session = orderSessionManager.get(session_id);
        if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });
        if (!requireAsrSessionAccess({ sessionId: session_id, session, req, res, sessionLifecycle })) return;
        if (isStaleSession(session)
            && !(session.state === SessionState.COMPLETED && session.close_reason === 'order_confirmed')) {
            if (rejectStaleSession(res, session)) return;
        }
        if (![SessionState.AWAITING_CONFIRMATION, SessionState.CONFIRMED, SessionState.COMPLETED].includes(session.state)) {
            return res.status(409).json({ error: `No se puede confirmar en estado ${session.state}` });
        }
        const orderId = session.active_order_id;
        if (!orderId) return res.status(409).json({ error: 'No hay pedido activo' });

        try {
            const { order, alreadyConfirmed } = await confirmSession(session);
            if (!alreadyConfirmed && temporaryMemoryService && session.profile_id) {
                try {
                    await temporaryMemoryService.recordLastConfirmedOrder({ sessionId: session_id, profileId: session.profile_id, order });
                } catch (memoryError) {
                    console.warn('[ASR:confirm] memoria de último pedido no guardada:', memoryError.message);
                }
            }
            // Fase 7: al confirmar, cerrar la sesión automáticamente
            // (el pedido permanece en Cocina y en el historial).
            if (sessionLifecycle && !alreadyConfirmed) {
                try { sessionLifecycle.closeAfterOrderConfirmed(session_id); }
                catch (e) { console.warn('[ASR:confirm] session close failed:', e?.message); }
            }
            return jsonWithTts(res, localTtsPlayer, {
                text: alreadyConfirmed ? 'Tu pedido ya fue confirmado y está en cocina.' : '¡Confirmado! Pedido enviado a cocina. Esperando la siguiente atención.',
                ...statePayload(session, order),
                turn_id: session.turn_id || 0,
                order_status: 'sent_to_kitchen',
                confirmed: true,
                already_confirmed: alreadyConfirmed,
            });
        } catch (err) {
            orderSessionManager.rollbackConfirmation(session_id);
            console.error(`[ASR:${session_id}] Error confirmando:`, err.message);
            const status = err.code === 'SPECIAL_CONFIRMATION_REQUIRED' ? 409 : 500;
            return res.status(status).json({ error: `Error: ${err.message}`, code: err.code, safety: err.safety, ...statePayload(session, await loadActiveOrder(session)) });
        }
    });

    // ── POST /api/asr/cancel — cancelar pedido desde botón ──────
    router.post('/cancel', async (req, res) => {
        const { session_id } = req.body || {};
        if (!session_id) return res.status(400).json({ error: 'session_id required' });
        const session = orderSessionManager.get(session_id);
        if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });
        if (!requireAsrSessionAccess({ sessionId: session_id, session, req, res, sessionLifecycle })) return;
        if (rejectStaleSession(res, session)) return;
        if ([SessionState.CONFIRMED, SessionState.COMPLETED].includes(session.state)) {
            return res.status(409).json({ error: 'El pedido confirmado no se puede cancelar desde esta sesión', code: 'ORDER_LOCKED', ...statePayload(session, await loadActiveOrder(session)) });
        }
        await cancelDraftSafely(session);
        return jsonWithTts(res, localTtsPlayer, {
            text: 'Pedido cancelado.',
            ...statePayload(session),
            turn_id: session.turn_id || 0,
            cancelled: true,
        });
    });

    // ── POST /api/asr/complete — cerrar voz sin borrar el pedido ──
    router.post('/complete', async (req, res) => {
        const { session_id } = req.body || {};
        if (!session_id) return res.status(400).json({ error: 'session_id required' });
        const session = orderSessionManager.get(session_id);
        if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });
        if (!requireAsrSessionAccess({ sessionId: session_id, session, req, res, sessionLifecycle })) return;
        try {
            orderSessionManager.completeSession(session_id);
            const order = await loadActiveOrder(session);
            return res.json({ ...statePayload(session, order), completed: true });
        } catch (err) {
            return res.status(409).json({ error: err.message, code: 'COMPLETE_ERROR', ...statePayload(session) });
        }
    });

    // ── POST /api/asr/new — iniciar otro pedido sin tocar el confirmado
    router.post('/new', async (req, res) => {
        const { session_id } = req.body || {};
        if (!session_id) return res.status(400).json({ error: 'session_id required' });
        const session = orderSessionManager.get(session_id);
        if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });
        if (!requireAsrSessionAccess({ sessionId: session_id, session, req, res, sessionLifecycle })) return;
        try {
            if (session.state === SessionState.AWAITING_CONFIRMATION) await cancelDraftSafely(session);
            orderSessionManager.resetForNewOrder(session_id);
            return jsonWithSpeech(res, localTtsPlayer, { text: 'Pedido nuevo iniciado.', ...statePayload(session), new_order: true });
        } catch (err) {
            return res.status(409).json({ error: err.message, code: 'NEW_ORDER_ERROR' });
        }
    });

    // ── GET /api/asr/active-order/:sessionId — estado actual ───
    router.get('/active-order/:sessionId', async (req, res) => {
        const session = orderSessionManager.get(req.params.sessionId);
        if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });
        if (!requireAsrSessionAccess({ sessionId: req.params.sessionId, session, req, res, sessionLifecycle })) return;
        const order = await loadActiveOrder(session);
        res.json({ ...statePayload(session, order), menu_source: orderSessionManager.getMenuSource() });
    });

    return router;
}
