import { randomUUID } from 'node:crypto';
import { sanitizeForSpeech } from './SpeechTextSanitizer.mjs';

export function normalizeSafetyText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[¿?¡!.,;:()[\]{}"']/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function textList(value) {
    if (!Array.isArray(value)) return [];
    return value.map(item => String(item || '').trim()).filter(Boolean);
}

function bool(value, fallback = false) {
    return value === undefined || value === null ? fallback : Boolean(value);
}

export function normalizeModifier(value = {}) {
    return {
        id: value.id || value.modificador_id || value.modifier_id || null,
        nombre: String(value.nombre || value.name || value.descripcion || '').trim(),
        tipo: String(value.tipo || value.type || 'note').trim(),
        ingrediente: value.ingrediente ? String(value.ingrediente).trim() : null,
        valor: value.valor === undefined ? null : String(value.valor),
        precio_adicional: Number(value.precio_adicional ?? value.price ?? 0) || 0,
        disponible: value.disponible !== false,
        requiere_confirmacion_especial: bool(value.requiere_confirmacion_especial, false),
    };
}

export function normalizeSafetyMenuItem(item = {}) {
    const restrictions = item.restricciones && typeof item.restricciones === 'object'
        ? item.restricciones
        : {};
    return {
        ...item,
        ingredientes: textList(item.ingredientes),
        alergenos: textList(item.alergenos),
        restricciones: {
            vegetariano: bool(restrictions.vegetariano),
            vegano: bool(restrictions.vegano),
            sin_gluten_configurado: bool(restrictions.sin_gluten_configurado),
            sin_lactosa_configurado: bool(restrictions.sin_lactosa_configurado),
        },
        permite_modificadores: item.permite_modificadores !== false,
        modificadores_disponibles: Array.isArray(item.modificadores_disponibles)
            ? item.modificadores_disponibles.map(normalizeModifier).filter(modifier => modifier.nombre || modifier.id)
            : [],
        informacion_completa: bool(item.informacion_completa, false),
        advertencia_contaminacion: String(item.advertencia_contaminacion || '').trim(),
    };
}

function sameText(a, b) {
    return normalizeSafetyText(a) === normalizeSafetyText(b);
}

function itemName(item) {
    return String(item?.nombre || '').trim();
}

function modifierKey(modifier) {
    return normalizeSafetyText(modifier?.id || modifier?.nombre || modifier?.descripcion || '');
}

export function itemVariantKey(item = {}) {
    const modifiers = (item.modificaciones || item.modifiers || [])
        .map(modifierKey)
        .sort()
        .join('|');
    const notes = (item.observaciones || item.notes || [])
        .map(normalizeSafetyText)
        .sort()
        .join('|');
    return `${normalizeSafetyText(itemName(item))}::${modifiers}::${notes}`;
}

function copyItem(item) {
    return {
        ...item,
        cantidad: Math.max(1, Number(item.cantidad) || 1),
        modificaciones: Array.isArray(item.modificaciones)
            ? item.modificaciones.map(modifier => ({ ...modifier }))
            : [],
        observaciones: Array.isArray(item.observaciones) ? [...item.observaciones] : [],
    };
}

export function findConfiguredModifier(menuItem, request = {}) {
    const menu = normalizeSafetyMenuItem(menuItem);
    const requestedId = normalizeSafetyText(request.id || request.modifier_id || '');
    const requestedName = normalizeSafetyText(request.nombre || request.name || request.descripcion || request.requested || '');
    const requestedIngredient = normalizeSafetyText(request.ingrediente || '');
    const byIdentity = menu.modificadores_disponibles.find(candidate => {
        const idMatch = requestedId && normalizeSafetyText(candidate.id) === requestedId;
        const nameMatch = requestedName && (
            normalizeSafetyText(candidate.nombre).includes(requestedName)
            || requestedName.includes(normalizeSafetyText(candidate.nombre))
        );
        return idMatch || nameMatch;
    });
    if (byIdentity && byIdentity.disponible !== false) return byIdentity;
    const byIngredient = menu.modificadores_disponibles.find(candidate => (
        requestedIngredient && normalizeSafetyText(candidate.ingrediente) === requestedIngredient
    ));
    return byIngredient && byIngredient.disponible !== false ? byIngredient : null;
}

