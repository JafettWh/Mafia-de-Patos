// ==========================================
// CONFIGURACIÓN DE FIREBASE Y CONSTANTES
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
const ADMIN_PASSWORD = "profe2026";

let myPlayerId = null, myPlayerName = "", myMafiaId = null, myMafiaName = "", isHost = false, globalGameState = {}, timerInterval = null;
let lastProcessedPhase = ""; // Bandera para evitar bucles infinitos de renderizado

const SoundEffects = {
    ctx: null,
    play(type) {
        try {
            if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = this.ctx.createOscillator(), gain = this.ctx.createGain();
            osc.connect(gain); gain.connect(this.ctx.destination);
            
            const configs = {
                click: { freq: 400, vol: 0.1, duration: 0.05, type: 'sine' },
                traicion: { freq: 140, vol: 0.2, duration: 0.35, type: 'sawtooth' },
                victoria: { freq: 440, vol: 0.15, duration: 0.5, type: 'sine' }
            }[type];

            osc.type = configs.type;
            osc.frequency.setValueAtTime(configs.freq, this.ctx.currentTime);
            gain.gain.setValueAtTime(configs.vol, this.ctx.currentTime);
            osc.start(); osc.stop(this.ctx.currentTime + configs.duration);
        } catch(e){}
    }
};

const EVENTOS = [
    { title: "MERCADO EN AUGE", desc: "Las ganancias por Cooperación aumentan un 50% este turno.", code: "AUGE" },
    { title: "REDADA POLICIAL", desc: "Las traiciones son descubiertas. El Traidor pierde $500 extras.", code: "REDADA" },
    { title: "CRISIS ECONÓMICA", desc: "El mercado cae. Todas las mafias pierden $200 al iniciar la ronda.", code: "CRISIS" },
    { title: "LAVADO DE DINERO", desc: "La influencia otorga dividendos. +$10 por cada punto de influencia.", code: "LAVADO" }
];

function changeScreen(screenId) {
    if (isHost) return; // El Admin se queda fijo viendo el panel maestro
    document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === screenId));
}

// ==========================================
// INICIALIZACIÓN Y LISTENERS
// ==========================================
document.addEventListener("DOMContentLoaded", () => {
    const adminToggle = document.getElementById('admin-toggle');
    const adminBox = document.getElementById('admin-password-box');
    
    adminToggle.addEventListener('change', () => adminBox.classList.toggle('hidden', !adminToggle.checked));
    document.getElementById('btn-join').addEventListener('click', setupLogin);
    
    // Controles del admin (fijos siempre)
    document.getElementById('btn-start-game').addEventListener('click', masterActionStartGame);
    document.getElementById('btn-launch-dashboard').addEventListener('click', masterLaunchRound);
    document.getElementById('btn-force-resolve').addEventListener('click', () => confirm("¿Forzar resolución de la ronda?") && resolveRoundLogic());
    document.getElementById('btn-admin-next').addEventListener('click', masterActionNextRound);
    document.getElementById('btn-end-game-now').addEventListener('click', () => confirm("¿Terminar partida inmediatamente?") && masterEndGameNow());
    document.getElementById('btn-reset-game').addEventListener('click', masterResetEverything);
    document.getElementById('btn-host-reset-final').addEventListener('click', masterResetEverything);
    
    document.getElementById('btn-save-mafia-name').addEventListener('click', () => {
        const cName = document.getElementById('custom-mafia-name').value.trim();
        if (cName.length < 3) return alert("Nombre demasiado corto.");
        SoundEffects.play('click');
        db.ref(`game_room/mafias/${myMafiaId}`).update({ name: cName });
        document.getElementById('naming-box').innerHTML = "<p>¡Identidad familiar establecida ante el Don!</p>";
    });

    document.querySelectorAll('.btn-action').forEach(btn => {
        btn.addEventListener('click', () => {
            const act = btn.getAttribute('data-action');
            const target = document.getElementById('target-mafia').value;
            document.querySelectorAll('.btn-action').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            
            db.ref(`game_room/votes/ronda_${globalGameState.round}/${myPlayerId}`).set({
                player: myPlayerName, mafiaSource: myMafiaId, action: act, target: target
            });
            SoundEffects.play('click');
        });
    });

    listenToGlobalState();
});

