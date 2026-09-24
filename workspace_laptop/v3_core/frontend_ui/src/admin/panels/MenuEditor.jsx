import { useState, useEffect } from 'react';
import { useAuth } from '../AuthContext.jsx';
import SafetyMenuFields from './SafetyMenuFields.jsx';

const CATEGORIAS = [
    { value: 'plato', label: 'Plato' },
    { value: 'bebida', label: 'Bebida' },
    { value: 'postre', label: 'Postre' },
];

const FORM_VACIO = {
    nombre: '',
    descripcion: '',
    precio: '',
    categoria: 'plato',
    disponible: true,
    imagen_url: '',
    ingredientes: [],
    alergenos: [],
    restricciones: {},
    permite_modificadores: true,
    modificadores_disponibles: [],
    informacion_completa: false,
    advertencia_contaminacion: '',
    destacado: false,
    recomendable: true,
    orden_aparicion: 100,
    etiqueta_promocional: '',
};

export default function MenuEditor() {
    const { token } = useAuth();
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [editando, setEditando] = useState(null);
    const [form, setForm] = useState(FORM_VACIO);
    const [filtro, setFiltro] = useState('');
    const [msg, setMsg] = useState(null);

    const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
    };

    const cargar = async () => {
        setLoading(true);
        try {
            const r = await fetch('/api/admin/menu', { headers });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const data = await r.json();
            setItems(data.data || []);
        } catch (e) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { cargar(); }, []);

    const iniciarNuevo = () => {
        setEditando('nuevo');
        setForm(FORM_VACIO);
        setMsg(null);
        setError(null);
    };

    const iniciarEditar = (item) => {
        setEditando(item.id);
        setForm({
            nombre: item.nombre,
            descripcion: item.descripcion || '',
            precio: item.precio,
            categoria: item.categoria,
            disponible: item.disponible,
            imagen_url: item.imagen_url || '',
            ingredientes: item.ingredientes || [],
            alergenos: item.alergenos || [],
            restricciones: item.restricciones || {},
            permite_modificadores: item.permite_modificadores !== false,
            modificadores_disponibles: item.modificadores_disponibles || [],
            informacion_completa: item.informacion_completa === true,
            advertencia_contaminacion: item.advertencia_contaminacion || '',
            destacado: item.destacado === true,
            recomendable: item.recomendable !== false,
            orden_aparicion: Number.isFinite(Number(item.orden_aparicion)) ? Number(item.orden_aparicion) : 100,
            etiqueta_promocional: item.etiqueta_promocional || '',
        });
        setMsg(null);
        setError(null);
    };

    const cancelar = () => {
        setEditando(null);
        setForm(FORM_VACIO);
    };

    const guardar = async (e) => {
        e.preventDefault();
        setError(null);
        try {
            const body = {
                ...form,
                precio: parseFloat(form.precio),
            };
            const url = editando === 'nuevo'
                ? '/api/admin/menu'
                : `/api/admin/menu/${editando}`;
            const method = editando === 'nuevo' ? 'POST' : 'PUT';
            const r = await fetch(url, { method, headers, body: JSON.stringify(body) });
            if (!r.ok) {
                const err = await r.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${r.status}`);
            }
            setMsg(editando === 'nuevo' ? 'Item creado' : 'Item actualizado');
            setEditando(null);
            setForm(FORM_VACIO);
            await cargar();
        } catch (e) {
            setError(e.message);
        }
    };

    const eliminar = async (id) => {
        if (!confirm('¿Eliminar este item del menú?')) return;
        try {
            const r = await fetch(`/api/admin/menu/${id}`, { method: 'DELETE', headers });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            setMsg('Item eliminado');
            await cargar();
        } catch (e) {
            setError(e.message);
        }
    };

    const itemsFiltrados = filtro
        ? items.filter(i => i.categoria === filtro)
        : items;

    if (loading) return <div className="text-slate-400 p-4">Cargando menú...</div>;

    return (
        <div className="p-6">
            <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
                <h2 className="text-2xl font-bold text-neon-cyan">Menú de la cafetería</h2>
                <div className="flex gap-2">
                    <select
                        value={filtro}
                        onChange={e => setFiltro(e.target.value)}
                        className="px-3 py-2 rounded-lg bg-chipi-800 border border-chipi-border text-sm"
                    >
                        <option value="">Todas las categorías</option>
                        {CATEGORIAS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                    </select>
                    <button
                        onClick={iniciarNuevo}
                        className="px-4 py-2 bg-neon-cyan text-chipi-900 font-bold rounded-lg hover:brightness-110"
                    >
                        + Nuevo item
                    </button>
                </div>
            </div>

            {editando && (
                <form onSubmit={guardar} className="glass rounded-2xl border border-chipi-border p-5 mb-6 space-y-3">
                    <h3 className="font-bold text-lg">
                        {editando === 'nuevo' ? 'Nuevo item' : 'Editar item'}
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <input
                            required
                            placeholder="Nombre"
                            value={form.nombre}
                            onChange={e => setForm({ ...form, nombre: e.target.value })}
                            className="px-3 py-2 rounded-lg bg-chipi-800 border border-chipi-border"
                        />
                        <input
                            required
                            type="number"
                            step="0.01"
                            min="0"
                            placeholder="Precio (S/)"
                            value={form.precio}
                            onChange={e => setForm({ ...form, precio: e.target.value })}
                            className="px-3 py-2 rounded-lg bg-chipi-800 border border-chipi-border"
                        />
                        <select
                            value={form.categoria}
                            onChange={e => setForm({ ...form, categoria: e.target.value })}
                            className="px-3 py-2 rounded-lg bg-chipi-800 border border-chipi-border"
                        >
                            {CATEGORIAS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                        </select>
                        <input
                            type="url"
                            placeholder="URL de imagen (opcional)"
                            value={form.imagen_url}
                            onChange={e => setForm({ ...form, imagen_url: e.target.value })}
                            className="px-3 py-2 rounded-lg bg-chipi-800 border border-chipi-border"
                        />
                    </div>
                    <textarea
                        placeholder="Descripción (opcional)"
                        value={form.descripcion}
                        onChange={e => setForm({ ...form, descripcion: e.target.value })}
                        className="w-full px-3 py-2 rounded-lg bg-chipi-800 border border-chipi-border"
                        rows={2}
                    />
                    <label className="flex items-center gap-2 text-sm">
                        <input
                            type="checkbox"
                            checked={form.disponible}
                            onChange={e => setForm({ ...form, disponible: e.target.checked })}
                        />
                        Disponible para clientes
                    </label>
                    <div className="rounded-lg border border-chipi-border bg-chipi-800/40 p-3 space-y-2">
                        <p className="text-[10px] uppercase tracking-wider text-text-secondary">Recomendaciones (Fase 6)</p>
                        <label className="flex items-center gap-2 text-sm">
                            <input
                                type="checkbox"
                                checked={form.destacado}
                                onChange={e => setForm({ ...form, destacado: e.target.checked })}
                            />
                            Producto destacado (aparece primero en recomendaciones)
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                            <input
                                type="checkbox"
                                checked={form.recomendable}
                                onChange={e => setForm({ ...form, recomendable: e.target.checked })}
                            />
                            Puede recomendarse
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                            <span className="w-32">Orden de aparición</span>
                            <input
                                type="number"
                                min="1"
                                max="9999"
                                value={form.orden_aparicion}
                                onChange={e => setForm({ ...form, orden_aparicion: Math.max(1, Number(e.target.value) || 100) })}
                                className="px-2 py-1 rounded bg-chipi-800 border border-chipi-border w-24"
                            />
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                            <span className="w-32">Etiqueta promocional</span>
                            <input
                                type="text"
                                maxLength={40}
                                placeholder="Opcional (ej. Más pedido, Nuevo)"
                                value={form.etiqueta_promocional}
                                onChange={e => setForm({ ...form, etiqueta_promocional: e.target.value })}
                                className="px-2 py-1 rounded bg-chipi-800 border border-chipi-border flex-1"
                            />
                        </label>
                    </div>
                    <SafetyMenuFields form={form} setForm={setForm} />
                    <div className="flex gap-2">
                        <button
                            type="submit"
                            className="px-4 py-2 bg-neon-cyan text-chipi-900 font-bold rounded-lg"
                        >
                            Guardar
                        </button>
                        <button
                            type="button"
                            onClick={cancelar}
                            className="px-4 py-2 text-slate-400"
                        >
                            Cancelar
                        </button>
                    </div>
                </form>
            )}

            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="text-left text-text-secondary border-b border-chipi-border">
                            <th className="py-2 pr-2">Nombre</th>
                            <th className="py-2 pr-2">Categoría</th>
                            <th className="py-2 pr-2">Precio</th>
                            <th className="py-2 pr-2">Disponible</th>
                            <th className="py-2 pr-2">Fase 6</th>
                            <th className="py-2 pr-2">Acciones</th>
                        </tr>
                    </thead>
                    <tbody>
                        {itemsFiltrados.map(item => (
                            <tr key={item.id} className="border-b border-chipi-border/50">
                                <td className="py-2 pr-2">
                                    <div className="font-semibold">{item.nombre}</div>
                                    {item.descripcion && (
                                        <div className="text-xs text-text-dim">{item.descripcion}</div>
                                    )}
                                </td>
                                <td className="py-2 pr-2 capitalize">{item.categoria}</td>
                                <td className="py-2 pr-2 font-mono">S/ {parseFloat(item.precio).toFixed(2)}</td>
                                <td className="py-2 pr-2">
                                    {item.disponible
                                        ? <span className="text-green-400">Sí</span>
                                        : <span className="text-red-400">No</span>}
                                </td>
                                <td className="py-2 pr-2">
                                    <div className="flex flex-col gap-0.5">
                                        {item.destacado && <span className="text-[10px] text-neon-amber font-bold">★ Destacado</span>}
                                        {item.recomendable === false && <span className="text-[10px] text-text-dim">No recomienda</span>}
                                        {item.etiqueta_promocional && <span className="text-[10px] text-neon-cyan">{item.etiqueta_promocional}</span>}
                                        <span className="text-[10px] text-text-dim">#{item.orden_aparicion || 100}</span>
                                    </div>
                                </td>
                                <td className="py-2 pr-2 flex gap-2">
                                    <button
                                        onClick={() => iniciarEditar(item)}
                                        className="text-neon-cyan text-xs hover:underline"
                                    >
                                        Editar
                                    </button>
                                    <button
                                        onClick={() => eliminar(item.id)}
                                        className="text-red-400 text-xs hover:underline"
                                    >
                                        Eliminar
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {itemsFiltrados.length === 0 && (
                    <p className="text-center text-text-dim py-6">No hay items en esta categoría</p>
                )}
            </div>

            {msg && (
                <div className="mt-4 p-3 rounded-lg bg-green-900/30 border border-green-700 text-green-300 text-sm">
                    {msg}
                </div>
            )}
            {error && (
                <div className="mt-4 p-3 rounded-lg bg-red-900/30 border border-red-700 text-red-300 text-sm">
                    {error}
                </div>
            )}
        </div>
    );
}
