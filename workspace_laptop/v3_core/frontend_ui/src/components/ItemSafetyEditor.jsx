import { useEffect, useState } from 'react';

function modifierKey(modifier) {
  return String(modifier.id || modifier.nombre || '').trim();
}

// Espejo de Fase5Safety.normalizeSafetyText del backend; cualquier
// divergencia rompe la validación contra la allowlist canónica.
function normalizeObservationText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[¿?¡!.,;:()[\]{}"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Es la frontera de seguridad contra texto libre: SOLO se acepta si
// matchea un label de la allowlist fetched del backend.
function matchAllowlistEntry(text, allowlist) {
  const normalized = normalizeObservationText(text);
  if (!normalized || !Array.isArray(allowlist)) return null;
  for (const entry of allowlist) {
    const label = normalizeObservationText(entry.label);
    if (!label) continue;
    if (normalized === label) return entry;
    if (normalized.includes(label) || label.includes(normalized)) return entry;
  }
  return null;
}

export default function ItemSafetyEditor({ item, menuItem, onApply, onClose, allowlist = [] }) {
  const [note, setNote] = useState('');
  const [scope, setScope] = useState('all');
  const [localError, setLocalError] = useState('');
  const options = Array.isArray(menuItem?.modificadores_disponibles) ? menuItem.modificadores_disponibles : [];
  const selected = Array.isArray(item?.modificaciones) ? item.modificaciones : [];
  const notes = Array.isArray(item?.observaciones) ? item.observaciones : [];
  // Observaciones que ya están aplicadas sobre la línea
  const appliedLabels = new Set(notes.map(n => normalizeObservationText(n)));

  useEffect(() => { setLocalError(''); }, [note]);

  function tryAddNote() {
    const trimmed = note.trim();
    if (!trimmed) return;
    const matched = matchAllowlistEntry(trimmed, allowlist);
    if (!matched) {
      setLocalError('Esa preparación no está en la lista. Elige una opción o llama a un mesero.');
      return;
    }
    if (appliedLabels.has(normalizeObservationText(matched.label))) {
      setLocalError(`"${matched.label}" ya está aplicada.`);
      return;
    }
    onApply({ operation: 'add_note', note: matched.label, scope });
    setNote('');
    setLocalError('');
  }

  return (
    <div className="absolute inset-2 z-50 flex items-end sm:items-center justify-center" role="dialog" aria-label={`Editar ${item.nombre}`}>
      <button className="absolute inset-0 bg-black/60" onClick={onClose} aria-label="Cerrar editor" />
      <section className="relative w-full max-w-md max-h-[82%] overflow-y-auto glass rounded-2xl border border-neon-cyan/50 p-4 shadow-2xl">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-neon-cyan">Modificar unidad</p>
            <h3 className="text-sm font-bold text-text-primary">{item.nombre} ×{item.cantidad}</h3>
          </div>
          <button onClick={onClose} className="rounded-lg border border-chipi-border px-2 py-1 text-xs text-text-secondary">Cerrar</button>
        </div>
        <div className="space-y-2">
          <p className="text-[10px] text-text-secondary">Opciones registradas en el menú</p>
          {Number(item?.cantidad) > 1 && (
            <label className="flex items-center justify-between gap-2 rounded-lg border border-neon-amber/30 bg-neon-amber/10 px-2 py-2 text-[10px] text-neon-amber">
              <span>Aplicar a</span>
              <select value={scope} onChange={event => setScope(event.target.value)} className="rounded-md border border-chipi-border bg-chipi-card px-2 py-1 text-[10px] text-text-primary">
                <option value="all">todas las unidades</option>
                <option value="one">una unidad</option>
              </select>
            </label>
          )}
          {options.length === 0 && <p className="rounded-lg border border-neon-amber/30 bg-neon-amber/10 p-2 text-xs text-neon-amber">No hay modificadores configurados para este producto.</p>}
          {options.map(option => {
            const active = selected.some(modifier => modifierKey(modifier) === modifierKey(option));
            return (
              <div key={modifierKey(option)} className="flex items-center justify-between gap-2 rounded-lg border border-chipi-border bg-chipi-card px-2 py-2">
                <span className="min-w-0 text-xs text-text-primary">{option.nombre}</span>
                <div className="flex gap-1 shrink-0">
                  {!active && <button onClick={() => onApply({ operation: 'add_modifier', modifier_id: option.id || option.nombre, scope })} className="rounded-md border border-neon-cyan/40 px-2 py-1 text-[10px] text-neon-cyan">Añadir</button>}
                  {active && <button onClick={() => onApply({ operation: 'remove_modifier', modifier_id: option.id || option.nombre, scope })} className="rounded-md border border-neon-rose/40 px-2 py-1 text-[10px] text-neon-rose">Quitar</button>}
                </div>
              </div>
            );
          })}
        </div>
        {Array.isArray(allowlist) && allowlist.length > 0 && (
          <div className="mt-3">
            <p className="text-[10px] text-text-secondary mb-1">Observaciones culinarias</p>
            <div className="flex flex-wrap gap-1">
              {allowlist.map(entry => {
                const applied = appliedLabels.has(normalizeObservationText(entry.label));
                return (
                  <button
                    key={entry.id}
                    type="button"
                    disabled={applied}
                    onClick={() => onApply({ operation: 'add_note', note: entry.label, scope })}
                    className={`rounded-full border px-2 py-1 text-[10px] ${applied
                      ? 'border-neon-amber/60 bg-neon-amber/15 text-neon-amber cursor-not-allowed'
                      : 'border-chipi-border bg-chipi-card text-text-primary hover:border-neon-amber/40'
                    }`}
                  >
                    {applied ? `✓ ${entry.label}` : `+ ${entry.label}`}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {notes.length > 0 && <p className="mt-3 text-[10px] text-neon-amber">Observación: {notes.join('; ')}</p>}
        <div className="mt-3 flex gap-2">
          <input
            value={note}
            onChange={event => setNote(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); tryAddNote(); } }}
            maxLength={120}
            placeholder="Solo observaciones de la allowlist (ej. Sin sal)"
            className="min-w-0 flex-1 rounded-lg border border-chipi-border bg-chipi-card px-2 py-2 text-xs text-text-primary outline-none focus:border-neon-cyan"
            list="observation-allowlist"
            aria-invalid={localError ? 'true' : 'false'}
          />
          <datalist id="observation-allowlist">
            {allowlist.map(entry => <option key={entry.id} value={entry.label} />)}
          </datalist>
          <button
            type="button"
            disabled={!note.trim()}
            onClick={tryAddNote}
            className="rounded-lg border border-neon-amber/40 px-2 py-1 text-[10px] text-neon-amber disabled:opacity-40"
          >
            Guardar
          </button>
        </div>
        {localError && <p className="mt-1 text-[10px] text-neon-rose" role="alert">{localError}</p>}
        {notes.length > 0 && <button onClick={() => onApply({ operation: 'remove_note', scope })} className="mt-2 rounded-lg border border-neon-rose/40 px-2 py-1 text-[10px] text-neon-rose">Quitar observación</button>}
      </section>
    </div>
  );
}
