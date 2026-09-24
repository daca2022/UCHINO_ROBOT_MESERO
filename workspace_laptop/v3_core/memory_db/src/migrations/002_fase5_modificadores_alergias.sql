ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS ingredientes JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS alergenos JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS restricciones JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS permite_modificadores BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS modificadores_disponibles JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS informacion_completa BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS advertencia_contaminacion TEXT;

ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS session_id VARCHAR(160);
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS declared_allergies JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS dietary_restrictions JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS allergy_conflicts JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS special_warning TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS requires_special_confirmation BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS special_confirmation JSONB NOT NULL DEFAULT '{}'::jsonb;

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
