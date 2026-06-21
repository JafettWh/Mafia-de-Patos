// ==========================================
// CONEXIÓN AL BACKEND PROPIO (Node.js + MySQL)
// ==========================================
// db-shim.js (cargado antes que este archivo en index.html) define un objeto
// `firebase` compatible con la API que usa el resto de este archivo (ref/set/
// update/push/once/on/onDisconnect), pero hablando con nuestro propio servidor
// vía Socket.IO en vez de con Firebase. Así toda la lógica de juego de abajo
// (ya corregida y probada) sigue funcionando sin cambios.
firebase.initializeApp({});
const db = firebase.database();
const ADMIN_PASSWORD = "profe2025";

// ==========================================
// ESTADO GLOBAL
// ==========================================
let myPlayerId         = null;
let myPlayerName       = "";
let currentRoomCode    = null;
let playerRegistered   = false; // true solo después de que pRef.set() confirmó al servidor
let myMafiaId          = null;
let myMafiaName        = "";
let isHost             = false;
let globalGameState    = {};
let timerInterval      = null;
let lastProcessedPhaseKey = "";
let mafiaNameListenerActive = false;
let internalVotesListenerActive = false;

// Referencias de listeners de chat (para limpiarlos)
let chatListenerRef        = null;
let globalLeaderListenerRef= null;
let adminSpyChatRef        = null;
let adminSpyGlobalRef      = null;

// Confirmación de voto: guarda la acción pendiente antes de confirmar
let pendingVoteAction = null;
let pendingVoteTarget = null;

// ==========================================
// ANTI-XSS
// ==========================================
function escapeHTML(str) {
    if (!str) return "";
    return str.toString().replace(/[&<>'"]/g, t => (
        {'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[t] || t
    ));
}

// ==========================================
// AUDIO LAZY (iOS/Android safe)
// ==========================================
const SoundEffects = {
    ctx: null,
    init() {
        try {
            if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
            if (this.ctx.state === 'suspended') this.ctx.resume();
        } catch(e) {}
    },
    play(type) {
        try {
            this.init();
            const osc = this.ctx.createOscillator(), gain = this.ctx.createGain();
            osc.connect(gain); gain.connect(this.ctx.destination);
            const c = { click:{freq:400,vol:0.1,dur:0.05,type:'sine'}, traicion:{freq:140,vol:0.2,dur:0.35,type:'sawtooth'}, victoria:{freq:440,vol:0.15,dur:0.5,type:'sine'} }[type];
            if (!c) return;
            osc.type = c.type;
            osc.frequency.setValueAtTime(c.freq, this.ctx.currentTime);
            gain.gain.setValueAtTime(c.vol, this.ctx.currentTime);
            osc.start(); osc.stop(this.ctx.currentTime + c.dur);
        } catch(e) {}
    }
};

const EVENTOS = [
    { title:"MERCADO EN AUGE",  desc:"Ganancias por Cooperación aumentan 50%.", code:"AUGE" },
    { title:"REDADA POLICIAL",  desc:"Traiciones descubiertas. El traidor pierde $500 extras.", code:"REDADA" },
    { title:"CRISIS ECONÓMICA", desc:"Todas las mafias pierden $200 al inicio.", code:"CRISIS" },
    { title:"LAVADO DE DINERO", desc:"+$10 por cada punto de influencia.", code:"LAVADO" }
];

const ACTION_LABELS = { cooperar:'🤝 Cooperar', traicionar:'🗡️ Traicionar', robar:'🥷 Robar Recursos', alianza:'📜 Pacto Temporal' };
const ACTION_ICONS  = { cooperar:'🤝', traicionar:'🗡️', robar:'🥷', alianza:'📜' };

// ==========================================
// CAMBIO DE PANTALLA (Bypass de Estilos Forzado)
// ==========================================
function changeScreen(id) {
    if (isHost && id !== 'screen-login') return;
    
    console.log("Cambiando de pantalla de forma segura a: " + id);
    
    document.querySelectorAll('.screen').forEach(s => {
        if (s.id === id) {
            s.classList.add('active');
            s.classList.remove('hidden');
            s.style.setProperty('display', 'block', 'important'); 
        } else {
            s.classList.remove('active');
            s.style.setProperty('display', 'none', 'important');  
        }
    });
}

// ==========================================
// INICIALIZACIÓN DOM
// ==========================================
document.addEventListener("DOMContentLoaded", () => {
    // Desbloquear audio en primer toque (iOS)
    ['click','touchstart'].forEach(ev => document.body.addEventListener(ev, () => SoundEffects.init(), {once:true}));

    // Toggle contraseña admin
    document.getElementById('admin-toggle').addEventListener('change', function() {
        document.getElementById('admin-password-box').classList.toggle('hidden', !this.checked);
    });

    document.getElementById('btn-join').addEventListener('click', setupLogin);

    // Controles del admin
    document.getElementById('btn-start-game').addEventListener('click', masterActionStartGame);
    document.getElementById('btn-launch-dashboard').addEventListener('click', masterLaunchRound);
    document.getElementById('btn-force-resolve').addEventListener('click', () => {
        showConfirmModal("¿Forzar resolución de la ronda ahora?", resolveRoundLogic);
    });
    document.getElementById('btn-admin-next').addEventListener('click', masterActionNextRound);
    document.getElementById('btn-end-game-now').addEventListener('click', () => {
        showConfirmModal("¿Terminar la partida ahora con los datos actuales?", masterEndGameNow);
    });
    document.getElementById('btn-reset-game').addEventListener('click', () => {
        showConfirmModal("¿Reset completo? Borra toda la partida.", masterResetEverything);
    });
    document.getElementById('btn-reset-db')?.addEventListener('click', () => {
        showConfirmModal("¿Limpiar sala? Borra todos los jugadores y el estado. Todos verán la pantalla de login.", masterResetDatabase);
    });
    document.getElementById('btn-host-reset-final').addEventListener('click', () => {
        showConfirmModal("¿Iniciar nueva partida? Borra todos los datos.", masterResetEverything);
    });

    // Chat de mafia
    document.getElementById('btn-mafia-chat-send').addEventListener('click', sendMafiaChatMessage);
    document.getElementById('mafia-chat-input').addEventListener('keydown', e => { if(e.key==='Enter') sendMafiaChatMessage(); });

    // Chat de líderes
    document.getElementById('btn-global-leader-send').addEventListener('click', sendGlobalLeaderMessage);
    document.getElementById('global-leader-input').addEventListener('keydown', e => { if(e.key==='Enter') sendGlobalLeaderMessage(); });

    // Spy select del admin
    document.getElementById('admin-spy-target')?.addEventListener('change', function() {
        if (isHost) initAdminSpyChatStreams(this.value);
    });

    // Sistema de votación con confirmación modal
    document.querySelectorAll('.btn-action').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!myPlayerId || !myMafiaId) return;
            const act      = btn.getAttribute('data-action');
            const targetId = document.getElementById('target-mafia').value;
            const targetName = escapeHTML(globalGameState.mafias?.[targetId]?.name || targetId);
            try { SoundEffects.play('click'); } catch(e){}
            pendingVoteAction = act;
            pendingVoteTarget = targetId;
            showVoteConfirmModal(act, targetName);
        });
    });

    // Botones del modal de confirmación de voto
    document.getElementById('btn-confirm-vote').addEventListener('click', () => {
        if (!pendingVoteAction || !pendingVoteTarget) return;
        db.ref(`votes/ronda_${globalGameState.round}/${myPlayerId}`).set({
            player: myPlayerName, mafiaSource: myMafiaId,
            action: pendingVoteAction, target: pendingVoteTarget
        });
        try { SoundEffects.play('click'); } catch(e){}
        document.getElementById('vote-status').innerText = `✅ Voto confirmado: ${ACTION_LABELS[pendingVoteAction]}`;
        document.querySelectorAll('.btn-action').forEach(b => {
            b.classList.toggle('selected', b.getAttribute('data-action') === pendingVoteAction);
        });
        pendingVoteAction = null; pendingVoteTarget = null;
        hideVoteModal();
    });

    document.getElementById('btn-cancel-vote').addEventListener('click', () => {
        pendingVoteAction = null; pendingVoteTarget = null;
        hideVoteModal();
    });

    // Resetear estado de confirmación si cambia el target
    document.getElementById('target-mafia').addEventListener('change', () => {
        pendingVoteAction = null; pendingVoteTarget = null;
    });

    // listenToGlobalState() se llama después de joinRoom(), no aquí
});

