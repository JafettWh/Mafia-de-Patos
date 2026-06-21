// ==========================================================
// server.js — Backend de "Mafia de Patos" con sistema de salas
// ----------------------------------------------------------
// Cada partida vive en una sala con código único de 6 caracteres.
// El admin crea la sala; los jugadores entran con el código.
// El estado de CADA sala es independiente en memoria y en MySQL.
// ==========================================================

require("dotenv").config();
const express = require("express");
const http    = require("http");
const cors    = require("cors");
const { Server } = require("socket.io");
const mysql   = require("mysql2/promise");

const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.FRONTEND_ORIGIN || "*")
    .split(",").map(s => s.trim()).filter(Boolean);

// ---------------------------------------------------------
// MySQL
// ---------------------------------------------------------
const pool = mysql.createPool({
    host:     process.env.DB_HOST,
    port:     Number(process.env.DB_PORT || 3306),
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : undefined,
    waitForConnections: true,
    connectionLimit: 5
});

// rooms: { [roomCode]: { state: {}, valueSubs: Map, childAddedSubs: Map } }
const rooms = {};

async function ensureSchema() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS rooms (
            code VARCHAR(10) PRIMARY KEY,
            data JSON NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    `);
}

async function loadRooms() {
    const [rows] = await pool.query("SELECT code, data FROM rooms");
    for (const row of rows) {
        const state = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
        rooms[row.code] = makeRoom(state);
    }
    console.log(`Salas cargadas desde MySQL: ${Object.keys(rooms).length}`);
}

function makeRoom(initialState = {}) {
    return {
        state: initialState,
        valueSubs: new Map(),
        childAddedSubs: new Map(),
        persistTimer: null
    };
}

function schedulePersist(code) {
    const room = rooms[code];
    if (!room) return;
    if (room.persistTimer) return;
    room.persistTimer = setTimeout(async () => {
        room.persistTimer = null;
        try {
            await pool.query(
                "INSERT INTO rooms (code, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)",
                [code, JSON.stringify(room.state)]
            );
        } catch (err) {
            console.error(`Error guardando sala ${code}:`, err.message);
        }
    }, 400);
}

async function persistAllNow() {
    for (const [code, room] of Object.entries(rooms)) {
        try {
            await pool.query(
                "INSERT INTO rooms (code, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)",
                [code, JSON.stringify(room.state)]
            );
        } catch (err) {
            console.error(`Error guardando sala ${code}:`, err.message);
        }
    }
}

// ---------------------------------------------------------
// Utilidades de rutas
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
    if (value === null || value === undefined) delete cur[lastKey];
    else cur[lastKey] = value;
}

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

function pathsRelated(subPath, changedPath) {
    const a = normalize(subPath).split("/").filter(Boolean);
    const b = normalize(changedPath).split("/").filter(Boolean);
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

// exactOnly=true: notifica solo a suscriptores en changedPath o descendientes,
// NO a ancestros. Evita que set() de un jugador dispare el listener raíz.
function notifyChange(room, changedPath, exactOnly = false) {
    for (const [subPath, sockets] of room.valueSubs.entries()) {
        if (exactOnly) {
            const a = normalize(subPath).split("/").filter(Boolean);
            const b = normalize(changedPath).split("/").filter(Boolean);
            if (b.length > a.length) continue;
            let match = true;
            for (let i = 0; i < b.length; i++) {
                if (a[i] !== b[i]) { match = false; break; }
            }
            if (!match) continue;
        } else {
            if (!pathsRelated(subPath, changedPath)) continue;
        }
        const val = getAtPath(room.state, subPath);
        const payload = { path: subPath, data: val === undefined ? null : val };
        sockets.forEach(sock => sock.emit("value", payload));
    }
}

// Genera código de sala: 6 caracteres alfanuméricos en mayúsculas
function generateRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code;
    do {
        code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    } while (rooms[code]);
    return code;
}

// ---------------------------------------------------------
// Express
// ---------------------------------------------------------
const app = express();
app.use(express.json());
app.use(cors({ origin: ALLOWED_ORIGINS.includes("*") ? true : ALLOWED_ORIGINS }));

app.get("/", (_req, res) => res.send("Mafia de Patos backend OK"));

app.get("/healthz", (_req, res) => {
    const roomList = Object.entries(rooms).map(([code, r]) => ({
        code,
        players: Object.keys(getAtPath(r.state, "players") || {}).length,
        phase: getAtPath(r.state, "currentPhase") || "LOGIN"
    }));
    res.json({ ok: true, rooms: roomList });
});

// El admin crea una sala nueva
app.post("/create-room", (_req, res) => {
    const code = generateRoomCode();
    rooms[code] = makeRoom({
        currentPhase: "LOGIN",
        round: 0,
        players: null,
        mafias: null,
        votes: null,
        chats: null,
        global_leader_chat: null,
        lastRoundLogs: [],
        currentEvent: null,
        timerEndTime: null
    });
    schedulePersist(code);
    res.json({ ok: true, code });
});

// Verifica si un código de sala existe
app.get("/room/:code", (req, res) => {
    const code = req.params.code.toUpperCase();
    if (rooms[code]) {
        res.json({ ok: true, phase: getAtPath(rooms[code].state, "currentPhase") || "LOGIN" });
    } else {
        res.status(404).json({ ok: false, error: "Sala no encontrada" });
    }
});

// Reset completo de una sala
app.post("/room/:code/reset", (req, res) => {
    const code = req.params.code.toUpperCase();
    const room = rooms[code];
    if (!room) return res.status(404).json({ ok: false, error: "Sala no encontrada" });
    room.state = {
        currentPhase: "LOGIN", round: 0,
        players: null, mafias: null, votes: null,
        chats: null, global_leader_chat: null,
        lastRoundLogs: [], currentEvent: null, timerEndTime: null
    };
    schedulePersist(code);
    notifyChange(room, "", false);
    res.json({ ok: true });
});

// Eliminar sala completamente
app.delete("/room/:code", async (req, res) => {
    const code = req.params.code.toUpperCase();
    if (rooms[code]) {
        // Desconectar todos los sockets de esa sala
        for (const sockets of rooms[code].valueSubs.values()) {
            sockets.forEach(s => s.emit("room_deleted"));
        }
        delete rooms[code];
        try { await pool.query("DELETE FROM rooms WHERE code = ?", [code]); } catch(e) {}
    }
    res.json({ ok: true });
});

// ---------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
    cors: { origin: ALLOWED_ORIGINS.includes("*") ? true : ALLOWED_ORIGINS, methods: ["GET","POST"] }
});

io.on("connection", (socket) => {
    socket.data.roomCode    = null;
    socket.data.onDisconnectOps = [];

    // El cliente se une a una sala específica
    socket.on("join_room", (code, ack) => {
        const roomCode = (code || "").toUpperCase();
        if (!rooms[roomCode]) {
            return ack && ack({ error: "Sala no encontrada" });
        }
        socket.data.roomCode = roomCode;
        ack && ack({ ok: true });
    });

    function getRoom() {
        return rooms[socket.data.roomCode];
    }

    socket.on("subscribe:value", (rawPath) => {
        const room = getRoom(); if (!room) return;
        const path = normalize(rawPath);
        if (!room.valueSubs.has(path)) room.valueSubs.set(path, new Set());
        room.valueSubs.get(path).add(socket);
        const val = getAtPath(room.state, path);
        socket.emit("value", { path, data: val === undefined ? null : val });
    });

    socket.on("subscribe:childAdded", (rawPath) => {
        const room = getRoom(); if (!room) return;
        const path = normalize(rawPath);
        if (!room.childAddedSubs.has(path)) room.childAddedSubs.set(path, new Set());
        room.childAddedSubs.get(path).add(socket);
        const node = getAtPath(room.state, path);
        if (node && typeof node === "object") {
            Object.keys(node).forEach(key => {
                socket.emit("child_added", { path, key, data: node[key] });
            });
        }
    });

    socket.on("unsubscribe", (rawPath) => {
        const room = getRoom(); if (!room) return;
        const path = normalize(rawPath);
        room.valueSubs.get(path)?.delete(socket);
        room.childAddedSubs.get(path)?.delete(socket);
    });

    socket.on("db:get", ({ path }, ack) => {
        const room = getRoom(); if (!room) return;
        const val = getAtPath(room.state, path);
        ack && ack({ data: val === undefined ? null : val });
    });

    socket.on("db:set", ({ path, value }, ack) => {
        const room = getRoom(); if (!room) return;
        try {
            fullSetAtPath(room.state, path, resolveServerValues(value));
            notifyChange(room, normalize(path), true);
            schedulePersist(socket.data.roomCode);
            ack && ack({ ok: true });
        } catch (err) { ack && ack({ error: err.message }); }
    });

    socket.on("db:push", ({ path, key, value }) => {
        const room = getRoom(); if (!room) return;
        const parent   = normalize(path);
        const fullPath = parent ? `${parent}/${key}` : key;
        fullSetAtPath(room.state, fullPath, resolveServerValues(value));
        const subs = room.childAddedSubs.get(parent);
        if (subs) {
            const childVal = getAtPath(room.state, fullPath);
            subs.forEach(s => s.emit("child_added", { path: parent, key, data: childVal }));
        }
        // exactOnly: no notifica a suscriptores ancestros
        const exactSubs = room.valueSubs.get(parent);
        if (exactSubs) {
            const parentVal = getAtPath(room.state, parent);
            exactSubs.forEach(s => s.emit("value", { path: parent, data: parentVal ?? null }));
        }
        schedulePersist(socket.data.roomCode);
    });

    socket.on("db:update", ({ path, updates }, ack) => {
        const room = getRoom(); if (!room) return;
        try {
            const base = normalize(path);
            Object.keys(updates).forEach(key => {
                const full = base ? `${base}/${key}` : key;
                fullSetAtPath(room.state, full, resolveServerValues(updates[key]));
                notifyChange(room, full);
            });
            schedulePersist(socket.data.roomCode);
            ack && ack({ ok: true });
        } catch (err) { ack && ack({ error: err.message }); }
    });

    socket.on("db:remove", ({ path }, ack) => {
        const room = getRoom(); if (!room) return;
        try {
            fullSetAtPath(room.state, path, null);
            notifyChange(room, normalize(path));
            schedulePersist(socket.data.roomCode);
            ack && ack({ ok: true });
        } catch (err) { ack && ack({ error: err.message }); }
    });

    socket.on("db:onDisconnect:update", ({ path, data }) => {
        socket.data.onDisconnectOps.push({ type: "update", path: normalize(path), data });
    });
    socket.on("db:onDisconnect:remove", ({ path }) => {
        socket.data.onDisconnectOps.push({ type: "remove", path: normalize(path) });
    });
    socket.on("db:onDisconnect:cancel", ({ path }) => {
        const p2 = normalize(path);
        socket.data.onDisconnectOps = socket.data.onDisconnectOps.filter(op => op.path !== p2);
    });

    socket.on("disconnect", () => {
        const room = getRoom();
        if (room) {
            for (const set of room.valueSubs.values()) set.delete(socket);
            for (const set of room.childAddedSubs.values()) set.delete(socket);
        }
        const ops = socket.data.onDisconnectOps || [];
        if (!ops.length || !room) return;
        ops.forEach(op => {
            if (op.type === "update") {
                const resolved = resolveServerValues(op.data) || {};
                Object.keys(resolved).forEach(field => {
                    fullSetAtPath(room.state, `${op.path}/${field}`, resolved[field]);
                });
                notifyChange(room, op.path);
            } else if (op.type === "remove") {
                fullSetAtPath(room.state, op.path, null);
                notifyChange(room, op.path);
            }
        });
        schedulePersist(socket.data.roomCode);
    });
});

// ---------------------------------------------------------
// Arranque
// ---------------------------------------------------------
async function start() {
    await ensureSchema();
    await loadRooms();
    httpServer.listen(PORT, () => {
        console.log(`Backend de Mafia de Patos escuchando en puerto ${PORT}`);
    });
}

async function gracefulShutdown(signal) {
    console.log(`Recibido ${signal}, guardando estado...`);
    await persistAllNow();
    process.exit(0);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));

start().catch(err => {
    console.error("Error fatal al iniciar el servidor:", err);
    process.exit(1);
});
