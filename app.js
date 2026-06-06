// ==========================================
// CONFIGURACIÓN DE FIREBASE (¡Reemplaza con tus credenciales!)
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
const ADMIN_PASSWORD = "profe2025"; // Contraseña del host

let myPlayerId    = null;
let myPlayerName  = "";
let myMafiaId     = null;
let myMafiaName   = "";
let isHost        = false;
let globalGameState = {};
let timerInterval = null;
let lastProcessedPhaseKey = "";

let chatListenerRef = null;
let globalLeaderListenerRef = null;
let adminSpyChatRef = null;
let adminSpyGlobalChatRef = null;

// ==========================================
// SEGURIDAD: FUNCIÓN ANTI-XSS (Evita Bugs en Chat)
// ==========================================
function escapeHTML(str) {
    if (!str) return "";
    return str.toString().replace(/[&<>'"]/g, tag => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[tag] || tag));
}

// ==========================================
// AUDIO SINTETIZADO (Soporte iOS/Android)
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
            const configs = {
                click:    { freq: 400, vol: 0.1,  dur: 0.05, type: 'sine'     },
                traicion: { freq: 140, vol: 0.2,  dur: 0.35, type: 'sawtooth' },
                victoria: { freq: 440, vol: 0.15, dur: 0.5,  type: 'sine'     }
            }[type];
            if (!configs) return;
            osc.type = configs.type;
            osc.frequency.setValueAtTime(configs.freq, this.ctx.currentTime);
            gain.gain.setValueAtTime(configs.vol, this.ctx.currentTime);
            osc.start(); osc.stop(this.ctx.currentTime + configs.dur);
        } catch(e) {}
    }
};

const EVENTOS = [
    { title: "MERCADO EN AUGE",   desc: "Ganancias por Cooperación aumentan 50%.", code: "AUGE" },
    { title: "REDADA POLICIAL",   desc: "Traiciones descubiertas. Traidor pierde $500 extras.", code: "REDADA" },
    { title: "CRISIS ECONÓMICA",  desc: "Todas las mafias pierden $200 al inicio.", code: "CRISIS" },
    { title: "LAVADO DE DINERO",  desc: "+$10 de dinero por cada punto de influencia.", code: "LAVADO" }
];

function changeScreen(screenId) {
    if (isHost && screenId !== 'screen-login') return; // Host se queda en pantalla principal
    document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === screenId));
}

