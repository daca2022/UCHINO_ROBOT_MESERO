import { normalizeSafetyText, matchCulinaryObservation } from './Fase5Safety.mjs';

const WORD_NUMBERS = new Map([
    ['un', 1], ['una', 1], ['uno', 1], ['dos', 2], ['tres', 3], ['cuatro', 4],
]);

function namesFor(item) {
    const name = normalizeSafetyText(item?.nombre);
    const aliases = [name];
    if (name === 'tallarines verdes') aliases.push('tallarines');
    if (name === 'suspiro a la limena' || name === 'suspiro limeno') aliases.push('suspiro');
    return aliases.filter(Boolean);
}

function productMatches(text, menu = [], draftItems = []) {
    const candidates = [...menu, ...draftItems];
    const result = [];
    const textWords = new Set(String(text || '').split(/\s+/u).filter(Boolean));
    for (const item of candidates) {
        const names = namesFor(item);
        const exactMatch = names.some(name => text.includes(name));
        // Coincidencia laxa por palabra singular cuando el texto usa
        // plural o una forma derivada (ej. "lomos" -> "lomo", "tallarines"
        // -> "tallarin"). Esto cubre frases como "dos lomos" sin
        // requerir el nombre completo del producto.
        const stemMatch = !exactMatch && names.some(name => {
            const nameWords = name.split(/\s+/u);
            return nameWords.some(word => {
                if (word.length < 4) return false;
                const wordSingular = word.replace(/s$/u, '');
                return [...textWords].some(tw => {
                    if (tw === word || tw === wordSingular) return true;
                    if (tw.length >= 4) {
                        const twSingular = tw.replace(/s$/u, '');
                        if (twSingular === word || twSingular === wordSingular) return true;
                    }
                    return false;
                });
            });
        });
        if (!exactMatch && !stemMatch) continue;
        if (!result.some(existing => normalizeSafetyText(existing.nombre) === normalizeSafetyText(item.nombre))) result.push(item);
    }
    return result.sort((a, b) => normalizeSafetyText(b.nombre).length - normalizeSafetyText(a.nombre).length);
}

function quantity(text) {
    const number = text.match(/\b(\d{1,2})\b/u);
    if (number) return Number(number[1]);
    let found = null;
    for (const [word, value] of WORD_NUMBERS) {
        const position = text.search(new RegExp(`\\b${word}\\b`, 'u'));
        if (position >= 0 && (!found || position < found.position)) found = { position, value };
    }
    return found?.value || null;
}

function modifierRequest(text) {
    const patterns = [
        { expression: /\bsin\s+(cebolla|sal|picante|aji|queso|hielo|azucar|azúcar)\b/u, tipo: 'remove' },
        { expression: /\b(?:quita|elimina|retira)\s+(?:la|el|un|una)?\s*(cebolla|sal|picante|aji|queso|hielo|azucar|azúcar)\b/u, tipo: 'remove' },
        { expression: /\b(?:poco|poca)\s+(sal|picante|aji|ají|azucar|azúcar)\b/u, tipo: 'level', valor: 'low' },
        { expression: /\bsalsa\s+aparte\b/u, tipo: 'separate' },
        { expression: /\b(?:bien\s+cocido|termino\s+medio|t[eé]rmino\s+medio)\b/u, tipo: 'level' },
        { expression: /\bextra\s+(?:de\s+)?([a-záéíóúñ ]{2,30})\b/u, tipo: 'add' },
    ];
    for (const pattern of patterns) {
        const match = text.match(pattern.expression);
        if (!match) continue;
        const raw = match[1] || match[0];
        return {
            requested: raw.trim(),
            nombre: match[0].trim(),
            ingrediente: pattern.tipo === 'separate' ? 'salsa' : raw.trim(),
            tipo: pattern.tipo,
            valor: pattern.valor || null,
        };
    }
    if (/\bsin\s+eso\b/u.test(text)) return { cancel_last: true, requested: 'eso', nombre: 'Sin eso' };
    const genericRemoval = text.match(/\bsin\s+([a-záéíóúñ][a-záéíóúñ ]{1,29})\b/u);
    if (genericRemoval) {
        const requested = genericRemoval[1].trim();
        if (requested && requested !== 'eso') {
            return {
                requested,
                nombre: genericRemoval[0].trim(),
                ingrediente: requested,
                tipo: 'remove',
            };
        }
    }
    return null;
}

