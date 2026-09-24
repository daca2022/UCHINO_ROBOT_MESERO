import { useState } from 'react';

function slug(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

export default function SafetyMenuFields({ form, setForm }) {
  const [draft, setDraft] = useState({ nombre: '', ingrediente: '', tipo: 'remove', valor: '', precio_adicional: '0', requiere_confirmacion_especial: false });
  const update = (key, value) => setForm(current => ({ ...current, [key]: value }));
  const updateList = (key, value) => update(key, value.split(',').map(item => item.trim()).filter(Boolean));
  const modifiers = Array.isArray(form.modificadores_disponibles) ? form.modificadores_disponibles : [];

  function addModifier() {
    if (!draft.nombre.trim()) return;
    const modifier = {
      id: slug(draft.nombre), nombre: draft.nombre.trim(), ingrediente: draft.ingrediente.trim() || null,
      tipo: draft.tipo, valor: draft.valor.trim() || null, precio_adicional: Number(draft.precio_adicional) || 0,
      disponible: true, requiere_confirmacion_especial: Boolean(draft.requiere_confirmacion_especial),
    };
    update('modificadores_disponibles', [...modifiers, modifier]);
    setDraft({ nombre: '', ingrediente: '', tipo: 'remove', valor: '', precio_adicional: '0', requiere_confirmacion_especial: false });
  }

  return (
    <div className="space-y-3 rounded-xl border border-neon-cyan/20 bg-chipi-bg/40 p-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <label className="text-xs text-text-secondary">Ingredientes registrados
          <input value={(form.ingredientes || []).join(', ')} onChange={event => updateList('ingredientes', event.target.value)} placeholder="pescado, cebolla, limón" className="mt-1 w-full rounded-lg bg-chipi-800 border border-chipi-border px-3 py-2 text-sm" />
        </label>
        <label className="text-xs text-text-secondary">Alérgenos registrados
          <input value={(form.alergenos || []).join(', ')} onChange={event => updateList('alergenos', event.target.value)} placeholder="pescado, leche, maní" className="mt-1 w-full rounded-lg bg-chipi-800 border border-chipi-border px-3 py-2 text-sm" />
        </label>
      </div>
      <div className="flex flex-wrap gap-3 text-xs text-text-secondary">
        {[
          ['vegetariano', 'Vegetariano'], ['vegano', 'Vegano'], ['sin_gluten_configurado', 'Sin gluten'], ['sin_lactosa_configurado', 'Sin lactosa'],
        ].map(([key, label]) => <label key={key} className="flex items-center gap-1"><input type="checkbox" checked={Boolean(form.restricciones?.[key])} onChange={event => update('restricciones', { ...(form.restricciones || {}), [key]: event.target.checked })} />{label}</label>)}
        <label className="flex items-center gap-1"><input type="checkbox" checked={Boolean(form.informacion_completa)} onChange={event => update('informacion_completa', event.target.checked)} />Ficha verificada</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={form.permite_modificadores !== false} onChange={event => update('permite_modificadores', event.target.checked)} />Permite modificadores</label>
      </div>
      <label className="block text-xs text-text-secondary">Advertencia para Cocina / alergias
        <textarea value={form.advertencia_contaminacion || ''} maxLength={240} onChange={event => update('advertencia_contaminacion', event.target.value)} placeholder="Información incompleta o advertencia operativa" rows={2} className="mt-1 w-full rounded-lg bg-chipi-800 border border-chipi-border px-3 py-2 text-sm" />
      </label>
      <div>
        <p className="text-xs font-semibold text-neon-cyan mb-2">Modificadores configurados</p>
        <div className="space-y-1 mb-2">
          {modifiers.map((modifier, index) => <div key={modifier.id || `${modifier.nombre}-${index}`} className="flex items-center justify-between gap-2 rounded-lg border border-chipi-border px-2 py-1.5 text-xs"><span>{modifier.nombre} <span className="text-text-dim">({modifier.tipo}, S/ {Number(modifier.precio_adicional || 0).toFixed(2)})</span></span><button type="button" onClick={() => update('modificadores_disponibles', modifiers.filter((_, current) => current !== index))} className="text-neon-rose">Quitar</button></div>)}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
          <input value={draft.nombre} onChange={event => setDraft({ ...draft, nombre: event.target.value })} placeholder="Nombre" className="col-span-2 rounded-lg bg-chipi-800 border border-chipi-border px-2 py-2 text-xs" />
          <input value={draft.ingrediente} onChange={event => setDraft({ ...draft, ingrediente: event.target.value })} placeholder="Ingrediente" className="rounded-lg bg-chipi-800 border border-chipi-border px-2 py-2 text-xs" />
          <select value={draft.tipo} onChange={event => setDraft({ ...draft, tipo: event.target.value })} className="rounded-lg bg-chipi-800 border border-chipi-border px-2 py-2 text-xs"><option value="remove">Quitar</option><option value="level">Nivel</option><option value="separate">Aparte</option><option value="add">Extra</option></select>
          <input value={draft.precio_adicional} onChange={event => setDraft({ ...draft, precio_adicional: event.target.value })} type="number" min="0" step="0.01" placeholder="S/" className="rounded-lg bg-chipi-800 border border-chipi-border px-2 py-2 text-xs" />
          <button type="button" onClick={addModifier} className="rounded-lg border border-neon-cyan/40 px-2 py-2 text-xs text-neon-cyan">Añadir</button>
        </div>
        <label className="mt-2 flex items-center gap-1 text-[11px] text-text-secondary"><input type="checkbox" checked={draft.requiere_confirmacion_especial} onChange={event => setDraft({ ...draft, requiere_confirmacion_especial: event.target.checked })} />Requiere confirmación especial</label>
      </div>
    </div>
  );
}