// ==========================================
// MODAL DE CONFIRMACIÓN DE VOTO
// ==========================================
function showVoteConfirmModal(action, targetName) {
    document.getElementById('modal-vote-action').innerText = ACTION_LABELS[action];
    document.getElementById('modal-vote-target').innerText = targetName;
    document.getElementById('modal-vote-icon').innerText   = ACTION_ICONS[action];
    document.getElementById('vote-confirm-modal').classList.remove('hidden');
}
function hideVoteModal() {
    document.getElementById('vote-confirm-modal').classList.add('hidden');
}


function returnToLoginScreen() {
    // Reset local player state
    myPlayerId = null;
    myPlayerName = "";
    myMafiaId = null;
    myMafiaName = "";
    isHost = false;

    // Clear UI fields
    const playerNameInput = document.getElementById('player-name');
    if (playerNameInput) playerNameInput.value = '';

    const adminPasswordInput = document.getElementById('admin-password');
    if (adminPasswordInput) adminPasswordInput.value = '';
    document.getElementById('pass-error').classList.add('hidden');

    // Uncheck admin toggle and hide password box
    const adminToggle = document.getElementById('admin-toggle');
    if (adminToggle) adminToggle.checked = false;
    const adminPasswordBox = document.getElementById('admin-password-box');
    if (adminPasswordBox) adminPasswordBox.classList.add('hidden');

    // Hide admin panel and show login area
    const adminArea = document.getElementById('admin-login-area');
    if (adminArea) adminArea.style.setProperty('display', 'block', 'important');

    const mainLogo = document.getElementById('main-logo-area');
    if (mainLogo) mainLogo.style.setProperty('display', 'block', 'important');

    const lobbyStat = document.getElementById('lobby-status');
    if (lobbyStat) lobbyStat.style.setProperty('display', 'block', 'important');

    // Si el bloque de tutorial seguía visible (ej. el admin reseteó mientras alguien
    // leía las reglas), lo ocultamos para volver limpio al formulario de login.
    const tutBlock = document.getElementById('lobby-tutorial-block');
    if (tutBlock) tutBlock.classList.add('hidden');

    // Hide admin panel
    const adminPanel = document.getElementById('admin-panel');
    if (adminPanel) {
        adminPanel.classList.add('hidden');
        adminPanel.style.removeProperty('display');
    }

    // Show login screen
    changeScreen('screen-login');
}

// ==========================================
// MODAL GENÉRICO DE CONFIRMACIÓN (para admin)
// ==========================================
function showConfirmModal(message, onConfirm) {
    document.getElementById('confirm-modal-text').innerText = message;
    const btn = document.getElementById('btn-confirm-action');
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', () => {
        document.getElementById('confirm-modal').classList.add('hidden');
        onConfirm();
    });
    document.getElementById('btn-cancel-action').onclick = () => {
        document.getElementById('confirm-modal').classList.add('hidden');
    };
    document.getElementById('confirm-modal').classList.remove('hidden');
}

// ==========================================
// LOGIN (Corregido y Protegido)
// ==========================================
function setupLogin() {
    const nameIn = document.getElementById('player-name').value.trim();
    if (nameIn.length < 2) return alert("Alias inválido. Mínimo 2 caracteres.");

    const roomCodeInput = document.getElementById('room-code-input');
    const enteredCode = roomCodeInput ? roomCodeInput.value.trim().toUpperCase() : "";

    if (document.getElementById('admin-toggle').checked) {
        if (document.getElementById('admin-password').value !== ADMIN_PASSWORD) {
            document.getElementById('pass-error').classList.remove('hidden');
            document.getElementById('admin-password').value = '';
            return;
        }
        isHost = true;
    }

    if (!isHost && enteredCode.length !== 6) {
        return alert("Ingresa el código de sala de 6 caracteres que te dio el Don.");
    }

    document.getElementById('pass-error').classList.add('hidden');
    myPlayerName = escapeHTML(nameIn);
    try { SoundEffects.play('click'); } catch(e){}

    const doJoin = (code) => {
        const db2 = firebase.database();
        db2.joinRoom(code).then(() => {
            // Ahora que estamos en la sala, activamos el listener global
            listenToGlobalState();
            const pRef = db.ref('players').push();
            myPlayerId = pRef.key;
            pRef.set({ name: myPlayerName, mafiaId: "sin_asignar", online: true, isHost }).then(() => {
                playerRegistered = true;
            });
    // Marcamos que ya "procesamos" la fase actual para que el snapshot inicial
    // (o cualquier snapshot disparado por OTRO jugador entrando justo después) no se
    // interprete como un cambio de fase que deba resetear nuestra pantalla. Sin esto,
    // 'lastProcessedPhaseKey' quedaba en "" durante todo el tutorial, y cualquier
    // jugador nuevo entrando (push a 'players') disparaba el listener global en TODOS
    // los clientes, haciendo que cualquiera que siguiera en el tutorial fuera
    // expulsado de vuelta a la pantalla de login.
            const curPhase = globalGameState.currentPhase || 'LOGIN';
            const curRound = globalGameState.round || 0;
            lastProcessedPhaseKey = `${curPhase}_${curRound}`;
    // IMPORTANTE: NO usamos .remove() aquí. Con 5+ dispositivos en la misma red WiFi
    // de salón, es normal que el router sature su tabla NAT y cierre/recicle sockets
    // brevemente (1-3 segundos) cuando entran conexiones nuevas. Firebase interpreta
    // eso como una desconexión real y ejecuta este callback. Si borráramos el nodo,
    // el jugador perdería su sesión por una simple fluctuación de red, aunque su
    // navegador siga abierto y reconecte solo segundos después.
    // En su lugar, solo lo marcamos 'online: false'; su nodo y su progreso permanecen
    // intactos y se reactiva solo si vuelve a tener actividad.
            pRef.onDisconnect().update({ online: false, disconnectedAt: firebase.database.ServerValue.TIMESTAMP });
            if (!isHost) setupPresenceHandling();

            const adminArea = document.getElementById('admin-login-area');
            if (adminArea) adminArea.style.setProperty('display', 'none', 'important');
            const mainLogo = document.getElementById('main-logo-area');
            if (mainLogo) mainLogo.style.setProperty('display', 'none', 'important');
            const lobbyStat = document.getElementById('lobby-status');
            if (lobbyStat) lobbyStat.style.setProperty('display', 'none', 'important');

            if (isHost) {
                // Mostrar código de sala en el panel admin
                const codeDisplay = document.getElementById('room-code-display');
                if (codeDisplay) codeDisplay.innerText = code;
                const adminPanel = document.getElementById('admin-panel');
                if (adminPanel) {
                    adminPanel.classList.remove('hidden');
                    adminPanel.style.setProperty('display', 'block', 'important');
                }
                updateAdminButtonVisibility('LOGIN');
                setTimeout(() => initAdminSpyChatStreams('mafia_1'), 800);
            } else {
                // El tutorial ahora vive DENTRO de screen-login (ya no es una pantalla
                // aparte). Esto significa que mientras el jugador lee las reglas,
                // 'changeScreen()' nunca se vuelve a invocar para él — por lo tanto,
                // ningún snapshot disparado por otro jugador entrando puede "moverlo"
                // de pantalla por error. Solo ocultamos el formulario y mostramos el
                // bloque de reglas, ambos dentro de la misma screen-login activa.
                const tutBlock = document.getElementById('lobby-tutorial-block');
                if (tutBlock) tutBlock.classList.remove('hidden');
                try {
                    initTutorialLogic();
                    const stepOne = document.querySelector('.tutorial-step[data-step="1"]');
                    if (stepOne) stepOne.style.setProperty('display', 'block', 'important');
                } catch(e) {
                    console.error("Error en tutorial:", e);
                }
            }
        }).catch(err => {
            alert("No se pudo unir a la sala. Verifica el código e intenta de nuevo.");
            console.error(err);
        });
    };

    if (isHost) {
        // El admin crea una sala nueva
        fetch(window.MAFIA_BACKEND_URL + '/create-room', { method: 'POST' })
            .then(r => r.json())
            .then(res => {
                if (!res.ok) return alert("Error al crear sala.");
                currentRoomCode = res.code;
                doJoin(res.code);
            })
            .catch(() => alert("Error de conexión al crear la sala."));
    } else {
        doJoin(enteredCode);
    }
}

