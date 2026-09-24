/**
 * Clasificador determinístico de intenciones críticas del pedido.
 *
 * Este módulo se ejecuta antes del LLM. Solo devuelve una mutación cuando la
 * operación y sus entidades son suficientemente claras; el LLM queda para
 * conversación social y lenguaje que no afecta el draft.
 */

import { classifySafetyIntent } from './Fase5IntentRules.mjs';

export const InteractionMode = Object.freeze({
    VOICE: 'voice',
    SCREEN: 'screen',
    HUMAN_WAITER: 'human_waiter',
});

export const Intent = Object.freeze({
    SELECT_INTERACTION_MODE: 'select_interaction_mode',
    CHANGE_INTERACTION_MODE: 'change_interaction_mode',
    REQUEST_HUMAN_WAITER: 'request_human_waiter',
    CONSULT_MENU: 'consult_menu',
    SHOW_CATEGORY: 'show_category',
    ADD_PRODUCT: 'add_product',
    CHANGE_QUANTITY: 'change_quantity',
    INCREMENT_QUANTITY: 'increment_quantity',
    REMOVE_PRODUCT: 'remove_product',
    DECREMENT_QUANTITY: 'decrement_quantity',
    REPLACE_PRODUCT: 'replace_product',
    CONSULT_ORDER: 'consult_order',
    CONFIRM_ORDER: 'confirm_order',
    REJECT_CONFIRMATION: 'reject_confirmation',
    CANCEL_ORDER: 'cancel_order',
    FINISH_CONVERSATION: 'finish_conversation',
    CHANGE_TABLE: 'change_table',
    SET_PARTY_SIZE: 'set_party_size',
    START_ADDITIONAL_ORDER: 'start_additional_order',
    IDENTIFY_CUSTOMER: 'identify_customer',
    REQUEST_CLARIFICATION: 'request_clarification',
    SOCIAL_CONVERSATION: 'social_conversation',
    REPEAT_PRODUCT: 'repeat_product',
    ADD_ITEM_MODIFIER: 'add_item_modifier',
    REMOVE_ITEM_MODIFIER: 'remove_item_modifier',
    REPLACE_ITEM_MODIFIER: 'replace_item_modifier',
    ADD_ITEM_NOTE: 'add_item_note',
    REMOVE_ITEM_NOTE: 'remove_item_note',
    REPLACE_ITEM_NOTE: 'replace_item_note',
    DECLARE_ALLERGY: 'declare_allergy',
    REMOVE_ALLERGY: 'remove_allergy',
    DECLARE_DIETARY_RESTRICTION: 'declare_dietary_restriction',
    QUERY_INGREDIENTS: 'query_ingredients',
    QUERY_ALLERGENS: 'query_allergens',
    QUERY_DIETARY_OPTIONS: 'query_dietary_options',
    QUERY_MODIFIER_OPTIONS: 'query_modifier_options',
    QUERY_PRODUCT_DETAILS: 'query_product_details',
    QUERY_PRICE: 'query_price',
    QUERY_AVAILABILITY: 'query_availability',
    QUERY_POPULAR_PRODUCTS: 'query_popular_products',
    QUERY_AFFORDABLE_PRODUCTS: 'query_affordable_products',
    QUERY_RECOMMENDATION: 'query_recommendation',
    COMPARE_PRODUCTS: 'compare_products',
    SELECT_VISIBLE_PRODUCT: 'select_visible_product',
    RETURN_TO_MENU: 'return_to_menu',
    CLEAR_MENU_FILTER: 'clear_menu_filter',
    SEARCH_PRODUCT: 'search_product',
    LIST_PRODUCTS: 'list_products',
    CONFIRM_ALLERGY_ORDER: 'confirm_allergy_order',
    REJECT_ALLERGY_ORDER: 'reject_allergy_order',
    CLARIFY_TARGET_ITEM: 'clarify_target_item',
});

const NUMBER_WORDS = new Map([
    ['un', 1], ['una', 1], ['uno', 1], ['primer', 1], ['primero', 1],
    ['dos', 2], ['segundo', 2],
    ['tres', 3], ['cuatro', 4], ['cinco', 5], ['seis', 6], ['siete', 7],
    ['ocho', 8], ['nueve', 9], ['diez', 10], ['once', 11], ['doce', 12],
]);

