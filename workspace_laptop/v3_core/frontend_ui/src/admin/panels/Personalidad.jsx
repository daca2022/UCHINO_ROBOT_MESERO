import { useState, useEffect } from 'react';
import { useAuth } from '../AuthContext.jsx';

const OPCIONES = {
    tono: ['cordial', 'serio', 'entusiasta', 'calido'],
    humor: ['bajo', 'medio', 'alto'],
    formalidad: ['usted', 'mixto', 'tu'],
    proactividad: ['baja', 'media', 'alta'],
    longitud: ['corta', 'media', 'larga'],
};

const ETIQUETAS = {
    tono: 'Tono',
    humor: 'Nivel de humor',
    formalidad: 'Tratamiento',
    proactividad: 'Proactividad',
    longitud: 'Longitud de respuesta',
};

const DESCRIPCIONES = {
    tono: {
        cordial: 'Cercano y amable, sin excesos',
        serio: 'Formal y profesional, pocas bromas',
        entusiasta: 'Energético, motivador',
        calido: 'Empático, como un amigo',
    },
    humor: {
        bajo: 'No hace chistes, va al grano',
        medio: 'Algún comentario ligero cuando encaje',
        alto: 'Suele bromear y animar la conversación',
    },
    formalidad: {
        usted: 'Respetuoso, usa "usted" siempre',
        mixto: 'Mezcla "tú" y "usted" según el cliente',
        tu: 'Cercano, usa "tú" siempre',
    },
    proactividad: {
        baja: 'Solo responde cuando le preguntan',
        media: 'Sugiere si hay silencio',
        alta: 'Ofrece productos proactivamente',
    },
    longitud: {
        corta: '1 frase por turno',
        media: '2 frases por turno',
        larga: 'Hasta 4 frases por turno',
    },
};

const CONTEXTOS_HRI = [
    ['reposo_base', 'Reposo en base'],
    ['recepcion_orden_admin', 'Orden de mesero/Admin'],
    ['llegada_mesa', 'Llegada a mesa'],
    ['explicacion_modos', 'Explicación de modos'],
    ['conversacion_general', 'Conversación general'],
    ['toma_pedido_voz', 'Pedido por voz'],
    ['correccion_pedido', 'Corrección de pedido'],
    ['confirmacion_final', 'Confirmación final'],
    ['envio_cocina', 'Envío a cocina'],
    ['solicitud_cuenta', 'Solicitud de cuenta'],
    ['manejo_queja', 'Manejo de queja'],
    ['llamada_mesero', 'Llamada a mesero humano'],
    ['navegacion_advertencia', 'Navegación'],
    ['pausa_error_tecnico', 'Error técnico'],
];