// ==========================================
// LISTENERS Y CONFIGURACIÓN INICIAL
// ==========================================
document.addEventListener("DOMContentLoaded", () => {
    // Desbloquear audio en el primer toque de pantalla (Requisito iOS Safari)
    document.body.addEventListener('click', () => { SoundEffects.init(); }, { once: true });
    document.body.addEventListener('touchstart', () => { SoundEffects.init(); }, { once: true });

    document.getElementById('admin-toggle').addEventListener('change', function() {
        document.getElementById('admin-password-box').classList.toggle('hidden', !this.checked);
    });

    document.getElementById('btn-join').addEventListener('click', setupLogin);
    
    // Controles de Administrador
    document.getElementById('btn-start-game').addEventListener('click', masterActionStartGame);
    document.getElementById('btn-launch-dashboard').addEventListener('click', masterLaunchRound);
    document.getElementById('btn-force-resolve').addEventListener('click', () => {
        if (confirm("¿Forzar resolución de la ronda?")) resolveRoundLogic();
    });
    document.getElementById('btn-admin-next').addEventListener('click', masterActionNextRound);
    document.getElementById('btn-end-game-now').addEventListener('click', () => {
        if (confirm("¿Terminar la partida de inmediato?")) masterEndGameNow();
    });
    document.getElementById('btn-reset-game').addEventListener('click', masterResetEverything);
    document.getElementById('btn-host-reset-final').addEventListener('click', masterResetEverything);

    // Eventos de teclado (usando 'keydown' para celulares)
    document.getElementById('btn-mafia-chat-send').addEventListener('click', sendMafiaChatMessage);
    document.getElementById('mafia-chat-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendMafiaChatMessage();
    });

    document.getElementById('btn-global-leader-send').addEventListener('click', sendGlobalLeaderMessage);
    document.getElementById('global-leader-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') sendGlobalLeaderMessage();
    });

    const spySelect = document.getElementById('admin-spy-target');
    if (spySelect) {
        spySelect.addEventListener('change', () => {
            if (isHost) initAdminSpyChatStreams(spySelect.value);
        });
    }

    // Sistema de Votación (Doble Tap de seguridad)
    let lastClickedAction = null;
    document.querySelectorAll('.btn-action').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!myPlayerId || !myMafiaId) return;
            
            const act = btn.getAttribute('data-action');
            const targetId = document.getElementById('target-mafia').value;
            
            if (lastClickedAction !== act) {
                document.querySelectorAll('.btn-action').forEach(b => {
                    b.classList.remove('selected');
                    const bLabels = { cooperar: '🤝 Cooperar', traicionar: '🗡️ Traicionar', robar: '🥷 Robar Recursos', alianza: '📜 Pacto Temporal' };
                    b.querySelector('strong').innerText = bLabels[b.getAttribute('data-action')];
                });
                lastClickedAction = act;
                btn.classList.add('selected');
                btn.querySelector('strong').innerText = "🚨 ¿Seguro? ¡Pulsa otra vez!";
                SoundEffects.play('click');
                return;
            }

            document.querySelectorAll('.btn-action').forEach(b => b.classList.remove('selected'));
            lastClickedAction = null; 
            
            const labels = { cooperar: '🤝 Cooperar', traicionar: '🗡️ Traicionar', robar: '🥷 Robar Recursos', alianza: '📜 Pacto Temporal' };
            btn.querySelector('strong').innerText = labels[act];

            db.ref(`game_room/votes/ronda_${globalGameState.round}/${myPlayerId}`).set({
                player: myPlayerName, mafiaSource: myMafiaId, action: act, target: targetId
            });
            SoundEffects.play('click');
            document.getElementById('vote-status').innerText = `✅ Voto enviado: ${act}`;
        });
    });

    document.getElementById('target-mafia').addEventListener('change', () => {
        lastClickedAction = null;
        document.querySelectorAll('.btn-action').forEach(b => {
            b.classList.remove('selected');
            const labels = { cooperar: '🤝 Cooperar', traicionar: '🗡️ Traicionar', robar: '🥷 Robar Recursos', alianza: '📜 Pacto Temporal' };
            b.querySelector('strong').innerText = labels[b.getAttribute('data-action')];
        });
    });

    listenToGlobalState();
});

// ==========================================
// REGISTRO Y LOGIN
// ==========================================
function setupLogin() {
    const nameIn = escapeHTML(document.getElementById('player-name').value.trim());
    if (nameIn.length < 2) return alert("Alias inválido. Mínimo 2 caracteres.");

    if (document.getElementById('admin-toggle').checked) {
        const pass = document.getElementById('admin-password').value;
        if (pass !== ADMIN_PASSWORD) {
            document.getElementById('pass-error').classList.remove('hidden');
            document.getElementById('admin-password').value = '';
            return;
        }
        isHost = true;
    }

    document.getElementById('pass-error').classList.add('hidden');
    myPlayerName = nameIn;
    SoundEffects.play('click');

    const pRef = db.ref('game_room/players').push();
    myPlayerId = pRef.key;
    pRef.set({ name: myPlayerName, mafiaId: "sin_asignar", online: true, isHost });
    pRef.onDisconnect().remove();

    document.getElementById('admin-login-area').classList.add('hidden');

    if (isHost) {
        document.getElementById('main-logo-area').classList.add('hidden');
        document.getElementById('admin-panel').classList.remove('hidden');
        document.getElementById('lobby-status').classList.add('hidden');
        updateAdminButtonVisibility('LOGIN');
        setTimeout(() => { initAdminSpyChatStreams('mafia_1'); }, 1000);
    } else {
        changeScreen('screen-tutorial');
        initTutorialLogic();
    }
}

function initTutorialLogic() {
    let currentStep = 1;
    const totalSteps = 4;
    const btnPrev = document.getElementById('btn-tut-prev');
    const btnNext = document.getElementById('btn-tut-next');
    
    function updateStepUI() {
        document.querySelectorAll('.tutorial-step').forEach(step => {
            step.style.display = parseInt(step.getAttribute('data-step')) === currentStep ? 'block' : 'none';
        });
        btnPrev.style.display = currentStep === 1 ? 'none' : 'block';
        btnNext.innerText = currentStep === totalSteps ? "¡Entendido! 🦆" : "Siguiente";
    }

    btnNext.onclick = () => {
        SoundEffects.play('click');
        if (currentStep < totalSteps) { currentStep++; updateStepUI(); } 
        else {
            changeScreen('screen-login');
            document.getElementById('lobby-status').innerText = "¡Reglamento memorizado! Esperando sindicato...";
        }
    };
    btnPrev.onclick = () => { SoundEffects.play('click'); if (currentStep > 1) { currentStep--; updateStepUI(); } };
    updateStepUI();
}

