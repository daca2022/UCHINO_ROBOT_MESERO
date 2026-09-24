/**
 * MenuNavigationService — Fase 6.
 *
 * Capa de navegación conversacional del menú y recomendaciones controladas.
 * Opera sobre el menú real cargado por OrderSessionManager.getMenu()
 * (PostgreSQL) y nunca inventa productos, precios, ingredientes ni
 * disponibilidad. Las alergias y restricciones declaradas en la sesión
 * tienen prioridad sobre cualquier otra fuente de recomendación.
 */

import { normalizeSafetyText } from './Fase5Safety.mjs';

const CATEGORIAS_CANONICAS = ['plato', 'bebida', 'postre'];
const CATEGORIA_ALIASES = {
    plato: 'plato', platos: 'plato', comida: 'plato', comidas: 'plato', principal: 'plato', principales: 'plato', plato_principal: 'plato',
    bebida: 'bebida', bebidas: 'bebida', trago: 'bebida', tragos: 'bebida', drink: 'bebida', drinks: 'bebida',
    postre: 'postre', postres: 'postre', dulce: 'postre', dulces: 'postre', dessert: 'postre',
};

const ESTADOS_VENTA_VALIDOS = new Set([
    'confirmed', 'sent_to_kitchen', 'preparing', 'ready', 'delivered',
    'entregado', 'preparando', 'listo', 'enviado_a_cocina', 'confirmado',
]);

function canonCategoria(value) {
    const norm = normalizeSafetyText(value);
    if (!norm) return null;
    return CATEGORIA_ALIASES[norm] || (CATEGORIAS_CANONICAS.includes(norm) ? norm : null);
}

function toNumberOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function toBool(value, fallback = false) {
    if (value === true || value === 'true' || value === 1 || value === '1') return true;
    if (value === false || value === 'false' || value === 0 || value === '0') return false;
    return fallback;
}

function safeText(value) {
    return String(value || '').trim();
}

function itemMatchesText(item, query) {
    const q = normalizeSafetyText(query);
    if (!q) return true;
    const haystack = normalizeSafetyText([
        item.nombre,
        item.descripcion,
        item.categoria,
        ...(Array.isArray(item.ingredientes) ? item.ingredientes : []),
        ...(Array.isArray(item.alergenos) ? item.alergenos : []),
    ].join(' '));
    return haystack.includes(q);
}

function hasRestriction(item, key) {
    if (!item || typeof item !== 'object') return false;
    const r = item.restricciones || {};
    return Boolean(r[key]);
}

export class MenuNavigationService {
    constructor({ menu, memoryService = null, fetchSales = null, period = '30d', logger = null } = {}) {
        this._menu = Array.isArray(menu) ? menu : [];
        this._memoryService = memoryService;
        this._fetchSales = typeof fetchSales === 'function' ? fetchSales : null;
        this._defaultPeriod = String(period || '30d');
        this._logger = logger;
        // Caché de ventas por período: clave = `${period}:${fromEpoch}`
        this._salesCache = new Map();
    }

    setMenu(menu = []) {
        this._menu = Array.isArray(menu) ? menu : [];
    }

    listCategories() {
        const counts = new Map();
        for (const item of this._menu) {
            if (!item || item.disponible === false) continue;
            const cat = canonCategoria(item.categoria) || 'plato';
            counts.set(cat, (counts.get(cat) || 0) + 1);
        }
        return Array.from(counts.entries())
            .map(([id, count]) => ({ id, label: id, count }))
            .sort((a, b) => a.id.localeCompare(b.id));
    }