function targetScope(text) {
    if (/\b(?:los dos|ambos|todos|todas)\b/u.test(text)) return 'all';
    if (/\b(?:solo\s+uno|uno\s+solo|una\s+unidad)\b/u.test(text)) return 'one';
    if (/\b(?:el primero|la primera|primero|primera)\b/u.test(text)) return 'first';
    if (/\b(?:el segundo|la segunda|segundo|segunda)\b/u.test(text)) return 'second';
    return 'all';
}

function targetFromProducts(products, draftItems, lastProduct, text) {
    if (products.length === 1) return { nombre: products[0].nombre };
    if (products.length > 1) return { candidates: products.map(item => item.nombre) };
    if (/\b(?:ese|esa|eso|el ultimo|la ultima)\b/u.test(text) && lastProduct) return { nombre: lastProduct };
    if (/\b(?:primero|primera)\b/u.test(text) && draftItems[0]) return { nombre: draftItems[0].nombre, ordinal: 'first' };
    if (/\b(?:segundo|segunda|el otro|la otra)\b/u.test(text) && draftItems.length === 2) return { ordinal: 'second' };
    if (draftItems.length === 1) return { nombre: draftItems[0].nombre };
    return { candidates: draftItems.map(item => item.nombre) };
}

function targetWithExistingModifier(target, draftItems, modifier) {
    if (!target.candidates?.length || !modifier) return target;
    const requested = normalizeSafetyText(modifier.ingrediente || modifier.nombre || modifier.requested || '');
    const matching = draftItems.filter(item => (item.modificaciones || []).some(existing => (
        modifier.cancel_last
        || normalizeSafetyText(existing.id) === requested
        || normalizeSafetyText(existing.nombre).includes(requested)
        || requested.includes(normalizeSafetyText(existing.nombre))
        || normalizeSafetyText(existing.ingrediente) === requested
    )));
    return matching.length === 1
        ? { nombre: matching[0].nombre, item_id: matching[0].item_id }
        : target;
}

function safetyResult(intent, entities, { confidence = 0.98, mutatesOrder = false, requiresClarification = false } = {}) {
    return {
        intent,
        confidence,
        mutates_order: mutatesOrder,
        requires_clarification: requiresClarification,
        entities,
        source: 'deterministic_rule',
    };
}

function allergyTerm(text) {
    const match = text.match(/\b(?:alerg(?:ia|ico|ica)|reaccion)\s+(?:al|a|por)\s+(?:el\s+|la\s+|los\s+|las\s+)?([a-z0-9áéíóúñ ]{2,30})/u);
    if (match) return match[1].trim().split(/\b(?:pero|y|aunque|porque)\b/u)[0].trim();
    const known = ['pescado', 'mariscos', 'mani', 'maní', 'leche', 'lactosa', 'gluten', 'huevo', 'soya', 'nueces'];
    return known.find(term => text.includes(normalizeSafetyText(term))) || null;
}