const CATEGORY_ALIASES = new Map([
    ['plato', 'platos'], ['platos', 'platos'], ['comida', 'platos'], ['comidas', 'platos'],
    ['bebida', 'bebidas'], ['bebidas', 'bebidas'], ['postre', 'postres'], ['postres', 'postres'],
]);

const CONFIRMATION_PHRASES = [
    'confirmo', 'confirmo mi pedido', 'confirma mi pedido', 'si confirma', 'correcto',
    'dale', 'esta bien', 'eso seria todo', 'ya esta', 'nada mas', 'envialo',
    'puedes mandarlo a cocina', 'mandalo a cocina', 'mandalo cocina', 'termine',
    'eso es todo', 'si ese es mi pedido', 'si eso quiero', 'procede',
];

const NEGATIVE_CONFIRMATION_PHRASES = [
    'todavia no confirmes', 'no lo envies', 'espera', 'aun falta algo',
    'no confirmes todavia', 'todavia no', 'aun no', 'no confirmes', 'quiero cambiar algo',
    'eso no esta bien', 'no esta bien', 'eso no es todo',
];

const HUMAN_WAITER_PHRASES = [
    'mesero', 'mesera', 'persona', 'ayuda humana', 'atencion de un mesero',
    'que venga alguien', 'llama a un mesero', 'necesito ayuda humana',
];

const VOICE_PHRASES = [
    'por voz', 'quiero hablar', 'pedir hablando', 'modo voz', 'pedir por voz',
    'hablando', 'continuar hablando',
];

const SCREEN_PHRASES = [
    'por pantalla', 'con la tableta', 'tocar la pantalla',
    'usar pantalla', 'modo pantalla', 'cambiar a pantalla', 'pantalla', 'tableta',
];

const ADDITIONAL_ORDER_PHRASES = [
    'quiero pedir algo mas',
    'deseo agregar otra bebida',
    'otro pedido para esta mesa',
    'quiero anadir un postre',
    'necesitamos pedir algo adicional',
    'quiero pedir algo adicional',
    'agregar pedido adicional',
];

const CONSULT_ORDER_RE = /\b(?:repite|repiteme|repitame|resumen|que he pedido|como va mi pedido|cual es mi pedido|mi pedido)\b/u;
const CONSULT_MENU_RE = /\b(?:menu|carta|que tienen|que hay|opciones)\b/u;
const RESET_RE = /\b(?:cancela todo|nuevo pedido)\b/u;
const TABLE_RE = /\bmesa\s*(?:numero\s*)?(\d{1,2})\b/u;
const SOCIAL_RE = /^(?:hola|buenos dias|buenas tardes|buenas noches|gracias|muchas gracias|jaja|que alegria|como estas)$/u;

export function normalizeIntentText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[¿?¡!.,;:()[\]{}"']/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function includesPhrase(text, phrase) {
    return text === phrase || text.includes(` ${phrase} `) || text.startsWith(`${phrase} `) || text.endsWith(` ${phrase}`);
}

function hasAnyPhrase(text, phrases) {
    return phrases.some(phrase => includesPhrase(text, phrase));
}

function normalizeProductText(value) {
    return normalizeIntentText(value)
        .replace(/\btallarin\b/g, 'tallarines')
        .replace(/\btallarines verdes\b/g, 'tallarines verdes')
        .replace(/\bsuspiro de la limena\b/g, 'suspiro a la limena')
        .replace(/\bsuspiro limeno\b/g, 'suspiro a la limena');
}

function productTerms(item) {
    const fullName = normalizeProductText(item.nombre);
    const words = fullName.split(' ').filter(Boolean);
    const terms = new Set([fullName]);
    if (words.length > 1 && words[0].length >= 4) terms.add(words[0]);
    if (fullName === 'tallarines verdes') terms.add('tallarines');
    if (fullName === 'suspiro a la limena') terms.add('suspiro');
    return [...terms].sort((a, b) => b.length - a.length);
}

function menuItemMatchesFragment(item, fragment) {
    const text = normalizeProductText(fragment);
    return productTerms(item).some(term => text.includes(term));
}

