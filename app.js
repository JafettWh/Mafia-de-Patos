// ==========================================
// CONFIGURACIÓN DE FIREBASE
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

let myPlayerId    = null;
let myPlayerName  = "";
let myMafiaId     = null;
let myMafiaName   = "";
let isHost        = false;
let globalGameState = {};
let timerInterval = null;
let lastProcessedPhaseKey = "";
let chatListenerRef = null;

// Referencias de escucha de espionaje del Don para evitar fugas de memoria
let adminSpyChatRef = null;

// ==========================================
// AUDIO SINTETIZADO
// ==========================================
const SoundEffects = {
    ctx: null,
    play(type) {
        try {
            if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
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
    { title: "MERCADO EN AUGE",   desc: "Las ganancias por Cooperación aumentan un 50% este turno.", code: "AUGE"   },
    { title: "REDADA POLICIAL",   desc: "Las traiciones son descubiertas. El Traidor pierde $500 extras.", code: "REDADA" },
    { title: "CRISIS ECONÓMICA",  desc: "El mercado cae. Todas las mafias pierden $200 al iniciar la ronda.", code: "CRISIS" },
    { title: "LAVADO DE DINERO",  desc: "La influencia otorga dividendos. +$10 por cada punto de influencia.", code: "LAVADO" }
];

function changeScreen(screenId) {
    if (isHost) return;
    document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === screenId));
}

// ==========================================
// INICIALIZACIÓN DE LISTENERS
// ==========================================
document.addEventListener("DOMContentLoaded", () => {
    document.getElementById('admin-toggle').addEventListener('change', function() {
        document.getElementById('admin-password-box').classList.toggle('hidden', !this.checked);
    });

    document.getElementById('btn-join').addEventListener('click', setupLogin);
    document.getElementById('btn-start-game').addEventListener('click', masterActionStartGame);
    document.getElementById('btn-launch-dashboard').addEventListener('click', masterLaunchRound);
    document.getElementById('btn-force-resolve').addEventListener('click', () => {
        if (confirm("¿Forzar la resolución de la ronda actual de manera manual?")) resolveRoundLogic();
    });
    document.getElementById('btn-admin-next').addEventListener('click', masterActionNextRound);
    document.getElementById('btn-end-game-now').addEventListener('click', () => {
        if (confirm("¿Terminar la partida de manera inmediata?")) masterEndGameNow();
    });
    document.getElementById('btn-reset-game').addEventListener('click', masterResetEverything);
    document.getElementById('btn-host-reset-final').addEventListener('click', masterResetEverything);

    document.getElementById('btn-mafia-chat-send').addEventListener('click', sendMafiaChatMessage);
    document.getElementById('mafia-chat-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMafiaChatMessage();
    });

    // Cambiar de frecuencia de radio en la consola de espionaje del Don sin acumular memoria
    const spySelect = document.getElementById('admin-spy-target');
    if (spySelect) {
        spySelect.addEventListener('change', () => {
            if (!isHost) return;
            initAdminSpyChatStream(spySelect.value);
        });
    }

    // SISTEMA DE CONFIRMACIÓN DE VOTOS
    document.querySelectorAll('.btn-action').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!myPlayerId || !myMafiaId) return;
            
            const act = btn.getAttribute('data-action');
            const targetSelect = document.getElementById('target-mafia');
            const targetId = targetSelect.value;
            const targetName = targetSelect.options[targetSelect.selectedIndex]?.text || targetId;
            
            const actionText = {
                cooperar: "COOPERAR con",
                traicionar: "TRAICIONAR a",
                robar: "ROBAR RECURSOS a",
                alianza: "proponer un PACTO TEMPORAL a"
            }[act] || act;

            if (!confirm(`¿Confirmas que deseas ${actionText} a "${targetName}"?`)) return; 

            document.querySelectorAll('.btn-action').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            
            db.ref(`game_room/votes/ronda_${globalGameState.round}/${myPlayerId}`).set({
                player: myPlayerName, mafiaSource: myMafiaId, action: act, target: targetId
            });
            
            SoundEffects.play('click');
            document.getElementById('vote-status').innerText = `✅ Voto enviado: ${act} → ${globalGameState.mafias?.[targetId]?.name || targetId}`;
        });
    });

    listenToGlobalState();
});