// ==========================================
// SINCRONIZADOR GLOBAL
// ==========================================
function listenToGlobalState() {
    db.ref('game_room').on('value', (snapshot) => {
        const data = snapshot.val() || {};
        globalGameState = data;

        if (data.players?.[myPlayerId] && myMafiaId === null) {
            const serverMafiaId = data.players[myPlayerId].mafiaId;
            if (serverMafiaId && serverMafiaId !== "sin_asignar") myMafiaId = serverMafiaId;
        }

        const phase = data.currentPhase || 'LOGIN';
        const phaseKey = `${phase}_${data.round || 0}`;

        if (isHost) {
            renderMafiaTable('admin-mafia-tbody', data, true);
            updateAdminPanel(data);
            drawWarMap(data);
            updateAdminButtonVisibility(phase);
            document.getElementById('btn-host-reset-final').classList.toggle('hidden', phase !== 'END');
        } else {
            if (lastProcessedPhaseKey !== phaseKey) {
                if (phase === 'LOGIN' && document.getElementById('screen-tutorial').classList.contains('active')) return;
                lastProcessedPhaseKey = phaseKey;
                syncGamePhase(phase);
            }
        }
    });
}

function updateAdminButtonVisibility(phase) {
    const show = (id, v) => document.getElementById(id)?.classList.toggle('hidden', !v);
    show('btn-start-game',      phase === 'LOGIN');
    show('btn-launch-dashboard',phase === 'ASSIGNMENT');
    show('btn-force-resolve',   phase === 'DASHBOARD');
    show('btn-admin-next',      phase === 'TRANSITION');
    show('btn-end-game-now',    ['DASHBOARD', 'TRANSITION', 'ASSIGNMENT'].includes(phase));
    show('btn-reset-game',      true);
}

function renderMafiaTable(tableId, data, isAdmin) {
    const tbody = document.getElementById(tableId);
    if (!tbody || !data.mafias) return;
    tbody.innerHTML = "";

    Object.values(data.mafias).sort((a, b) => b.money - a.money).forEach(m => {
        const lastCol = isAdmin ? getVoteInfoForMafia(data, m.id) : "";
        let membersLi = "";
        Object.keys(data.players || {}).forEach(pId => {
            const p = data.players[pId];
            if (p.mafiaId === m.id) {
                membersLi += `<li>👤 ${escapeHTML(p.name)}${m.leaderId === pId ? ' <span class="leader-tag">👑 Jefe</span>' : ''}</li>`;
            }
        });
        if (!membersLi) membersLi = `<li class="text-muted">Sin personal</li>`;

        tbody.innerHTML += `<tr>
            <td><strong>${escapeHTML(m.name)}</strong><ul class="mafia-members-list">${membersLi}</ul></td>
            <td class="text-success font-bold">$${m.money}</td><td>${m.reputation}%</td><td>${m.influence}</td>
            ${isAdmin ? `<td>${lastCol}</td>` : ''}
        </tr>`;
    });
}

// ==========================================
// CONSOLA DEL DON (ADMIN)
// ==========================================
function updateAdminPanel(data) {
    document.getElementById('admin-round-label').innerText = `Fase: ${data.currentPhase || 'LOGIN'} — Ronda ${data.round || 0}/5`;
    const tPlayers = data.players ? Object.keys(data.players).length : 0;
    const tVotes = (data.round && data.votes?.[`ronda_${data.round}`]) ? Object.keys(data.votes[`ronda_${data.round}`]).length : 0;
    document.getElementById('admin-vote-count').innerText = `Votos: ${tVotes} / ${tPlayers}`;

    const adminLog = document.getElementById('admin-round-log');
    if (adminLog) {
        adminLog.innerHTML = (data.lastRoundLogs || []).map(t => `<p>${escapeHTML(t)}</p>`).join("") || '<p class="text-muted">Sin operaciones.</p>';
    }

    const spySelect = document.getElementById('admin-spy-target');
    if (spySelect) {
        const selectedId = spySelect.value;
        spySelect.innerHTML = Object.values(data.mafias || {}).map(m => `<option value="${m.id}" ${m.id === selectedId ? 'selected' : ''}>${escapeHTML(m.name)}</option>`).join("");
        
        const spyVotesUi = document.getElementById('admin-spy-votes');
        const fVotes = Object.values(data.votes?.[`ronda_${data.round}`] || {}).filter(v => v.mafiaSource === spySelect.value);
        if (fVotes.length === 0) spyVotesUi.innerHTML = `<li class="text-muted">Esperando votos...</li>`;
        else {
            const icons = { cooperar: '🤝', traicionar: '🗡️', robar: '🥷', alianza: '📜' };
            spyVotesUi.innerHTML = fVotes.map(v => `<li>👤 <strong>${escapeHTML(v.player)}</strong>: <span class="vote-badge-${v.action}">${icons[v.action]}</span> → <em>${escapeHTML(data.mafias?.[v.target]?.name || v.target)}</em></li>`).join("");
        }
    }
}