function uniqueProducts(items) {
    const seen = new Set();
    return items.filter(item => {
        const key = normalizeProductText(item.nombre);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function findProducts(fragment, menu = []) {
    const ordered = [...menu]
        .sort((a, b) => normalizeProductText(b.nombre).length - normalizeProductText(a.nombre).length)
    const text = normalizeProductText(fragment);
    const exactNames = ordered.filter(item => text.includes(normalizeProductText(item.nombre)));
    if (exactNames.length > 0) return uniqueProducts(exactNames);
    return uniqueProducts(ordered.filter(item => menuItemMatchesFragment(item, fragment)));
}

function findDraftProducts(fragment, draftItems = []) {
    const text = normalizeProductText(fragment);
    const ordered = [...draftItems].sort((a, b) => normalizeProductText(b.nombre).length - normalizeProductText(a.nombre).length);
    const exactNames = ordered.filter(item => text.includes(normalizeProductText(item.nombre)));
    if (exactNames.length > 0) return uniqueProducts(exactNames);
    return uniqueProducts(ordered.filter(item => menuItemMatchesFragment(item, fragment)));
}

function categoryForText(text) {
    for (const [alias, category] of CATEGORY_ALIASES) {
        if (new RegExp(`\\b${alias}\\b`, 'u').test(text)) return category;
    }
    return null;
}

function draftByCategory(category, draftItems, menu) {
    if (!category) return [];
    return uniqueProducts(draftItems.filter(item => {
        if (item.categoria && CATEGORY_ALIASES.get(normalizeIntentText(item.categoria)) === category) return true;
        const menuItem = menu.find(candidate => normalizeProductText(candidate.nombre) === normalizeProductText(item.nombre));
        return CATEGORY_ALIASES.get(normalizeIntentText(menuItem?.categoria)) === category;
    }));
}

function parseQuantity(text) {
    const number = text.match(/\b(\d{1,2})\b/u);
    if (number) return Number(number[1]);
    for (const [word, value] of NUMBER_WORDS) {
        if (new RegExp(`\\b${word}\\b`, 'u').test(text)) return value;
    }
    return null;
}

function parsePartySize(text) {
    const token = '(\\d{1,3}|[a-z]+)';
    const grouped = text.match(new RegExp(`\\b${token}\\s+(?:adultos?|personas?|comensales?)\\s+(?:y|e|,)\\s+${token}\\s+(?:niñ(?:o|os|a|as)|nin(?:o|os|a|as)|adultos?|personas?|comensales?)\\b`, 'u'));
    if (grouped) {
        const first = /^\\d+$/u.test(grouped[1]) ? Number(grouped[1]) : NUMBER_WORDS.get(grouped[1]);
        const second = /^\\d+$/u.test(grouped[2]) ? Number(grouped[2]) : NUMBER_WORDS.get(grouped[2]);
        if (Number.isInteger(first) && Number.isInteger(second)) return first + second;
    }
    const solo = text.match(new RegExp(`^(?:somos\\s+)?solo\\s+${token}$`, 'u'));
    if (solo) {
        const value = /^\\d+$/u.test(solo[1]) ? Number(solo[1]) : NUMBER_WORDS.get(solo[1]);
        if (Number.isInteger(value)) return value;
    }
    const direct = text.match(/\b(?:somos|estamos|hay|son|seremos|venimos)\s+(?:un total de\s+)?(\d{1,3}|[a-z]+)\b/u)
        || text.match(/\b(\d{1,3}|[a-z]+)\s+(?:personas?|comensales?)\b/u)
        || text.match(/\b(?:grupo de|mesa para)\s+(\d{1,3}|[a-z]+)\b/u);
    if (!direct) return null;
    const raw = direct[1];
    if (/^\d+$/u.test(raw)) return Number(raw);
    return NUMBER_WORDS.get(raw) || null;
}

function productEntities(text, menu, draftItems) {
    return findProducts(text, menu).map(item => ({ ...item, cantidad: 1 }));
}

function result(intent, {
    confidence = 0.98,
    mutatesOrder = false,
    requiresClarification = false,
    entities = {},
    source = 'deterministic_rule',
} = {}) {
    return {
        intent,
        confidence,
        mutates_order: mutatesOrder,
        requires_clarification: requiresClarification,
        entities,
        source,
    };
}

function modeFromText(text) {
    if (hasAnyPhrase(text, HUMAN_WAITER_PHRASES)) return InteractionMode.HUMAN_WAITER;
    if (hasAnyPhrase(text, VOICE_PHRASES)) return InteractionMode.VOICE;
    if (hasAnyPhrase(text, SCREEN_PHRASES)) return InteractionMode.SCREEN;
    return null;
}

function isConfirmationPhrase(text) {
    return hasAnyPhrase(text, CONFIRMATION_PHRASES);
}

function isNegativeConfirmation(text) {
    return hasAnyPhrase(text, NEGATIVE_CONFIRMATION_PHRASES)
        || /\b(?:no|todavia|aun)\b.*\b(?:confirm|envia|mand|falta)\w*/u.test(text)
        || /\bno\b.*\b(?:mejor|cambia|cambiar|reemplaza|sustituye)\b/u.test(text);
}

function isRepeatProduct(text) {
    return ( /\b(?:solo quiero|eso quiero|eso es lo que quiero|eso es|si)\b/u.test(text)
        || /\b(?:ya lo anotaste|ya lo tienes|ya esta anotado|ya esta registrado)\b/u.test(text) )
        && !/\b(?:agrega|anade|suma|otro|mas|tambien)\b/u.test(text);
}

function clarification(entities = {}, confidence = 0.35) {
    return result(Intent.REQUEST_CLARIFICATION, {
        confidence,
        requiresClarification: true,
        entities,
    });
}

/**
 * @param {object} input
 * @param {string} input.text
 * @param {Array<object>} input.menu
 * @param {Array<object>} input.draftItems
 * @param {string} [input.state]
 * @param {string|null} [input.interactionMode]
 * @param {string|null} [input.lastProduct]
 */
export function classifyIntent({ text, menu = [], draftItems = [], state = 'idle', interactionMode = null, lastProduct = null } = {}) {
    const normalized = normalizeIntentText(text);
    if (!normalized) return clarification({}, 0.05);

    const mode = modeFromText(normalized);
    if (mode === InteractionMode.HUMAN_WAITER) {
        return result(Intent.REQUEST_HUMAN_WAITER, { entities: { mode } });
    }
    if (mode) {
        const intent = interactionMode ? Intent.CHANGE_INTERACTION_MODE : Intent.SELECT_INTERACTION_MODE;
        return result(intent, { entities: { mode }, mutatesOrder: false });
    }
    if (/\b(?:cambiar modo|cambia el modo|ya no quiero usar|prefiero hacerlo)\b/u.test(normalized)) {
        return result(Intent.CHANGE_INTERACTION_MODE, {
            confidence: 0.75,
            requiresClarification: true,
            entities: { available_modes: Object.values(InteractionMode) },
        });
    }

    const humanRequest = hasAnyPhrase(normalized, HUMAN_WAITER_PHRASES);
    if (humanRequest) return result(Intent.REQUEST_HUMAN_WAITER, { entities: { mode: InteractionMode.HUMAN_WAITER } });

    const table = normalized.match(TABLE_RE);
    if (table) return result(Intent.CHANGE_TABLE, { entities: { mesa: `M${Number(table[1])}` } });

    if (hasAnyPhrase(normalized, ADDITIONAL_ORDER_PHRASES)) {
        return result(Intent.START_ADDITIONAL_ORDER, {
            mutatesOrder: true,
            entities: { additional_order: true },
        });
    }

    const partySize = parsePartySize(normalized);
    if (partySize !== null) {
        return result(Intent.SET_PARTY_SIZE, {
            confidence: 0.99,
            mutatesOrder: false,
            entities: { guest_count: partySize },
        });
    }

    const safetyClassification = classifySafetyIntent({
        text: normalized,
        menu,
        draftItems,
        lastProduct,
    });
    if (safetyClassification) return safetyClassification;

    if (RESET_RE.test(normalized)) {
        return result(Intent.CANCEL_ORDER, { mutatesOrder: true, entities: { reset_all: true } });
    }

    if (/\b(?:cancelar pedido|cancela el pedido|cancelar|cancela)\b/u.test(normalized)) {
        return result(Intent.CANCEL_ORDER, { mutatesOrder: true, entities: { reset_all: false } });
    }

    const hasExplicitEdit = /\b(?:quita|elimina|retira|cambia|reemplaza|sustituye|agrega|anade|añade|suma)\b/u.test(normalized);
    const negativeConfirmation = isNegativeConfirmation(normalized);
    if (negativeConfirmation) {
        if (hasExplicitEdit) {
            // The edit branch below owns the mutation; this guard only prevents
            // a leading "sí" from reaching confirmation.
        } else {
            return result(Intent.REJECT_CONFIRMATION, { entities: { reason: 'negative_confirmation' } });
        }
    }

    if (isConfirmationPhrase(normalized) && !negativeConfirmation && !hasExplicitEdit) {
        return result(Intent.CONFIRM_ORDER, {
            mutatesOrder: ['awaiting_confirmation', 'confirmed', 'completed'].includes(state),
        });
    }

    if (CONSULT_ORDER_RE.test(normalized) && !/\b(?:quita|elimina|cambia|agrega)\b/u.test(normalized)) {
        return result(Intent.CONSULT_ORDER, { entities: { read_only: true } });
    }

    // ─── Fase 6: navegación conversacional del menú ──────────────────
    // Bloque separado del path "agregar producto" para garantizar que las
    // consultas puras no mutan el carrito. RETURN_TO_MENU y CLEAR_MENU_FILTER
    // se evalúan ANTES de CONSULT_MENU para que "Vuelve al menú" no se
    // confunda con "consultar el menú".
    if (/\b(?:vuelve|regresa|volver|regresar)\b.*\b(?:menu|menú|categorias|categorías|inicio)\b/u.test(normalized)) {
        return result(Intent.RETURN_TO_MENU, { entities: { read_only: true } });
    }
    if (/\b(?:quita|limpiar|quitar|reset)\b.*\b(?:filtros|filtro)\b/u.test(normalized)) {
        return result(Intent.CLEAR_MENU_FILTER, { entities: { read_only: true } });
    }

    if (CONSULT_MENU_RE.test(normalized) && !/\b(?:quiero|dame|agrega|anade|añade)\b/u.test(normalized)) {
        const category = categoryForText(normalized);
        return result(category ? Intent.SHOW_CATEGORY : Intent.CONSULT_MENU, {
            entities: category ? { category } : { read_only: true },
        });
    }
    if (/\b(?:compara|comparar|cual es mas barato|cu[aá]l cuesta menos)\b/u.test(normalized)) {
        return result(Intent.COMPARE_PRODUCTS, { entities: { read_only: true } });
    }
    if (/\b(?:que|qué)\b.*\b(?:piden normalmente|se pide mas|venden mas|mas vendido|mas pedidos)\b/u.test(normalized)
        || /\b(?:cual|cu[aá]l)\b.*\b(?:es el mas pedido|el mas vendido|el favorito)\b/u.test(normalized)) {
        return result(Intent.QUERY_POPULAR_PRODUCTS, { entities: { read_only: true } });
    }
    // "Muéstrame X" / "Ver X" con categoría y/o filtro de precio
    if (/\b(?:muestra|mostrar|muestrame|mu[eé]strame|ensename|ens[eé]ñame|ver|enseñame)\b/u.test(normalized)
        && !/\b(?:agrega|anade|añade|quiero|dame)\b/u.test(normalized)) {
        const category = categoryForText(normalized);
        const priceRe = normalized.match(/\b(?:menos de|hasta|m[aá]ximo)\s+(?:de\s+)?(\d+)\b/u);
        const priceWords = { diez: 10, veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50 };
        let maxPrice = null;
        if (priceRe) maxPrice = Number(priceRe[1]);
        else {
            for (const [w, v] of Object.entries(priceWords)) {
                if (new RegExp(`\\b(?:menos de|hasta|m[aá]ximo)\\s+${w}\\b`, 'u').test(normalized)) {
                    maxPrice = v; break;
                }
            }
        }
        if (category) {
            return result(Intent.SHOW_CATEGORY, {
                entities: { category, max_price: maxPrice, read_only: true },
            });
        }
        if (maxPrice !== null) {
            return result(Intent.QUERY_AFFORDABLE_PRODUCTS, { entities: { max_price: maxPrice, read_only: true } });
        }
        return result(Intent.LIST_PRODUCTS, { entities: { read_only: true } });
    }
    if (/\b(?:barato|barata|economico|econ[oó]mica|m[eé]nos de|hasta)\b/u.test(normalized)) {
        return result(Intent.QUERY_AFFORDABLE_PRODUCTS, { entities: { read_only: true } });
    }
    if (/\b(?:algo|opcion|opciones|recomiendas?|recomendacion|recomendaci[oó]n|sugerencia|sugieres)\b/u.test(normalized)) {
        return result(Intent.QUERY_RECOMMENDATION, { entities: { read_only: true } });
    }
    if (/\b(?:cu[aá]nto cuesta|cu[aá]nto vale|cu[aá]nto es|precio de|precio del)\b/u.test(normalized)) {
        return result(Intent.QUERY_PRICE, { entities: { read_only: true } });
    }
    if (/\b(?:esta disponible|hay|hay stock|tienen|tienen stock|disponible|disponibles)\b/u.test(normalized)
        && !/\b(?:agrega|anade|añade|quiero|dame)\b/u.test(normalized)) {
        return result(Intent.QUERY_AVAILABILITY, { entities: { read_only: true } });
    }
    // "El primero / el segundo / el tercero" cuando hay lista visible
    if (/\b(?:el primero|la primera|el segundo|la segunda|el tercero|la tercera|ese de ahi|esa de ahi)\b/u.test(normalized)) {
        return result(Intent.SELECT_VISIBLE_PRODUCT, { entities: { read_only: true, position: normalized } });
    }
    // Búsqueda textual libre: "busca ...", "tienen ..."
    if (/\b(?:busca|buscar|tienen|tienen algo de|hay algo de)\b/u.test(normalized)
        && !/\b(?:agrega|anade|añade|quiero|dame)\b/u.test(normalized)) {
        return result(Intent.SEARCH_PRODUCT, { entities: { query: normalized, read_only: true } });
    }

    const replaceMatch = normalized.match(/\b(?:cambia|cambiar|reemplaza|reemplazar|sustituye|sustituir)\b(.+?)\bpor\b(.+)/u);
    if (replaceMatch) {
        const sourceProducts = findDraftProducts(replaceMatch[1], draftItems);
        const targetProducts = findProducts(replaceMatch[2], menu);
        let sourceProduct = sourceProducts.length === 1 ? sourceProducts[0] : null;
        if (!sourceProduct && /\b(?:ese|esa)\b/u.test(replaceMatch[1])) {
            const contextual = draftItems.filter(item => normalizeProductText(item.nombre) === normalizeProductText(lastProduct));
            if (contextual.length === 1) sourceProduct = contextual[0];
        }
        if (!sourceProduct && /\b(?:el otro|la otra)\b/u.test(replaceMatch[1]) && draftItems.length === 2 && lastProduct) {
            const contextual = draftItems.filter(item => normalizeProductText(item.nombre) !== normalizeProductText(lastProduct));
            if (contextual.length === 1) sourceProduct = contextual[0];
        }
        if (!sourceProduct || targetProducts.length !== 1) {
            return clarification({ source_candidates: sourceProducts, target_candidates: targetProducts }, 0.4);
        }
        return result(Intent.REPLACE_PRODUCT, {
            mutatesOrder: true,
            entities: { source_product: sourceProduct, target_product: targetProducts[0] },
        });
    }

    const isRemoval = /\b(?:quita|quitar|elimina|eliminar|retira|retirar|no quiero)\b/u.test(normalized);
    if (isRemoval && normalized.includes('no quiero otro')) {
        return result(Intent.REJECT_CONFIRMATION, { entities: { reason: 'not_another_product' } });
    }
    if (isRemoval) {
        const category = categoryForText(normalized);
        let products = productEntities(normalized, menu, draftItems);
        if (products.length === 0 && category) products = draftByCategory(category, draftItems, menu);
        if (products.length === 0 && /\b(?:ese|esa)\b/u.test(normalized)) {
            const contextual = draftItems.filter(item => normalizeProductText(item.nombre) === normalizeProductText(lastProduct));
            if (contextual.length === 1) products = contextual.map(item => ({ ...item, cantidad: 1 }));
        }
        if (products.length === 0 && /\b(?:el otro|la otra)\b/u.test(normalized) && draftItems.length === 2 && lastProduct) {
            const contextual = draftItems.filter(item => normalizeProductText(item.nombre) !== normalizeProductText(lastProduct));
            if (contextual.length === 1) products = contextual.map(item => ({ ...item, cantidad: 1 }));
        }
        const unitRemoval = /\b(?:uno|una|un|unidad|unidades)\b/u.test(normalized);
        if (unitRemoval && products.length === 0 && draftItems.length === 1) {
            products = [{ ...draftItems[0], cantidad: 1 }];
        }
        if (products.length === 0 || (unitRemoval && products.length > 1)) {
            return clarification({ candidates: products.length > 1 ? products : draftItems }, 0.4);
        }
        return result(unitRemoval ? Intent.DECREMENT_QUANTITY : Intent.REMOVE_PRODUCT, {
            mutatesOrder: true,
            entities: {
                products,
                confirm_after_edit: /\bpero antes\b/u.test(normalized),
                quantity: 1,
            },
        });
    }

    if (/\b(?:finaliza|finalizar|termina la conversacion|cerrar la conversacion)\b/u.test(normalized)) {
        return result(Intent.FINISH_CONVERSATION, { mutatesOrder: false });
    }

    if (isNegativeConfirmation(normalized)) {
        return result(Intent.REJECT_CONFIRMATION, { entities: { reason: 'negative_confirmation' } });
    }

    if (normalized.startsWith('me llamo ') || normalized.startsWith('soy ')) {
        return result(Intent.IDENTIFY_CUSTOMER, { entities: { name: normalized.replace(/^me llamo |^soy /u, '').trim() } });
    }

    const products = productEntities(normalized, menu, draftItems);
    const quantity = parseQuantity(normalized);
    const explicitIncrement = /\b(?:agrega|agregar|anade|añade|suma|tambien quiero|también quiero|otro|otra|uno mas|una mas|más)\b/u.test(normalized);
    const explicitTotal = quantity !== null && /\b(?:quiero|dame|pon|deja|dejalo|déjalo|que sean|seran|seran|cantidad|solo quiero)\b/u.test(normalized);
    const explicitProductList = /\b(?:y|tambien|también|ademas|además)\b/u.test(normalized);

    if (products.length > 1 && !explicitProductList) {
        return clarification({ product_candidates: products.map(product => product.nombre) }, 0.4);
    }

    // En confirmación, una frase que reconoce que el producto ya está
    // anotado es una repetición/consulta, aunque también contenga "dame"
    // o una cantidad. No debe pasar por el parser de cantidades y duplicar.
    if (products.length > 0 && state === 'awaiting_confirmation' && isRepeatProduct(normalized)) {
        return result(Intent.REPEAT_PRODUCT, { entities: { products, read_only: true } });
    }

    if (products.length === 0 && quantity !== null && /\b(?:deja(?:lo)?|dejalo|pon(?:lo)?|que sean)\b/u.test(normalized)) {
        const contextual = lastProduct
            ? draftItems.filter(item => normalizeProductText(item.nombre) === normalizeProductText(lastProduct))
            : draftItems.length === 1 ? draftItems : [];
        if (contextual.length === 1) {
            return result(Intent.CHANGE_QUANTITY, {
                mutatesOrder: true,
                entities: { products: contextual.map(item => ({ ...item, cantidad: 1 })), quantity, quantity_mode: 'total' },
            });
        }
        return clarification({ candidates: draftItems, quantity }, 0.4);
    }

    if (products.length > 0 && explicitTotal && !explicitIncrement) {
        return result(Intent.CHANGE_QUANTITY, {
            mutatesOrder: true,
            entities: { products, quantity, quantity_mode: 'total' },
        });
    }
    if (products.length > 0 && explicitIncrement && (normalized.includes('otro') || normalized.includes('mas') || normalized.includes('más'))) {
        return result(Intent.INCREMENT_QUANTITY, {
            mutatesOrder: true,
            entities: { products, quantity: quantity || 1, quantity_mode: 'increment' },
        });
    }
    if (products.length > 0 && explicitIncrement) {
        return result(Intent.ADD_PRODUCT, {
            mutatesOrder: true,
            entities: { products, quantity: quantity || 1, quantity_mode: 'increment' },
        });
    }

    if (products.length > 0) {
        const sameAsDraft = products.every(product => draftItems.some(item => normalizeProductText(item.nombre) === normalizeProductText(product.nombre)));
        if (sameAsDraft && state === 'awaiting_confirmation') {
            return result(Intent.REPEAT_PRODUCT, { entities: { products, read_only: true } });
        }
        return result(Intent.ADD_PRODUCT, {
            mutatesOrder: true,
            entities: { products, quantity: quantity || 1, quantity_mode: 'increment' },
        });
    }

    if (SOCIAL_RE.test(normalized)) return result(Intent.SOCIAL_CONVERSATION, { entities: { read_only: true } });

    return clarification({ utterance: text }, 0.25);
}
