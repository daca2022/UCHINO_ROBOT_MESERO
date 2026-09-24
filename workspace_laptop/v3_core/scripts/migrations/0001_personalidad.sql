-- ═══════════════════════════════════════════════════════════
-- 0001 — Tabla `personalidad` (singleton 1 fila)
-- ═══════════════════════════════════════════════════════════
-- Crea la tabla que persiste los 5 parámetros editables desde
-- Admin: tono, humor, formalidad, proactividad, longitud de
-- respuesta. Mas un campo JSONB para reglas por contexto.
--
-- Singleton: la app siempre lee/escribe la fila id=1.
--
-- Idempotente: usa CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS personalidad (
    id              INT PRIMARY KEY DEFAULT 1,
    tono            TEXT NOT NULL DEFAULT 'cordial'
                    CHECK (tono IN ('cordial', 'serio', 'entusiasta', 'calido')),
    humor           TEXT NOT NULL DEFAULT 'bajo'
                    CHECK (humor IN ('bajo', 'medio', 'alto')),
    formalidad      TEXT NOT NULL DEFAULT 'usted'
                    CHECK (formalidad IN ('usted', 'mixto', 'tu')),
    proactividad    TEXT NOT NULL DEFAULT 'media'
                    CHECK (proactividad IN ('baja', 'media', 'alta')),
    longitud        TEXT NOT NULL DEFAULT 'corta'
                    CHECK (longitud IN ('corta', 'media', 'larga')),
    reglas_contexto JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT singleton_personalidad CHECK (id = 1)
);

-- Inserta la fila singleton si no existe.
INSERT INTO personalidad (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