function lineMatches(item, target = {}) {
    if (target.item_id) return item.item_id === target.item_id;
    if (target.line_id) return item.line_id === target.line_id;
    if (target.nombre && sameText(item.nombre, target.nombre)) return true;
    if (target.product_id && String(item.product_id || item.id) === String(target.product_id)) return true;
    return false;
}

export function resolveSafetyTargets(items = [], target = {}) {
    const hasDirectTarget = target.item_id || target.line_id || target.nombre || target.product_id;
    const candidates = items.map((item, index) => ({ item, index }))
        .filter(({ item }) => hasDirectTarget ? lineMatches(item, target) : true);
    if (target.ordinal) {
        const index = target.ordinal === 'first' ? 0 : target.ordinal === 'second' ? 1 : null;
        if (index !== null && candidates[index]) return [candidates[index]];
    }
    return candidates;
}

function withModifier(item, modifier) {
    const next = copyItem(item);
    const current = next.modificaciones.findIndex(existing => modifierKey(existing) === modifierKey(modifier));
    if (current >= 0) next.modificaciones[current] = { ...modifier };
    else next.modificaciones.push({ ...modifier });
    next.item_id ||= randomUUID();
    next.product_id ||= next.id || null;
    next.requiere_confirmacion_especial = Boolean(
        next.requiere_confirmacion_especial || modifier.requiere_confirmacion_especial,
    );
    return next;
}

export function addModifierToItems(items = [], target, modifier, { quantity = null, scope = 'all' } = {}) {
    const next = items.map(copyItem);
    const matches = resolveSafetyTargets(next, target);
    if (matches.length === 0) return { items: next, changed: false, affected: [] };
    if (matches.length > 1 && scope === 'all') {
        return {
            items: next.map(item => matches.some(match => match.item === item) ? withModifier(item, modifier) : item),
            changed: true,
            affected: matches.map(match => match.item.item_id || match.item.nombre),
        };
    }

    const selected = scope === 'second' ? matches[1] : scope === 'first' ? matches[0] : matches[0];
    if (!selected) return { items: next, changed: false, affected: [] };
    const amount = Math.max(1, Number(quantity) || (scope === 'one' ? 1 : selected.item.cantidad));
    if (amount >= selected.item.cantidad || scope === 'all') {
        next[selected.index] = withModifier(selected.item, modifier);
        return { items: next, changed: true, affected: [selected.item.item_id || selected.item.nombre] };
    }

    const base = copyItem(selected.item);
    base.cantidad -= amount;
    const modified = withModifier({ ...selected.item, cantidad: amount, item_id: randomUUID() }, modifier);
    next.splice(selected.index, 1, base, modified);
    return { items: next, changed: true, split: true, affected: [modified.item_id] };
}

export function removeModifierFromItems(items = [], target, requested = null, { scope = 'all' } = {}) {
    const next = items.map(copyItem);
    const matches = resolveSafetyTargets(next, target);
    const selected = scope === 'second' ? matches.slice(1, 2)
        : scope === 'first' || scope === 'one' ? matches.slice(0, 1)
            : matches;
    let changed = false;
    for (const match of selected) {
        const before = match.item.modificaciones.length;
        const remainingModifiers = requested
            ? match.item.modificaciones.filter(modifier => modifierKey(modifier) !== modifierKey(requested))
            : [];
        if (before === remainingModifiers.length) continue;
        if (scope === 'one' && match.item.cantidad > 1) {
            const retained = copyItem(match.item);
            retained.cantidad -= 1;
            const unmodified = copyItem(match.item);
            unmodified.cantidad = 1;
            unmodified.item_id = randomUUID();
            unmodified.modificaciones = remainingModifiers;
            unmodified.requiere_confirmacion_especial = unmodified.modificaciones.some(modifier => modifier.requiere_confirmacion_especial);
            next.splice(match.index, 1, retained, unmodified);
        } else {
            match.item.modificaciones = remainingModifiers;
            match.item.requiere_confirmacion_especial = match.item.modificaciones.some(modifier => modifier.requiere_confirmacion_especial);
        }
        changed = true;
    }
    return { items: next, changed, affected: selected.map(match => match.item.item_id || match.item.nombre) };
}

