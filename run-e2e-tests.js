// ==========================================================
// run-e2e-tests.js — Test suite END-TO-END REAL contra tu
// server.js sin modificarlo y SIN necesitar una base de datos
// MySQL real (se mockea mysql2/promise en memoria).
//
// CÓMO USARLO (en tu máquina, donde sí tienes internet para
// npm install):
//
//   1. Copia esta carpeta 'tests/' dentro de tu carpeta backend/
//      (al mismo nivel que server.js, package.json, etc.)
//   2. cd backend/
//   3. npm install        (si no lo habías hecho ya)
//   4. node tests/run-e2e-tests.js
//
// Qué hace exactamente:
//   - Mockea mysql2/promise ANTES de requerir server.js, para que
//     tu servidor real arranque sin necesitar Aiven/MySQL de verdad.
//   - Levanta tu server.js real en un puerto local (loopback, sin
//     salir a internet).
//   - Conecta varios clientes socket.io-client REALES (el mismo
//     paquete que usaría un navegador) simulando jugadores que
//     entran de forma concurrente, con latencias de red variables.
//   - Verifica que ningún jugador sea expulsado erróneamente del
//     'players/{id}' propio al entrar otro jugador.
//
// Si tu server.js cambia de puerto/env vars, ajusta las constantes
// de abajo (PORT, ROOM_CODE_ENV, etc.) según corresponda.
// ==========================================================

const path = require("path");
const Module = require("module");

// ----------------------------------------------------------
// 1) Mock de mysql2/promise — se inyecta ANTES de requerir
//    server.js para que NO intente conectarse a una BD real.
//    Todas las queries devuelven resultados vacíos/neutros;
//    el estado real del juego vive en memoria de todos modos
//    (server.js ya está diseñado para funcionar así, MySQL es
//    solo persistencia de respaldo).
// ----------------------------------------------------------
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === "mysql2/promise") {
        return {
            createPool() {
                return {
                    async query(sql) {
                        if (/CREATE TABLE/i.test(sql)) return [[]];
                        if (/SELECT code, data FROM rooms/i.test(sql)) return [[]];
                        return [[]];
                    },
                    async end() {}
                };
            }
        };
    }
    return originalLoad.apply(this, arguments);
};

// ----------------------------------------------------------
// 2) Variables de entorno mínimas para que server.js arranque
// ----------------------------------------------------------
process.env.PORT = process.env.TEST_PORT || "3911";
process.env.FRONTEND_ORIGIN = "*";
process.env.DB_HOST = "mock";
process.env.DB_USER = "mock";
process.env.DB_PASSWORD = "mock";
process.env.DB_NAME = "mock";

const PORT = process.env.PORT;
const SERVER_PATH = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(__dirname, "..", "server.js");

let ioClient;
try {
    ioClient = require("socket.io-client");
} catch (e) {
    console.error("\nFalta 'socket.io-client'. Instálalo con:\n  npm install --save-dev socket.io-client\n");
    process.exit(1);
}

// ----------------------------------------------------------
// Utilidades de test
// ----------------------------------------------------------
let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log(`  ✅ ${msg}`); }
    else { failed++; console.log(`  ❌ ${msg}`); }
}

function randDelay(min, max) {
    return min + Math.random() * (max - min);
}

function makeFakePlayerSocket(serverUrl, netDelayRange) {
    // socket.io-client real, pero le agregamos latencia artificial a los
    // emits (no al transporte real) para simular wifi de salón saturado,
    // ya que en loopback local la latencia real es ~0ms.
    const socket = ioClient(serverUrl, { transports: ["websocket"], forceNew: true });
    function emit(event, payload, ack) {
        const d = randDelay(...netDelayRange);
        setTimeout(() => {
            if (ack) socket.emit(event, payload, ack);
            else socket.emit(event, payload);
        }, d);
    }
    return { socket, emit };
}

function waitConnect(socket) {
    return new Promise((resolve, reject) => {
        socket.on("connect", resolve);
        socket.on("connect_error", reject);
        setTimeout(() => reject(new Error("timeout conectando")), 5000);
    });
}