// ==========================================
// CONTROL DE ESTADO GLOBAL
// ==========================================
function setupLogin() {
    const nameIn = document.getElementById('player-name').value.trim();
    if (nameIn.length < 2) return alert("¡Alias inválido!");

    if (document.getElementById('admin-toggle').checked) {
        if (document.getElementById('admin-password').value !== ADMIN_PASSWORD) {
            return document.getElementById('pass-error').classList.remove('hidden');
        }
        isHost = true;
    }

    myPlayerName = nameIn;
    SoundEffects.play('click');

    const pRef = db.ref('game_room/players').push();
    myPlayerId = pRef.key;
    pRef.set({ name: myPlayerName, mafiaId: "sin_asignar", online: true, isHost });
    pRef.onDisconnect().remove();

    document.getElementById('admin-login-area').classList.add('hidden');
    if (isHost) {
        document.getElementById('main-logo-area').classList.add('hidden');
        document.getElementById('lobby-status').innerText = "👑 MODO DON ACTIVO.";
        document.getElementById('admin-panel').classList.remove('hidden');
    } else {
        document.getElementById('lobby-status').innerText = "¡Ingresaste al Callejón! Esperando al Don...";
    }
}

function listenToGlobalState() {
    db.ref('game_room').on('value', (snapshot) => {
        const data = snapshot.val() || {};
        globalGameState = data;

        if (data.players) document.getElementById('player-count').innerText = Object.keys(data.players).length;
        
        if (data.players?.[myPlayerId] && myMafiaId === null) {
            myMafiaId = data.players[myPlayerId].mafiaId !== "sin_asignar" ? data.players[myPlayerId].mafiaId : null;
        }

        const currentPhase = data.currentPhase || 'LOGIN';

        if (isHost) {
            renderMafiaTable('admin-mafia-tbody', data, true);
            updateAdminPanel(data);
            drawWarMap(data); 
            document.getElementById('btn-host-reset-final').classList.toggle('hidden', currentPhase !== 'END');
        } else {
            // Evita reprocesar pantallas y causar bucles si la fase no ha cambiado físicamente
            if (lastProcessedPhase !== currentPhase) {
                lastProcessedPhase = currentPhase;
                syncGamePhase(currentPhase);
            }
        }
    });
}

function renderMafiaTable(tableId, data, isAdmin) {
    const tbody = document.getElementById(tableId);
    if (!tbody || !data.mafias) return;
    tbody.innerHTML = "";
    Object.values(data.mafias).sort((a, b) => b.money - a.money).forEach(m => {
        const voteInfo = isAdmin ? getVoteInfoForMafia(data, m.id) : `${m.influence} 👑`;
        tbody.innerHTML += `<tr>
            <td><strong>${m.name}</strong></td>
            <td>$${m.money}</td>
            <td>${m.reputation}%</td>
            <td>${m.influence}</td>
            <td>${voteInfo}</td>
        </tr>`;
    });
}

function updateAdminPanel(data) {
    document.getElementById('admin-round-label').innerText = `Fase: ${data.currentPhase || 'LOGIN'} — Ronda ${data.round || 0} / 5`;
    const totalVotes = data.round && data.votes?.[`ronda_${data.round}`] ? Object.keys(data.votes[`ronda_${data.round}`]).length : 0;
    document.getElementById('admin-vote-count').innerText = `Votos: ${totalVotes} / ${data.players ? Object.keys(data.players).length : 0}`;

    const adminLog = document.getElementById('admin-round-log');
    if (adminLog && data.lastRoundLogs) {
        adminLog.innerHTML = data.lastRoundLogs.map(txt => `<p>${txt}</p>`).join("");
    }
}

function getVoteInfoForMafia(data, mafiaId) {
    const roundVotes = data.votes?.[`ronda_${data.round}`];
    const votes = roundVotes ? Object.values(roundVotes).filter(v => v.mafiaSource === mafiaId) : [];
    if (votes.length === 0) return '<span class="text-muted">Pensando...</span>';
    const counts = {};
    votes.forEach(v => counts[v.action] = (counts[v.action] || 0) + 1);
    const topAction = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    
    const iconMap = { cooperar: '🤝 Coop', traicionar: '🗡️ Traic', robar: '🥷 Robo', alianza: '📜 Alianza' };
    return `<span class="vote-badge-${topAction}">${iconMap[topAction] || ''} (${votes.length}v)</span>`;
}