function initAdminSpyChatStreams(mafiaId) {
    if (adminSpyChatRef) adminSpyChatRef.off();
    if (adminSpyGlobalChatRef) adminSpyGlobalChatRef.off();
    
    const bInt = document.getElementById('admin-spy-chat'); const bGlob = document.getElementById('admin-spy-global-chat');
    bInt.innerHTML = ""; bGlob.innerHTML = ""; const r = globalGameState.round || 1;

    adminSpyChatRef = db.ref(`game_room/chats/${mafiaId}/ronda_${r}`);
    adminSpyChatRef.on('child_added', s => {
        const m = s.val(); if(m) { bInt.innerHTML += `<div><strong>[${escapeHTML(m.sender)}]:</strong> ${escapeHTML(m.text)}</div>`; bInt.scrollTop = bInt.scrollHeight; }
    });

    adminSpyGlobalChatRef = db.ref(`game_room/global_leader_chat/ronda_${r}`);
    adminSpyGlobalChatRef.on('child_added', s => {
        const m = s.val(); if(m) { bGlob.innerHTML += `<div><strong>[${escapeHTML(m.mafiaName)} - ${escapeHTML(m.sender)}]:</strong> ${escapeHTML(m.text)}</div>`; bGlob.scrollTop = bGlob.scrollHeight; }
    });
}

function getVoteInfoForMafia(data, mafiaId) {
    const v = Object.values(data.votes?.[`ronda_${data.round}`] || {}).filter(x => x.mafiaSource === mafiaId);
    if (v.length === 0) return '<span class="text-muted">Pensando...</span>';
    const counts = {}; v.forEach(x => counts[x.action] = (counts[x.action] || 0) + 1);
    const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    const icons = { cooperar: '🤝 Coop', traicionar: '🗡️ Traic', robar: '🥷 Robo', alianza: '📜 Pac' };
    return `<span class="vote-badge-${top}">${icons[top]} (${v.length}v)</span>`;
}