export function addNoteToItems(items = [], target, note, { scope = 'all' } = {}) {
    const next = items.map(copyItem);
    const matches = resolveSafetyTargets(next, target);
    const selected = scope === 'second' ? matches.slice(1, 2)
        : scope === 'first' || scope === 'one' ? matches.slice(0, 1)
            : matches;
    if (!String(note || '').trim() || selected.length === 0) return { items: next, changed: false, affected: [] };
    for (const match of selected) {
        if (scope === 'one' && match.item.cantidad > 1) {
            const retained = copyItem(match.item);
            retained.cantidad -= 1;
            const noted = copyItem(match.item);
            noted.cantidad = 1;
            noted.item_id = randomUUID();
            if (!noted.observaciones.some(existing => sameText(existing, note))) noted.observaciones.push(String(note).trim());
            next.splice(match.index, 1, retained, noted);
            continue;
        }
        if (!match.item.observaciones.some(existing => sameText(existing, note))) match.item.observaciones.push(String(note).trim());
        match.item.item_id ||= randomUUID();
    }
    return { items: next, changed: true, affected: selected.map(match => match.item.item_id || match.item.nombre) };
}

export function removeNoteFromItems(items = [], target, { scope = 'all' } = {}) {
    const next = items.map(copyItem);
    const matches = resolveSafetyTargets(next, target);
    const selected = scope === 'second' ? matches.slice(1, 2)
        : scope === 'first' || scope === 'one' ? matches.slice(0, 1)
            : matches;
    let changed = false;
    for (const match of selected) {
        if (!match.item.observaciones.length) continue;
        if (scope === 'one' && match.item.cantidad > 1) {
            const retained = copyItem(match.item);
            retained.cantidad -= 1;
            const unnoted = copyItem(match.item);
            unnoted.cantidad = 1;
            unnoted.item_id = randomUUID();
            unnoted.observaciones = [];
            next.splice(match.index, 1, retained, unnoted);
        } else {
            match.item.observaciones = [];
        }
        changed = true;
    }
    return { items: next, changed, affected: selected.map(match => match.item.item_id || match.item.nombre) };
}

function matchesSafetyTerm(value, term) {
    const left = normalizeSafetyText(value);
    const right = normalizeSafetyText(term);
    return left === right || left.includes(right) || right.includes(left);
}

export function deriveSafetyContext(items = [], menu = [], declaredAllergies = [], dietaryRestrictions = []) {
    const normalizedMenu = menu.map(normalizeSafetyMenuItem);
    const allergies = textList(declaredAllergies);
    const restrictions = textList(dietaryRestrictions);
    const conflicts = [];
    const incomplete = [];
    const itemWarnings = [];
    const configuredWarnings = [];
    const criticalModifiers = [];
    for (const item of items) {
        const menuItem = normalizedMenu.find(candidate => (
            (item.product_id && String(candidate.id) === String(item.product_id)) || sameText(candidate.nombre, item.nombre)
        ));
        if (!menuItem) continue;
        if (menuItem.advertencia_contaminacion) configuredWarnings.push(menuItem.advertencia_contaminacion);
        if (item.requiere_confirmacion_especial || (item.modificaciones || []).some(modifier => modifier.requiere_confirmacion_especial)) {
            criticalModifiers.push(menuItem.nombre);
        }
        const terms = [...menuItem.alergenos, ...menuItem.ingredientes];
        const matchingAllergies = allergies.filter(allergy => terms.some(term => matchesSafetyTerm(term, allergy)));
        if (matchingAllergies.length > 0) {
            conflicts.push({ item_id: item.item_id || item.nombre, producto: menuItem.nombre, alergias: matchingAllergies, ingredientes: terms });
            itemWarnings.push(`${menuItem.nombre}: coincide con ${matchingAllergies.join(', ')}`);
        }
        if (allergies.length > 0 && !menuItem.informacion_completa) {
            incomplete.push({ item_id: item.item_id || item.nombre, producto: menuItem.nombre });
        }
        for (const restriction of restrictions) {
            const normalizedRestriction = normalizeSafetyText(restriction);
            const configured = normalizedRestriction.includes('gluten')
                ? menuItem.restricciones.sin_gluten_configurado
                : normalizedRestriction.includes('lactosa')
                    ? menuItem.restricciones.sin_lactosa_configurado
                    : normalizedRestriction.includes('vegetari')
                        ? menuItem.restricciones.vegetariano
                        : normalizedRestriction.includes('vegan') || normalizedRestriction.includes('vegano')
                            ? menuItem.restricciones.vegano
                            : false;
            if (!configured) {
                incomplete.push({ item_id: item.item_id || item.nombre, producto: menuItem.nombre, restriction: restrictionLabel(restrictions, normalizedRestriction) });
            }
        }
    }
    const requiresSpecialConfirmation = allergies.length > 0 || conflicts.length > 0 || incomplete.length > 0
        || criticalModifiers.length > 0;
    const configuredWarning = [...new Set(configuredWarnings)].join(' ');
    const warning = conflicts.length > 0
        ? `Advertencia: ${itemWarnings.join('; ')}. No se garantiza ausencia de contaminación cruzada.`
        : incomplete.length > 0
            ? 'Advertencia: la información de ingredientes o restricciones está incompleta. No puedo garantizar ausencia de contaminación cruzada.'
            : allergies.length > 0
                ? 'Alergia declarada: confirma expresamente que deseas continuar. No puedo garantizar ausencia de contaminación cruzada.'
                : criticalModifiers.length > 0
                    ? `Este pedido contiene una modificación que requiere confirmación especial (${criticalModifiers.join(', ')}).`
                    : '';
    return {
        declared_allergies: allergies,
        dietary_restrictions: restrictions,
        allergy_conflicts: conflicts,
        incomplete_information: incomplete,
        special_warning: [warning, configuredWarning].filter(Boolean).join(' '),
        requires_special_confirmation: requiresSpecialConfirmation,
    };
}