// ==========================================
// MAPA DE GUERRA EN TIEMPO REAL (SVG)
// ==========================================
function drawWarMap(data) {
    const nodesG = document.getElementById('svg-nodes');
    const connG = document.getElementById('svg-connections');
    if (!nodesG || !connG) return;
    
    nodesG.innerHTML = "";
    connG.innerHTML = "";
    if (!data.mafias) return;

    const mafiasArr = Object.values(data.mafias).sort((a, b) => a.id.localeCompare(b.id));
    const total = 7; 
    const cx = 200, cy = 200, r = 125;
    const nodeCoords = {};

    mafiasArr.forEach((m, i) => {
        const angle = (i * 2 * Math.PI) / total - Math.PI / 2;
        nodeCoords[m.id] = { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle), name: m.name };
    });

    const currentRoundVotes = data.votes?.[`ronda_${data.round}`] || {};
    const processedActions = {};

    Object.values(currentRoundVotes).forEach(v => {
        if (!processedActions[v.mafiaSource]) {
            processedActions[v.mafiaSource] = { counts: {}, target: v.target };
        }
        processedActions[v.mafiaSource].counts[v.action] = (processedActions[v.mafiaSource].counts[v.action] || 0) + 1;
    });

    Object.keys(processedActions).forEach(srcId => {
        const counts = processedActions[srcId].counts;
        const topAction = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
        const targetId = processedActions[srcId].target;

        if (srcId && targetId && nodeCoords[srcId] && nodeCoords[targetId] && srcId !== targetId) {
            const start = nodeCoords[srcId];
            const end = nodeCoords[targetId];
            
            const colorMap = { cooperar: '#10b981', traicionar: '#ff0055', robar: '#ffcc00', alianza: '#00ffff' };
            const strokeColor = colorMap[topAction] || '#64748b';
            const isDash = topAction === 'cooperar' || topAction === 'alianza' ? '5,5' : '0';

            const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
            path.setAttribute("d", `M ${start.x} ${start.y} L ${end.x} ${end.y}`);
            path.setAttribute("stroke", strokeColor);
            path.setAttribute("stroke-width", "3");
            path.setAttribute("fill", "none");
            path.setAttribute("marker-end", `url(#arrow-${topAction})`);
            path.setAttribute("stroke-dasharray", isDash);
            
            if (topAction === 'traicionar' || topAction === 'robar') {
                path.innerHTML = `<animate attributeName="stroke-dashoffset" values="100;0" dur="1.5s" repeatCount="indefinite" />`;
                path.setAttribute("stroke-dasharray", "10,5");
            }
            connG.appendChild(path);
        }
    });

    Object.keys(nodeCoords).forEach(mId => {
        const coord = nodeCoords[mId];
        const g = document.createElementNS("http://www.w3.org/2000/svg", "g");

        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("cx", coord.x);
        circle.setAttribute("cy", coord.y);
        circle.setAttribute("r", "22");
        circle.setAttribute("class", "svg-node-element");
        circle.setAttribute("stroke", processedActions[mId] ? "#00ffcc" : "#334155");
        circle.setAttribute("fill", processedActions[mId] ? "#1e293b" : "#0f172a");

        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("x", coord.x);
        text.setAttribute("y", coord.y + 4);
        text.setAttribute("text-anchor", "middle");
        text.setAttribute("fill", "#fff");
        text.setAttribute("font-size", "10px");
        text.setAttribute("font-weight", "bold");
        text.textContent = coord.name.substring(0, 5);

        g.appendChild(circle);
        g.appendChild(text);
        nodesG.appendChild(g);
    });
}

function syncGamePhase(phase) {
    if (phase === 'LOGIN') {
        changeScreen('screen-login');
        return;
    }
    if (phase === 'ASSIGNMENT' && myMafiaId) {
        changeScreen('screen-assignment');
        db.ref(`game_room/mafias/${myMafiaId}`).on('value', snap => {
            if (!snap.val()) return;
            myMafiaName = snap.val().name;
            document.getElementById('assigned-mafia-name').innerText = myMafiaName;
            document.getElementById('naming-box').classList.toggle('hidden', snap.val().leaderId !== myPlayerId);
        });
    } else if (phase === 'DASHBOARD') {
        renderDashboard();
    } else if (phase === 'TRANSITION') {
        changeScreen('screen-transition');
        document.getElementById('rep-ronda-num').innerText = globalGameState.round;
        document.getElementById('round-narrative-log').innerHTML = (globalGameState.lastRoundLogs || []).map(t => `<p>${t}</p>`).join("");
        if (globalGameState.lastRoundLogs?.join(" ").includes("TRAICIÓN")) SoundEffects.play('traicion');
    } else if (phase === 'END') {
        renderEndScreen();
    }
}