export function classifySafetyIntent({ text, menu = [], draftItems = [], lastProduct = null } = {}) {
    const normalized = normalizeSafetyText(text);
    if (!normalized) return null;

    if (/\b(?:confirma|confirmalo|confírmalo|envialo|envíalo)\b.*\b(?:todas formas|de todas formas|igual)\b/u.test(normalized)) {
        return safetyResult('confirm_allergy_order', { explicit_override: true }, { mutatesOrder: true });
    }

    if (/\b(?:no soy alergic\w*|solo no me gusta|no me gusta)\b/u.test(normalized)) {
        const explicitProducts = productMatches(normalized, menu, draftItems);
        if (explicitProducts.length === 0 && draftItems.length !== 1) {
            return safetyResult('social_conversation', {
                preference: true,
                read_only: true,
            });
        }
        const target = targetFromProducts(explicitProducts, draftItems, lastProduct, normalized);
        return safetyResult('add_item_note', {
            target,
            note: normalized.replace(/^.*?\b(?:solo no me gusta|no me gusta)\b/u, '').trim() || 'Preferencia del cliente',
            preference: true,
        }, { mutatesOrder: true });
    }

    const allergy = allergyTerm(normalized);
    const allergyDeclaration = /\b(?:soy|tengo|sufro|tiene|presento|es|persona|alguien|pedido)\b.*\b(?:alerg\w*|reaccion\w*)\b/u.test(normalized)
        || /\b(?:soy alergic\w*|tengo alergia)\b/u.test(normalized)
        || /\bno puedo\s+(?:comer|consumir|tomar)\b/u.test(normalized);
    if (allergyDeclaration) {
        const requestedProducts = productMatches(normalized, menu, draftItems).map(item => ({ ...item, cantidad: 1 }));
        return safetyResult('declare_allergy', {
            allergen: allergy || normalized,
            declared_by_user: true,
            requested_products: requestedProducts,
        }, { mutatesOrder: requestedProducts.length > 0 });
    }
    if (/\b(?:ya no|retira|quita|elimina)\b.*\b(?:alergia|alergico|alergica)\b/u.test(normalized)) {
        return safetyResult('remove_allergy', { allergen: allergy || null }, { mutatesOrder: false });
    }

    const restriction = normalized.match(/\b(?:vegetarian[oa]|vegan[oa]|sin gluten|sin lactosa|halal)\b/u);
    const restrictionQuery = restriction && /\b(?:tienen|tiene|hay|busco|quiero|algo|opciones|platos|bebidas|recomiendas)\b/u.test(normalized);
    if (restrictionQuery) {
        return safetyResult('query_dietary_options', {
            restriction: restriction[0],
            category: /\bbebidas?\b/u.test(normalized) ? 'bebidas' : /\bpostres?\b/u.test(normalized) ? 'postres' : /\bplatos?|comidas?\b/u.test(normalized) ? 'platos' : null,
            read_only: true,
        });
    }
    if (restriction && !/\b(?:tiene|tienen|contiene|ingredientes|alergen|seguro)\b/u.test(normalized)) {
        return safetyResult('declare_dietary_restriction', { restriction: restriction[0] }, { mutatesOrder: false });
    }

    const queryProduct = productMatches(normalized, menu, draftItems);
    const products = productMatches(normalized, menu, draftItems);
    const exclusion = normalized.match(/\b(?:que|qué)\s+(?:platos|comidas|bebidas|postres|productos|opciones)\s+(?:no\s+(?:tienen|tiene)|sin)\s+([a-záéíóúñ][a-záéíóúñ ]{1,24})\b/u);
    if (exclusion) {
        return safetyResult('query_ingredients', {
            exclude_ingredient: exclusion[1].trim(),
            category: /\bbebidas?\b/u.test(normalized) ? 'bebidas' : /\bpostres?\b/u.test(normalized) ? 'postres' : /\bplatos?|comidas?\b/u.test(normalized) ? 'platos' : null,
            read_only: true,
        });
    }
    if (/\b(?:seguro|segura|totalmente seguro)\b/u.test(normalized)) {
        return safetyResult('query_allergens', {
            allergen: allergy || null,
            product: queryProduct[0]?.nombre || null,
            safety_question: true,
            read_only: true,
        });
    }
    if (/\brecomiendas?\b/u.test(normalized) && allergy) {
        return safetyResult('query_allergens', {
            allergen: allergy,
            product: queryProduct[0]?.nombre || null,
            recommendation: true,
            safe_for_allergen: true,
            read_only: true,
        });
    }
    if (/\b(?:tiene|hay|contiene|alergeno|alergenos|seguro|recomiendas)\b/u.test(normalized)
        && /\b(?:mani|maní|pescado|mariscos|leche|lactosa|gluten|huevo|nueces|alerg\w*)\b/u.test(normalized)) {
        return safetyResult('query_allergens', {
            allergen: allergy || ['mani', 'pescado', 'leche', 'gluten', 'huevo', 'nueces'].find(term => normalized.includes(term)) || null,
            product: queryProduct[0]?.nombre || null,
            recommendation: /\brecomiendas\b/u.test(normalized),
            safety_question: /\bseguro\b/u.test(normalized),
            read_only: true,
        });
    }
    if (/\b(?:contiene|ingredientes|lleva|preparad[oa]|que tiene)\b/u.test(normalized)) {
        if (queryProduct.length > 1) return safetyResult('clarify_target_item', { candidates: queryProduct.map(item => item.nombre) }, { confidence: 0.4, requiresClarification: true });
        return safetyResult('query_ingredients', { product: queryProduct[0]?.nombre || null, read_only: true });
    }
    if (/\b(?:modificador|modificadores|personalizar|sin que)\b/u.test(normalized)) {
        return safetyResult('query_modifier_options', { product: queryProduct[0]?.nombre || null, read_only: true });
    }

    if (/\b(?:quita|elimina|retira|cancela)\b.*\bobservaci[oó]n\b/u.test(normalized)) {
        return safetyResult('remove_item_note', {
            target: targetFromProducts(products, draftItems, lastProduct, normalized),
            scope: targetScope(normalized),
        }, { mutatesOrder: true });
    }
    const firstNormalSecondModifier = normalized.match(/\b(?:el primero|la primera|primero|primera)\s+normal(?:es)?\s+y\s+(?:el segundo|la segunda|segundo|segunda)\s+(.+)$/u);
    if (firstNormalSecondModifier) {
        const modifier = modifierRequest(firstNormalSecondModifier[1]);
        if (modifier) {
            return safetyResult('replace_item_modifier', {
                target: { ordinal: 'second' },
                clear_target: { ordinal: 'first' },
                modifier,
                scope: 'all',
                variant_plan: 'first_normal_second_modifier',
            }, { mutatesOrder: true });
        }
    }
    if (/\b(?:los dos|ambos|todas?|todos)\s+normales?\b/u.test(normalized)) {
        return safetyResult('remove_item_modifier', {
            target: { all: true },
            modifier: null,
            scope: 'all',
        }, { mutatesOrder: true });
    }
    const modifierReplacement = normalized.match(/\b(?:cambia|cambiar|reemplaza|reemplazar|sustituye|sustituir)\s+(.+?)\s+(?:por|a)\s+(.+)$/u);
    if (modifierReplacement) {
        // Primero intentamos reemplazo entre dos observaciones culinarias
        // (ej. "cambia sin sal por poca sal"). Esto evita que la ruta
        // modifier intente buscar modificadores de ingrediente que no
        // existen configurados en el producto.
        const fromObservation = matchCulinaryObservation(modifierReplacement[1]);
        const toObservation = matchCulinaryObservation(modifierReplacement[2]);
        if (fromObservation && toObservation) {
            const target = targetFromProducts(products, draftItems, lastProduct, normalized);
            if (target.candidates?.length > 1) {
                return safetyResult('clarify_target_item', { candidates: target.candidates, from_observation: fromObservation, observation: toObservation }, { confidence: 0.4, requiresClarification: true });
            }
            return safetyResult('replace_item_note', {
                target,
                from_note_id: fromObservation.id,
                note: toObservation.label,
                observation_id: toObservation.id,
                scope: targetScope(normalized),
            }, { mutatesOrder: true });
        }
        const fromModifier = modifierRequest(modifierReplacement[1]);
        const toModifier = modifierRequest(modifierReplacement[2]);
        if (fromModifier && toModifier) {
            const target = targetWithExistingModifier(
                targetFromProducts(products, draftItems, lastProduct, normalized),
                draftItems,
                fromModifier,
            );
            if (target.candidates?.length > 1) {
                return safetyResult('clarify_target_item', { candidates: target.candidates, from_modifier: fromModifier, modifier: toModifier }, { confidence: 0.4, requiresClarification: true });
            }
            return safetyResult('replace_item_modifier', {
                target,
                from_modifier: fromModifier,
                modifier: toModifier,
                scope: targetScope(normalized),
            }, { mutatesOrder: true });
        }
    }
    const modifier = modifierRequest(normalized);
    if (!modifier && /\b(?:pon|aplica|agrega|añade|anade)\b.*\blo mismo\b.*\b(?:segundo|segund[oa]|otro|otra)\b/u.test(normalized)) {
        const target = targetFromProducts(products, draftItems, lastProduct, normalized);
        if (target.candidates?.length > 1) {
            return safetyResult('clarify_target_item', { candidates: target.candidates }, { confidence: 0.4, requiresClarification: true });
        }
        return safetyResult('replace_item_modifier', { target, copy_from: 'first', scope: 'second' }, { mutatesOrder: true });
    }
    if (modifier?.cancel_last && !draftItems.some(item => (
        (Array.isArray(item.observaciones) && item.observaciones.length > 0)
        || (Array.isArray(item.notes) && item.notes.length > 0)
        || (Array.isArray(item.modificaciones) && item.modificaciones.length > 0)
        || (Array.isArray(item.modifiers) && item.modifiers.length > 0)
    ))) {
        return safetyResult('clarify_target_item', {
            reason: 'no_active_observation_or_modifier',
            read_only: true,
        }, { confidence: 0.4, requiresClarification: true });
    }
    if (!modifier && /\b(?:uno normal|normal)\b/u.test(normalized)) {
        const target = targetFromProducts(products, draftItems, lastProduct, normalized);
        if (target.candidates?.length > 1 || (!target.nombre && !target.ordinal)) {
            return safetyResult('clarify_target_item', { candidates: target.candidates || draftItems.map(item => item.nombre) }, { confidence: 0.4, requiresClarification: true });
        }
        return safetyResult('remove_item_modifier', { target, modifier: null, scope: 'one' }, { mutatesOrder: true });
    }
    if (!modifier) return null;
    const target = targetWithExistingModifier(
        targetFromProducts(products, draftItems, lastProduct, normalized),
        draftItems,
        modifier,
    );
    if (target.candidates?.length > 1) {
        return safetyResult('clarify_target_item', { candidates: target.candidates, modifier }, { confidence: 0.4, requiresClarification: true });
    }
    if (modifier.cancel_last
        || (/\b(?:quita|elimina|cancela|retira)\b.*\b(?:observacion|modificacion|lo de|eso)\b/u.test(normalized)
        || (modifier.tipo === 'remove' && /\b(?:quita|elimina|retira)\b/u.test(normalized)))
        || /\bcancela lo de\b/u.test(normalized)) {
        return safetyResult('remove_item_modifier', { target, modifier: modifier.cancel_last ? null : modifier, scope: targetScope(normalized) }, { mutatesOrder: true });
    }
    if (/\b(?:pon|agrega|añade|anade|quiero)\b.*\b(?:lo mismo|igual)\b/u.test(normalized)) {
        return safetyResult('replace_item_modifier', { target, copy_from: 'first', scope: targetScope(normalized) }, { mutatesOrder: true });
    }
    if (/\buno normal\b.*\bel otro\b.*\bcon\b/u.test(normalized)) {
        return safetyResult('add_item_modifier', {
            target,
            modifier,
            quantity: 2,
            scope: 'one',
            base_product: target.nombre || null,
            explicit_add: false,
            variant_plan: 'split',
        }, { mutatesOrder: true });
    }
    const hasProduct = Boolean(target.nombre);
    const total = /\buno\s+normal\s+y\s+el\s+otro\b/u.test(normalized) ? 2 : quantity(normalized);
    const scope = targetScope(normalized);
    if (!hasProduct && target.candidates?.length > 0) {
        return safetyResult('clarify_target_item', { candidates: target.candidates, modifier }, { confidence: 0.4, requiresClarification: true });
    }

    // Si el producto target existe en el menú real pero NO tiene un
    // modificador configurado que matchee esta solicitud, y la frase
    // coincide con la allowlist de observaciones culinarias, la solicitud
    // se trata como `add_item_note` (no requiere modifier configurado,
    // no cambia el precio, no dispara confirmación especial).
    if (hasProduct) {
        const targetItem = [...menu, ...draftItems].find(item => normalizeSafetyText(item.nombre) === normalizeSafetyText(target.nombre));
        const configured = Array.isArray(targetItem?.modificadores_disponibles) ? targetItem.modificadores_disponibles : [];
        const requestedKey = normalizeSafetyText(modifier.ingrediente || modifier.requested || modifier.nombre || '');
        const requestedTipo = modifier.tipo;
        const matchesConfigured = configured.some(opt => {
            const optKey = normalizeSafetyText(opt.ingrediente || opt.id || opt.nombre || '');
            if (!optKey || optKey !== requestedKey) return false;
            // Si el modifier solicitado es de tipo "remove" y el
            // configurado es de tipo "level" (ej. "sin sal" vs "poca sal"),
            // NO es el mismo modificador: requieren acciones distintas en
            // cocina y la allowlist debe ganar.
            if (requestedTipo && opt.tipo && requestedTipo !== opt.tipo) return false;
            return true;
        });
        if (!matchesConfigured) {
            const observation = matchCulinaryObservation(normalized);
            if (observation) {
                return safetyResult('add_item_note', {
                    target,
                    note: observation.label,
                    observation_id: observation.id,
                    scope,
                    quantity: total || 1,
                    variant_plan: /\b(?:uno normal y el otro|solo uno|uno con)\b/u.test(normalized) ? 'split' : null,
                    observation_only: true,
                }, { mutatesOrder: true });
            }
        }
    }

    const explicitAdd = /\b(?:dame|quiero|agrega|añade|anade|con)\b/u.test(normalized);
    return safetyResult('add_item_modifier', {
        target,
        modifier,
        quantity: total || 1,
        scope,
        base_product: hasProduct ? target.nombre : null,
        explicit_add: explicitAdd,
        variant_plan: /\b(?:uno normal y el otro|solo uno|uno con)\b/u.test(normalized) ? 'split' : null,
    }, { mutatesOrder: true });
}