    /**
     * Vista filtrada del menú. Ningún filtro aplicado al carrito.
     * Devuelve productos con `informacion_completa` y `restricciones` ya
     * normalizados (Fase 5) y ordenados por `orden_aparicion` (Fase 6).
     */
    filterMenu({ category = null, maxPrice = null, vegetarian = null, vegan = null, allergen = null, available = null, query = null, includeUnavailable = false } = {}) {
        const targetCat = category ? canonCategoria(category) : null;
        const max = toNumberOrNull(maxPrice);
        const allergenKey = allergen ? normalizeSafetyText(allergen) : null;
        const wantVeg = vegetarian === true || vegetarian === 'true';
        const wantVegan = vegan === true || vegan === 'true';
        const wantAvail = available === true || available === 'true';
        const q = query ? safeText(query) : null;
        return this._menu
            .filter(item => {
                if (!item) return false;
                if (!includeUnavailable && item.disponible === false) return false;
                if (wantAvail && item.disponible === false) return false;
                if (targetCat) {
                    const c = canonCategoria(item.categoria);
                    if (c !== targetCat) return false;
                }
                if (max !== null && Number(item.precio) > max) return false;
                if (wantVeg && !hasRestriction(item, 'vegetariano')) return false;
                if (wantVegan && !hasRestriction(item, 'vegano')) return false;
                if (allergenKey) {
                    const list = (item.alergenos || []).map(normalizeSafetyText);
                    if (list.includes(allergenKey)) return false;
                }
                if (q && !itemMatchesText(item, q)) return false;
                return true;
            })
            .sort((a, b) => {
                const oa = Number.isFinite(Number(a.orden_aparicion)) ? Number(a.orden_aparicion) : 100;
                const ob = Number.isFinite(Number(b.orden_aparicion)) ? Number(b.orden_aparicion) : 100;
                if (oa !== ob) return oa - ob;
                return normalizeSafetyText(a.nombre).localeCompare(normalizeSafetyText(b.nombre));
            });
    }

    searchProducts(query, { limit = 8 } = {}) {
        if (!query) return [];
        return this.filterMenu({ query }).slice(0, Math.max(1, limit));
    }

    findProductByName(text) {
        if (!text) return null;
        const norm = normalizeSafetyText(text);
        let best = null;
        for (const item of this._menu) {
            if (!item) continue;
            const name = normalizeSafetyText(item.nombre);
            if (name === norm) return item;
            if (name.includes(norm) || norm.includes(name)) {
                if (!best) best = item;
            }
        }
        return best;
    }

    /**
     * Devuelve el id canónico y nombre de una categoría a partir de un texto
     * libre del usuario ("bebidas", "postre", "lo que tengan para tomar", etc.).
     * Devuelve `null` si no se puede resolver.
     */
    resolveCategory(text) {
        if (!text) return null;
        const norm = normalizeSafetyText(text);
        if (!norm) return null;
        // Match directo contra alias canónicos.
        if (CATEGORIA_ALIASES[norm]) return CATEGORIA_ALIASES[norm];
        // Heurística de palabra clave cuando la frase tiene varias palabras.
        for (const [alias, canon] of Object.entries(CATEGORIA_ALIASES)) {
            if (norm.includes(alias)) return canon;
        }
        return null;
    }

    /**
     * Extrae un rango de precios del texto del usuario: "menos de veinte",
     * "entre diez y treinta", "menos de 20 soles". Devuelve { max, min, exact }.
     */
    extractPriceFilter(text) {
        if (!text) return { max: null, min: null, exact: null };
        const norm = normalizeSafetyText(text);
        const numbers = [];
        const wordMap = { diez: 10, veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, cien: 100 };
        // Numéricos arabígos
        const arabic = norm.match(/\b\d+(?:\.\d+)?\b/gu) || [];
        for (const a of arabic) numbers.push(Number(a));
        // Numéricos en palabras (mismo orden en que aparecen)
        const tokens = norm.split(/\s+/u);
        for (const t of tokens) if (wordMap[t] != null) numbers.push(wordMap[t]);
        const maxKeywords = /\b(menos de|hasta|barato|economico|economica|barata)\b/u.test(norm);
        const minKeywords = /\b(mas de|desde|sobre)\b/u.test(norm);
        const rangeKeywords = /\b(entre|y)\b/u.test(norm);
        let max = null;
        let min = null;
        let exact = null;
        if (rangeKeywords && numbers.length >= 2) {
            min = Math.min(numbers[0], numbers[1]);
            max = Math.max(numbers[0], numbers[1]);
        } else if (maxKeywords && numbers.length >= 1) {
            max = numbers[0];
        } else if (minKeywords && numbers.length >= 1) {
            min = numbers[0];
        } else if (numbers.length === 1 && /\b(soles|sol|precio|cuesta|vale)\b/u.test(norm)) {
            exact = numbers[0];
        }
        return { max, min, exact };
    }

