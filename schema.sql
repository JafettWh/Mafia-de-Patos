-- ==========================================================
-- schema.sql — Mafia de Patos
-- ----------------------------------------------------------
-- Una sola tabla con una fila: guarda TODO el árbol del juego
-- (lo que antes era "game_room/..." en Firebase) como una
-- columna JSON. Esto es justamente lo que hace posible que el
-- backend pueda hablar el mismo "idioma" que Firebase sin
-- tener que rediseñar tu lógica de juego en tablas separadas.
-- ==========================================================

CREATE TABLE IF NOT EXISTS game_state (
    id INT PRIMARY KEY,
    data JSON NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

INSERT INTO game_state (id, data)
SELECT 1, JSON_OBJECT()
WHERE NOT EXISTS (SELECT 1 FROM game_state WHERE id = 1);