function renderDashboard() {
    changeScreen('screen-dashboard');
    document.getElementById('dash-player-name').innerText = myPlayerName;
    document.getElementById('dash-mafia-name').innerText = myMafiaName;
    document.getElementById('timer-label').innerText = `RONDA ${globalGameState.round || 1}/5`;

    db.ref(`game_room/mafias/${myMafiaId}`).on('value', (s) => {
        const m = s.val(); if (!m) return;
        document.getElementById('stat-money').innerText = `$${m.money}`;
        document.getElementById('stat-rep').innerText = `${m.reputation}%`;
        document.getElementById('stat-inf').innerText = m.influence;
    });

    const ev = globalGameState.currentEvent;
    document.getElementById('event-banner').classList.toggle('hidden', !ev);
    if (ev) { document.getElementById('event-title').innerText = ev.title; document.getElementById('event-desc').innerText = ev.desc; }

    const targetSelect = document.getElementById('target-mafia');
    targetSelect.innerHTML = "";
    Object.keys(globalGameState.mafias || {}).forEach(mId => {
        if (mId !== myMafiaId) {
            targetSelect.innerHTML += `<option value="${mId}">${globalGameState.mafias[mId].name}</option>`;
        }
    });

    runClientTimer(globalGameState.timerEndTime);
    renderMafiaTable('live-ranking-body', globalGameState, false);
    listenInternalVotes();
}

function listenInternalVotes() {
    db.ref(`game_room/votes/ronda_${globalGameState.round}`).on('value', (snap) => {
        const vObj = snap.val() || {}, listUi = document.getElementById('internal-votes-list');
        if (!listUi) return;
        listUi.innerHTML = Object.values(vObj).filter(v => v.mafiaSource === myMafiaId).map(v => `<li>✔️ ${v.player}: Encriptado</li>`).join("");
        
        const voted = vObj[myPlayerId] !== undefined;
        document.getElementById('panel-voting').classList.toggle('hidden', voted);
        document.getElementById('panel-waiting-results').classList.toggle('hidden', !voted);
    });
}

function runClientTimer(endTime) {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        const diff = endTime - new Date().getTime();
        if (diff <= 0) {
            clearInterval(timerInterval);
            document.getElementById('timer-display').innerText = "00:00";
            if (isHost) resolveRoundLogic();
        } else {
            const min = Math.floor(diff / 60000), sec = Math.floor((diff % 60000) / 1000);
            document.getElementById('timer-display').innerText = `${min}:${sec < 10 ? '0' : ''}${sec}`;
        }
    }, 1000);
}

