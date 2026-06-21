-- ==========================================================
-- schema.sql — Mafia de Patos (sistema de salas)
-- ----------------------------------------------------------
-- Una tabla 'rooms' donde cada fila es una sala activa.
-- Cada sala guarda su estado completo como JSON.
-- ==========================================================

CREATE TABLE IF NOT EXISTS rooms (
    code        VARCHAR(10) PRIMARY KEY,
    data        JSON NOT NULL,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