// ==========================================
// TUTORIAL
// ==========================================
function initTutorialLogic() {
    let step = 1;
    const total = 4;
    const btnPrev = document.getElementById('btn-tut-prev');
    const btnNext = document.getElementById('btn-tut-next');

    function updateUI() {
        document.querySelectorAll('.tutorial-step').forEach(s => {
            s.style.setProperty('display', parseInt(s.dataset.step) === step ? 'block' : 'none', 'important');
        });
        if (btnPrev) btnPrev.style.display = step === 1 ? 'none' : '';
        if (btnNext) btnNext.innerText = step === total ? "¡Entendido! 🦆" : "Siguiente →";
    }

    btnNext.onclick = () => {
        try { SoundEffects.play('click'); } catch(e){}
        if (step < total) { step++; updateUI(); }
        else {
            finishTutorialAndSync();
        }
    };
    if (btnPrev) {
        btnPrev.onclick = () => { 
            try { SoundEffects.play('click'); } catch(e){}
            if (step > 1) { step--; updateUI(); } 
        };
    }
    updateUI();
}

// ==========================================
// FIN DE TUTORIAL → VOLVER AL ESTADO DE ESPERA DEL LOBBY
// ==========================================
// Por qué se simplificó esto: antes, terminar el tutorial implicaba decidir en el
// momento "¿a qué pantalla voy?" comparando 'globalGameState' y 'myMafiaId' en ese
// instante exacto. Como ambos se actualizan de forma asíncrona, esa decisión podía
// tomarse con datos desfasados (más probable cuantos más jugadores hay conectados
// a la vez), lo que en versiones anteriores llegó a expulsar jugadores por error.
//
// Ahora el tutorial vive DENTRO de 'screen-login' (nunca cambiamos de pantalla para
// mostrarlo), así que terminar el tutorial no necesita decidir nada: solo ocultamos
// el bloque de reglas y mostramos el mensaje de espera, ambos dentro del lobby. El
// listener global (listenToGlobalState → syncGamePhase → ensureMafiaIdThenShowAssignment)
// ya se encarga, con sus propios reintentos robustos, de avanzar a la pantalla de
// asignación en cuanto la fase real cambie y nuestro mafiaId esté listo.
function finishTutorialAndSync() {
    const tutBlock = document.getElementById('lobby-tutorial-block');
    if (tutBlock) tutBlock.classList.add('hidden');

    const lobbyStat = document.getElementById('lobby-status');
    if (lobbyStat) {
        lobbyStat.innerText = "¡Listo! Esperando que el Don asigne sindicatos...";
        lobbyStat.style.setProperty('display', 'block', 'important');
    }

    // Por si la fase ya cambió mientras leíamos las reglas (el admin asignó sindicatos
    // durante esos segundos), forzamos una comprobación inmediata en vez de esperar
    // pasivamente al próximo snapshot del listener global.
    const phase = globalGameState.currentPhase || 'LOGIN';
    if (phase !== 'LOGIN') {
        const phaseKey = `${phase}_${globalGameState.round || 0}`;
        lastProcessedPhaseKey = phaseKey;
        syncGamePhase(phase);
    }
}

// ==========================================
// PRESENCIA / RECONEXIÓN
// ==========================================
// Firebase dispara '.info/connected' cada vez que el socket se conecta o reconecta.
// Tras una micro-caída de WiFi (común con 6+ dispositivos en la misma red de salón),
// el SDK reconecta solo, pero el onDisconnect que registramos al hacer login ya se
// "gastó" (Firebase lo ejecuta una sola vez por conexión). Por eso, en cada reconexión,
// debemos volver a marcarnos online y volver a registrar el onDisconnect.
function setupPresenceHandling() {
    db.ref('.info/connected').on('value', snap => {
        if (snap.val() === true && myPlayerId && !isHost) {
            const pRef = db.ref(`players/${myPlayerId}`);
            pRef.update({ online: true, disconnectedAt: null });
            pRef.onDisconnect().update({ online: false, disconnectedAt: firebase.database.ServerValue.TIMESTAMP });
        }
    });
}

// ==========================================
// LISTENER GLOBAL FIREBASE
// ==========================================
let adminRenderDebounceTimer = null;