function restrictionLabel(restrictions, term) {
    return restrictions.find(value => normalizeSafetyText(value).includes(term)) || term;
}

function categoryMatches(item, category) {
    if (!category) return true;
    const normalized = normalizeSafetyText(item.categoria);
    const requested = normalizeSafetyText(category);
    const aliases = new Map([
        ['plato', 'platos'], ['platos', 'platos'], ['comida', 'platos'], ['comidas', 'platos'],
        ['bebida', 'bebidas'], ['bebidas', 'bebidas'], ['postre', 'postres'], ['postres', 'postres'],
    ]);
    return (aliases.get(normalized) || normalized) === (aliases.get(requested) || requested);
}

function termsContain(item, term) {
    return [...item.alergenos, ...item.ingredientes].some(value => matchesSafetyTerm(value, term));
}

export function menuQuery(menu = [], {
    productName = null,
    allergen = null,
    restriction = null,
    excludeIngredient = null,
    category = null,
    safeForAllergen = false,
} = {}) {
    const normalizedMenu = menu.map(normalizeSafetyMenuItem);
    const selected = productName
        ? normalizedMenu.filter(item => sameText(item.nombre, productName))
        : normalizedMenu.filter(item => categoryMatches(item, category));
    if (safeForAllergen && allergen) {
        const unknown = selected.filter(item => !item.informacion_completa);
        const known = selected.filter(item => item.informacion_completa);
        return {
            type: 'safe_options',
            allergen,
            items: known.filter(item => !termsContain(item, allergen)),
            unknown_items: unknown,
            complete: unknown.length === 0,
        };
    }
    if (allergen) {
        const matching = selected.filter(item => termsContain(item, allergen));
        return { type: 'allergen', allergen, items: matching, complete: matching.every(item => item.informacion_completa) };
    }
    if (restriction) {
        const normalized = normalizeSafetyText(restriction);
        const key = normalized.includes('gluten') ? 'sin_gluten_configurado' : normalized.includes('lactosa') ? 'sin_lactosa_configurado' : normalized;
        return { type: 'restriction', restriction, items: selected.filter(item => item.restricciones[key] === true), complete: selected.every(item => item.informacion_completa) };
    }
    if (excludeIngredient) {
        const unknown = selected.filter(item => !item.informacion_completa);
        const known = selected.filter(item => item.informacion_completa);
        return {
            type: 'ingredient_exclusion',
            ingredient: excludeIngredient,
            items: known.filter(item => !termsContain(item, excludeIngredient)),
            unknown_items: unknown,
            complete: unknown.length === 0,
        };
    }
    return { type: 'ingredients', items: selected, complete: selected.every(item => item.informacion_completa) };
}

export function sanitizeSpeechText(value) {
    return sanitizeForSpeech(value).speechText;
}

