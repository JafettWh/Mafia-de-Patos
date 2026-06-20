// ==========================================================
// server.js — Backend de "Mafia de Patos"
// ----------------------------------------------------------
// Reemplaza a Firebase Realtime Database. Expone, vía Socket.IO,
// la misma semántica que usa el cliente (db-shim.js):
//   - db:get / db:set / db:update / db:remove / db:push
//   - subscribe:value / subscribe:childAdded / unsubscribe
//   - db:onDisconnect:update / :remove / :cancel
//
// El estado completo del juego ("game_room/...") vive en memoria
// (un solo objeto JS) para que las escrituras sean atómicas sin
// necesidad de locks (Node es single-threaded), y se persiste de
// forma asíncrona en una columna JSON de MySQL para sobrevivir a
// reinicios del servidor (Render duerme el servicio tras 15 min
// de inactividad y lo reinicia en la siguiente petición).
// ==========================================================

require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const mysql = require("mysql2/promise");

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.FRONTEND_ORIGIN || "*")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

// ---------------------------------------------------------
// MySQL
// ---------------------------------------------------------
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : undefined,
    waitForConnections: true,
    connectionLimit: 5
});

let state = {}; // estado completo del juego, en memoria (fuente de verdad en caliente)

async function ensureSchema() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS game_state (
            id INT PRIMARY KEY,
            data JSON NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    `);
}

async function loadState() {
    const [rows] = await pool.query("SELECT data FROM game_state WHERE id = 1");
    if (rows.length) {
        state = typeof rows[0].data === "string" ? JSON.parse(rows[0].data) : rows[0].data;
    } else {
        state = {};
        await pool.query("INSERT INTO game_state (id, data) VALUES (1, ?)", [JSON.stringify(state)]);
    }
    console.log("Estado cargado desde MySQL.");
}

let persistTimer = null;
function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(async () => {
        persistTimer = null;
        try {
            await pool.query("UPDATE game_state SET data = ? WHERE id = 1", [JSON.stringify(state)]);
        } catch (err) {
            console.error("Error guardando estado en MySQL:", err.message);
        }
    }, 400);
}

async function persistNow() {
    try {
        await pool.query("UPDATE game_state SET data = ? WHERE id = 1", [JSON.stringify(state)]);
    } catch (err) {
        console.error("Error guardando estado en MySQL (shutdown):", err.message);
    }
}

// ---------------------------------------------------------
// Utilidades de manipulación de rutas tipo Firebase
// ---------------------------------------------------------
function normalize(path) {
    return (path || "").toString().replace(/^\/+|\/+$/g, "");
}

function getAtPath(root, path) {
    const parts = normalize(path).split("/").filter(Boolean);
    let cur = root;
    for (const p of parts) {
        if (cur === null || cur === undefined) return undefined;
        cur = cur[p];
    }
    return cur;
}

// Reemplaza por completo el valor en `path` (igual que .set() de Firebase)
function fullSetAtPath(root, path, value) {
    const parts = normalize(path).split("/").filter(Boolean);
    if (parts.length === 0) {
        Object.keys(root).forEach(k => delete root[k]);
        if (value && typeof value === "object") Object.assign(root, value);
        return;
    }
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
        const k = parts[i];
        if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
        cur = cur[k];
    }
    const lastKey = parts[parts.length - 1];
    if (value === null || value === undefined) {
        delete cur[lastKey];
    } else {
        cur[lastKey] = value;
    }
}

// Resuelve el sentinel de ServerValue.TIMESTAMP en cualquier nivel del objeto
function resolveServerValues(value) {
    if (value && typeof value === "object") {
        if (value[".sv"] === "timestamp") return Date.now();
        if (Array.isArray(value)) return value.map(resolveServerValues);
        const out = {};
        Object.keys(value).forEach(k => { out[k] = resolveServerValues(value[k]); });
        return out;
    }
    return value;
}

// ¿Un cambio en `changedPath` puede afectar lo que ve un suscriptor en `subPath`?
// (uno es prefijo del otro, en cualquier dirección — igual que Firebase)
function pathsRelated(subPath, changedPath) {
    const a = normalize(subPath).split("/").filter(Boolean);
    const b = normalize(changedPath).split("/").filter(Boolean);
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

// ---------------------------------------------------------
// Express + Socket.IO
// ---------------------------------------------------------
const app = express();
app.use(cors({ origin: ALLOWED_ORIGINS.includes("*") ? true : ALLOWED_ORIGINS }));
app.get("/", (_req, res) => res.send("Mafia de Patos backend OK"));
app.get("/healthz", (_req, res) => res.json({ ok: true, players: Object.keys(getAtPath(state, "game_room/players") || {}).length }));

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
    cors: { origin: ALLOWED_ORIGINS.includes("*") ? true : ALLOWED_ORIGINS, methods: ["GET", "POST"] }
});

const valueSubs = new Map();      // path -> Set<socket>
const childAddedSubs = new Map(); // path -> Set<socket>

function notifyChange(changedPath) {
    for (const [subPath, sockets] of valueSubs.entries()) {
        if (!pathsRelated(subPath, changedPath)) continue;
        const val = getAtPath(state, subPath);
        const payload = { path: subPath, data: val === undefined ? null : val };
        sockets.forEach(sock => sock.emit("value", payload));
    }
}

io.on("connection", (socket) => {
    socket.data.onDisconnectOps = [];

    socket.on("subscribe:value", (rawPath) => {
        const path = normalize(rawPath);
        if (!valueSubs.has(path)) valueSubs.set(path, new Set());
        valueSubs.get(path).add(socket);
        const val = getAtPath(state, path);
        socket.emit("value", { path, data: val === undefined ? null : val });
    });

    socket.on("subscribe:childAdded", (rawPath) => {
        const path = normalize(rawPath);
        if (!childAddedSubs.has(path)) childAddedSubs.set(path, new Set());
        childAddedSubs.get(path).add(socket);
        const node = getAtPath(state, path);
        if (node && typeof node === "object") {
            Object.keys(node).forEach(key => {
                socket.emit("child_added", { path, key, data: node[key] });
            });
        }
    });

    socket.on("unsubscribe", (rawPath) => {
        const path = normalize(rawPath);
        valueSubs.get(path)?.delete(socket);
        childAddedSubs.get(path)?.delete(socket);
    });

    socket.on("db:get", ({ path }, ack) => {
        const val = getAtPath(state, path);
        ack && ack({ data: val === undefined ? null : val });
    });

    socket.on("db:set", ({ path, value }, ack) => {
        try {
            fullSetAtPath(state, path, resolveServerValues(value));
            notifyChange(normalize(path));
            schedulePersist();
            ack && ack({ ok: true });
        } catch (err) {
            ack && ack({ error: err.message });
        }
    });

    socket.on("db:push", ({ path, key, value }) => {
        const parent = normalize(path);
        const fullPath = parent ? `${parent}/${key}` : key;
        fullSetAtPath(state, fullPath, resolveServerValues(value));
        const subs = childAddedSubs.get(parent);
        if (subs) {
            const childVal = getAtPath(state, fullPath);
            subs.forEach(s => s.emit("child_added", { path: parent, key, data: childVal }));
        }
        notifyChange(fullPath);
        schedulePersist();
    });

    socket.on("db:update", ({ path, updates }, ack) => {
        try {
            const base = normalize(path);
            Object.keys(updates).forEach(key => {
                const full = base ? `${base}/${key}` : key;
                fullSetAtPath(state, full, resolveServerValues(updates[key]));
                notifyChange(full);
            });
            schedulePersist();
            ack && ack({ ok: true });
        } catch (err) {
            ack && ack({ error: err.message });
        }
    });

    socket.on("db:remove", ({ path }, ack) => {
        try {
            fullSetAtPath(state, path, null);
            notifyChange(normalize(path));
            schedulePersist();
            ack && ack({ ok: true });
        } catch (err) {
            ack && ack({ error: err.message });
        }
    });

    // onDisconnect: igual que Firebase, se registra ahora y se ejecuta
    // automáticamente cuando este socket se desconecte.
    socket.on("db:onDisconnect:update", ({ path, data }) => {
        socket.data.onDisconnectOps.push({ type: "update", path: normalize(path), data });
    });
    socket.on("db:onDisconnect:remove", ({ path }) => {
        socket.data.onDisconnectOps.push({ type: "remove", path: normalize(path) });
    });
    socket.on("db:onDisconnect:cancel", ({ path }) => {
        const path2 = normalize(path);
        socket.data.onDisconnectOps = socket.data.onDisconnectOps.filter(op => op.path !== path2);
    });

    socket.on("disconnect", () => {
        for (const set of valueSubs.values()) set.delete(socket);
        for (const set of childAddedSubs.values()) set.delete(socket);

        const ops = socket.data.onDisconnectOps || [];
        if (!ops.length) return;

        ops.forEach(op => {
            if (op.type === "update") {
                const resolved = resolveServerValues(op.data) || {};
                Object.keys(resolved).forEach(field => {
                    fullSetAtPath(state, `${op.path}/${field}`, resolved[field]);
                });
                notifyChange(op.path);
            } else if (op.type === "remove") {
                fullSetAtPath(state, op.path, null);
                notifyChange(op.path);
            }
        });
        schedulePersist();
    });
});

// ---------------------------------------------------------
// Arranque
// ---------------------------------------------------------
async function start() {
    await ensureSchema();
    await loadState();
    httpServer.listen(PORT, () => {
        console.log(`Backend de Mafia de Patos escuchando en puerto ${PORT}`);
    });
}

async function gracefulShutdown(signal) {
    console.log(`Recibido ${signal}, guardando estado antes de salir...`);
    await persistNow();
    process.exit(0);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

start().catch(err => {
    console.error("Error fatal al iniciar el servidor:", err);
    process.exit(1);
});