// ==========================================
// REGISTRO Y LOGIN
// ==========================================
function setupLogin() {
    const nameIn = document.getElementById('player-name').value.trim();
    if (nameIn.length < 2) return alert("Alias inválido. Debe contener mínimo 2 caracteres.");

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
        updateAdminButtonVisibility('LOGIN');
        // Inicializar la radio espía del Don en la primera mafia por defecto
        setTimeout(() => { initAdminSpyChatStream('mafia_1'); }, 1000);
    } else {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        document.getElementById('screen-tutorial').classList.add('active');
        initTutorialLogic();
    }
}

// ==========================================
// REGLAMENTO INTERACTIVO
// ==========================================
function initTutorialLogic() {
    let currentStep = 1;
    const totalSteps = 4;
    
    const btnPrev = document.getElementById('btn-tut-prev');
    const btnNext = document.getElementById('btn-tut-next');
    
    function updateStepUI() {
        document.querySelectorAll('.tutorial-step').forEach(step => {
            const stepNum = parseInt(step.getAttribute('data-step'));
            step.style.display = stepNum === currentStep ? 'block' : 'none';
        });
        
        btnPrev.classList.toggle('hidden', currentStep === 1);
        btnPrev.style.display = currentStep === 1 ? 'none' : 'block';
        
        if (currentStep === totalSteps) {
            btnNext.innerText = "¡Entendido, ir al Callejón! 🦆";
        } else {
            btnNext.innerText = "Siguiente";
        }
    }

    btnNext.onclick = () => {
        SoundEffects.play('click');
        if (currentStep < totalSteps) {
            currentStep++;
            updateStepUI();
        } else {
            document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
            document.getElementById('screen-login').classList.add('active');
            document.getElementById('lobby-status').innerText = "¡Leíste el reglamento! Esperando que el Don asigne las familias...";
        }
    };

    btnPrev.onclick = () => {
        SoundEffects.play('click');
        if (currentStep > 1) {
            currentStep--;
            updateStepUI();
        }
    };

    updateStepUI();
}