export default function Personalidad() {
    const { token } = useAuth();
    const [data, setData] = useState(null);
    const [saving, setSaving] = useState(false);
    const [loading, setLoading] = useState(false);
    const [msg, setMsg] = useState(null);
    const [error, setError] = useState(null);
    const [errorAction, setErrorAction] = useState('load');

    const cargar = async () => {
        setLoading(true);
        setError(null);
        setErrorAction('load');
        try {
            const r = await fetch('/api/admin/personalidad', {
                headers: { Authorization: `Bearer ${token}` },
            });
            const body = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
            setData(body);
        } catch (e) {
            setErrorAction('load');
            setError(e.name === 'TypeError'
                ? 'No se pudo conectar con el backend. Comprueba que Uchino esté iniciado.'
                : `No se pudo cargar la personalidad: ${e.message}`);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { cargar(); }, [token]);

    const cambiar = (campo, valor) => {
        setData(prev => ({ ...prev, [campo]: valor }));
    };

    const cambiarRegla = (contexto, valor) => {
        setData(prev => ({
            ...prev,
            reglas_contexto: {
                ...(prev.reglas_contexto || {}),
                [contexto]: valor,
            },
        }));
    };

    const guardar = async () => {
        setSaving(true);
        setMsg(null);
        setError(null);
        setErrorAction('save');
        try {
            const r = await fetch('/api/admin/personalidad', {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify(data),
            });
            if (!r.ok) {
                const err = await r.json().catch(() => ({}));
                throw new Error(err.error || `HTTP ${r.status}`);
            }
            const updated = await r.json();
            setData(updated);
            setErrorAction('load');
            setMsg('Personalidad guardada. El robot la usará en su próxima respuesta.');
        } catch (e) {
            setError(e.name === 'TypeError'
                ? 'No se pudo conectar con el backend. Tus cambios siguen en pantalla; reintenta el guardado.'
                : `No se pudo guardar la personalidad: ${e.message}`);
        } finally {
            setSaving(false);
        }
    };

    if (error && !data) {
        return (
            <div className="max-w-2xl mx-auto p-6" role="alert">
                <div className="glass rounded-2xl border border-neon-rose/40 p-5">
                    <h2 className="text-lg font-bold text-neon-rose mb-2">Personalidad no disponible</h2>
                    <p className="text-sm text-text-secondary mb-4">{error}</p>
                    <button
                        onClick={cargar}
                        disabled={loading}
                        className="btn-primary px-4 py-2 rounded-xl text-sm font-semibold disabled:opacity-50"
                    >
                        {loading ? 'Reintentando...' : 'Reintentar'}
                    </button>
                </div>
            </div>
        );
    }
    if (!data) {
        return <div className="text-slate-400 p-4">Cargando personalidad...</div>;
    }

    return (
        <div className="max-w-3xl mx-auto p-6">
            <h2 className="text-2xl font-bold mb-2 text-neon-cyan">Personalidad de Uchino</h2>
            <p className="text-sm text-slate-400 mb-6">
                Cambia cómo habla el robot. Los cambios se aplican a la siguiente respuesta del LLM, sin reiniciar.
            </p>

            <div className="space-y-6">
                {Object.keys(OPCIONES).map(campo => (
                    <div key={campo} className="glass rounded-2xl border border-chipi-border p-5">
                        <label className="block text-sm font-bold mb-3 text-slate-200">
                            {ETIQUETAS[campo]}
                        </label>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-2">
                            {OPCIONES[campo].map(op => (
                                <button
                                    key={op}
                                    onClick={() => cambiar(campo, op)}
                                    className={`px-3 py-2 rounded-lg text-sm font-semibold border transition-all ${
                                        data[campo] === op
                                            ? 'bg-neon-cyan/20 border-neon-cyan text-neon-cyan'
                                            : 'border-chipi-border text-slate-400 hover:border-slate-500'
                                    }`}
                                >
                                    {op}
                                </button>
                            ))}
                        </div>
                        <p className="text-xs text-slate-500 mt-2">
                            {DESCRIPCIONES[campo][data[campo]] || ''}
                        </p>
                    </div>
                ))}
            </div>

            <section className="mt-8 glass rounded-2xl border border-chipi-border p-5">
                <div className="mb-5">
                    <h3 className="text-lg font-bold neon-text-purple">Reglas por contexto HRI</h3>
                    <p className="text-xs text-slate-500 mt-1">
                        Instrucciones operativas para cada escena del servicio.
                    </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {CONTEXTOS_HRI.map(([key, label]) => (
                        <label key={key} className="block">
                            <span className="block text-xs font-semibold uppercase tracking-wide text-slate-400 mb-2">
                                {label}
                            </span>
                            <textarea
                                value={data.reglas_contexto?.[key] || ''}
                                onChange={(event) => cambiarRegla(key, event.target.value)}
                                rows={4}
                                className="w-full min-h-28 resize-y rounded-xl border border-chipi-border bg-chipi-card/80 px-3 py-2 text-sm text-slate-100 outline-none transition-colors focus:border-neon-cyan"
                            />
                        </label>
                    ))}
                </div>
            </section>

            <div className="mt-8 flex items-center gap-4">
                <button
                    onClick={guardar}
                    disabled={saving}
                    className="px-6 py-3 bg-neon-cyan text-chipi-900 font-bold rounded-xl hover:brightness-110 transition-all disabled:opacity-50"
                >
                    {saving ? 'Guardando...' : 'Guardar y aplicar'}
                </button>
                <button
                    onClick={cargar}
                    disabled={saving}
                    className="px-4 py-2 text-sm text-slate-400 hover:text-slate-200"
                >
                    Descartar cambios
                </button>
            </div>

            {msg && (
                <div className="mt-4 p-3 rounded-lg bg-green-900/30 border border-green-700 text-green-300 text-sm">
                    {msg}
                </div>
            )}
            {error && (
                <div className="mt-4 p-3 rounded-lg bg-neon-rose/10 border border-neon-rose/40 text-neon-rose text-sm flex flex-wrap items-center justify-between gap-3" role="alert">
                    <span>{error}</span>
                    <button
                        onClick={() => (errorAction === 'save' ? guardar() : cargar())}
                        disabled={loading || saving}
                        className="btn-primary px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-50"
                    >
                        {loading ? 'Reintentando...' : saving ? 'Guardando...' : errorAction === 'save' ? 'Reintentar guardado' : 'Reintentar'}
                    </button>
                </div>
            )}

            {data.updated_at && (
                <p className="mt-4 text-xs text-slate-500">
                    Última actualización: {new Date(data.updated_at).toLocaleString()}
                </p>
            )}
        </div>
    );
}