function listenToGlobalState() {
    db.ref('').on('value', snapshot => {
        const data = snapshot.val() || {};
        globalGameState = data;

        if (myPlayerId && data.players?.[myPlayerId] && myMafiaId === null) {
            const sid = data.players[myPlayerId].mafiaId;
            if (sid && sid !== "sin_asignar") myMafiaId = sid;
        }

        const phase    = data.currentPhase || 'LOGIN';
        const phaseKey = `${phase}_${data.round || 0}`;

        if (isHost) {
            // Debounce: con muchos jugadores votando/chateando a la vez, este callback
            // se dispara docenas de veces por segundo. Sin debounce, redibujar la tabla
            // completa + el mapa SVG en cada disparo satura el hilo principal y la
            // pantalla del admin parece "reiniciarse" o congelarse.
            if (adminRenderDebounceTimer) clearTimeout(adminRenderDebounceTimer);
            adminRenderDebounceTimer = setTimeout(() => {
                renderMafiaTable('admin-mafia-tbody', data, true);
                updateAdminPanel(data);
                drawWarMap(data);
            }, 200);

            // Estos son ligeros (no recorren listas grandes), se actualizan sin debounce
            updateAdminButtonVisibility(phase);
            document.getElementById('btn-host-reset-final').classList.toggle('hidden', phase !== 'END');
            return;
        }

        // Blindaje: si mi propio nodo de jugador ya no existe en la base de datos
        // (por ejemplo, el admin borró 'players' manualmente desde la consola de Firebase
        // en vez de usar el botón de reset), mi pantalla debe volver a LOGIN aunque
        // 'currentPhase' no haya cambiado.
        //
        // IMPORTANTE: bajo varias escrituras simultáneas (varios jugadores haciendo push()
        // casi al mismo tiempo, típico al llenarse el lobby con 5+ personas), un snapshot
        // de 'on(value)' puede llegar momentáneamente sin reflejar aún la propia escritura
        // de este cliente. Si actuáramos sobre ese snapshot directamente, expulsaríamos
        // jugadores reales por error. Por eso, antes de expulsar, confirmamos con una
        // lectura directa (once) de nuestro propio nodo.
        if (myPlayerId && !isHost && playerRegistered && data.players && !data.players[myPlayerId]) {
            const idToCheck = myPlayerId;
            db.ref(`players/${idToCheck}`).once('value').then(soloSnap => {
                if (soloSnap.exists()) return; // Falso positivo: mi nodo sí existe, fue un snapshot incompleto/desfasado
                if (myPlayerId !== idToCheck) return; // Ya cambió el estado local (p.ej. reset legítimo en curso)
                myMafiaId = null; myMafiaName = ""; myPlayerId = null; myPlayerName = "";
                lastProcessedPhaseKey = ""; playerRegistered = false;
                if (timerInterval) clearInterval(timerInterval);
                if (chatListenerRef) chatListenerRef.off();
                if (globalLeaderListenerRef) globalLeaderListenerRef.off();
                returnToLoginScreen();
            });
            return;
        }

        if (lastProcessedPhaseKey !== phaseKey) {
            // Si el jugador sigue leyendo las reglas dentro del lobby, no lo interrumpimos
            // con una transición automática de pantalla aunque la fase ya haya cambiado.
            // 'finishTutorialAndSync()' se encarga de revisar la fase real apenas cierre
            // el bloque de reglas (botón "¡Entendido!").
            const tutBlock = document.getElementById('lobby-tutorial-block');
            const inTutorial = tutBlock && !tutBlock.classList.contains('hidden');
            if (inTutorial && phase !== 'LOGIN') {
                return;
            }
            lastProcessedPhaseKey = phaseKey;
            syncGamePhase(phase);
        }
    });
}

// ==========================================
// VISIBILIDAD DE BOTONES ADMIN
// ==========================================
function updateAdminButtonVisibility(phase) {
    const show = (id, v) => document.getElementById(id)?.classList.toggle('hidden', !v);
    show('btn-start-game',       phase === 'LOGIN');
    show('btn-launch-dashboard', phase === 'ASSIGNMENT');
    show('btn-force-resolve',    phase === 'DASHBOARD');
    show('btn-admin-next',       phase === 'TRANSITION');
    show('btn-end-game-now',     ['DASHBOARD','TRANSITION','ASSIGNMENT'].includes(phase));
    show('btn-reset-game',       true);
}

// ==========================================
// TABLA DE MAFIAS
// ==========================================
function renderMafiaTable(tableId, data, isAdmin) {
    const tbody = document.getElementById(tableId);
    if (!tbody || !data.mafias) return;
    tbody.innerHTML = "";
    Object.values(data.mafias).sort((a, b) => b.money - a.money).forEach(m => {
        let members = "";
        Object.keys(data.players || {}).forEach(pId => {
            const p = data.players[pId];
            if (p.isHost) return; // El admin nunca debe aparecer como miembro de un sindicato
            if (p.mafiaId === m.id) {
                members += `<li>👤 ${escapeHTML(p.name)}${m.leaderId===pId?' <span class="leader-tag">👑</span>':''}</li>`;
            }
        });
        if (!members) members = `<li class="text-muted">Sin personal</li>`;
        const lastCol = isAdmin ? `<td>${getVoteInfoForMafia(data, m.id)}</td>` : '';
        tbody.innerHTML += `<tr>
            <td><strong>${escapeHTML(m.name)}</strong><ul class="mafia-members-list">${members}</ul></td>
            <td class="text-success font-bold">$${m.money}</td>
            <td>${m.reputation}%</td>
            <td>${m.influence}</td>
            ${lastCol}
        </tr>`;
    });
}

// ==========================================
// PANEL ADMIN INTERNO
// ==========================================
function updateAdminPanel(data) {
    document.getElementById('admin-round-label').innerText = `Fase: ${data.currentPhase||'LOGIN'} — Ronda ${data.round||0}/5`;
    // Solo contar jugadores reales (excluye al admin/host)
    const tP = data.players ? Object.values(data.players).filter(p => !p.isHost).length : 0;
    const tV = (data.round && data.votes?.[`ronda_${data.round}`]) ? Object.keys(data.votes[`ronda_${data.round}`]).length : 0;
    document.getElementById('admin-vote-count').innerText = `Votos: ${tV} / ${tP}`;

    const log = document.getElementById('admin-round-log');
    if (log) {
        log.innerHTML = (data.lastRoundLogs||[]).map(t=>`<p>${escapeHTML(t)}</p>`).join("") || '<p class="text-muted">Sin operaciones.</p>';
    }

    const spySel = document.getElementById('admin-spy-target');
    if (spySel && data.mafias) {
        const prev = spySel.value;
        spySel.innerHTML = Object.values(data.mafias).map(m =>
            `<option value="${m.id}"${m.id===prev?' selected':''}>${escapeHTML(m.name)}</option>`
        ).join("");
        const spyVotes = document.getElementById('admin-spy-votes');
        const fV = Object.values(data.votes?.[`ronda_${data.round}`]||{}).filter(v=>v.mafiaSource===spySel.value);
        spyVotes.innerHTML = fV.length === 0
            ? `<li class="text-muted">Sin votos aún...</li>`
            : fV.map(v=>`<li>👤 <strong>${escapeHTML(v.player)}</strong>: <span class="vote-badge-${v.action}">${ACTION_ICONS[v.action]}</span> → <em>${escapeHTML(data.mafias?.[v.target]?.name||v.target)}</em></li>`).join("");
    }
}

function initAdminSpyChatStreams(mafiaId) {
    if (adminSpyChatRef) adminSpyChatRef.off();
    if (adminSpyGlobalRef) adminSpyGlobalRef.off();
    const bInt = document.getElementById('admin-spy-chat');
    const bGlob = document.getElementById('admin-spy-global-chat');
    if (!bInt || !bGlob) return;
    bInt.innerHTML = ""; bGlob.innerHTML = "";
    const r = globalGameState.round || 1;

    adminSpyChatRef = db.ref(`chats/${mafiaId}/ronda_${r}`);
    adminSpyChatRef.on('child_added', s => {
        const m = s.val(); if(!m) return;
        bInt.innerHTML += `<div><strong>[${escapeHTML(m.sender)}]:</strong> ${escapeHTML(m.text)}</div>`;
        bInt.scrollTop = bInt.scrollHeight;
    });

    adminSpyGlobalRef = db.ref(`global_leader_chat/ronda_${r}`);
    adminSpyGlobalRef.on('child_added', s => {
        const m = s.val(); if(!m) return;
        bGlob.innerHTML += `<div><strong>[${escapeHTML(m.mafiaName)} - ${escapeHTML(m.sender)}]:</strong> ${escapeHTML(m.text)}</div>`;
        bGlob.scrollTop = bGlob.scrollHeight;
    });
}

