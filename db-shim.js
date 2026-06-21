// ==========================================================
// db-shim.js — Mafia de Patos (sistema de salas)
// ----------------------------------------------------------
// Reemplaza el SDK de Firebase. Ahora incluye join_room:
// el cliente envía el código de sala al conectarse y todas
// las operaciones de DB quedan aisladas a esa sala.
// ==========================================================
(function (global) {
    const SERVER_URL = global.MAFIA_BACKEND_URL || "http://localhost:3000";

    const socket = global.io(SERVER_URL, {
        transports: ["websocket", "polling"]
    });

    function normalize(path) {
        return (path || "").toString().replace(/^\/+|\/+$/g, "");
    }
    function getAtPath(obj, path) {
        const parts = normalize(path).split("/").filter(Boolean);
        let cur = obj;
        for (const p of parts) {
            if (cur === null || cur === undefined) return undefined;
            cur = cur[p];
        }
        return cur;
    }
    function lastKeyOf(path) {
        const parts = normalize(path).split("/").filter(Boolean);
        return parts.length ? parts[parts.length - 1] : null;
    }
    function generatePushId() {
        return "k" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }
    function makeSnapshot(path, val) {
        const value = val === undefined ? null : val;
        return { val: () => value, exists: () => value !== null && value !== undefined, key: lastKeyOf(path) };
    }

    const valueListeners    = {};
    const childAddedListeners = {};
    const childAddedSeen    = {};
    let isConnected = false;
    const connInfoListeners = new Set();
    let currentRoomCode = null;

    // Unirse a una sala. Devuelve una Promise.
    function joinRoom(code) {
        currentRoomCode = code.toUpperCase();
        return new Promise((resolve, reject) => {
            socket.emit("join_room", currentRoomCode, (res) => {
                if (res && res.error) return reject(new Error(res.error));
                // Re-suscribir listeners activos a la nueva sala
                Object.keys(valueListeners).forEach(p => socket.emit("subscribe:value", p));
                Object.keys(childAddedListeners).forEach(p => socket.emit("subscribe:childAdded", p));
                resolve();
            });
        });
    }

    socket.on("connect", () => {
        isConnected = true;
        connInfoListeners.forEach(cb => cb(makeSnapshot(".info/connected", true)));
        if (currentRoomCode) {
            socket.emit("join_room", currentRoomCode, () => {
                Object.keys(valueListeners).forEach(p => socket.emit("subscribe:value", p));
                Object.keys(childAddedListeners).forEach(p => socket.emit("subscribe:childAdded", p));
            });
        }
    });
    socket.on("disconnect", () => { isConnected = false; connInfoListeners.forEach(cb => cb(makeSnapshot(".info/connected", false))); });
    socket.on("room_deleted", () => { global.dispatchEvent(new Event("mafia_room_deleted")); });

    socket.on("value", ({ path, data }) => {
        const set = valueListeners[path]; if (!set) return;
        set.forEach(cb => cb(makeSnapshot(path, data)));
    });
    socket.on("child_added", ({ path, key, data }) => {
        const seen = childAddedSeen[path] || (childAddedSeen[path] = new Set());
        if (seen.has(key)) return;
        seen.add(key);
        const set = childAddedListeners[path]; if (!set) return;
        const childPath = path ? `${path}/${key}` : key;
        set.forEach(cb => cb(makeSnapshot(childPath, data)));
    });

    function ref(rawPath) {
        const path = normalize(rawPath);
        if (path === ".info/connected") {
            return {
                key: null,
                on(eventType, cb) {
                    if (eventType !== "value") return;
                    connInfoListeners.add(cb);
                    cb(makeSnapshot(".info/connected", isConnected));
                },
                off() { connInfoListeners.clear(); },
                once() { return Promise.resolve(makeSnapshot(".info/connected", isConnected)); }
            };
        }
        return {
            key: lastKeyOf(path),
            set(value) {
                return new Promise((resolve, reject) => {
                    socket.emit("db:set", { path, value }, (res) => {
                        if (res && res.error) return reject(res.error);
                        resolve();
                    });
                });
            },
            update(updates, callback) {
                const p = new Promise((resolve, reject) => {
                    socket.emit("db:update", { path, updates }, (res) => {
                        if (res && res.error) { if (callback) callback(res.error); return reject(res.error); }
                        if (callback) callback(null);
                        resolve();
                    });
                });
                return p;
            },
            remove(callback) {
                return new Promise((resolve, reject) => {
                    socket.emit("db:remove", { path }, (res) => {
                        if (res && res.error) { if (callback) callback(res.error); return reject(res.error); }
                        if (callback) callback(null);
                        resolve();
                    });
                });
            },
            push(value) {
                const newKey = generatePushId();
                const childPath = path ? `${path}/${newKey}` : newKey;
                if (value !== undefined) socket.emit("db:push", { path, key: newKey, value });
                return ref(childPath);
            },
            once(eventType, callback) {
                const p = new Promise((resolve) => {
                    socket.emit("db:get", { path }, (res) => {
                        resolve(makeSnapshot(path, res ? res.data : undefined));
                    });
                });
                if (typeof callback === "function") p.then(callback);
                return p;
            },
            on(eventType, cb) {
                if (eventType === "value") {
                    if (!valueListeners[path]) valueListeners[path] = new Set();
                    valueListeners[path].add(cb);
                    socket.emit("subscribe:value", path);
                } else if (eventType === "child_added") {
                    if (!childAddedListeners[path]) childAddedListeners[path] = new Set();
                    childAddedListeners[path].add(cb);
                    socket.emit("subscribe:childAdded", path);
                }
            },
            off() {
                delete valueListeners[path];
                delete childAddedListeners[path];
                delete childAddedSeen[path];
                socket.emit("unsubscribe", path);
            },
            onDisconnect() {
                return {
                    update(data) { socket.emit("db:onDisconnect:update", { path, data }); return Promise.resolve(); },
                    remove()     { socket.emit("db:onDisconnect:remove", { path });       return Promise.resolve(); },
                    cancel()     { socket.emit("db:onDisconnect:cancel", { path });       return Promise.resolve(); }
                };
            }
        };
    }

    function database() { return { ref, joinRoom }; }
    database.ServerValue = { TIMESTAMP: { ".sv": "timestamp" } };

    global.firebase = { initializeApp() {}, database };
})(window);
