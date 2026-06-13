// ==========================================
// FIREBASE CONFIG
// ==========================================
const firebaseConfig = {
    apiKey: "AIzaSyAG9BbgcQKuVAXPeXJgjz_7VA4FXnYST6Y",
    authDomain: "mafia-de-patos-a9e22.firebaseapp.com",
    projectId: "mafia-de-patos-a9e22",
    storageBucket: "mafia-de-patos-a9e22.firebasestorage.app",
    messagingSenderId: "32475436802",
    appId: "1:32475436802:web:7c3d0011c40bdd11a9541b",
    databaseURL: "https://mafia-de-patos-a9e22-default-rtdb.firebaseio.com"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const ADMIN_PASSWORD = "profe2025";

// ==========================================
// ESTADO GLOBAL
// ==========================================
let myPlayerId = null;
let myPlayerName = "";
let myMafiaId = null;
let myMafiaName = "";
let isHost = false;
let globalGameState = {};
let timerInterval = null;
let lastProcessedPhaseKey = "";
let mafiaNameListenerActive = false;
let internalVotesListenerActive = false;

// Referencias de listeners de chat (para limpiarlos)
let chatListenerRef = null;
let globalLeaderListenerRef = null;
let adminSpyChatRef = null;
let adminSpyGlobalRef = null;

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
            const c = {
                click:{freq:400,vol:0.1,dur:0.05,type:'sine'},
                traicion:{freq:140,vol:0.2,dur:0.35,type:'sawtooth'},
                victoria:{freq:440,vol:0.15,dur:0.5,type:'sine'}
            }[type];
            if (!c) return;
            osc.type = c.type;
            osc.frequency.setValueAtTime(c.freq, this.ctx.currentTime);
            gain.gain.setValueAtTime(c.vol, this.ctx.currentTime);
            osc.start(); osc.stop(this.ctx.currentTime + c.dur);
        } catch(e) {}
    }
};

const EVENTOS = [
    { title:"MERCADO EN AUGE", desc:"Ganancias por Cooperación aumentan 50%.", code:"AUGE" },
    { title:"REDADA POLICIAL", desc:"Traiciones descubiertas. El traidor pierde $500 extras.", code:"REDADA" },
    { title:"CRISIS ECONÓMICA", desc:"Todas las mafias pierden $200 al inicio.", code:"CRISIS" },
    { title:"LAVADO DE DINERO", desc:"+$10 por cada punto de influencia.", code:"LAVADO" }
];

const ACTION_LABELS = { cooperar:'🤝 Cooperar', traicionar:'🗡 Traicionar', robar:'🥷 Robar Recursos', alianza:'📜 Pacto Temporal' };
const ACTION_ICONS = { cooperar:'🤝', traicionar:'🗡', robar:'🥷', alianza:'📜' };

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
            const act = btn.getAttribute('data-action');
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
        db.ref(`game_room/votes/ronda_${globalGameState.round}/${myPlayerId}`).set({
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

    listenToGlobalState();
});