/**
 * Allowlist centralizada de observaciones culinarias controladas.
 *
 * Son notas de preparación válidas que el cliente puede pedir sin que exista
 * un modificador configurado en `producto.modificadores_disponibles`. NO son
 * modificadores de ingredientes, NO cambian el precio, NO disparan
 * confirmación especial y NO afectan alérgenos.
 *
 * Si la frase del usuario matchea una entrada, la solicitud se clasifica
 * como `add_item_note` con `note = label` y se persiste en la línea como
 * `observaciones` (visible en /robot y /cocina).
 *
 * Si la frase NO matchea esta allowlist NI un modifier configurado, la
 * solicitud se rechaza con la sugerencia de llamar a un mesero humano.
 *
 * Reglas explícitas:
 *   - NO incluir aquí frases con palabras de alergia/restricción
 *     ("alerg", "intoleran", "no puedo comer", "sin lactosa por salud"). Esas
 *     rutas tienen prioridad en `classifySafetyIntent`.
 *   - NO incluir modificadores reales de ingredientes ("sin cebolla",
 *     "sin queso"). Esos viven en `modificadores_disponibles` del producto.
 *   - Cada `label` debe ser texto corto, neutral y útil para Cocina.
 */
export const CULINARY_OBSERVATION_ALLOWLIST = Object.freeze([
    { id: 'sin_sal',        label: 'Sin sal',         patterns: [/\bsin\s+sal\b/u] },
    { id: 'poca_sal',       label: 'Poca sal',        patterns: [/\b(?:poca|poco)\s+sal\b/u, /\bcon\s+(?:poca|poco)\s+sal\b/u] },
    { id: 'poco_picante',   label: 'Poco picante',    patterns: [/\b(?:poco|poca)\s+picante\b/u, /\bcon\s+(?:poco|poca)\s+picante\b/u] },
    { id: 'bien_cocido',    label: 'Bien cocido',     patterns: [/\bbien\s+cocid[oa]\b/u, /\bcocinar\s+bien\b/u] },
    { id: 'termino_medio',  label: 'Término medio',   patterns: [/\b(?:termino|termino\s+medio|t[eé]rmino\s+medio)\b/u, /\ba\s+(?:termino|t[eé]rmino)\s+medio\b/u] },
    { id: 'salsa_aparte',   label: 'Salsa aparte',    patterns: [/\b(?:la\s+)?salsa\s+aparte\b/u, /\bservir\s+(?:la\s+)?salsa\s+aparte\b/u] },
    { id: 'sin_cubiertos',  label: 'Sin cubiertos',   patterns: [/\bsin\s+cubiertos\b/u, /\sno\s+traer\s+cubiertos\b/u] },
    { id: 'servir_caliente',label: 'Servir caliente', patterns: [/\bservir\s+caliente\b/u, /\bque\s+est[ée]\s+(?:bien\s+)?caliente\b/u, /\bbien\s+caliente\b/u] },
    { id: 'no_mezclar',     label: 'No mezclar',      patterns: [/\bno\s+mezclar\b/u, /\sseparado\s+(?:el|la|los|las)\b/u] },
]);

/**
 * Detecta si una frase del usuario corresponde a una observación culinaria
 * de la allowlist. Devuelve `{ id, label, raw }` si matchea, `null` en caso
 * contrario.
 *
 * Importante: esta función es SOLO LECTURA sobre la allowlist. No inventa
 * observaciones, no acepta texto libre, y rechaza cualquier frase que
 * contenga marcas de alergia (esas rutas tienen prioridad en el clasificador).
 */
export function matchCulinaryObservation(text) {
    const normalized = normalizeSafetyText(text);
    if (!normalized) return null;
    if (/\b(?:alerg\w*|intoleran\w*|no\s+puedo\s+(?:comer|consumir)|tengo\s+alergia|reaccion\w*)\b/u.test(normalized)) {
        return null;
    }
    for (const entry of CULINARY_OBSERVATION_ALLOWLIST) {
        for (const pattern of entry.patterns) {
            const match = normalized.match(pattern);
            if (match) {
                return { id: entry.id, label: entry.label, raw: match[0].trim() };
            }
        }
    }
    return null;
}

/**
 * Devuelve la allowlist como payload público (id + label + sinónimos).
 * Pensado para que el frontend consuma la misma fuente de verdad que el
 * backend y muestre los chips de observación en el editor táctil.
 */
export function listCulinaryObservations() {
    return CULINARY_OBSERVATION_ALLOWLIST.map(entry => ({
        id: entry.id,
        label: entry.label,
    }));
}
