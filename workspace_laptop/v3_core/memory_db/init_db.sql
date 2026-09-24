-- ═══════════════════════════════════════════════════════════
--  🤖 ROBOT MESERO UTEC — Esquema PostgreSQL v3.0
--  Se ejecuta automáticamente al crear el container por primera vez
-- ═══════════════════════════════════════════════════════════

-- ── Tipos ENUM ────────────────────────────────────────────
CREATE TYPE estado_pedido AS ENUM (
    'provisional', 'confirmado', 'preparando', 'listo', 'entregado', 'cancelado'
);
CREATE TYPE categoria_menu AS ENUM (
    'plato_principal', 'entrada', 'menu_completo', 'bebida', 'postre'
);

-- ── Menú ──────────────────────────────────────────────────
CREATE TABLE menu_items (
    id          VARCHAR(10) PRIMARY KEY,
    nombre      VARCHAR(120) NOT NULL,
    categoria   categoria_menu NOT NULL DEFAULT 'plato_principal',
    precio      DECIMAL(8,2) NOT NULL,
    descripcion TEXT DEFAULT '',
    foto_url    TEXT DEFAULT '',
    calorias    INTEGER DEFAULT 0,
    alergenos   JSONB DEFAULT '[]'::jsonb,
    tags        JSONB DEFAULT '[]'::jsonb,
    tiempo_prep_min INTEGER DEFAULT 10,
    disponible  BOOLEAN DEFAULT true,
    dias_semana TEXT[] DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Pedidos ───────────────────────────────────────────────
CREATE TABLE pedidos (
    id          UUID PRIMARY KEY,
    mesa        INTEGER NOT NULL,
    estado      estado_pedido NOT NULL DEFAULT 'provisional',
    platos      JSONB NOT NULL DEFAULT '[]'::jsonb,
    bebida      VARCHAR(120),
    total       DECIMAL(8,2) DEFAULT 0,
    notas       TEXT DEFAULT '',
    inicio_preparacion TIMESTAMPTZ,
    fin_preparacion    TIMESTAMPTZ,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_pedidos_estado ON pedidos(estado);
CREATE INDEX idx_pedidos_mesa ON pedidos(mesa);
CREATE INDEX idx_pedidos_created ON pedidos(created_at);

-- ── Telemetría ────────────────────────────────────────────
CREATE TABLE telemetria (
    id          BIGSERIAL PRIMARY KEY,
    ts          TIMESTAMPTZ DEFAULT NOW(),
    measurement VARCHAR(50) NOT NULL DEFAULT 'robot',
    estado      VARCHAR(30),
    x           REAL,
    y           REAL,
    bateria     REAL,
    personas    INTEGER DEFAULT 0,
    emocion     VARCHAR(30),
    data        JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_telemetria_ts ON telemetria(ts DESC);
CREATE INDEX idx_telemetria_measurement ON telemetria(measurement);

-- ── Memoria largo plazo ───────────────────────────────────
CREATE TABLE memoria_largo_plazo (
    id          SERIAL PRIMARY KEY,
    categoria   VARCHAR(50) NOT NULL,
    clave       VARCHAR(120) NOT NULL,
    valor       TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(categoria, clave)
);

-- ── Caras conocidas ───────────────────────────────────────
CREATE TABLE caras (
    id          SERIAL PRIMARY KEY,
    nombre      VARCHAR(120) NOT NULL,
    embedding   JSONB NOT NULL,
    foto_b64    TEXT,
    veces_visto INTEGER DEFAULT 1,
    visto_en    TIMESTAMPTZ DEFAULT NOW(),
    creado_en   TIMESTAMPTZ DEFAULT NOW()
);

-- ── Configuración ─────────────────────────────────────────
CREATE TABLE configuracion (
    clave          VARCHAR(80) PRIMARY KEY,
    valor          TEXT NOT NULL,
    tipo           VARCHAR(20) DEFAULT 'string',
    actualizado_en TIMESTAMPTZ DEFAULT NOW()
);

-- ── Historial de platos pedidos (para tendencias) ─────────
CREATE TABLE platos_pedidos (
    id          BIGSERIAL PRIMARY KEY,
    nombre      VARCHAR(120) NOT NULL,
    cantidad    INTEGER DEFAULT 1,
    hora_dia    VARCHAR(2),
    dia_semana  VARCHAR(3),
    pedido_id   UUID REFERENCES pedidos(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_platos_pedidos_nombre ON platos_pedidos(nombre);
CREATE INDEX idx_platos_pedidos_created ON platos_pedidos(created_at);

-- ═══════════════════════════════════════════════════════════
--  SEED DATA — Menú Cafetería UTEC
-- ═══════════════════════════════════════════════════════════

-- Platos principales
INSERT INTO menu_items (id, nombre, categoria, precio, descripcion, foto_url, calorias, alergenos, tags, tiempo_prep_min) VALUES
('p001', 'Lomo Saltado', 'plato_principal', 14.00,
 'Lomo de res salteado con tomate, cebolla, ají amarillo, papas fritas y arroz blanco.',
 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/85/Lomo_saltado2.jpg/320px-Lomo_saltado2.jpg',
 680, '[]'::jsonb, '["carne","popular","peruano"]'::jsonb, 12),

('p002', 'Arroz con Pollo', 'plato_principal', 12.00,
 'Pollo guisado con arroz verde (cilantro), zanahoria, arvejas y ají amarillo.',
 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6b/Arroz_con_pollo_peruano.jpg/320px-Arroz_con_pollo_peruano.jpg',
 590, '[]'::jsonb, '["pollo","popular","peruano"]'::jsonb, 10),

('p003', 'Ají de Gallina', 'plato_principal', 13.00,
 'Pollo desmenuzado en salsa de ají amarillo, pan, nueces y queso parmesano. Con arroz y papa amarilla.',
 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/1e/Aji_de_gallina.jpg/320px-Aji_de_gallina.jpg',
 620, '["nueces","lacteos"]'::jsonb, '["pollo","cremoso","peruano"]'::jsonb, 8),

('p004', 'Cau Cau', 'plato_principal', 11.00,
 'Mondongo guisado con papas en cuadraditos, ají amarillo, hierbabuena y arroz blanco.',
 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/da/Cau-cau.jpg/320px-Cau-cau.jpg',
 520, '[]'::jsonb, '["tripa","tradicional","peruano"]'::jsonb, 10),

('p005', 'Seco de Res', 'plato_principal', 13.50,
 'Carne de res guisada en salsa de cilantro, ají amarillo, chicha de jora. Con arroz y frejoles.',
 'https://upload.wikimedia.org/wikipedia/commons/thumb/5/5a/Seco_de_carne.jpg/320px-Seco_de_carne.jpg',
 650, '[]'::jsonb, '["carne","guiso","peruano"]'::jsonb, 12),

('p006', 'Pollo a la Brasa (1/4)', 'plato_principal', 14.50,
 'Un cuarto de pollo a la brasa con papas fritas, ensalada y ají.',
 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0a/Pollo_a_la_Brasa.jpg/320px-Pollo_a_la_Brasa.jpg',
 720, '[]'::jsonb, '["pollo","brasa","popular"]'::jsonb, 15),

('p007', 'Fideos a la Huancaína', 'plato_principal', 9.50,
 'Espagueti bañado en salsa huancaína (ají amarillo, queso fresco, galletas). Vegetariano.',
 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c8/Tallar%C3%ADn_con_salsa_huanca%C3%ADna.jpg/320px-Tallar%C3%ADn_con_salsa_huanca%C3%ADna.jpg',
 480, '["lacteos","gluten"]'::jsonb, '["vegetariano","pasta","economico"]'::jsonb, 8),

('p008', 'Causa Rellena', 'entrada', 8.00,
 'Causa de papa amarilla rellena de atún o pollo con mayonesa, palta y tomate.',
 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8a/Causa_rellena.jpg/320px-Causa_rellena.jpg',
 340, '["mariscos","lacteos"]'::jsonb, '["entrada","peruano","frio"]'::jsonb, 5),

('p009', 'Tallarines Verdes con Bistek', 'plato_principal', 13.00,
 'Espagueti en salsa de albahaca, queso, leche y perejil con bistek apanado.',
 'https://upload.wikimedia.org/wikipedia/commons/thumb/7/7c/Tallarines_verdes_con_bistec_apanado.jpg/320px-Tallarines_verdes_con_bistec_apanado.jpg',
 700, '["gluten","lacteos"]'::jsonb, '["pasta","carne","contundente"]'::jsonb, 12),

('p010', 'Menú del Día (completo)', 'menu_completo', 10.00,
 'Sopa + plato de fondo del día + refresco. Varía cada día.',
 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ef/Menu_ejecutivo_peruano.jpg/320px-Menu_ejecutivo_peruano.jpg',
 700, '[]'::jsonb, '["economico","completo","variable"]'::jsonb, 8);

-- Bebidas
INSERT INTO menu_items (id, nombre, categoria, precio, descripcion, foto_url, calorias, tags, tiempo_prep_min) VALUES
('b001', 'Agua mineral',    'bebida', 2.00, 'Agua mineral sin gas 500ml',
 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f1/Glass-of-water.jpg/200px-Glass-of-water.jpg',
 0, '["basico"]'::jsonb, 1),
('b002', 'Chicha morada',   'bebida', 3.00, 'Bebida tradicional peruana de maíz morado con frutas y canela',
 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/fb/Chicha_Morada.jpg/240px-Chicha_Morada.jpg',
 120, '["peruano","tradicional"]'::jsonb, 2),
('b003', 'Inca Kola',       'bebida', 3.50, 'La bebida del Perú, gaseosa de hierba luisa',
 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/d0/Inca_Kola_-_Botella_Plástica.png/120px-Inca_Kola_-_Botella_Plástica.png',
 180, '["gaseosa","popular"]'::jsonb, 1),
('b004', 'Coca Cola',       'bebida', 3.50, 'Coca Cola 500ml',
 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/87/CocaColaBottle_background_free.jpg/120px-CocaColaBottle_background_free.jpg',
 210, '["gaseosa"]'::jsonb, 1),
('b005', 'Maracuyá frozen', 'bebida', 4.00, 'Jugo de maracuyá congelado y licuado tipo slushie',
 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/04/Passionfruit_Juice.jpg/240px-Passionfruit_Juice.jpg',
 90, '["natural","refrescante"]'::jsonb, 3),
('b006', 'Limonada',        'bebida', 3.50, 'Limonada fresca con hierbabuena',
 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4a/Lemonade.jpg/240px-Lemonade.jpg',
 80, '["natural","refrescante"]'::jsonb, 2),
('b007', 'Café americano',  'bebida', 4.00, 'Café de grano peruano recién pasado',
 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/45/A_small_cup_of_coffee.JPG/240px-A_small_cup_of_coffee.JPG',
 5, '["caliente","cafe"]'::jsonb, 3),
('b008', 'Jugo de naranja', 'bebida', 4.50, 'Jugo de naranja natural recién exprimido',
 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/05/Orangejuice.jpg/240px-Orangejuice.jpg',
 110, '["natural","vitaminas"]'::jsonb, 3),
('b009', 'Té frío',         'bebida', 3.00, 'Té helado de limón',
 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/05/Iced_tea_crop.jpg/240px-Iced_tea_crop.jpg',
 60, '["refrescante"]'::jsonb, 2);

-- Postres
INSERT INTO menu_items (id, nombre, categoria, precio, descripcion, foto_url, calorias, tags, tiempo_prep_min) VALUES
('po001', 'Mazamorra morada', 'postre', 4.00, 'Postre tradicional de maíz morado con frutas deshidratadas y canela',
 'https://upload.wikimedia.org/wikipedia/commons/thumb/f/f0/Mazamorra_morada.jpg/240px-Mazamorra_morada.jpg',
 280, '["peruano","tradicional"]'::jsonb, 2),
('po002', 'Arroz con leche',  'postre', 3.50, 'Arroz cocido en leche con canela y azúcar',
 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2c/Arroz_con_leche_peruano.jpg/240px-Arroz_con_leche_peruano.jpg',
 320, '["cremoso","clasico"]'::jsonb, 2),
('po003', 'Suspiro limeño',   'postre', 4.50, 'Dulce de leche cubierto con merengue de oporto',
 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/85/Suspiro_a_la_lime%C3%B1a.jpg/240px-Suspiro_a_la_lime%C3%B1a.jpg',
 350, '["peruano","dulce"]'::jsonb, 2),
('po004', 'Picarones (2 un)', 'postre', 3.50, 'Donuts peruanos de camote y zapallo bañados en miel de chancaca',
 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b2/Picarones_de_Lima.jpg/240px-Picarones_de_Lima.jpg',
 290, '["peruano","caliente"]'::jsonb, 5);

-- Configuración por defecto
INSERT INTO configuracion (clave, valor, tipo) VALUES
('idioma',        'es',     'string'),
('nombre_robot',  'Chipi',  'string'),
('voz',           'Puck',   'string'),
('volumen',       '0.8',    'number'),
('modo_estricto', 'false',  'boolean'),
('saludo_inicial','Hola! Soy Uchino, el robot mesero de la cafetería UTEC. ¿En qué mesa te encuentras?','string'),
('horario',       'Lunes–Viernes 7:30–20:00','string'),
('mesas_activas', '20',     'number');

-- ── Función de auto-updated_at ────────────────────────────
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at
    BEFORE UPDATE ON pedidos
    FOR EACH ROW
    EXECUTE FUNCTION trigger_set_updated_at();

-- ── Vista: estadísticas del día ───────────────────────────
CREATE OR REPLACE VIEW estadisticas_hoy AS
SELECT
    COUNT(*) AS total_pedidos,
    COALESCE(SUM(total), 0) AS ventas_total,
    CURRENT_DATE AS fecha
FROM pedidos
WHERE created_at >= CURRENT_DATE
  AND estado NOT IN ('cancelado', 'provisional');
