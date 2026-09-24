CREATE TABLE IF NOT EXISTS pedidos (
    id UUID PRIMARY KEY,
    mesa VARCHAR(10) NOT NULL,
    table_id VARCHAR(10),
    platos JSONB NOT NULL,
    items JSONB,
    bebida VARCHAR(50),
    subtotal DECIMAL(10,2),
    total DECIMAL(10,2),
    estado VARCHAR(20) DEFAULT 'provisional',
    status VARCHAR(30) DEFAULT 'draft',
    modo VARCHAR(20) DEFAULT 'tablet',
    mode VARCHAR(20) DEFAULT 'tablet',
    cliente_id UUID,
    notas TEXT,
    notes TEXT,
    requires_human BOOLEAN DEFAULT false,
    session_id VARCHAR(160),
    declared_allergies JSONB NOT NULL DEFAULT '[]'::jsonb,
    dietary_restrictions JSONB NOT NULL DEFAULT '[]'::jsonb,
    allergy_conflicts JSONB NOT NULL DEFAULT '[]'::jsonb,
    special_warning TEXT,
    requires_special_confirmation BOOLEAN NOT NULL DEFAULT false,
    special_confirmation JSONB NOT NULL DEFAULT '{}'::jsonb,
    timestamp TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS table_id VARCHAR(10);
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS items JSONB;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS subtotal DECIMAL(10,2);
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS status VARCHAR(30) DEFAULT 'draft';
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS modo VARCHAR(20) DEFAULT 'tablet';
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS mode VARCHAR(20) DEFAULT 'tablet';
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS requires_human BOOLEAN DEFAULT false;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS session_id VARCHAR(160);
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS declared_allergies JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS dietary_restrictions JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS allergy_conflicts JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS special_warning TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS requires_special_confirmation BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS special_confirmation JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE pedidos
SET
    table_id = COALESCE(table_id, mesa),
    items = COALESCE(items, platos),
    subtotal = COALESCE(subtotal, total, 0),
    status = COALESCE(status, CASE estado
        WHEN 'provisional' THEN 'draft'
        WHEN 'confirmado' THEN 'confirmed'
        WHEN 'en_preparacion' THEN 'preparing'
        WHEN 'listo' THEN 'ready'
        WHEN 'entregado' THEN 'delivered'
        WHEN 'cancelado' THEN 'cancelled'
        ELSE 'draft'
    END),
    mode = COALESCE(NULLIF(mode, ''), NULLIF(modo, ''), 'tablet'),
    modo = COALESCE(NULLIF(modo, ''), NULLIF(mode, ''), 'tablet'),
    notes = COALESCE(notes, notas, '')
WHERE table_id IS NULL
   OR items IS NULL
   OR subtotal IS NULL
   OR status IS NULL
   OR mode IS NULL
   OR modo IS NULL
   OR notes IS NULL;

CREATE TABLE IF NOT EXISTS menu_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre VARCHAR(100) NOT NULL,
    descripcion TEXT,
    precio DECIMAL(10,2) NOT NULL,
    categoria VARCHAR(50) NOT NULL,
    disponible BOOLEAN DEFAULT true,
    imagen_url TEXT,
    ingredientes JSONB NOT NULL DEFAULT '[]'::jsonb,
    alergenos JSONB NOT NULL DEFAULT '[]'::jsonb,
    restricciones JSONB NOT NULL DEFAULT '{}'::jsonb,
    permite_modificadores BOOLEAN NOT NULL DEFAULT true,
    modificadores_disponibles JSONB NOT NULL DEFAULT '[]'::jsonb,
    informacion_completa BOOLEAN NOT NULL DEFAULT false,
    advertencia_contaminacion TEXT
);

CREATE TABLE IF NOT EXISTS clientes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre VARCHAR(100),
    preferencias JSONB DEFAULT '[]',
    frecuencia INTEGER DEFAULT 0,
    ultima_visita TIMESTAMPTZ,
    cara_embedding JSONB
);

CREATE TABLE IF NOT EXISTS personalidad (
    id INT PRIMARY KEY DEFAULT 1,
    tono TEXT DEFAULT 'cordial',
    humor TEXT DEFAULT 'bajo',
    formalidad TEXT DEFAULT 'usted',
    proactividad TEXT DEFAULT 'media',
    longitud TEXT DEFAULT 'corta',
    reglas_contexto JSONB DEFAULT '{}',
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO personalidad (id) VALUES (1)
ON CONFLICT (id) DO NOTHING;

INSERT INTO menu_items (nombre, descripcion, precio, categoria) VALUES
    ('Lomo Saltado', 'Lomo de res salteado con cebolla, tomate y papas fritas', 25.00, 'platos'),
    ('Ceviche', 'Pescado fresco marinado en limón con cebolla y ají', 22.00, 'platos'),
    ('Pollo a la Brasa', 'Pollo asado con papas fritas y ensalada', 30.00, 'platos'),
    ('Tallarines', 'Fideos salteados con pollo y verduras', 20.00, 'platos'),
    ('Inca Kola', 'Gaseosa peruana de sabor crema', 5.00, 'bebidas'),
    ('Chicha Morada', 'Bebida tradicional de maíz morado', 4.00, 'bebidas')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS pedido_eventos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event VARCHAR(90) NOT NULL,
    session_id VARCHAR(160),
    order_id UUID,
    item_id VARCHAR(160),
    product_id UUID,
    mesa VARCHAR(10),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor VARCHAR(80) NOT NULL DEFAULT 'system',
    previous_state JSONB NOT NULL DEFAULT '{}'::jsonb,
    next_state JSONB NOT NULL DEFAULT '{}'::jsonb,
    source VARCHAR(40) NOT NULL DEFAULT 'backend',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_pedido_eventos_order ON pedido_eventos(order_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_pedido_eventos_session ON pedido_eventos(session_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_pedido_eventos_event ON pedido_eventos(event, timestamp DESC);