function getVoteInfoForMafia(data, mafiaId) {
    const v = Object.values(data.votes?.[`ronda_${data.round}`]||{}).filter(x=>x.mafiaSource===mafiaId);
    if (v.length === 0) return '<span class="text-muted">Pensando...</span>';
    const counts = {}; v.forEach(x => counts[x.action] = (counts[x.action]||0)+1);
    const top = Object.keys(counts).sort((a,b)=>counts[b]-counts[a])[0];
    const icons = { cooperar:'🤝 Coop', traicionar:'🗡️ Traic', robar:'🥷 Robo', alianza:'📜 Pac' };
    return `<span class="vote-badge-${top}">${icons[top]} (${v.length}v)</span>`;
}

// ==========================================
// MAPA SVG
// ==========================================
function drawWarMap(data) {
    const nG = document.getElementById('svg-nodes');
    const cG = document.getElementById('svg-connections');
    if (!nG || !cG || !data.mafias) return;
    nG.innerHTML = ""; cG.innerHTML = "";

    const mafias = Object.values(data.mafias).sort((a,b)=>a.id.localeCompare(b.id));
    const total  = mafias.length;
    const cx=200, cy=200, r=130;
    const coords = {};
    mafias.forEach((m,i) => {
        const a = (i * 2*Math.PI/total) - Math.PI/2;
        coords[m.id] = { x: cx+r*Math.cos(a), y: cy+r*Math.sin(a), name: m.name };
    });

    const pAct = {};
    Object.values(data.votes?.[`ronda_${data.round}`]||{}).forEach(v => {
        if (!pAct[v.mafiaSource]) pAct[v.mafiaSource] = { counts:{}, target:v.target };
        pAct[v.mafiaSource].counts[v.action] = (pAct[v.mafiaSource].counts[v.action]||0)+1;
    });

    const colorMap = { cooperar:'#10b981', traicionar:'#ff0055', robar:'#ffcc00', alianza:'#00ffff' };

    Object.keys(pAct).forEach(src => {
        const { counts, target } = pAct[src];
        const top = Object.keys(counts).sort((a,b)=>counts[b]-counts[a])[0];
        if (!coords[src] || !coords[target] || src === target) return;
        const p = document.createElementNS("http://www.w3.org/2000/svg","path");
        p.setAttribute("d",`M ${coords[src].x} ${coords[src].y} L ${coords[target].x} ${coords[target].y}`);
        p.setAttribute("stroke", colorMap[top]||'#64748b');
        p.setAttribute("stroke-width","2.5");
        p.setAttribute("fill","none");
        p.setAttribute("marker-end",`url(#arrow-${top})`);
        if (top==='traicionar'||top==='robar') {
            p.setAttribute("stroke-dasharray","8,4");
            const anim = document.createElementNS("http://www.w3.org/2000/svg","animate");
            anim.setAttribute("attributeName","stroke-dashoffset");
            anim.setAttribute("values","100;0"); anim.setAttribute("dur","1.2s");
            anim.setAttribute("repeatCount","indefinite"); p.appendChild(anim);
        } else { p.setAttribute("stroke-dasharray","5,5"); }
        cG.appendChild(p);
    });

    Object.keys(coords).forEach(id => {
        const g = document.createElementNS("http://www.w3.org/2000/svg","g");
        const c = document.createElementNS("http://www.w3.org/2000/svg","circle");
        c.setAttribute("cx",coords[id].x); c.setAttribute("cy",coords[id].y);
        c.setAttribute("r","22");
        c.setAttribute("fill", pAct[id]?"#1e293b":"#0f172a");
        c.setAttribute("stroke", pAct[id]?"#00ffcc":"#334155");
        c.setAttribute("stroke-width","2");
        const t = document.createElementNS("http://www.w3.org/2000/svg","text");
        t.setAttribute("x",coords[id].x); t.setAttribute("y",coords[id].y+4);
        t.setAttribute("text-anchor","middle"); t.setAttribute("fill","#fff");
        t.setAttribute("font-size","8px"); t.setAttribute("font-weight","bold");
        t.textContent = coords[id].name.substring(0,7);
        g.appendChild(c); g.appendChild(t); nG.appendChild(g);
    });
}

// ==========================================
// SINCRONIZACIÓN DE FASES
// ==========================================
// ==========================================
// RESOLVER mafiaId CON REINTENTOS (no dejar al jugador atascado)
// ==========================================
// Por qué existe: 'myMafiaId' se llena de forma asíncrona cuando llega el snapshot
// de Firebase con la asignación de sindicato. Con muchos jugadores conectados a la
// vez (cada escritura del admin compite por el mismo ancho de banda del socket de
// cada cliente), el snapshot con NUESTRO propio mafiaId puede tardar más en llegar
// que con pocos jugadores. El código anterior solo reintentaba UNA vez (800ms) y
// si fallaba, no hacía nada — el jugador quedaba congelado sin avanzar ni saber
// por qué. Esta función reintenta varias veces antes de rendirse, y si tras varios
// segundos reales seguimos sin mafiaId, hace una lectura directa a la base de datos
// como último recurso antes de mostrar cualquier mensaje de error.
function ensureMafiaIdThenShowAssignment(onReady, attempt = 0) {
    if (myMafiaId) {
        changeScreen('screen-assignment');
        if (!mafiaNameListenerActive) setupMafiaNameListener();
        if (onReady) onReady();
        return;
    }

    const sid = globalGameState.players?.[myPlayerId]?.mafiaId;
    if (sid && sid !== "sin_asignar") {
        myMafiaId = sid;
        changeScreen('screen-assignment');
        setupMafiaNameListener();
        if (onReady) onReady();
        return;
    }

    if (attempt < 8) {
        // Hasta 8 intentos cada 500ms (~4 segundos), tiempo de sobra incluso con
        // la red compartida por 30 conexiones a la vez.
        setTimeout(() => ensureMafiaIdThenShowAssignment(onReady, attempt + 1), 500);
        return;
    }

    // Último recurso: lectura directa (once) por si el listener general se perdió
    // la actualización bajo carga.
    db.ref(`players/${myPlayerId}`).once('value').then(snap => {
        const directSid = snap.val()?.mafiaId;
        if (directSid && directSid !== "sin_asignar") {
            myMafiaId = directSid;
            changeScreen('screen-assignment');
            setupMafiaNameListener();
            if (onReady) onReady();
        } else {
            // Esto ya sería un caso real: el jugador de verdad no tiene sindicato
            // asignado (por ejemplo, se unió después de que el admin ya inició la
            // partida). Mostramos la pantalla de espera con un mensaje claro en
            // vez de dejarlo en blanco o expulsarlo silenciosamente.
            changeScreen('screen-login');
            const lobbyStat = document.getElementById('lobby-status');
            if (lobbyStat) {
                lobbyStat.innerText = "⚠️ No se pudo confirmar tu sindicato. Avisa al Don.";
                lobbyStat.style.setProperty('display', 'block', 'important');
            }
        }
    }).catch(() => {
        const lobbyStat = document.getElementById('lobby-status');
        if (lobbyStat) {
            lobbyStat.innerText = "⚠️ Problema de conexión. Intenta recargar la página.";
            lobbyStat.style.setProperty('display', 'block', 'important');
        }
    });
}