function drawWarMap(data) {
    const nG = document.getElementById('svg-nodes'), cG = document.getElementById('svg-connections');
    if (!nG || !cG || !data.mafias) return;
    nG.innerHTML = ""; cG.innerHTML = "";

    const mafias = Object.values(data.mafias).sort((a, b) => a.id.localeCompare(b.id));
    const coords = {}; const cx = 200, cy = 150, r = 100;
    mafias.forEach((m, i) => {
        const a = (i * 2 * Math.PI / mafias.length) - Math.PI / 4; 
        coords[m.id] = { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), name: m.name };
    });

    const pAct = {};
    Object.values(data.votes?.[`ronda_${data.round}`] || {}).forEach(v => {
        if (!pAct[v.mafiaSource]) pAct[v.mafiaSource] = { counts: {}, target: v.target };
        pAct[v.mafiaSource].counts[v.action] = (pAct[v.mafiaSource].counts[v.action] || 0) + 1;
    });

    Object.keys(pAct).forEach(src => {
        const { counts, target } = pAct[src];
        const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
        if (src === target || !coords[src] || !coords[target]) return;

        const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("d", `M ${coords[src].x} ${coords[src].y} L ${coords[target].x} ${coords[target].y}`);
        p.setAttribute("stroke", { cooperar: '#10b981', traicionar: '#ff0055', robar: '#ffcc00', alianza: '#00ffff' }[top] || '#64748b');
        p.setAttribute("stroke-width", "3"); p.setAttribute("fill", "none");
        p.setAttribute("marker-end", `url(#arrow-${top})`);
        
        if (top === 'traicionar' || top === 'robar') {
            p.setAttribute("stroke-dasharray", "8,4");
            const anim = document.createElementNS("http://www.w3.org/2000/svg", "animate");
            anim.setAttribute("attributeName", "stroke-dashoffset");
            anim.setAttribute("values", "100;0"); anim.setAttribute("dur", "1.2s");
            anim.setAttribute("repeatCount", "indefinite"); p.appendChild(anim);
        } else p.setAttribute("stroke-dasharray", "5,5");
        cG.appendChild(p);
    });

    Object.keys(coords).forEach(id => {
        const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
        const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        c.setAttribute("cx", coords[id].x); c.setAttribute("cy", coords[id].y);
        c.setAttribute("r", "20"); c.setAttribute("fill", pAct[id] ? "#1e293b" : "#0f172a");
        c.setAttribute("stroke", pAct[id] ? "#00ffcc" : "#334155"); c.setAttribute("stroke-width", "2");

        const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
        t.setAttribute("x", coords[id].x); t.setAttribute("y", coords[id].y + 4);
        t.setAttribute("text-anchor", "middle"); t.setAttribute("fill", "#fff");
        t.setAttribute("font-size", "9px"); t.setAttribute("font-weight", "bold");
        t.textContent = escapeHTML(coords[id].name.substring(0, 8));

        g.appendChild(c); g.appendChild(t); nG.appendChild(g);
    });
}

// ==========================================
// CONTROL DE FLUJO Y DASHBOARD
// ==========================================
function syncGamePhase(phase) {
    if (phase === 'LOGIN') {
        if (myPlayerId) {
            myMafiaId = null; myMafiaName = ""; myPlayerId = null; myPlayerName = "";
            lastProcessedPhaseKey = "";
            [timerInterval, chatListenerRef, globalLeaderListenerRef, adminSpyChatRef].forEach(x => { if(x && x.off) x.off(); else if(x) clearInterval(x); });
            changeScreen('screen-login');
            document.getElementById('admin-login-area').classList.remove('hidden');
            document.getElementById('main-logo-area').classList.remove('hidden');
        }
        return;
    }
    if (phase === 'ASSIGNMENT') { if (myMafiaId) { changeScreen('screen-assignment'); setupMafiaNameListener(); } return; }
    if (phase === 'DASHBOARD') { renderDashboard(); return; }
    if (phase === 'TRANSITION') {
        changeScreen('screen-transition');
        document.getElementById('rep-ronda-num').innerText = globalGameState.round;
        const logs = globalGameState.lastRoundLogs || [];
        document.getElementById('round-narrative-log').innerHTML = logs.map(t => `<p>${escapeHTML(t)}</p>`).join("") || '<p>Sin registros.</p>';
        if (logs.join(" ").includes("TRAICIÓN")) SoundEffects.play('traicion');
        return;
    }
    if (phase === 'END') { renderEndScreen(); return; }
}

function setupMafiaNameListener() {
    db.ref(`game_room/mafias/${myMafiaId}`).on('value', snap => {
        const m = snap.val(); if (!m) return;
        myMafiaName = m.name;
        document.getElementById('assigned-mafia-name').innerText = escapeHTML(m.name);
        
        const isLeader = m.leaderId === myPlayerId;
        document.getElementById('assigned-player-role').innerText = isLeader ? "Tu Rol: 👑 ¡LÍDER SUPREMO!" : "Tu Rol: Operativo";
        document.getElementById('naming-box').classList.toggle('hidden', !isLeader);
    });

    const btn = document.getElementById('btn-save-mafia-name');
    const newBtn = btn.cloneNode(true); btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', () => {
        const v = escapeHTML(document.getElementById('custom-mafia-name').value.trim());
        if (v.length < 3) return alert("Mínimo 3 caracteres.");
        SoundEffects.play('click');
        db.ref(`game_room/mafias/${myMafiaId}`).update({ name: v });
        document.getElementById('naming-box').innerHTML = "<p class='text-success'>✅ Nombre actualizado</p>";
    });
}