// ==========================================
// SINCRONIZADOR GLOBAL FIREBASE
// ==========================================
function listenToGlobalState() {
    db.ref('game_room').on('value', (snapshot) => {
        const data = snapshot.val() || {};
        globalGameState = data;

        const countEl = document.getElementById('player-count');
        if (countEl && data.players) countEl.innerText = Object.keys(data.players).length;

        if (data.players?.[myPlayerId] && myMafiaId === null) {
            const serverMafiaId = data.players[myPlayerId].mafiaId;
            if (serverMafiaId && serverMafiaId !== "sin_asignar") {
                myMafiaId = serverMafiaId;
            }
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
    const show = (id, visible) => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('hidden', !visible);
    };
    show('btn-start-game',      phase === 'LOGIN');
    show('btn-launch-dashboard',phase === 'ASSIGNMENT');
    show('btn-force-resolve',   phase === 'DASHBOARD');
    show('btn-admin-next',      phase === 'TRANSITION');
    show('btn-end-game-now',    phase === 'DASHBOARD' || phase === 'TRANSITION' || phase === 'ASSIGNMENT');
    show('btn-reset-game',      true);
}

function renderMafiaTable(tableId, data, isAdmin) {
    const tbody = document.getElementById(tableId);
    if (!tbody || !data.mafias) return;
    tbody.innerHTML = "";
    Object.values(data.mafias).sort((a, b) => b.money - a.money).forEach(m => {
        const lastCol = isAdmin ? getVoteInfoForMafia(data, m.id) : `${m.influence} 👑`;
        tbody.innerHTML += `<tr>
            <td><strong>${m.name}</strong></td>
            <td>$${m.money}</td>
            <td>${m.reputation}%</td>
            <td>${m.influence}</td>
            <td>${lastCol}</td>
        </tr>`;
    });
}

// ==========================================
// CONSOLA CORE DE ESPIONAJE DEL DON
// ==========================================
function updateAdminPanel(data) {
    const phase = data.currentPhase || 'LOGIN';
    const round = data.round || 0;
    document.getElementById('admin-round-label').innerText = `Fase: ${phase} — Ronda ${round}/5`;

    const totalPlayers = data.players ? Object.keys(data.players).length : 0;
    const totalVotes   = (data.round && data.votes?.[`ronda_${data.round}`]) ? Object.keys(data.votes[`ronda_${data.round}`]).length : 0;
    document.getElementById('admin-vote-count').innerText = `Votos: ${totalVotes} / ${totalPlayers}`;

    const adminLog = document.getElementById('admin-round-log');
    if (adminLog) {
        adminLog.innerHTML = (data.lastRoundLogs || []).map(t => `<p>${t}</p>`).join("") || '<p style="color:var(--text-muted)">Sin operaciones registradas.</p>';
    }

    // LÓGICA DE ESPIONAJE DE VOTOS INDIVIDUALES EN VIVO
    const spySelect = document.getElementById('admin-spy-target');
    if (spySelect) {
        const selectedSpyMafia = spySelect.value;
        
        // Sincronizar nombres dinámicos de los sindicatos en el selector
        Object.keys(data.mafias || {}).forEach(mId => {
            const opt = spySelect.querySelector(`option[value="${mId}"]`);
            if (opt) opt.innerText = data.mafias[mId].name;
        });

        const spyVotesUi = document.getElementById('admin-spy-votes');
        const roundVotes = data.votes?.[`ronda_${data.round}`] || {};
        const actionIcons = { cooperar: '🤝 Coop', traicionar: '🗡️ Traic', robar: '🥷 Robo', alianza: '📜 Pac' };
        
        const filteredVotes = Object.values(roundVotes).filter(v => v.mafiaSource === selectedSpyMafia);
        if (filteredVotes.length === 0) {
            spyVotesUi.innerHTML = `<li style="color:var(--text-muted); font-style:italic;">Ningún miembro ha enviado su voto aún...</li>`;
        } else {
            spyVotesUi.innerHTML = filteredVotes.map(v => {
                const targetName = data.mafias?.[v.target]?.name || v.target;
                return `<li style="border-bottom:1px solid rgba(255,255,255,0.05); padding:2px 0;">👤 <strong>${v.player}</strong> votó <span class="vote-badge-${v.action}">${actionIcons[v.action]}</span> contra <em>${targetName}</em></li>`;
            }).join("");
        }
    }
}

// Escucha en streaming exclusiva del Don para interceptar los mensajes de la mafia seleccionada
function initAdminSpyChatStream(mafiaId) {
    if (adminSpyChatRef) adminSpyChatRef.off();
    
    const chatBox = document.getElementById('admin-spy-chat');
    if (!chatBox) return;
    chatBox.innerHTML = `<p style="color:var(--text-muted); font-style:italic;">Interceptando canal seguro de la mafia...</p>`;
    
    const currentRound = globalGameState.round || 1;
    adminSpyChatRef = db.ref(`game_room/chats/${mafiaId}/ronda_${currentRound}`);
    
    adminSpyChatRef.on('child_added', snap => {
        const msg = snap.val();
        if (!msg) return;
        
        // Remover el mensaje inicial informativo al recibir tráfico real
        const placeholder = chatBox.querySelector('p');
        if (placeholder) placeholder.remove();
        
        chatBox.innerHTML += `<div style="margin-bottom:4px; font-size:12px;">⏰ <strong>[${msg.sender}]:</strong> ${msg.text}</div>`;
        chatBox.scrollTop = chatBox.scrollHeight;
    });
}

function getVoteInfoForMafia(data, mafiaId) {
    const roundVotes = data.votes?.[`ronda_${data.round}`];
    const votes = roundVotes ? Object.values(roundVotes).filter(v => v.mafiaSource === mafiaId) : [];
    if (votes.length === 0) return '<span style="color:var(--text-muted)">Pensando...</span>';
    const counts = {};
    votes.forEach(v => counts[v.action] = (counts[v.action] || 0) + 1);
    const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    const icons = { cooperar: '🤝 Coop', traicionar: '🗡️ Traic', robar: '🥷 Robo', alianza: '📜 Pac' };
    return `<span class="vote-badge-${top}">${icons[top] || top} (${votes.length}v)</span>`;
}

// ==========================================
// RENDERIZADO DEL MAPA SVG
// ==========================================
function drawWarMap(data) {
    const nodesG = document.getElementById('svg-nodes');
    const connG  = document.getElementById('svg-connections');
    if (!nodesG || !connG) return;
    nodesG.innerHTML = ""; connG.innerHTML = "";
    if (!data.mafias) return;

    const mafiasArr = Object.values(data.mafias).sort((a, b) => a.id.localeCompare(b.id));
    const total = mafiasArr.length;
    const cx = 200, cy = 200, r = 125;
    const nodeCoords = {};

    mafiasArr.forEach((m, i) => {
        const angle = (i * 2 * Math.PI / total) - Math.PI / 2;
        nodeCoords[m.id] = { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle), name: m.name };
    });

    const currentVotes = data.votes?.[`ronda_${data.round}`] || {};
    const processedActions = {};
    Object.values(currentVotes).forEach(v => {
        if (!processedActions[v.mafiaSource]) {
            processedActions[v.mafiaSource] = { counts: {}, target: v.target };
        }
        processedActions[v.mafiaSource].counts[v.action] = (processedActions[v.mafiaSource].counts[v.action] || 0) + 1;
    });

    Object.keys(processedActions).forEach(srcId => {
        const { counts, target: targetId } = processedActions[srcId];
        const topAction = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
        if (!srcId || !targetId || !nodeCoords[srcId] || !nodeCoords[targetId] || srcId === targetId) return;

        const start = nodeCoords[srcId], end = nodeCoords[targetId];
        const colorMap = { cooperar: '#10b981', traicionar: '#ff0055', robar: '#ffcc00', alianza: '#00ffff' };
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", `M ${start.x} ${start.y} L ${end.x} ${end.y}`);
        path.setAttribute("stroke", colorMap[topAction] || '#64748b');
        path.setAttribute("stroke-width", "2.5");
        path.setAttribute("fill", "none");
        path.setAttribute("marker-end", `url(#arrow-${topAction})`);

        if (topAction === 'traicionar' || topAction === 'robar') {
            path.setAttribute("stroke-dasharray", "8,4");
            const anim = document.createElementNS("http://www.w3.org/2000/svg", "animate");
            anim.setAttribute("attributeName", "stroke-dashoffset");
            anim.setAttribute("values", "100;0");
            anim.setAttribute("dur", "1.2s");
            anim.setAttribute("repeatCount", "indefinite");
            path.appendChild(anim);
        } else {
            path.setAttribute("stroke-dasharray", "5,5");
        }
        connG.appendChild(path);
    });

    Object.keys(nodeCoords).forEach(mId => {
        const coord = nodeCoords[mId];
        const hasVoted = !!processedActions[mId];
        const g = document.createElementNS("http://www.w3.org/2000/svg", "g");

        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("cx", coord.x); circle.setAttribute("cy", coord.y);
        circle.setAttribute("r", "22");
        circle.setAttribute("fill",   hasVoted ? "#1e293b" : "#0f172a");
        circle.setAttribute("stroke", hasVoted ? "#00ffcc" : "#334155");
        circle.setAttribute("stroke-width", "2");

        const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
        label.setAttribute("x", coord.x); label.setAttribute("y", coord.y + 4);
        label.setAttribute("text-anchor", "middle");
        label.setAttribute("fill", "#fff"); label.setAttribute("font-size", "9px");
        label.setAttribute("font-weight", "bold");
        label.textContent = coord.name.substring(0, 6);

        g.appendChild(circle); g.appendChild(label);
        nodesG.appendChild(g);
    });
}

// ==========================================
// MAQUINARIA DE CAMBIO DE FASE
// ==========================================
function syncGamePhase(phase) {
    if (phase === 'LOGIN') {
        if (myPlayerId) {
            myMafiaId = null; myMafiaName = ""; myPlayerId = null; myPlayerName = "";
            lastProcessedPhaseKey = "";
            if (timerInterval) clearInterval(timerInterval);
            if (chatListenerRef) chatListenerRef.off();
            if (adminSpyChatRef) adminSpyChatRef.off();
            document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
            document.getElementById('screen-login').classList.add('active');
            document.getElementById('admin-login-area').classList.remove('hidden');
            document.getElementById('main-logo-area').classList.remove('hidden');
            document.getElementById('lobby-status').innerText = "Esperando conexión...";
        }
        return;
    }

    if (phase === 'ASSIGNMENT') {
        if (myMafiaId) {
            changeScreen('screen-assignment');
            setupMafiaNameListener();
        }
        return;
    }

    if (phase === 'DASHBOARD') {
        renderDashboard();
        return;
    }

    if (phase === 'TRANSITION') {
        changeScreen('screen-transition');
        document.getElementById('rep-ronda-num').innerText = globalGameState.round;
        const logs = globalGameState.lastRoundLogs || [];
        document.getElementById('round-narrative-log').innerHTML = logs.map(t => `<p>${t}</p>`).join("") || '<p>Sin registros.</p>';
        if (logs.join(" ").includes("TRAICIÓN")) SoundEffects.play('traicion');
        return;
    }

    if (phase === 'END') {
        renderEndScreen();
        return;
    }
}

function setupMafiaNameListener() {
    db.ref(`game_room/mafias/${myMafiaId}`).on('value', snap => {
        const mData = snap.val();
        if (!mData) return;
        myMafiaName = mData.name;
        document.getElementById('assigned-mafia-name').innerText = myMafiaName;
        
        const namingBox = document.getElementById('naming-box');
        if (namingBox) {
            namingBox.classList.toggle('hidden', mData.leaderId !== myPlayerId);
        }
    });

    const saveBtn = document.getElementById('btn-save-mafia-name');
    const newSaveBtn = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
    newSaveBtn.addEventListener('click', () => {
        const cName = document.getElementById('custom-mafia-name').value.trim();
        if (cName.length < 3) return alert("Nombre no válido. Debe tener mínimo 3 caracteres.");
        SoundEffects.play('click');
        db.ref(`game_room/mafias/${myMafiaId}`).update({ name: cName });
        document.getElementById('naming-box').innerHTML = "<p style='color:var(--success)'>✅ ¡Identidad establecida!</p>";
    });
}

// ==========================================
// RENDERIZADO DEL PANEL DE JUEGO (DASHBOARD)
// ==========================================
function renderDashboard() {
    changeScreen('screen-dashboard');
    document.getElementById('dash-player-name').innerText = myPlayerName;
    document.getElementById('dash-mafia-name').innerText  = myMafiaName;
    document.getElementById('timer-label').innerText = `RONDA ${globalGameState.round || 1}/5`;

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

    populateTargetSelect();

    document.getElementById('panel-voting').classList.remove('hidden');
    document.getElementById('panel-waiting-results').classList.add('hidden');
    document.getElementById('vote-status').innerText = "No has emitido tu voto secreto.";
    document.querySelectorAll('.btn-action').forEach(b => b.classList.remove('selected'));

    runClientTimer(globalGameState.timerEndTime);
    renderMafiaTable('live-ranking-body', globalGameState, false);
    
    listenInternalVotes();
    listenMafiaChat();

    // Sincronizar la radio de espionaje del Don automáticamente al arrancar la ronda
    if (isHost) {
        const spySelect = document.getElementById('admin-spy-target');
        if (spySelect) initAdminSpyChatStream(spySelect.value);
    }
}

function populateTargetSelect() {
    const targetSelect = document.getElementById('target-mafia');
    const previousValue = targetSelect.value;
    targetSelect.innerHTML = "";
    Object.keys(globalGameState.mafias || {}).forEach(mId => {
        if (mId !== myMafiaId) {
            const opt = document.createElement('option');
            opt.value = mId;
            opt.innerText = globalGameState.mafias[mId].name;
            targetSelect.appendChild(opt);
        }
    });
    if (previousValue && targetSelect.querySelector(`option[value="${previousValue}"]`)) {
        targetSelect.value = previousValue;
    }
}

function listenInternalVotes() {
    db.ref(`game_room/votes/ronda_${globalGameState.round}`).on('value', snap => {
        const vObj = snap.val() || {};
        const listUi = document.getElementById('internal-votes-list');
        if (!listUi) return;

        const actionIcons = { cooperar: '🤝 Coop', traicionar: '🗡️ Traic', robar: '🥷 Robo', alianza: '📜 Pac' };

        listUi.innerHTML = Object.values(vObj)
            .filter(v => v.mafiaSource === myMafiaId)
            .map(v => {
                const targetName = globalGameState.mafias?.[v.target]?.name || v.target;
                const icon = actionIcons[v.action] || v.action;
                return `<li style="margin-bottom:4px; padding:3px; background:rgba(255,255,255,0.05); border-radius:3px;">
                    📌 <strong>${v.player}</strong> eligió <span class="vote-badge-${v.action}" style="padding:1px 4px; border-radius:3px; font-size:11px;">${icon}</span> contra <em>${targetName}</em>
                </li>`;
            }).join("");

        const voted = vObj[myPlayerId] !== undefined;
        document.getElementById('panel-voting').classList.toggle('hidden', voted);
        document.getElementById('panel-waiting-results').classList.toggle('hidden', !voted);
    });
}

function listenMafiaChat() {
    if (chatListenerRef) chatListenerRef.off();
    
    const chatContainer = document.getElementById('mafia-chat-messages');
    if (!chatContainer) return;
    chatContainer.innerHTML = "";
    
    chatListenerRef = db.ref(`game_room/chats/${myMafiaId}/ronda_${globalGameState.round}`);
    chatListenerRef.on('child_added', (snap) => {
        const msg = snap.val();
        if (!msg) return;
        
        const isMe = msg.playerId === myPlayerId;
        const color = isMe ? 'var(--neon-cyan)' : 'var(--neon-pink)';
        
        chatContainer.innerHTML += `<div style="margin-bottom:6px; line-height:1.4;">
            <strong style="color:${color};">${msg.sender}:</strong> <span style="color:#e2e8f0;">${msg.text}</span>
        </div>`;
        chatContainer.scrollTop = chatContainer.scrollHeight;
    });
}

function sendMafiaChatMessage() {
    const input = document.getElementById('mafia-chat-input');
    const text = input.value.trim();
    if (text.length === 0 || !myMafiaId) return;

    db.ref(`game_room/chats/${myMafiaId}/ronda_${globalGameState.round}`).push({
        playerId: myPlayerId,
        sender: myPlayerName,
        text: text,
        timestamp: new Date().getTime()
    });

    input.value = "";
    SoundEffects.play('click');
}

function runClientTimer(endTime) {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        const diff = endTime - new Date().getTime();
        const timerEl = document.getElementById('timer-display');
        if (!timerEl) return;
        if (diff <= 0) {
            clearInterval(timerInterval);
            timerEl.innerText = "00:00";
            if (isHost) resolveRoundLogic();
        } else {
            const min = Math.floor(diff / 60000);
            const sec = Math.floor((diff % 60000) / 1000);
            timerEl.innerText = `${min}:${sec < 10 ? '0' : ''}${sec}`;
        }
    }, 1000);
}