    /**
     * Recomendaciones controladas. Devuelve hasta `limit` productos reales
     * con `recommendation_reason` y `constraints_checked` explícitos.
     * Nunca inventa productos. Si la sesión declara alergias, excluye los
     * conflictivos y deja constancia en `recommendation_rejected_by_allergy`.
     */
    async recommend({ category = null, maxPrice = null, period = null, limit = 3, declaredAllergies = [], dietaryRestrictions = [] } = {}) {
        const allergies = (declaredAllergies || []).map(normalizeSafetyText).filter(Boolean);
        const restrictions = (dietaryRestrictions || []).map(safeText);
        const targetCat = category ? canonCategoria(category) : null;
        const max = toNumberOrNull(maxPrice);
        const usePeriod = period || this._defaultPeriod;
        const recommendations = [];
        const reasons = [];
        const seen = new Set();
        const safetyRejectedIncomplete = new Set();
        const rejectIncompleteSafety = (item) => {
            if (!this._hasIncompleteSafetyInfo(item, allergies)) return false;
            if (item?.id) safetyRejectedIncomplete.add(String(item.id));
            return true;
        };
        const popularity = await this._loadPopularity(usePeriod);

        // 1) Recomendaciones marcadas como `destacado` en Admin.
        for (const item of this._menu) {
            if (recommendations.length >= limit) break;
            if (!item || item.disponible === false) continue;
            if (rejectIncompleteSafety(item)) continue;
            if (item.destacado !== true) continue;
            if (item.recomendable === false) continue;
            if (targetCat && canonCategoria(item.categoria) !== targetCat) continue;
            if (max !== null && Number(item.precio) > max) continue;
            if (this._conflictsWithAllergies(item, allergies)) continue;
            if (this._violatesRestrictions(item, restrictions)) continue;
            if (seen.has(item.id)) continue;
            seen.add(item.id);
            recommendations.push(item);
            reasons.push({
                product_id: item.id,
                reason: 'Producto destacado por el equipo',
                source: 'admin_flag',
                period: null,
                constraints_checked: this._constraintsChecked(item, allergies, restrictions),
            });
        }

        // 2) Recomendaciones por popularidad real (últimos N días).
        const popularityById = new Map(popularity.map(entry => [entry.product_id, entry]));
        for (const entry of popularity) {
            if (recommendations.length >= limit) break;
            const item = this._menu.find(candidate => candidate.id === entry.product_id);
            if (!item || item.disponible === false) continue;
            if (rejectIncompleteSafety(item)) continue;
            if (item.recomendable === false) continue;
            if (targetCat && canonCategoria(item.categoria) !== targetCat) continue;
            if (max !== null && Number(item.precio) > max) continue;
            if (this._conflictsWithAllergies(item, allergies)) continue;
            if (this._violatesRestrictions(item, restrictions)) continue;
            if (seen.has(item.id)) continue;
            seen.add(item.id);
            recommendations.push(item);
            reasons.push({
                product_id: item.id,
                reason: this._popularityReason(entry, usePeriod),
                source: 'sales_analytics',
                period: usePeriod,
                sales_count: entry.sales_count,
                constraints_checked: this._constraintsChecked(item, allergies, restrictions),
            });
        }

        // 3) Completar con productos disponibles si aún hay espacio y se
        //    pidió una categoría específica.
        if (targetCat && recommendations.length < limit) {
            for (const item of this._menu) {
                if (recommendations.length >= limit) break;
                if (!item || item.disponible === false) continue;
                if (rejectIncompleteSafety(item)) continue;
                if (item.recomendable === false) continue;
                if (canonCategoria(item.categoria) !== targetCat) continue;
                if (max !== null && Number(item.precio) > max) continue;
                if (this._conflictsWithAllergies(item, allergies)) continue;
                if (this._violatesRestrictions(item, restrictions)) continue;
                if (seen.has(item.id)) continue;
                seen.add(item.id);
                recommendations.push(item);
                reasons.push({
                    product_id: item.id,
                    reason: 'Disponible en la categoría solicitada',
                    source: 'category_match',
                    period: null,
                    constraints_checked: this._constraintsChecked(item, allergies, restrictions),
                });
            }
        }

        return {
            data: recommendations.map(item => this._publicItem(item)),
            reasons,
            safety_rejected_incomplete: [...safetyRejectedIncomplete],
            period: usePeriod,
            sample_size: popularity.reduce((sum, e) => sum + Number(e.sales_count || 0), 0),
            small_sample: popularity.length > 0 && popularity[0].sales_count < 3,
        };
    }