function syncGamePhase(phase) {
    if (phase === 'LOGIN') {
        if (!myPlayerId) return;
        myMafiaId = null; myMafiaName = ""; myPlayerId = null; myPlayerName = "";
        lastProcessedPhaseKey = ""; playerRegistered = false;
        mafiaNameListenerActive = false;
        internalVotesListenerActive = false;
        if (timerInterval) clearInterval(timerInterval);
        if (chatListenerRef) chatListenerRef.off();
        if (globalLeaderListenerRef) globalLeaderListenerRef.off();
        
        changeScreen('screen-login');
        const adminArea = document.getElementById('admin-login-area');
        if (adminArea) adminArea.style.setProperty('display', 'block', 'important');
        const mainLogo = document.getElementById('main-logo-area');
        if (mainLogo) mainLogo.style.setProperty('display', 'block', 'important');
        const tutBlock = document.getElementById('lobby-tutorial-block');
        if (tutBlock) tutBlock.classList.add('hidden');
        
        document.getElementById('lobby-status').innerText = "";
        document.getElementById('btn-join').disabled = false;
        document.getElementById('player-name').value = '';
        return;
    }

    if (phase === 'ASSIGNMENT') {
        ensureMafiaIdThenShowAssignment();
        return;
    }

    if (phase === 'DASHBOARD') {
        if (!myMafiaId) {
            // No deberíamos llegar aquí sin mafiaId (ASSIGNMENT ya debió resolverlo),
            // pero si pasa (ej. el admin avanzó muy rápido entre fases con mucha gente
            // conectada), nos aseguramos primero en vez de renderizar un dashboard roto
            // apuntando a 'game_room/mafias/null'.
            ensureMafiaIdThenShowAssignment(() => renderDashboard());
            return;
        }
        renderDashboard();
        return;
    }

    if (phase === 'TRANSITION') {
        changeScreen('screen-transition');
        document.getElementById('rep-ronda-num').innerText = globalGameState.round;
        const logs = globalGameState.lastRoundLogs || [];
        document.getElementById('round-narrative-log').innerHTML = logs.map(t=>`<p>${escapeHTML(t)}</p>`).join("") || '<p>Sin registros.</p>';
        if (logs.join(" ").includes("TRAICIÓN")) { try { SoundEffects.play('traicion'); } catch(e){} }
        return;
    }

    if (phase === 'END') { renderEndScreen(); return; }
}

// ==========================================
// NOMBRE DE MAFIA
// ==========================================
function setupMafiaNameListener() {
    mafiaNameListenerActive = true;
    db.ref(`mafias/${myMafiaId}`).on('value', snap => {
        const m = snap.val(); if (!m) return;
        myMafiaName = m.name;
        const el = document.getElementById('assigned-mafia-name');
        const roleEl = document.getElementById('assigned-player-role');
        if (el) el.innerText = escapeHTML(m.name);
        const isLeader = m.leaderId === myPlayerId;
        if (roleEl) roleEl.innerText = isLeader ? "Tu Rol: 👑 LÍDER SUPREMO" : "Tu Rol: Operativo";
        document.getElementById('naming-box')?.classList.toggle('hidden', !isLeader);
    });

    const btn = document.getElementById('btn-save-mafia-name');
    const newBtn = btn.cloneNode(true);
    btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', () => {
        const v = document.getElementById('custom-mafia-name').value.trim();
        if (v.length < 3) return alert("Mínimo 3 caracteres.");
        try { SoundEffects.play('click'); } catch(e){}
        db.ref(`mafias/${myMafiaId}`).update({ name: escapeHTML(v) });
        document.getElementById('naming-box').innerHTML = "<p class='text-success'>✅ ¡Nombre guardado!</p>";
    });
}

// ==========================================
// RENDERIZADO DEL DASHBOARD
// ==========================================
function renderDashboard() {
    changeScreen('screen-dashboard');
    document.getElementById('dash-player-name').innerText = escapeHTML(myPlayerName);
    document.getElementById('dash-mafia-name').innerText  = escapeHTML(myMafiaName);
    document.getElementById('timer-label').innerText = `RONDA ${globalGameState.round||1}/5`;

    const isLeader = globalGameState.mafias?.[myMafiaId]?.leaderId === myPlayerId;
    document.getElementById('dash-leader-badge').classList.toggle('hidden', !isLeader);
    document.getElementById('global-leader-chat-box').classList.toggle('hidden', !isLeader);

    db.ref(`mafias/${myMafiaId}`).on('value', s => {
        const m = s.val(); if (!m) return;
        document.getElementById('stat-money').innerText = `$${m.money}`;
        document.getElementById('stat-rep').innerText   = `${m.reputation}%`;
        document.getElementById('stat-inf').innerText   = m.influence;
    });

    const ev = globalGameState.currentEvent;
    document.getElementById('event-banner').classList.toggle('hidden', !ev);
    if (ev) {
        document.getElementById('event-title').innerText = ev.title;
        document.getElementById('event-desc').innerText  = ev.desc;
    }

    const tSel = document.getElementById('target-mafia');
    const prev = tSel.value;
    tSel.innerHTML = "";
    Object.keys(globalGameState.mafias||{}).forEach(mId => {
        if (mId !== myMafiaId) {
            const o = document.createElement('option');
            o.value = mId; o.innerText = escapeHTML(globalGameState.mafias[mId].name);
            tSel.appendChild(o);
        }
    });
    if (prev && tSel.querySelector(`option[value="${prev}"]`)) tSel.value = prev;

    document.getElementById('panel-voting').classList.remove('hidden');
    document.getElementById('panel-waiting-results').classList.add('hidden');
    document.getElementById('vote-status').innerText = "Selecciona una acción para votar.";
    document.querySelectorAll('.btn-action').forEach(b => b.classList.remove('selected'));
    pendingVoteAction = null; pendingVoteTarget = null;

    runClientTimer(globalGameState.timerEndTime);
    renderMafiaTable('live-ranking-body', globalGameState, false);
    listenInternalVotes();
    listenMafiaChat();
    if (isLeader) listenGlobalLeaderChat();
}

function runClientTimer(endTime) {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        const diff = endTime - Date.now();
        const el = document.getElementById('timer-display'); if (!el) return;
        if (diff <= 0) {
            clearInterval(timerInterval); el.innerText = "00:00";
            if (isHost) resolveRoundLogic();
        } else {
            const min = Math.floor(diff/60000), sec = Math.floor((diff%60000)/1000);
            el.innerText = `${min}:${sec<10?'0':''}${sec}`;
        }
    }, 1000);
}