// ==========================================
// PANTALLA FINAL
// ==========================================
function renderEndScreen() {
    changeScreen('screen-end');
    SoundEffects.play('victoria');

    const mafiasData = globalGameState.mafias || {};
    const arr = Object.values(mafiasData).sort((a, b) => b.money - a.money);

    const winnerEl = document.getElementById('winner-name');
    if (winnerEl) winnerEl.innerText = arr.length > 0 ? arr[0].name.toUpperCase() : "SIN GANADOR";

    const podiumEl = document.getElementById('final-podium');
    if (podiumEl) {
        if (arr.length === 0) {
            podiumEl.innerHTML = `<p style="color:var(--text-muted); text-align:center;">Sin datos financieros.</p>`;
        } else {
            podiumEl.innerHTML = arr.slice(0, 3).map((m, i) => {
                const borderColor = i === 0 ? 'var(--neon-yellow)' : 'var(--border-neon)';
                return `
                 <div class="stat-card" style="border-left: 4px solid ${borderColor}; margin-bottom: 10px; padding: 12px; background: #1a1d30; border-radius:8px; text-align: left;">
                    <h3 style="margin:0; font-size:14px; color:${borderColor}">#${i+1} Lugar</h3>
                    <h4 style="margin:4px 0; font-size:16px; font-weight:bold;">${m.name}</h4>
                    <p style="color:var(--success); font-weight:bold; margin:0;">$${m.money}</p>
                 </div>`;
            }).join("");
        }
    }

    const stats = globalGameState.estadisticasHistoricas || { traiciones: {}, cooperaciones: {} };
    let maxT = -1, tName = "Ninguno";
    let maxC = -1, cName = "Ninguno";

    Object.keys(stats.traiciones || {}).forEach(id => {
        if (stats.traiciones[id] > maxT) { maxT = stats.traiciones[id]; tName = mafiasData[id]?.name || id; }
    });
    Object.keys(stats.cooperaciones || {}).forEach(id => {
        if (stats.cooperaciones[id] > maxC) { maxC = stats.cooperaciones[id]; cName = mafiasData[id]?.name || id; }
    });

    const trustEl = document.getElementById('badge-trust-name');
    const traitorEl = document.getElementById('badge-traitor-name');
    if (trustEl) trustEl.innerText = maxC > 0 ? `${cName} (${maxC} veces)` : "Ninguno";
    if (traitorEl) traitorEl.innerText = maxT > 0 ? `${tName} (${maxT} veces)` : "Ninguno";

    const resetFinalEl = document.getElementById('btn-host-reset-final');
    if (resetFinalEl) resetFinalEl.classList.toggle('hidden', !isHost);
}

