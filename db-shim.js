// ==========================================================
// db-shim.js
// ----------------------------------------------------------
// Reemplazo ligero del SDK de Firebase Realtime Database.
// Expone la MISMA API que usa app.js (ref/.set/.update/.push/
// .once/.on/.off/.onDisconnect/ServerValue.TIMESTAMP/.info/connected)
// pero en vez de hablar con Firebase, habla con nuestro propio
// backend (Node.js + Socket.IO + MySQL).
//
// Gracias a esto, app.js no necesitó reescribirse: solo cambió
// el bloque de configuración inicial.
// ==========================================================
(function (global) {
    const SERVER_URL = global.MAFIA_BACKEND_URL || "http://localhost:3000";

    const socket = global.io(SERVER_URL, {
        transports: ["websocket", "polling"]
    });

    // ---------- utilidades de rutas ----------
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

    // ID estilo push() de Firebase: ordenable por tiempo + aleatorio
    function generatePushId() {
        return "k" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }

    function makeSnapshot(path, val) {
        const value = val === undefined ? null : val;
        return {
            val: () => value,
            exists: () => value !== null && value !== undefined,
            key: lastKeyOf(path)
        };
    }

    // ---------- estado de listeners locales ----------
    const valueListeners = {};       // path -> Set<callback>
    const childAddedListeners = {};  // path -> Set<callback>
    const childAddedSeen = {};       // path -> Set<key> (evita duplicados al re-suscribir)

    let isConnected = false;
    const connInfoListeners = new Set();

    socket.on("connect", () => {
        isConnected = true;
        connInfoListeners.forEach(cb => cb(makeSnapshot(".info/connected", true)));
        // Al reconectar (p.ej. tras una caída de wifi), volvemos a suscribir
        // todo lo que estaba activo, igual que hace el SDK real de Firebase.
        Object.keys(valueListeners).forEach(p => socket.emit("subscribe:value", p));
        Object.keys(childAddedListeners).forEach(p => socket.emit("subscribe:childAdded", p));
    });

    socket.on("disconnect", () => {
        isConnected = false;
    });

    socket.on("value", ({ path, data }) => {
        const set = valueListeners[path];
        if (!set) return;
        const snap = makeSnapshot(path, data);
        set.forEach(cb => cb(snap));
    });

    socket.on("child_added", ({ path, key, data }) => {
        const seen = childAddedSeen[path] || (childAddedSeen[path] = new Set());
        if (seen.has(key)) return;
        seen.add(key);
        const set = childAddedListeners[path];
        if (!set) return;
        const childPath = path ? `${path}/${key}` : key;
        const snap = makeSnapshot(childPath, data);
        set.forEach(cb => cb(snap));
    });

    // ---------- fábrica de referencias ----------
    function ref(rawPath) {
        const path = normalize(rawPath);

        // Caso especial: '.info/connected' (igual que en Firebase real)
        if (path === ".info/connected") {
            return {
                key: null,
                on(eventType, cb) {
                    if (eventType !== "value") return;
                    connInfoListeners.add(cb);
                    cb(makeSnapshot(".info/connected", isConnected));
                },
                off() { connInfoListeners.clear(); },
                once() {
                    return Promise.resolve(makeSnapshot(".info/connected", isConnected));
                }
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
                        if (res && res.error) {
                            if (callback) callback(res.error);
                            return reject(res.error);
                        }
                        if (callback) callback(null);
                        resolve();
                    });
                });
                return p;
            },

            remove(callback) {
                return new Promise((resolve, reject) => {
                    socket.emit("db:remove", { path }, (res) => {
                        if (res && res.error) {
                            if (callback) callback(res.error);
                            return reject(res.error);
                        }
                        if (callback) callback(null);
                        resolve();
                    });
                });
            },

            push(value) {
                const newKey = generatePushId();
                const childPath = path ? `${path}/${newKey}` : newKey;
                if (value !== undefined) {
                    socket.emit("db:push", { path, key: newKey, value });
                }
                return ref(childPath);
            },

            once(eventType) {
                return new Promise((resolve) => {
                    socket.emit("db:get", { path }, (res) => {
                        resolve(makeSnapshot(path, res ? res.data : undefined));
                    });
                });
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
                    update(data) {
                        socket.emit("db:onDisconnect:update", { path, data });
                        return Promise.resolve();
                    },
                    remove() {
                        socket.emit("db:onDisconnect:remove", { path });
                        return Promise.resolve();
                    },
                    cancel() {
                        socket.emit("db:onDisconnect:cancel", { path });
                        return Promise.resolve();
                    }
                };
            }
        };
    }

    // ---------- objeto global `firebase` compatible ----------
    function database() {
        return { ref };
    }
    database.ServerValue = { TIMESTAMP: { ".sv": "timestamp" } };

    global.firebase = {
        initializeApp() {},
        database
    };
})(window);