function renderDashboard() {
    changeScreen('screen-dashboard');
    document.getElementById('dash-player-name').innerText = escapeHTML(myPlayerName);
    document.getElementById('dash-mafia-name').innerText  = escapeHTML(myMafiaName);
    document.getElementById('timer-label').innerText = `RONDA ${globalGameState.round || 1}/5`;

    const isLeader = globalGameState.mafias?.[myMafiaId]?.leaderId === myPlayerId;
    document.getElementById('dash-leader-badge').classList.toggle('hidden', !isLeader);
    document.getElementById('global-leader-chat-box').classList.toggle('hidden', !isLeader);

    db.ref(`game_room/mafias/${myMafiaId}`).on('value', s => {
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
    const pVal = tSel.value; tSel.innerHTML = "";
    Object.keys(globalGameState.mafias || {}).forEach(mId => {
        if (mId !== myMafiaId) {
            const o = document.createElement('option'); o.value = mId;
            o.innerText = escapeHTML(globalGameState.mafias[mId].name); tSel.appendChild(o);
        }
    });
    if (pVal && tSel.querySelector(`option[value="${pVal}"]`)) tSel.value = pVal;

    document.getElementById('panel-voting').classList.remove('hidden');
    document.getElementById('panel-waiting-results').classList.add('hidden');
    document.getElementById('vote-status').innerText = "Vota una acción.";
    document.querySelectorAll('.btn-action').forEach(b => b.classList.remove('selected'));

    runClientTimer(globalGameState.timerEndTime);
    renderMafiaTable('live-ranking-body', globalGameState, false);
    
    listenInternalVotes();
    listenMafiaChat();
    if (isLeader) listenGlobalLeaderChat();
}

function listenInternalVotes() {
    db.ref(`game_room/votes/ronda_${globalGameState.round}`).on('value', s => {
        const vObj = s.val() || {}; const listUi = document.getElementById('internal-votes-list'); if (!listUi) return;
        const icons = { cooperar: '🤝', traicionar: '🗡️', robar: '🥷', alianza: '📜' };

        listUi.innerHTML = Object.values(vObj).filter(v => v.mafiaSource === myMafiaId).map(v => 
            `<li>📌 <strong>${escapeHTML(v.player)}</strong> eligió <span class="vote-badge-${v.action}">${icons[v.action]}</span> → <em>${escapeHTML(globalGameState.mafias?.[v.target]?.name || v.target)}</em></li>`
        ).join("");

        const voted = vObj[myPlayerId] !== undefined;
        document.getElementById('panel-voting').classList.toggle('hidden', voted);
        document.getElementById('panel-waiting-results').classList.toggle('hidden', !voted);
    });
}

function listenMafiaChat() {
    if (chatListenerRef) chatListenerRef.off();
    const c = document.getElementById('mafia-chat-messages'); c.innerHTML = "";
    chatListenerRef = db.ref(`game_room/chats/${myMafiaId}/ronda_${globalGameState.round}`);
    chatListenerRef.on('child_added', s => {
        const m = s.val(); if (!m) return;
        const col = m.playerId === myPlayerId ? 'var(--neon-cyan)' : 'var(--neon-pink)';
        c.innerHTML += `<div><strong style="color:${col};">${escapeHTML(m.sender)}:</strong> ${escapeHTML(m.text)}</div>`;
        c.scrollTop = c.scrollHeight;
    });
}

function sendMafiaChatMessage() {
    const i = document.getElementById('mafia-chat-input'); const t = i.value.trim();
    if (!t || !myMafiaId) return;
    db.ref(`game_room/chats/${myMafiaId}/ronda_${globalGameState.round}`).push({ playerId: myPlayerId, sender: myPlayerName, text: t });
    i.value = ""; SoundEffects.play('click');
}

function listenGlobalLeaderChat() {
    if (globalLeaderListenerRef) globalLeaderListenerRef.off();
    const c = document.getElementById('global-leader-messages'); c.innerHTML = "";
    globalLeaderListenerRef = db.ref(`game_room/global_leader_chat/ronda_${globalGameState.round}`);
    globalLeaderListenerRef.on('child_added', s => {
        const m = s.val(); if (!m) return;
        const name = m.playerId === myPlayerId ? `Tú (${escapeHTML(m.mafiaName)})` : `${escapeHTML(m.mafiaName)} [${escapeHTML(m.sender)}]`;
        c.innerHTML += `<div><strong>[${name}]:</strong> ${escapeHTML(m.text)}</div>`;
        c.scrollTop = c.scrollHeight;
    });
}

function sendGlobalLeaderMessage() {
    const i = document.getElementById('global-leader-input'); const t = i.value.trim();
    if (!t || !myMafiaId) return;
    db.ref(`game_room/global_leader_chat/ronda_${globalGameState.round}`).push({ playerId: myPlayerId, sender: myPlayerName, mafiaId: myMafiaId, mafiaName: myMafiaName, text: t });
    i.value = ""; SoundEffects.play('click');
}

function runClientTimer(endTime) {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        const diff = endTime - new Date().getTime();
        const tEl = document.getElementById('timer-display'); if (!tEl) return;
        if (diff <= 0) { clearInterval(timerInterval); tEl.innerText = "00:00"; if (isHost) resolveRoundLogic(); } 
        else { const min = Math.floor(diff / 60000); const sec = Math.floor((diff % 60000) / 1000); tEl.innerText = `${min}:${sec < 10 ? '0' : ''}${sec}`; }
    }, 1000);
}