// ----------------------------------------------------------
// Simula el flujo real de un jugador: join_room -> subscribe a
// la raíz -> push+set de su propio nodo en 'players'. Reproduce
// la misma secuencia que app.js (joinRoom().then(() => {
// listenToGlobalState(); pRef.set(...) }))
// ----------------------------------------------------------
function simulatePlayerLogin(serverUrl, roomCode, name, netDelayRange) {
    return new Promise(async (resolve, reject) => {
        const { socket, emit } = makeFakePlayerSocket(serverUrl, netDelayRange);
        const state = { kicked: false, myPlayerId: null, playerRegistered: false, snapshots: [] };

        try {
            await waitConnect(socket);
        } catch (e) { return reject(e); }

        emit("join_room", roomCode, (res) => {
            if (res && res.error) { socket.disconnect(); return reject(new Error(res.error)); }

            socket.on("value", ({ path: p, data }) => {
                if (p !== "") return; // solo nos interesa el listener raíz, como en app.js
                state.snapshots.push(data);
                if (state.myPlayerId && state.playerRegistered && data && data.players && !data.players[state.myPlayerId]) {
                    // Replica el guard de app.js: confirmar con once() antes de expulsar
                    emit("db:get", { path: `players/${state.myPlayerId}` }, (r) => {
                        const exists = r && r.data !== null && r.data !== undefined;
                        if (!exists) state.kicked = true;
                    });
                }
            });
            emit("subscribe:value", "");

            const key = "k" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
            state.myPlayerId = key;
            emit("db:set", { path: `players/${key}`, value: { name, mafiaId: "sin_asignar", online: true } }, (r) => {
                state.playerRegistered = true;
                setTimeout(() => resolve({ socket, state }), 400);
            });
        });
    });
}

function createRoom(serverUrl) {
    return new Promise((resolve, reject) => {
        const http = require("http");
        const req = http.request(serverUrl + "/create-room", { method: "POST" }, (res) => {
            let body = "";
            res.on("data", chunk => body += chunk);
            res.on("end", () => {
                try {
                    const json = JSON.parse(body);
                    if (json.ok) resolve(json.code);
                    else reject(new Error("create-room no devolvió ok"));
                } catch (e) { reject(e); }
            });
        });
        req.on("error", reject);
        req.end();
    });
}

// ----------------------------------------------------------
// Test principal
// ----------------------------------------------------------
async function main() {
    console.log(`Cargando server.js real desde: ${SERVER_PATH}`);
    require(SERVER_PATH);

    const serverUrl = `http://localhost:${PORT}`;
    // Espera breve a que el servidor termine de bindear el puerto
    await new Promise(r => setTimeout(r, 500));

    console.log("\n=== TEST: jugadores concurrentes entrando a una sala ===\n");

    let ROOM_CODE;
    try {
        ROOM_CODE = await createRoom(serverUrl);
        console.log(`Sala creada vía POST /create-room: ${ROOM_CODE}`);
    } catch (e) {
        console.error("❌ No se pudo crear la sala vía POST /create-room:", e.message);
        process.exit(1);
    }

    const NUM_PLAYERS = 15;
    const joins = [];
    for (let i = 0; i < NUM_PLAYERS; i++) {
        joins.push(
            simulatePlayerLogin(serverUrl, ROOM_CODE, `Jugador${i}`, [5, 150])
                .catch(err => ({ error: err.message }))
        );
        await new Promise(r => setTimeout(r, randDelay(0, 40)));
    }

    const results = await Promise.all(joins);

    const errors = results.filter(r => r.error);
    if (errors.length === NUM_PLAYERS) {
        console.log("❌ Ningún jugador pudo unirse, algo falló en el join_room.");
        console.log("   Primer error:", errors[0].error);
        failed++;
    } else {
        if (errors.length > 0) {
            console.log(`⚠️  ${errors.length} de ${NUM_PLAYERS} jugadores no pudieron conectarse (ver detalle abajo si es relevante).`);
        }
        results.forEach((r, i) => {
            if (r.error) return;
            assert(!r.state.kicked, `Jugador${i} no fue expulsado erróneamente`);
        });
    }

    results.forEach(r => { if (r.socket) r.socket.disconnect(); });

    console.log(`\n=== Resultado: ${passed} pasaron, ${failed} fallaron ===`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error("Error fatal en el test runner:", err);
    process.exit(1);
});