// ==========================================
// ACCIONES DEL DON
// ==========================================
function masterActionStartGame() {
    SoundEffects.play('click');
    db.ref('game_room/players').once('value', (snap) => {
        const pObj = snap.val(); if (!pObj) return alert("No hay jugadores en el callejón.");
        const keys = Object.keys(pObj), totalMafias = 7, mafiasConfig = {}, updates = {};

        for (let m = 1; m <= totalMafias; m++) {
            mafiasConfig[`mafia_${m}`] = { id: `mafia_${m}`, name: `Sindicato Plumas ${m}`, money: 1200, reputation: 100, influence: 50, leaderId: "" };
        }
        keys.forEach((pId, idx) => {
            const mId = `mafia_${(idx % totalMafias) + 1}`;
            updates[`players/${pId}/mafiaId`] = mId;
            if (!mafiasConfig[mId].leaderId) mafiasConfig[mId].leaderId = pId;
        });

        updates['mafias'] = mafiasConfig; updates['currentPhase'] = 'ASSIGNMENT'; updates['round'] = 1;
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
    db.ref('game_room').update({ currentPhase: 'END' }); 
}

function masterResetEverything() { 
    SoundEffects.play('click');
    // Forzamos la fase a LOGIN primero para limpiar las vistas de los clientes sin crash de redondas
    db.ref('game_room').set({ currentPhase: 'LOGIN' }).then(() => {
        window.location.reload();
    });
}

// ==========================================
// MATRIZ DE RESOLUCIÓN LÓGICA
// ==========================================
function resolveRoundLogic() {
    db.ref('game_room').once('value', (snap) => {
        const game = snap.val(), rVotes = game.votes?.[`ronda_${game.round}`], mafias = game.mafias, logs = [];
        if (!mafias) return;
        
        logs.push(`--- INFORME DE OPERACIONES: RONDA ${game.round} ---`);
        const mafiaDecisions = {};
        Object.keys(mafias).forEach(mId => mafiaDecisions[mId] = { action: 'cooperar', target: null, counts: {} });

        if (rVotes) {
            Object.values(rVotes).forEach(v => {
                if (mafiaDecisions[v.mafiaSource]) {
                    mafiaDecisions[v.mafiaSource].counts[v.action] = (mafiaDecisions[v.mafiaSource].counts[v.action] || 0) + 1;
                    mafiaDecisions[v.mafiaSource].target = v.target;
                }
            });
            Object.keys(mafiaDecisions).forEach(mId => {
                const c = mafiaDecisions[mId].counts;
                if (Object.keys(c).length > 0) mafiaDecisions[mId].action = Object.keys(c).sort((a,b)=>c[b]-c[a])[0];
            });
        }

        const stats = game.estadisticasHistoricas || { traiciones: {}, cooperaciones: {} };

        Object.keys(mafias).forEach(mId => {
            const dec = mafiaDecisions[mId].action, targetId = mafiaDecisions[mId].target || Object.keys(mafias).find(x => x !== mId);
            stats.traiciones[mId] = stats.traiciones[mId] || 0; stats.cooperaciones[mId] = stats.cooperaciones[mId] || 0;

            if (dec === 'cooperar') {
                let gain = 400 * (mafias[mId].reputation / 100);
                if (game.currentEvent?.code === "AUGE") gain *= 1.5;
                mafias[mId].money += Math.round(gain);
                mafias[mId].reputation = Math.min(100, mafias[mId].reputation + 10);
                stats.cooperaciones[mId]++;
                logs.push(`🕊️ [${mafias[mId].name}] COOPERÓ.`);
            } else if (dec === 'traicionar') {
                mafias[mId].money += 800; mafias[mId].reputation = Math.max(10, mafias[mId].reputation - 35);
                if (mafias[targetId]) mafias[targetId].money = Math.max(0, mafias[targetId].money - 400);
                stats.traiciones[mId]++;
                if (game.currentEvent?.code === "REDADA") { mafias[mId].money -= 500; logs.push(`🚨 REDADA: [${mafias[mId].name}] penalizado.`); }
                logs.push(`🗡️ TRAICIÓN: [${mafias[mId].name}] atacó a [${mafias[targetId]?.name || 'Rival'}].`);
            } else if (dec === 'robar') {
                mafias[mId].influence += 20; 
                if (mafias[targetId]) mafias[targetId].influence = Math.max(0, mafias[targetId].influence - 20);
                logs.push(`🥷 [${mafias[mId].name}] robó influencia a [${mafias[targetId]?.name || 'Rival'}].`);
            } else if (dec === 'alianza') {
                if (mafiaDecisions[targetId]?.action === 'alianza' && mafiaDecisions[targetId]?.target === mId) {
                    mafias[mId].money += 600; mafias[mId].influence += 15;
                    logs.push(`📜 PACTO: Alianza entre [${mafias[mId].name}] y [${mafias[targetId].name}].`);
                } else logs.push(`⚠️ Alianza fallida para [${mafias[mId].name}].`);
            }
            if (game.currentEvent?.code === "CRISIS") mafias[mId].money = Math.max(0, mafias[mId].money - 200);
        });

        if (game.currentEvent?.code === "LAVADO") {
            Object.keys(mafias).forEach(mId => {
                const bonus = mafias[mId].influence * 10; mafias[mId].money += bonus;
            });
        }
        db.ref('game_room').update({ mafias, lastRoundLogs: logs, estadisticasHistoricas: stats, currentPhase: 'TRANSITION' });
    });
}

function renderEndScreen() {
    changeScreen('screen-end'); SoundEffects.play('victoria');
    const arr = Object.values(globalGameState.mafias || {}).sort((a,b)=>b.money-a.money);
    if (arr.length > 0) document.getElementById('winner-mafia-name').innerText = arr[0].name;

    document.getElementById('final-podium').innerHTML = arr.slice(0,3).map((m,i)=> `<div class="stat-card"><h3>#${i+1}</h3><h4>${m.name}</h4><p>$${m.money}</p></div>`).join("");

    const stats = globalGameState.estadisticasHistoricas;
    if (stats) {
        let maxT = -1, tId = "Ninguno", maxC = -1, cId = "Ninguno";
        Object.keys(stats.traiciones || {}).forEach(id => { if(stats.traiciones[id]>maxT){ maxT=stats.traiciones[id]; tId=globalGameState.mafias[id]?.name; } });
        Object.keys(stats.cooperaciones || {}).forEach(id => { if(stats.cooperaciones[id]>maxC){ maxC=stats.cooperaciones[id]; cId=globalGameState.mafias[id]?.name; } });
        document.getElementById('badge-trust-name').innerText = `${cId} (${maxC} veces)`;
        document.getElementById('badge-traitor-name').innerText = `${tId} (${maxT} veces)`;
    }
}