// ==========================================
// CONTROLADORES DEL HOST
// ==========================================
function masterActionStartGame() {
    SoundEffects.play('click');
    db.ref('game_room/players').once('value', snap => {
        const pObj = snap.val();
        if (!pObj) return alert("No hay jugadores en la sala de espera.");

        const keys = Object.keys(pObj);
        const totalMafias = 7;
        const mafiasConfig = {};
        const updates = {};

        for (let m = 1; m <= totalMafias; m++) {
            mafiasConfig[`mafia_${m}`] = {
                id: `mafia_${m}`, name: `Sindicato Plumas ${m}`,
                money: 1200, reputation: 100, influence: 50, leaderId: ""
            };
        }

        keys.forEach((pId, idx) => {
            const mNum = (idx % totalMafias) + 1;
            const mId = `mafia_${mNum}`;
            updates[`players/${pId}/mafiaId`] = mId;
            
            if (!mafiasConfig[mId].leaderId) {
                mafiasConfig[mId].leaderId = pId;
            }
        });

        updates['mafias'] = mafiasConfig;
        updates['currentPhase'] = 'ASSIGNMENT';
        updates['round'] = 1;
        db.ref('game_room').update(updates);
    });
}

function masterLaunchRound() {
    SoundEffects.play('click');
    db.ref('game_room').update({
        timerEndTime: new Date().getTime() + 180000,
        currentEvent: EVENTOS[Math.floor(Math.random() * EVENTOS.length)],
        currentPhase: 'DASHBOARD'
    });
}