    /**
     * Devuelve los productos más pedidos en el período, contando solo
     * estados de venta válidos (confirmed, sent_to_kitchen, ...). Si no
     * hay datos, devuelve [] y `period` describe la búsqueda.
     */
    async popular({ period = null, limit = 3, category = null, declaredAllergies = [], dietaryRestrictions = [] } = {}) {
        const usePeriod = period || this._defaultPeriod;
        const popularity = await this._loadPopularity(usePeriod);
        const allergies = (declaredAllergies || []).map(normalizeSafetyText).filter(Boolean);
        const restrictions = (dietaryRestrictions || []).map(safeText);
        const targetCat = category ? canonCategoria(category) : null;
        const result = [];
        for (const entry of popularity) {
            const item = this._menu.find(candidate => candidate.id === entry.product_id);
            if (!item) continue;
            if (this._hasIncompleteSafetyInfo(item, allergies)) continue;
            if (targetCat && canonCategoria(item.categoria) !== targetCat) continue;
            if (this._conflictsWithAllergies(item, allergies)) continue;
            if (this._violatesRestrictions(item, restrictions)) continue;
            result.push({ ...this._publicItem(item), sales_count: entry.sales_count, period: usePeriod });
            if (result.length >= limit) break;
        }
        return {
            data: result,
            period: usePeriod,
            sample_size: popularity.reduce((sum, e) => sum + Number(e.sales_count || 0), 0),
            small_sample: popularity.length > 0 && popularity[0].sales_count < 3,
        };
    }

    /**
     * Comparación de 2-3 productos por precio (u otros atributos).
     * Devuelve los productos con un resumen `comparison` (cheapest, etc.).
     */
    compareProducts(productIds = []) {
        if (!Array.isArray(productIds) || productIds.length < 2) {
            return { data: [], error: 'Se requieren al menos 2 IDs para comparar' };
        }
        const items = productIds
            .map(id => this._menu.find(candidate => candidate.id === id))
            .filter(Boolean);
        if (items.length < 2) return { data: [], error: 'No se encontraron productos comparables' };
        const sortedByPrice = [...items].sort((a, b) => Number(a.precio) - Number(b.precio));
        return {
            data: items.map(item => this._publicItem(item)),
            comparison: {
                cheapest: sortedByPrice[0] ? { id: sortedByPrice[0].id, nombre: sortedByPrice[0].nombre, precio: sortedByPrice[0].precio } : null,
                most_expensive: sortedByPrice[sortedByPrice.length - 1] ? {
                    id: sortedByPrice[sortedByPrice.length - 1].id,
                    nombre: sortedByPrice[sortedByPrice.length - 1].nombre,
                    precio: sortedByPrice[sortedByPrice.length - 1].precio,
                } : null,
            },
        };
    }

    /**
     * Devuelve productos compatibles con una restricción dietética declarada
     * por el usuario (vegetariano, vegano, sin_gluten, sin_lactosa).
     */
    dietaryOptions({ restriction, limit = 10 } = {}) {
        const key = normalizeSafetyText(restriction);
        if (!key) return { data: [], restriction: null };
        const allowedKeys = new Set(['vegetariano', 'vegano', 'sin_gluten', 'sin_lactosa']);
        if (!allowedKeys.has(key)) return { data: [], restriction: key, error: 'Restricción no soportada' };
        const items = this._menu.filter(item => {
            if (!item || item.disponible === false) return false;
            if (key === 'sin_gluten') return hasRestriction(item, 'sin_gluten_configurado');
            if (key === 'sin_lactosa') return hasRestriction(item, 'sin_lactosa_configurado');
            return hasRestriction(item, key);
        });
        return { data: items.slice(0, limit).map(item => this._publicItem(item)), restriction: key };
    }