// ==========================================
// MODAL DE CONFIRMACIÓN DE VOTO
// ==========================================
function showVoteConfirmModal(action, targetName) {
    document.getElementById('modal-vote-action').innerText = ACTION_LABELS[action];
    document.getElementById('modal-vote-target').innerText = targetName;
    document.getElementById('modal-vote-icon').innerText = ACTION_ICONS[action];
    document.getElementById('vote-confirm-modal').classList.remove('hidden');
}
function hideVoteModal() {
    document.getElementById('vote-confirm-modal').classList.add('hidden');
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

    if (document.getElementById('admin-toggle').checked) {
        if (document.getElementById('admin-password').value !== ADMIN_PASSWORD) {
            document.getElementById('pass-error').classList.remove('hidden');
            document.getElementById('admin-password').value = '';
            return;
        }
        isHost = true;
    }

    document.getElementById('pass-error').classList.add('hidden');
    myPlayerName = escapeHTML(nameIn);
    try { SoundEffects.play('click'); } catch(e){}

    // El Don (admin) NO se registra como jugador: solo como espectador/iniciador.
    if (isHost) {
        // Forzar ocultamiento absoluto de elementos de login para evitar solapamientos
        const adminArea = document.getElementById('admin-login-area');
        if (adminArea) adminArea.style.setProperty('display', 'none', 'important');

        const mainLogo = document.getElementById('main-logo-area');
        if (mainLogo) mainLogo.style.setProperty('display', 'none', 'important');

        const lobbyStat = document.getElementById('lobby-status');
        if (lobbyStat) lobbyStat.style.setProperty('display', 'none', 'important');

        const adminPanel = document.getElementById('admin-panel');
        if (adminPanel) {
            adminPanel.classList.remove('hidden');
            adminPanel.style.setProperty('display', 'block', 'important');
        }
        updateAdminButtonVisibility('LOGIN');
        setTimeout(() => initAdminSpyChatStreams('mafia_1'), 800);
        return;
    }

    // Jugador normal: se registra en /players
    const pRef = db.ref('game_room/players').push();
    myPlayerId = pRef.key;
    pRef.set({ name: myPlayerName, mafiaId: "sin_asignar", online: true, isHost: false });
    pRef.onDisconnect().remove();

    // Forzar ocultamiento absoluto de elementos de login para evitar solapamientos
    const adminArea = document.getElementById('admin-login-area');
    if (adminArea) adminArea.style.setProperty('display', 'none', 'important');

    const mainLogo = document.getElementById('main-logo-area');
    if (mainLogo) mainLogo.style.setProperty('display', 'none', 'important');

    const lobbyStat = document.getElementById('lobby-status');
    if (lobbyStat) lobbyStat.style.setProperty('display', 'none', 'important');

    changeScreen('screen-tutorial');
    try {
        initTutorialLogic();
        const stepOne = document.querySelector('.tutorial-step[data-step="1"]');
        if (stepOne) stepOne.style.setProperty('display', 'block', 'important');
    } catch(e) {
        console.error("Error en tutorial:", e);
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
            const phase = globalGameState.currentPhase || 'LOGIN';
            const phaseKey = `${phase}_${globalGameState.round || 0}`;
            lastProcessedPhaseKey = "";
            if (phase === 'ASSIGNMENT' && myMafiaId) {
                lastProcessedPhaseKey = phaseKey;
                syncGamePhase('ASSIGNMENT');
            } else if (phase === 'DASHBOARD') {
                lastProcessedPhaseKey = phaseKey;
                syncGamePhase('DASHBOARD');
            } else {
                // En lugar de volver al login, pasamos a la pantalla de espera
                changeScreen('screen-waiting');
            }
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
// LISTENER GLOBAL FIREBASE
// ==========================================
function listenToGlobalState() {
    db.ref('game_room').on('value', snapshot => {
        const data = snapshot.val() || {};
        globalGameState = data;

        if (myPlayerId && data.players?.[myPlayerId] && myMafiaId === null) {
            const sid = data.players[myPlayerId].mafiaId;
            if (sid && sid !== "sin_asignar") myMafiaId = sid;
        }

        const phase = data.currentPhase || 'LOGIN';
        const phaseKey = `${phase}_${data.round || 0}`;

        if (isHost) {
            renderMafiaTable('admin-mafia-tbody', data, true);
            updateAdminPanel(data);
            drawWarMap(data);
            updateAdminButtonVisibility(phase);
            document.getElementById('btn-host-reset-final').classList.toggle('hidden', phase !== 'END');
            return;
        }

        if (lastProcessedPhaseKey !== phaseKey) {
            const tutScreen = document.getElementById('screen-tutorial');
            const inTutorial = tutScreen && (tutScreen.classList.contains('active') || tutScreen.style.display === 'block');
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
    show('btn-start-game', phase === 'LOGIN');
    show('btn-launch-dashboard', phase === 'ASSIGNMENT');
    show('btn-force-resolve', phase === 'DASHBOARD');
    show('btn-admin-next', phase === 'TRANSITION');
    show('btn-end-game-now', ['DASHBOARD','TRANSITION','ASSIGNMENT'].includes(phase));
    show('btn-reset-game', true);
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

    // Solo contamos jugadores reales (no al Don/admin) para el conteo de votos
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

    adminSpyChatRef = db.ref(`game_room/chats/${mafiaId}/ronda_${r}`);
    adminSpyChatRef.on('child_added', s => {
        const m = s.val(); if(!m) return;
        bInt.innerHTML += `<div><strong>[${escapeHTML(m.sender)}]:</strong> ${escapeHTML(m.text)}</div>`;
        bInt.scrollTop = bInt.scrollHeight;
    });

    adminSpyGlobalRef = db.ref(`game_room/global_leader_chat/ronda_${r}`);
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
    const icons = { cooperar:'🤝 Coop', traicionar:'🗡 Traic', robar:'🥷 Robo', alianza:'📜 Pac' };
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
    const total = mafias.length;
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
            anim.setAttribute("values","100;0");
            anim.setAttribute("dur","1.2s");
            anim.setAttribute("repeatCount","indefinite");
            p.appendChild(anim);
        } else { p.setAttribute("stroke-dasharray","5,5"); }

        cG.appendChild(p);
    });

    Object.keys(coords).forEach(id => {
        const g = document.createElementNS("http://www.w3.org/2000/svg","g");
        const c = document.createElementNS("http://www.w3.org/2000/svg","circle");
        c.setAttribute("cx",coords[id].x);
        c.setAttribute("cy",coords[id].y);
        c.setAttribute("r","22");
        c.setAttribute("fill", pAct[id]?"#1e293b":"#0f172a");
        c.setAttribute("stroke", pAct[id]?"#00ffcc":"#334155");
        c.setAttribute("stroke-width","2");

        const t = document.createElementNS("http://www.w3.org/2000/svg","text");
        t.setAttribute("x",coords[id].x);
        t.setAttribute("y",coords[id].y+4);
        t.setAttribute("text-anchor","middle");
        t.setAttribute("fill","#fff");
        t.setAttribute("font-size","8px");
        t.setAttribute("font-weight","bold");
        t.textContent = coords[id].name.substring(0,7);

        g.appendChild(c); g.appendChild(t); nG.appendChild(g);
    });
}

// ==========================================
// SINCRONIZACIÓN DE FASES
// ==========================================
function syncGamePhase(phase) {
    if (phase === 'LOGIN') {
        if (!myPlayerId) return;
        myMafiaId = null; myMafiaName = ""; myPlayerId = null; myPlayerName = "";
        lastProcessedPhaseKey = "";
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

        document.getElementById('lobby-status').innerText = "";
        document.getElementById('btn-join').disabled = false;
        document.getElementById('player-name').value = '';
        return;
    }

    if (phase === 'ASSIGNMENT') {
        if (!myMafiaId) {
            setTimeout(() => {
                const sid = globalGameState.players?.[myPlayerId]?.mafiaId;
                if (sid && sid !== "sin_asignar") {
                    myMafiaId = sid;
                    changeScreen('screen-assignment');
                    setupMafiaNameListener();
                }
            }, 800);
        } else {
            changeScreen('screen-assignment');
            if (!mafiaNameListenerActive) setupMafiaNameListener();
        }
        return;
    }

    if (phase === 'DASHBOARD') { renderDashboard(); return; }

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
    db.ref(`game_room/mafias/${myMafiaId}`).on('value', snap => {
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
        db.ref(`game_room/mafias/${myMafiaId}`).update({ name: escapeHTML(v) });
        document.getElementById('naming-box').innerHTML = "<p class='text-success'>✅ ¡Nombre guardado!</p>";
    });
}

// ==========================================
// RENDERIZADO DEL DASHBOARD
// ==========================================
function renderDashboard() {
    changeScreen('screen-dashboard');
    document.getElementById('dash-player-name').innerText = escapeHTML(myPlayerName);
    document.getElementById('dash-mafia-name').innerText = escapeHTML(myMafiaName);
    document.getElementById('timer-label').innerText = `RONDA ${globalGameState.round||1}/5`;

    const isLeader = globalGameState.mafias?.[myMafiaId]?.leaderId === myPlayerId;
    document.getElementById('dash-leader-badge').classList.toggle('hidden', !isLeader);
    document.getElementById('global-leader-chat-box').classList.toggle('hidden', !isLeader);

    db.ref(`game_room/mafias/${myMafiaId}`).on('value', s => {
        const m = s.val(); if (!m) return;
        document.getElementById('stat-money').innerText = `$${m.money}`;
        document.getElementById('stat-rep').innerText = `${m.reputation}%`;
        document.getElementById('stat-inf').innerText = m.influence;
    });

    const ev = globalGameState.currentEvent;
    document.getElementById('event-banner').classList.toggle('hidden', !ev);
    if (ev) {
        document.getElementById('event-title').innerText = ev.title;
        document.getElementById('event-desc').innerText = ev.desc;
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
        db.ref(`game_room/votes/ronda_${globalGameState.round}`).off();
    }
    internalVotesListenerActive = true;

    db.ref(`game_room/votes/ronda_${globalGameState.round}`).on('value', s => {
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
    const box = document.getElementById('mafia-chat-messages');
    box.innerHTML = "";
    chatListenerRef = db.ref(`game_room/chats/${myMafiaId}/ronda_${globalGameState.round}`);
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
    db.ref(`game_room/chats/${myMafiaId}/ronda_${globalGameState.round}`).push({
        playerId: myPlayerId, sender: myPlayerName, text: escapeHTML(t)
    });
    i.value = ""; try { SoundEffects.play('click'); } catch(e){}
}

function listenGlobalLeaderChat() {
    if (globalLeaderListenerRef) globalLeaderListenerRef.off();
    const box = document.getElementById('global-leader-messages');
    box.innerHTML = "";
    globalLeaderListenerRef = db.ref(`game_room/global_leader_chat/ronda_${globalGameState.round}`);
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
    db.ref(`game_room/global_leader_chat/ronda_${globalGameState.round}`).push({
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

    document.getElementById('badge-trust-name').innerText = mC>0?`${escapeHTML(cN)} (${mC} veces)`:"Ninguno";
    document.getElementById('badge-traitor-name').innerText = mT>0?`${escapeHTML(tN)} (${mT} veces)`:"Ninguno";

    document.getElementById('btn-host-reset-final').classList.toggle('hidden', !isHost);
}

// ==========================================
// CONTROL INTERNO DEL HOST
// ==========================================
function masterActionStartGame() {
    try { SoundEffects.play('click'); } catch(e){}

    // 1. Limpiamos primero el nodo de mafias viejo en Firebase para evitar conflictos de datos
    db.ref('game_room/mafias').remove(() => {

        db.ref('game_room/players').once('value', s => {
            const pObj = s.val();
            if (!pObj) return alert("Sin jugadores en el callejón.");

            // Excluimos al Don/admin del reparto (no debe contar como jugador)
            const keys = Object.keys(pObj).filter(k => !pObj[k].isHost);
            if (keys.length === 0) return alert("Sin jugadores en el callejón.");

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

            // 3. Distribuimos los jugadores (sin contar al Don) de forma equitativa
            keys.forEach((pId, i) => {
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

            db.ref('game_room').update(upd, (error) => {
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
    db.ref('game_room').update({
        timerEndTime: Date.now() + 180000,
        currentEvent: EVENTOS[Math.floor(Math.random()*EVENTOS.length)],
        currentPhase: 'DASHBOARD'
    });
}

function masterActionNextRound() {
    try { SoundEffects.play('click'); } catch(e){}
    const n = (globalGameState.round||1)+1;
    if (n>5) return masterEndGameNow();
    db.ref('game_room').update({
        round:n, timerEndTime:Date.now()+180000,
        currentEvent: EVENTOS[Math.floor(Math.random()*EVENTOS.length)],
        currentPhase: 'DASHBOARD'
    });
}

function masterEndGameNow() {
    try { SoundEffects.play('click'); } catch(e){}
    db.ref('game_room').once('value', s => {
        if (s.val()?.currentPhase==='DASHBOARD') resolveRoundLogic(true);
        else db.ref('game_room').update({ currentPhase:'END' });
    });
}

function masterResetEverything() {
    try { SoundEffects.play('click'); } catch(e){}
    if (timerInterval) clearInterval(timerInterval);
    if (chatListenerRef) chatListenerRef.off();
    if (globalLeaderListenerRef) globalLeaderListenerRef.off();
    if (adminSpyChatRef) adminSpyChatRef.off();
    if (adminSpyGlobalRef) adminSpyGlobalRef.off();
    db.ref('game_room').set({ currentPhase:'LOGIN' }).then(() => window.location.reload());
}

function resolveRoundLogic(goToEnd=false) {
    db.ref('game_room').once('value', s => {
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
            st.traiciones[mId] = st.traiciones[mId]||0;
            st.cooperaciones[mId] = st.cooperaciones[mId]||0;

            if (a==='cooperar') {
                let g = 400*(mafias[mId].reputation/100);
                if (game.currentEvent?.code==="AUGE") g*=1.5;
                mafias[mId].money += Math.round(g);
                mafias[mId].reputation = Math.min(100, mafias[mId].reputation+10);
                st.cooperaciones[mId]++;
                logs.push(`🕊 [${mafias[mId].name}] COOPERÓ. +$${Math.round(g)}`);
            } else if (a==='traicionar') {
                mafias[mId].money += 800;
                mafias[mId].reputation = Math.max(10, mafias[mId].reputation-35);
                if (mafias[t]) mafias[t].money = Math.max(0, mafias[t].money-400);
                st.traiciones[mId]++;
                if (game.currentEvent?.code==="REDADA") { mafias[mId].money-=500; logs.push(`🚨 REDADA: [${mafias[mId].name}] penalizado -$500.`); }
                logs.push(`🗡 TRAICIÓN: [${mafias[mId].name}] atacó a [${mafias[t]?.name||'Rival'}].`);
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

        db.ref('game_room').update({ mafias, lastRoundLogs:logs, estadisticasHistoricas:st, currentPhase: goToEnd?'END':'TRANSITION' });
    });
}