function listenInternalVotes() {
    if (internalVotesListenerActive) {
        db.ref(`votes/ronda_${globalGameState.round}`).off();
    }
    internalVotesListenerActive = true;
    db.ref(`votes/ronda_${globalGameState.round}`).on('value', s => {
        const vObj = s.val()||{};
        const listUi = document.getElementById('internal-votes-list'); if (!listUi) return;
        listUi.innerHTML = Object.values(vObj)
            .filter(v => v.mafiaSource === myMafiaId)
            .map(v => `<li>📌 <strong>${escapeHTML(v.player)}</strong> → <span class="vote-badge-${v.action}">${ACTION_ICONS[v.action]} ${v.action}</span> contra <em>${escapeHTML(globalGameState.mafias?.[v.target]?.name||v.target)}</em></li>`)
            .join("");
        const voted = vObj[myPlayerId] !== undefined;
        document.getElementById('panel-voting').classList.toggle('hidden', voted);
        document.getElementById('panel-waiting-results').classList.toggle('hidden', !voted);
    });
}

function listenMafiaChat() {
    if (chatListenerRef) chatListenerRef.off();
    const box = document.getElementById('mafia-chat-messages'); box.innerHTML = "";
    chatListenerRef = db.ref(`chats/${myMafiaId}/ronda_${globalGameState.round}`);
    chatListenerRef.on('child_added', s => {
        const m = s.val(); if (!m) return;
        const color = m.playerId === myPlayerId ? 'var(--neon-cyan)' : 'var(--neon-pink)';
        box.innerHTML += `<div><strong style="color:${color};">${escapeHTML(m.sender)}:</strong> ${escapeHTML(m.text)}</div>`;
        box.scrollTop = box.scrollHeight;
    });
}

function sendMafiaChatMessage() {
    const i = document.getElementById('mafia-chat-input');
    const t = i.value.trim(); if (!t || !myMafiaId) return;
    db.ref(`chats/${myMafiaId}/ronda_${globalGameState.round}`).push({
        playerId: myPlayerId, sender: myPlayerName, text: escapeHTML(t)
    });
    i.value = ""; try { SoundEffects.play('click'); } catch(e){}
}

function listenGlobalLeaderChat() {
    if (globalLeaderListenerRef) globalLeaderListenerRef.off();
    const box = document.getElementById('global-leader-messages'); box.innerHTML = "";
    globalLeaderListenerRef = db.ref(`global_leader_chat/ronda_${globalGameState.round}`);
    globalLeaderListenerRef.on('child_added', s => {
        const m = s.val(); if (!m) return;
        const name = m.playerId === myPlayerId ? `Tú (${escapeHTML(m.mafiaName)})` : `${escapeHTML(m.mafiaName)} [${escapeHTML(m.sender)}]`;
        box.innerHTML += `<div><strong>[${name}]:</strong> ${escapeHTML(m.text)}</div>`;
        box.scrollTop = box.scrollHeight;
    });
}

function sendGlobalLeaderMessage() {
    const i = document.getElementById('global-leader-input');
    const t = i.value.trim(); if (!t || !myMafiaId) return;
    db.ref(`global_leader_chat/ronda_${globalGameState.round}`).push({
        playerId: myPlayerId, sender: myPlayerName,
        mafiaId: myMafiaId, mafiaName: myMafiaName, text: escapeHTML(t)
    });
    i.value = ""; try { SoundEffects.play('click'); } catch(e){}
}

// ==========================================
// PANTALLA DE CIERRE
// ==========================================
function renderEndScreen() {
    changeScreen('screen-end'); 
    try { SoundEffects.play('victoria'); } catch(e){}
    const arr = Object.values(globalGameState.mafias||{}).sort((a,b)=>b.money-a.money);

    const winEl = document.getElementById('winner-name');
    if (winEl) winEl.innerText = arr.length>0 ? arr[0].name.toUpperCase() : "SIN GANADOR";

    const pod = document.getElementById('final-podium');
    if (pod) pod.innerHTML = arr.slice(0,3).map((m,i)=>`
        <div class="card bg-dark text-left mt-1" style="border-left:4px solid ${i===0?'var(--neon-yellow)':'var(--border-neon)'};">
            <h3 style="margin:0;font-size:14px;color:${i===0?'var(--neon-yellow)':'var(--border-neon)'}">#${i+1} Lugar</h3>
            <h4 style="margin:4px 0;font-size:16px;">${escapeHTML(m.name)}</h4>
            <p class="text-success m-0 font-bold">$${m.money}</p>
        </div>`).join("");

    const stats = globalGameState.estadisticasHistoricas||{traiciones:{},cooperaciones:{}};
    let mT=-1,tN="Ninguno",mC=-1,cN="Ninguno";
    Object.keys(stats.traiciones||{}).forEach(id=>{ if(stats.traiciones[id]>mT){mT=stats.traiciones[id];tN=globalGameState.mafias?.[id]?.name||id;} });
    Object.keys(stats.cooperaciones||{}).forEach(id=>{ if(stats.cooperaciones[id]>mC){mC=stats.cooperaciones[id];cN=globalGameState.mafias?.[id]?.name||id;} });

    document.getElementById('badge-trust-name').innerText   = mC>0?`${escapeHTML(cN)} (${mC} veces)`:"Ninguno";
    document.getElementById('badge-traitor-name').innerText = mT>0?`${escapeHTML(tN)} (${mT} veces)`:"Ninguno";
    document.getElementById('btn-host-reset-final').classList.toggle('hidden', !isHost);
}

// ==========================================
// CONTROL INTERNO DEL HOST
// ==========================================
function masterActionStartGame() {
    try { SoundEffects.play('click'); } catch(e){}
    
    // 1. Limpiamos primero el nodo de mafias viejo en Firebase para evitar conflictos de datos
    db.ref('mafias').remove(() => {
        
        db.ref('players').once('value', s => {
            const pObj = s.val(); 
            if (!pObj) return alert("Sin jugadores en el callejón.");
            
            // Filter out admin players (isHost === true) y jugadores desconectados (online === false)
            const playerEntries = Object.entries(pObj).filter(([_, p]) => !p.isHost && p.online !== false);
            if (playerEntries.length === 0) return alert("Solo hay administradores o jugadores desconectados. Necesitas al menos un jugador conectado.");

            const TOTAL_SINDICATOS = 4;

            // Nombres base iniciales
            const nombresSindicatos = {
                1: "Sindicato Alfa 🦆",
                2: "Sindicato Beta 🦆",
                3: "Sindicato Gamma 🦆",
                4: "Sindicato Delta 🦆"
            };

            const config = {};
            const upd = {};

            // 2. Creamos la estructura limpia para los 4 sindicatos
            for (let m = 1; m <= TOTAL_SINDICATOS; m++) {
                config[`mafia_${m}`] = { 
                    id: `mafia_${m}`, 
                    name: nombresSindicatos[m], 
                    money: 1200, 
                    reputation: 100, 
                    influence: 50, 
                    leaderId: "" 
                };
            }

            // 3. Distribuimos los jugadores de forma equitativa
            playerEntries.forEach(([pId, p], i) => {
                const mId = `mafia_${(i % TOTAL_SINDICATOS) + 1}`;
                upd[`players/${pId}/mafiaId`] = mId;

                // Si el sindicato no tiene líder asignado aún, este jugador se convierte en el Jefe
                if (!config[mId].leaderId) {
                    config[mId].leaderId = pId;
                }
            });

            // 4. Subimos la nueva configuración unificada a Firebase
            upd['mafias'] = config; 
            upd['currentPhase'] = 'ASSIGNMENT'; 
            upd['round'] = 1;
            
            db.ref('').update(upd, (error) => {
                if (error) {
                    console.error("Error al iniciar el juego:", error);
                } else {
                    console.log("¡Partida de 4 sindicatos iniciada con éxito!");
                }
            });
        });
    });
}