    /**
     * Resuelve referencias visibles del estilo "el primero", "el segundo",
     * "el de veinticinco soles", "el postre que mostraste", "ese de ahí".
     * Devuelve un producto único si la referencia es inequívoca, o un objeto
     * `{ ambiguous: true, candidates: [...] }` si hay más de un candidato.
     * Devuelve `null` si no hay candidatos.
     */
    resolveVisibleReference(text, visibleProducts = []) {
        if (!text || !Array.isArray(visibleProducts) || visibleProducts.length === 0) return null;
        const norm = normalizeSafetyText(text);
        if (!norm) return null;
        // 1) Posición ordinal directa
        const ordinalMap = { primero: 0, primera: 0, segundo: 1, segunda: 1, tercero: 2, tercera: 2 };
        for (const [key, idx] of Object.entries(ordinalMap)) {
            if (norm === key || norm.includes(`el ${key}`) || norm.includes(`la ${key}`)) {
                if (idx < visibleProducts.length) return { product: visibleProducts[idx] };
                return { out_of_range: true, max: visibleProducts.length, requested: idx + 1 };
            }
        }
        // 2) Por precio exacto (arabigo o palabra)
        const priceTarget = this._extractPriceNumber(norm);
        if (priceTarget !== null) {
            const matches = visibleProducts.filter(item => Number(item.precio) === priceTarget);
            if (matches.length === 1) return { product: matches[0] };
            if (matches.length > 1) return { ambiguous: true, candidates: matches };
        }
        // 3) Por nombre parcial: el texto contiene un token del nombre
        //    (ej. "el lomo" matchea "Lomo Saltado" y "Lomo Especial" → ambiguo).
        const refTokens = norm.split(/\s+/u).filter(t => t.length >= 3 && !['con', 'para', 'del', 'las', 'los', 'una', 'uno', 'ese', 'esa', 'eso'].includes(t));
        const byName = visibleProducts.filter(item => {
            const n = normalizeSafetyText(item.nombre);
            if (!n) return false;
            if (norm.includes(n) || n.includes(norm)) return true;
            const nameTokens = n.split(/\s+/u);
            return refTokens.some(token => nameTokens.some(nt => nt.includes(token) || token.includes(nt)));
        });
        if (byName.length === 1) return { product: byName[0] };
        if (byName.length > 1) return { ambiguous: true, candidates: byName };
        return null;
    }