function masterActionNextRound() {
    SoundEffects.play('click');
    const nextR = (globalGameState.round || 1) + 1;
    if (nextR > 5) return masterEndGameNow();
    db.ref('game_room').update({
        round: nextR,
        timerEndTime: new Date().getTime() + 180000,
        currentEvent: EVENTOS[Math.floor(Math.random() * EVENTOS.length)],
        currentPhase: 'DASHBOARD'
    });
}

function masterEndGameNow() {
    SoundEffects.play('click');
    db.ref('game_room').once('value', snap => {
        const game = snap.val();
        if (game?.currentPhase === 'DASHBOARD') {
            resolveRoundLogic(true);
        } else {
            db.ref('game_room').update({ currentPhase: 'END' });
        }
    });
}

function masterResetEverything() {
    if (!confirm("Atención: Esto limpiará la base de datos completa.")) return;
    SoundEffects.play('click');
    myMafiaId = null; myMafiaName = "";
    lastProcessedPhaseKey = "";
    if (timerInterval) clearInterval(timerInterval);
    if (chatListenerRef) chatListenerRef.off();
    if (adminSpyChatRef) adminSpyChatRef.off();
    db.ref('game_room').set({ currentPhase: 'LOGIN' }).then(() => {
        window.location.reload();
    });
}