// ==========================================
// PANTALLA FINAL
// ==========================================
function renderEndScreen() {
    changeScreen('screen-end'); SoundEffects.play('victoria');
    const arr = Object.values(globalGameState.mafias || {}).sort((a, b) => b.money - a.money);
    document.getElementById('winner-name').innerText = arr.length > 0 ? escapeHTML(arr[0].name).toUpperCase() : "SIN GANADOR";

    const pod = document.getElementById('final-podium');
    if (pod) pod.innerHTML = arr.slice(0, 3).map((m, i) => `
         <div class="card bg-dark text-left mt-1" style="border-left: 4px solid ${i===0?'var(--neon-yellow)':'var(--border-neon)'};">
            <h3 style="margin:0; font-size:14px; color:${i===0?'var(--neon-yellow)':'var(--border-neon)'}">#${i+1} Lugar</h3>
            <h4 style="margin:4px 0; font-size:16px;">${escapeHTML(m.name)}</h4>
            <p class="text-success m-0 font-bold">$${m.money}</p>
         </div>`).join("");

    const stats = globalGameState.estadisticasHistoricas || { traiciones: {}, cooperaciones: {} };
    let mT = -1, tN = "Ninguno", mC = -1, cN = "Ninguno";
    Object.keys(stats.traiciones || {}).forEach(id => { if (stats.traiciones[id] > mT) { mT = stats.traiciones[id]; tN = globalGameState.mafias[id]?.name || id; } });
    Object.keys(stats.cooperaciones || {}).forEach(id => { if (stats.cooperaciones[id] > mC) { mC = stats.cooperaciones[id]; cN = globalGameState.mafias[id]?.name || id; } });

    document.getElementById('badge-trust-name').innerText = mC > 0 ? `${escapeHTML(cN)} (${mC}v)` : "Ninguno";
    document.getElementById('badge-traitor-name').innerText = mT > 0 ? `${escapeHTML(tN)} (${mT}v)` : "Ninguno";
}

// ==========================================
// ACCIONES DEL MASTER
// ==========================================
function masterActionStartGame() {
    SoundEffects.play('click');
    db.ref('game_room/players').once('value', s => {
        const pObj = s.val(); if (!pObj) return alert("Sin jugadores.");
        const keys = Object.keys(pObj);
        
        const config = {}; const upd = {};
        for (let m = 1; m <= 4; m++) config[`mafia_${m}`] = { id: `mafia_${m}`, name: `Sindicato ${m}`, money: 1200, reputation: 100, influence: 50, leaderId: "" };

        keys.forEach((pId, i) => {
            const mId = `mafia_${(i % 4) + 1}`; upd[`players/${pId}/mafiaId`] = mId;
            if (!config[mId].leaderId) config[mId].leaderId = pId; 
        });

        upd['mafias'] = config; upd['currentPhase'] = 'ASSIGNMENT'; upd['round'] = 1;
        db.ref('game_room').update(upd);
    });
}

function masterLaunchRound() {
    SoundEffects.play('click');
    db.ref('game_room').update({ timerEndTime: new Date().getTime() + 180000, currentEvent: EVENTOS[Math.floor(Math.random() * EVENTOS.length)], currentPhase: 'DASHBOARD' });
}

function masterActionNextRound() {
    SoundEffects.play('click'); const n = (globalGameState.round || 1) + 1;
    if (n > 5) return masterEndGameNow();
    db.ref('game_room').update({ round: n, timerEndTime: new Date().getTime() + 180000, currentEvent: EVENTOS[Math.floor(Math.random() * EVENTOS.length)], currentPhase: 'DASHBOARD' });
}