    /**
     * Resuelve referencias a la lista visible de la sesión.
     * Acepta:
     *   - "esa", "ese", "eso" (cuando hay un solo highlight o un solo visible)
     *   - "el primero", "la primera", "el segundo", "la segunda", "el tercero", "la tercera"
     *   - "el postre/bebida/plato que mostraste" (resuelve contra el highlighted_product_id
     *     o el último visible de la categoría)
     *   - "el de veintidós soles" (precio exacto contra la lista visible)
     *   - "el lomo", "la chicha" (nombre parcial)
     *
     * Devuelve:
     *   { product }                 → exactamente 1 producto (mutación segura)
     *   { ambiguous, candidates }  → varios, no mutar
     *   { not_found }               → ninguno
     *   { out_of_range, max, requested } → posición fuera de rango
     *
     * Esta función es la que usa el cierre correctivo de Fase 6 para
     * resolver "Agrega esa", "Agrega el primero", etc., contra el
     * menu_state persistido de la sesión.
     */
    resolveSessionReference(text, menuState) {
        if (!text || !menuState) return { not_found: true };
        const norm = normalizeSafetyText(text);
        if (!norm) return { not_found: true };
        const visibleIds = Array.isArray(menuState.visible_product_ids) ? menuState.visible_product_ids : [];
        const visible = visibleIds
            .map(id => this._menu.find(candidate => String(candidate.id) === String(id)))
            .filter(Boolean);
        if (visible.length === 0) return { not_found: true };

        // 1) Pronombres "esa/ese/eso" con highlight activo y unívoco
        const usesDeictic = /\b(?:esa|ese|eso|esa de ahi|ese de ahi)\b/u.test(norm);
        const highlightedId = menuState.highlighted_product_id;
        if (usesDeictic && highlightedId) {
            const highlighted = this._menu.find(candidate => String(candidate.id) === String(highlightedId));
            if (highlighted) {
                // Si está en la lista visible, devuélvelo. Si no, devuélvelo igual
                // porque el highlight implica una vista previa.
                return { product: highlighted };
            }
        }
        if (usesDeictic && !highlightedId && visible.length === 1) {
            return { product: visible[0] };
        }
        if (usesDeictic && !highlightedId && visible.length > 1) {
            return { ambiguous: true, candidates: visible };
        }

        // 2) Ordinal directo
        const ordinalMap = { primero: 0, primera: 0, segundo: 1, segunda: 1, tercero: 2, tercera: 2 };
        for (const [key, idx] of Object.entries(ordinalMap)) {
            const re = new RegExp(`\\b(?:el|la|lo)?\\s*${key}\\b`, 'u');
            if (re.test(norm) || norm === key) {
                if (idx < visible.length) return { product: visible[idx] };
                return { out_of_range: true, max: visible.length, requested: idx + 1 };
            }
        }

        // 3) "el postre/bebida/plato que mostraste/que viste"
        const showedMatch = norm.match(/\b(?:el|la|lo)\s+(plato|bebida|postre|postres|bebidas|platos)\s+que\s+(?:mostraste|mostro|viste|ensenaste|ensenaste)\b/u);
        if (showedMatch) {
            const targetCategory = showedMatch[1].toLowerCase();
            const canonical = ['plato', 'platos', 'comida'].includes(targetCategory) ? 'plato'
                : ['bebida', 'bebidas'].includes(targetCategory) ? 'bebida'
                : ['postre', 'postres'].includes(targetCategory) ? 'postre'
                : null;
            if (canonical) {
                const inCategory = visible.filter(item => {
                    const c = (item.categoria || '').toLowerCase();
                    return c === canonical || c === targetCategory;
                });
                // Si hay un highlight activo Y pertenece a la categoría, gana.
                if (highlightedId && inCategory.length > 0) {
                    const highlighted = inCategory.find(item => String(item.id) === String(highlightedId));
                    if (highlighted) return { product: highlighted };
                }
                if (inCategory.length === 1) return { product: inCategory[0] };
                if (inCategory.length > 1) return { ambiguous: true, candidates: inCategory };
            }
        }

        // 4) Precio exacto
        const priceTarget = this._extractPriceNumber(norm);
        if (priceTarget !== null) {
            const matches = visible.filter(item => Number(item.precio) === priceTarget);
            if (matches.length === 1) return { product: matches[0] };
            if (matches.length > 1) return { ambiguous: true, candidates: matches };
        }

        // 5) Nombre parcial
        const refTokens = norm.split(/\s+/u).filter(t => t.length >= 3
            && !['con', 'para', 'del', 'las', 'los', 'una', 'uno', 'ese', 'esa', 'eso', 'que', 'mostraste', 'viste'].includes(t));
        const byName = visible.filter(item => {
            const n = normalizeSafetyText(item.nombre);
            if (!n) return false;
            if (norm.includes(n) || n.includes(norm)) return true;
            const nameTokens = n.split(/\s+/u);
            return refTokens.some(token => nameTokens.some(nt => nt.includes(token) || token.includes(nt)));
        });
        if (byName.length === 1) return { product: byName[0] };
        if (byName.length > 1) return { ambiguous: true, candidates: byName };
        return { not_found: true };
    }

    /**
     * Extrae el primer número (arabigo o palabra) del texto normalizado.
     * Devuelve `null` si no hay ninguno. Usado por `resolveVisibleReference`
     * para soportar referencias como "el de veintidós soles".
     */
    _extractPriceNumber(norm) {
        if (!norm) return null;
        const arabic = norm.match(/\b(\d+(?:\.\d+)?)\b/);
        if (arabic) return Number(arabic[1]);
        const wordMap = {
            cinco: 5, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
            veinte: 20, veintiuno: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25,
            treinta: 30, cuarenta: 40, cincuenta: 50, cien: 100,
        };
        for (const token of norm.split(/\s+/u)) {
            if (wordMap[token] != null) return wordMap[token];
        }
        return null;
    }