// ==========================================
// ALGORITMO RESOLUTIVO
// ==========================================
function resolveRoundLogic(goToEnd = false) {
    db.ref('game_room').once('value', snap => {
        const game = snap.val();
        if (!game?.mafias) return;

        const rVotes = game.votes?.[`ronda_${game.round}`];
        const mafias = game.mafias;
        const logs   = [`--- INFORME: RONDA ${game.round} ---`];

        const mafiaDecisions = {};
        Object.keys(mafias).forEach(mId => mafiaDecisions[mId] = { action: 'cooperar', target: null, counts: {} });

        if (rVotes) {
            Object.values(rVotes).forEach(v => {
                if (!mafiaDecisions[v.mafiaSource]) return;
                mafiaDecisions[v.mafiaSource].counts[v.action] = (mafiaDecisions[v.mafiaSource].counts[v.action] || 0) + 1;
                mafiaDecisions[v.mafiaSource].target = v.target;
            });
            Object.keys(mafiaDecisions).forEach(mId => {
                const c = mafiaDecisions[mId].counts;
                if (Object.keys(c).length > 0)
                    mafiaDecisions[mId].action = Object.keys(c).sort((a, b) => c[b] - c[a])[0];
            });
        }

        const stats = game.estadisticasHistoricas || { traiciones: {}, cooperaciones: {} };

        Object.keys(mafias).forEach(mId => {
            const dec      = mafiaDecisions[mId].action;
            const targetId = mafiaDecisions[mId].target || Object.keys(mafias).find(x => x !== mId);
            stats.traiciones[mId]    = stats.traiciones[mId]    || 0;
            stats.cooperaciones[mId] = stats.cooperaciones[mId] || 0;

            if (dec === 'cooperar') {
                let gain = 400 * (mafias[mId].reputation / 100);
                if (game.currentEvent?.code === "AUGE") gain *= 1.5;
                mafias[mId].money += Math.round(gain);
                mafias[mId].reputation = Math.min(100, mafias[mId].reputation + 10);
                stats.cooperaciones[mId]++;
                logs.push(`🕊️ [${mafias[mId].name}] COOPERÓ.`);
            } else if (dec === 'traicionar') {
                mafias[mId].money += 800;
                mafias[mId].reputation = Math.max(10, mafias[mId].reputation - 35);
                if (mafias[targetId]) mafias[targetId].money = Math.max(0, mafias[targetId].money - 400);
                stats.traiciones[mId]++;
                if (game.currentEvent?.code === "REDADA") { 
                    mafias[mId].money -= 500; 
                    logs.push(`🚨 REDADA: [${mafias[mId].name}] fue penalizado por traición.`); 
                }
                logs.push(`🗡️ TRAICIÓN: [${mafias[mId].name}] atacó a [${mafias[targetId]?.name || 'Rival'}].`);
            } else if (dec === 'robar') {
                mafias[mId].influence += 20;
                if (mafias[targetId]) mafias[targetId].influence = Math.max(0, mafias[targetId].influence - 20);
                logs.push(`🥷 [${mafias[mId].name}] sustrajo influencia de [${mafias[targetId]?.name || 'Rival'}].`);
            } else if (dec === 'alianza') {
                if (mafiaDecisions[targetId]?.action === 'alianza' && mafiaDecisions[targetId]?.target === mId) {
                    mafias[mId].money += 600; mafias[mId].influence += 15;
                    logs.push(`📜 PACTO: Alianza consolidada entre [${mafias[mId].name}] y [${mafias[targetId].name}].`);
                } else {
                    logs.push(`⚠️ Intento de alianza fallido para [${mafias[mId].name}].`);
                }
            }

            if (game.currentEvent?.code === "CRISIS") mafias[mId].money = Math.max(0, mafias[mId].money - 200);
        });

        if (game.currentEvent?.code === "LAVADO") {
            Object.keys(mafias).forEach(mId => {
                const bonus = mafias[mId].influence * 10;
                mafias[mId].money += bonus;
                logs.push(`💸 LAVADO: [${mafias[mId].name}] sumó +$${bonus} por dividendos.`);
            });
        }

        const nextPhase = goToEnd ? 'END' : 'TRANSITION';
        db.ref('game_room').update({ mafias, lastRoundLogs: logs, estadisticasHistoricas: stats, currentPhase: nextPhase });
    });
}