function masterLaunchRound() {
    try { SoundEffects.play('click'); } catch(e){}
    db.ref('').update({
        timerEndTime: Date.now() + 180000,
        currentEvent: EVENTOS[Math.floor(Math.random()*EVENTOS.length)],
        currentPhase: 'DASHBOARD'
    });
}

function masterActionNextRound() {
    try { SoundEffects.play('click'); } catch(e){}
    const n = (globalGameState.round||1)+1;
    if (n>5) return masterEndGameNow();
    db.ref('').update({
        round:n, timerEndTime:Date.now()+180000,
        currentEvent: EVENTOS[Math.floor(Math.random()*EVENTOS.length)],
        currentPhase: 'DASHBOARD'
    });
}

function masterEndGameNow() {
    try { SoundEffects.play('click'); } catch(e){}
    db.ref('').once('value', s => {
        if (s.val()?.currentPhase==='DASHBOARD') resolveRoundLogic(true);
        else db.ref('').update({ currentPhase:'END' });
    });
}

function masterResetDatabase() {
    try { SoundEffects.play('click'); } catch(e){}
    if (!currentRoomCode) return alert("No hay sala activa.");
    fetch(window.MAFIA_BACKEND_URL + '/room/' + currentRoomCode + '/reset', { method: 'POST' })
        .then(r => r.json())
        .then(() => {
            myPlayerId = null; myPlayerName = ""; myMafiaId = null;
            myMafiaName = ""; isHost = false; lastProcessedPhaseKey = "";
            globalGameState = {};
            if (timerInterval) clearInterval(timerInterval);
            if (chatListenerRef) { chatListenerRef.off(); chatListenerRef = null; }
            if (globalLeaderListenerRef) { globalLeaderListenerRef.off(); globalLeaderListenerRef = null; }
            if (adminSpyChatRef) { adminSpyChatRef.off(); adminSpyChatRef = null; }
            if (adminSpyGlobalRef) { adminSpyGlobalRef.off(); adminSpyGlobalRef = null; }
            returnToLoginScreen();
        })
        .catch(err => console.error("Error al limpiar sala:", err));
}

function masterResetEverything() {
    try { SoundEffects.play('click'); } catch(e){}
    if (timerInterval) clearInterval(timerInterval);
    if (chatListenerRef) chatListenerRef.off();
    if (globalLeaderListenerRef) globalLeaderListenerRef.off();
    if (adminSpyChatRef) adminSpyChatRef.off();
    if (adminSpyGlobalRef) adminSpyGlobalRef.off();

    // Preserve players while resetting game state
    db.ref('players').once('value', playersSnapshot => {
        const players = playersSnapshot.val() || {};
        const updates = {
            currentPhase: 'LOGIN',
            round: 0,
            mafias: null,
            votes: null,
            chats: null,
            'global_leader_chat': null,
            lastRoundLogs: [],
            estadisticasHistoricas: { traiciones: {}, cooperaciones: {} },
            currentEvent: null,
            timerEndTime: null
        };

        // Preserve players but reset their mafiaId to "sin_asignar"
        Object.keys(players).forEach(playerId => {
            updates[`players/${playerId}/mafiaId`] = "sin_asignar";
            // Preserve other player fields like name, isHost, online
        });

        db.ref('').update(updates).then(() => {
            // Instead of reloading, return to login screen to keep player connections intact
            returnToLoginScreen();
        });
    });
}

function resolveRoundLogic(goToEnd=false) {
    db.ref('').once('value', s => {
        const game = s.val(); if (!game?.mafias) return;
        const rV = game.votes?.[`ronda_${game.round}`];
        const mafias = game.mafias;
        const logs = [`--- RONDA ${game.round} ---`];
        const dec = {};
        Object.keys(mafias).forEach(mId => dec[mId] = { action:'cooperar', target:null, counts:{} });

        if (rV) {
            Object.values(rV).forEach(v => {
                if (!dec[v.mafiaSource]) return;
                dec[v.mafiaSource].counts[v.action] = (dec[v.mafiaSource].counts[v.action]||0)+1;
                dec[v.mafiaSource].target = v.target;
            });
            Object.keys(dec).forEach(mId => {
                const c = dec[mId].counts;
                if (Object.keys(c).length>0) dec[mId].action = Object.keys(c).sort((a,b)=>c[b]-c[a])[0];
            });
        }

        const st = game.estadisticasHistoricas||{traiciones:{},cooperaciones:{}};

        Object.keys(mafias).forEach(mId => {
            const a = dec[mId].action;
            const t = dec[mId].target || Object.keys(mafias).find(x=>x!==mId);
            st.traiciones[mId]    = st.traiciones[mId]||0;
            st.cooperaciones[mId] = st.cooperaciones[mId]||0;

            if (a==='cooperar') {
                let g = 400*(mafias[mId].reputation/100);
                if (game.currentEvent?.code==="AUGE") g*=1.5;
                mafias[mId].money += Math.round(g);
                mafias[mId].reputation = Math.min(100, mafias[mId].reputation+10);
                st.cooperaciones[mId]++;
                logs.push(`🕊️ [${mafias[mId].name}] COOPERÓ. +$${Math.round(g)}`);
            } else if (a==='traicionar') {
                mafias[mId].money += 800;
                mafias[mId].reputation = Math.max(10, mafias[mId].reputation-35);
                if (mafias[t]) mafias[t].money = Math.max(0, mafias[t].money-400);
                st.traiciones[mId]++;
                if (game.currentEvent?.code==="REDADA") { mafias[mId].money-=500; logs.push(`🚨 REDADA: [${mafias[mId].name}] penalizado -$500.`); }
                logs.push(`🗡️ TRAICIÓN: [${mafias[mId].name}] atacó a [${mafias[t]?.name||'Rival'}].`);
            } else if (a==='robar') {
                mafias[mId].influence += 20;
                if (mafias[t]) mafias[t].influence = Math.max(0, mafias[t].influence-20);
                logs.push(`🥷 [${mafias[mId].name}] robó influencia a [${mafias[t]?.name||'Rival'}].`);
            } else if (a==='alianza') {
                if (dec[t]?.action==='alianza' && dec[t]?.target===mId) {
                    mafias[mId].money += 600; mafias[mId].influence += 15;
                    logs.push(`📜 PACTO: [${mafias[mId].name}] y [${mafias[t].name}]. +$600 c/u`);
                } else logs.push(`⚠️ Alianza fallida de [${mafias[mId].name}].`);
            }
            if (game.currentEvent?.code==="CRISIS") mafias[mId].money = Math.max(0, mafias[mId].money-200);
        });

        if (game.currentEvent?.code==="LAVADO") {
            Object.keys(mafias).forEach(mId => {
                const b = mafias[mId].influence*10;
                mafias[mId].money += b;
                logs.push(`💸 LAVADO: [${mafias[mId].name}] +$${b}.`);
            });
        }

        db.ref('').update({ mafias, lastRoundLogs:logs, estadisticasHistoricas:st, currentPhase: goToEnd?'END':'TRANSITION' });
    });
}