    /**
     * Carga popularidad real (pedidos válidos) usando el callback
     * configurable o un fallback que cuenta los items del menú
     * agregados (memoria local). Devuelve `[]` si no hay fuente de datos.
     */
    async _loadPopularity(period) {
        const cacheKey = `pop:${period}`;
        if (this._salesCache.has(cacheKey)) return this._salesCache.get(cacheKey);
        let popularity = [];
        try {
            if (this._fetchSales) {
                popularity = await this._fetchSales(period);
            } else if (this._memoryService && typeof this._memoryService.obtenerPopularidad === 'function') {
                popularity = await this._memoryService.obtenerPopularidad(period);
            }
        } catch (err) {
            if (this._logger && typeof this._logger.warn === 'function') {
                this._logger.warn('MenuNavigationService: fallo al cargar popularidad', err);
            }
            popularity = [];
        }
        const safe = Array.isArray(popularity)
            ? popularity
                .filter(entry => entry && entry.product_id && Number.isFinite(Number(entry.sales_count)))
                .map(entry => ({ product_id: String(entry.product_id), sales_count: Number(entry.sales_count) }))
                .sort((a, b) => b.sales_count - a.sales_count)
            : [];
        this._salesCache.set(cacheKey, safe);
        return safe;
    }

    _publicItem(item) {
        if (!item) return null;
        return {
            id: item.id,
            nombre: item.nombre,
            descripcion: item.descripcion || '',
            precio: Number(item.precio),
            categoria: canonCategoria(item.categoria) || 'plato',
            disponible: item.disponible !== false,
            ingredientes: item.ingredientes || [],
            alergenos: item.alergenos || [],
            restricciones: item.restricciones || {},
            permite_modificadores: item.permite_modificadores !== false,
            modificadores_disponibles: item.modificadores_disponibles || [],
            informacion_completa: Boolean(item.informacion_completa),
            advertencia_contaminacion: item.advertencia_contaminacion || '',
            destacado: item.destacado === true,
            recomendable: item.recomendable !== false,
            orden_aparicion: Number.isFinite(Number(item.orden_aparicion)) ? Number(item.orden_aparicion) : 100,
            etiqueta_promocional: item.etiqueta_promocional || null,
        };
    }

    _conflictsWithAllergies(item, allergies) {
        if (!item || !Array.isArray(allergies) || allergies.length === 0) return false;
        const itemAllergens = (item.alergenos || []).map(normalizeSafetyText);
        return allergies.some(a => itemAllergens.includes(a));
    }

    _hasIncompleteSafetyInfo(item, allergies) {
        return Array.isArray(allergies) && allergies.length > 0 && item?.informacion_completa !== true;
    }

    _violatesRestrictions(item, restrictions) {
        if (!item || !Array.isArray(restrictions) || restrictions.length === 0) return false;
        const itemIngr = (item.ingredientes || []).map(normalizeSafetyText);
        const restr = item.restricciones || {};
        return restrictions.some(raw => {
            const norm = normalizeSafetyText(raw);
            if (!norm) return false;
            if (norm === 'vegetariano' && !restr.vegetariano) return true;
            if (norm === 'vegano' && !restr.vegano) return true;
            if ((norm === 'sin_gluten' || norm === 'sin gluten') && !restr.sin_gluten_configurado) return true;
            if ((norm === 'sin_lactosa' || norm === 'sin lactosa') && !restr.sin_lactosa_configurado) return true;
            return itemIngr.some(ingredient => ingredient.includes(norm) || norm.includes(ingredient));
        });
    }

    _constraintsChecked(item, allergies, restrictions) {
        const out = ['available'];
        if (item.disponible !== false) out.push('in_stock');
        if (allergies.length > 0) out.push('no_declared_allergen_conflict');
        if (restrictions.length > 0) out.push('compatible_with_restriction');
        if (item.informacion_completa) out.push('safety_info_complete');
        return out;
    }

    _popularityReason(entry, period) {
        const count = entry.sales_count;
        return count > 0
            ? `Uno de los productos más pedidos en los últimos ${period}`
            : `Sin datos de ventas en los últimos ${period}`;
    }
}

export { CATEGORIAS_CANONICAS, canonCategoria, ESTADOS_VENTA_VALIDOS };