function masterEndGameNow() {
    SoundEffects.play('click');
    db.ref('game_room').once('value', s => { if (s.val()?.currentPhase === 'DASHBOARD') resolveRoundLogic(true); else db.ref('game_room').update({ currentPhase: 'END' }); });
}

function masterResetEverything() {
    if (!confirm("Borrará toda la partida.")) return;
    SoundEffects.play('click');
    [timerInterval, chatListenerRef, globalLeaderListenerRef, adminSpyChatRef].forEach(x => { if(x && x.off) x.off(); else if(x) clearInterval(x); });
    db.ref('game_room').set({ currentPhase: 'LOGIN' }).then(() => window.location.reload());
}

// ==========================================
// RESOLUCIÓN DE RONDAS (Motor Principal)
// ==========================================
function resolveRoundLogic(goToEnd = false) {
    db.ref('game_room').once('value', s => {
        const game = s.val(); if (!game?.mafias) return;
        const rV = game.votes?.[`ronda_${game.round}`]; const mafias = game.mafias; const logs = [`--- RONDA ${game.round} ---`];
        const dec = {}; Object.keys(mafias).forEach(mId => dec[mId] = { action: 'cooperar', target: null, counts: {} });

        if (rV) {
            Object.values(rV).forEach(v => {
                if (dec[v.mafiaSource]) { dec[v.mafiaSource].counts[v.action] = (dec[v.mafiaSource].counts[v.action] || 0) + 1; dec[v.mafiaSource].target = v.target; }
            });
            Object.keys(dec).forEach(mId => {
                const c = dec[mId].counts; if (Object.keys(c).length > 0) dec[mId].action = Object.keys(c).sort((a, b) => c[b] - c[a])[0];
            });
        }

        const st = game.estadisticasHistoricas || { traiciones: {}, cooperaciones: {} };

        Object.keys(mafias).forEach(mId => {
            const a = dec[mId].action; const t = dec[mId].target || Object.keys(mafias).find(x => x !== mId);
            st.traiciones[mId] = st.traiciones[mId] || 0; st.cooperaciones[mId] = st.cooperaciones[mId] || 0;

            if (a === 'cooperar') {
                let g = 400 * (mafias[mId].reputation / 100); if (game.currentEvent?.code === "AUGE") g *= 1.5;
                mafias[mId].money += Math.round(g); mafias[mId].reputation = Math.min(100, mafias[mId].reputation + 10);
                st.cooperaciones[mId]++; logs.push(`🕊️ [${mafias[mId].name}] COOPERÓ.`);
            } else if (a === 'traicionar') {
                mafias[mId].money += 800; mafias[mId].reputation = Math.max(10, mafias[mId].reputation - 35);
                if (mafias[t]) mafias[t].money = Math.max(0, mafias[t].money - 400);
                st.traiciones[mId]++;
                if (game.currentEvent?.code === "REDADA") { mafias[mId].money -= 500; logs.push(`🚨 REDADA: [${mafias[mId].name}] penalizado.`); }
                logs.push(`🗡️ TRAICIÓN: [${mafias[mId].name}] atacó a [${mafias[t]?.name || 'Rival'}].`);
            } else if (a === 'robar') {
                mafias[mId].influence += 20; if (mafias[t]) mafias[t].influence = Math.max(0, mafias[t].influence - 20);
                logs.push(`🥷 [${mafias[mId].name}] robó influencia.`);
            } else if (a === 'alianza') {
                if (dec[t]?.action === 'alianza' && dec[t]?.target === mId) { mafias[mId].money += 600; mafias[mId].influence += 15; logs.push(`📜 PACTO: [${mafias[mId].name}] y [${mafias[t].name}].`); }
                else logs.push(`⚠️ Alianza fallida de [${mafias[mId].name}].`);
            }
            if (game.currentEvent?.code === "CRISIS") mafias[mId].money = Math.max(0, mafias[mId].money - 200);
        });

        if (game.currentEvent?.code === "LAVADO") {
            Object.keys(mafias).forEach(mId => { const b = mafias[mId].influence * 10; mafias[mId].money += b; logs.push(`💸 LAVADO: [${mafias[mId].name}] +$${b}.`); });
        }

        db.ref('game_room').update({ mafias, lastRoundLogs: logs, estadisticasHistoricas: st, currentPhase: goToEnd ? 'END' : 'TRANSITION' });
    });
}