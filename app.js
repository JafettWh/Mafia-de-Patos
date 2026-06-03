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

// ==========================================
// CONTRASEÑA DEL DON (cámbiala cuando quieras)
// ==========================================
const ADMIN_PASSWORD = "profe2026";

// VARIABLES LOCALES
let myPlayerId = null;
let myPlayerName = "";
let myMafiaId = null;
let myMafiaName = "";
let isHost = false;
let globalGameState = {};
let timerInterval = null;

// ==========================================
// AUDIO — lazy (navegadores modernos lo requieren)
// ==========================================
const SoundEffects = {
    ctx: null,
    getCtx() {
        if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        return this.ctx;
    },
    play(type) {
        try {
            let osc = this.getCtx().createOscillator();
            let gain = this.getCtx().createGain();
            osc.connect(gain);
            gain.connect(this.getCtx().destination);
            if (type === 'click') {
                osc.frequency.setValueAtTime(400, this.getCtx().currentTime);
                gain.gain.setValueAtTime(0.1, this.getCtx().currentTime);
                osc.start(); osc.stop(this.getCtx().currentTime + 0.05);
            } else if (type === 'traicion') {
                osc.type = 'sawtooth';
                osc.frequency.setValueAtTime(140, this.getCtx().currentTime);
                gain.gain.setValueAtTime(0.2, this.getCtx().currentTime);
                osc.start(); osc.stop(this.getCtx().currentTime + 0.35);
            } else if (type === 'victoria') {
                osc.frequency.setValueAtTime(440, this.getCtx().currentTime);
                gain.gain.setValueAtTime(0.15, this.getCtx().currentTime);
                osc.start(); osc.stop(this.getCtx().currentTime + 0.5);
            }
        } catch(e) {}
    }
};

const EVENTOS = [
    { title: "MERCADO EN AUGE", desc: "Las ganancias por Cooperación aumentan un 50% este turno.", code: "AUGE" },
    { title: "REDADA POLICIAL", desc: "Las traiciones son descubiertas. El Traidor pierde $500 extras por cargos penales.", code: "REDADA" },
    { title: "CRISIS ECONÓMICA", desc: "El mercado cae. Todas las mafias pierden $200 automáticamente al iniciar la ronda.", code: "CRISIS" },
    { title: "LAVADO DE DINERO", desc: "La influencia otorga dividendos. +$10 por cada punto de influencia que poseas.", code: "LAVADO" }
];

function changeScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
}

// ==========================================
// INICIALIZACIÓN
// ==========================================
document.addEventListener("DOMContentLoaded", () => {
    setupLoginLogic();
    listenToGlobalState();
});

// ==========================================
// LOGIN — con campo de contraseña oculto
// ==========================================
function setupLoginLogic() {
    const adminToggle = document.getElementById('admin-toggle');
    const adminBox = document.getElementById('admin-password-box');

    // Mostrar/ocultar campo de contraseña
    adminToggle.addEventListener('change', () => {
        adminBox.classList.toggle('hidden', !adminToggle.checked);
    });

    document.getElementById('btn-join').addEventListener('click', () => {
        const nameIn = document.getElementById('player-name').value.trim();
        if (nameIn.length < 2) return alert("¡Alias de mafioso inválido!");

        // Verificar si intenta entrar como Don
        if (adminToggle.checked) {
            const passIn = document.getElementById('admin-password').value;
            if (passIn !== ADMIN_PASSWORD) {
                document.getElementById('pass-error').classList.remove('hidden');
                document.getElementById('admin-password').value = '';
                return;
            }
            isHost = true;
        }

        myPlayerName = nameIn;
        SoundEffects.play('click');

        // Registrar jugador en Firebase
        const pRef = db.ref('game_room/players').push();
        myPlayerId = pRef.key;
        pRef.set({ name: myPlayerName, mafiaId: "sin_asignar", online: true, isHost: isHost });
        pRef.onDisconnect().remove();

        document.getElementById('btn-join').disabled = true;
        document.getElementById('pass-error').classList.add('hidden');

        if (isHost) {
            activateAdminMode();
            document.getElementById('lobby-status').innerText = "¡Entraste como El Don! Controlas la partida.";
        } else {
            document.getElementById('lobby-status').innerText = "¡Ingresaste al Callejón! Esperando que el Profesor inicie la simulación...";
        }
    });
}

function activateAdminMode() {
    document.getElementById('admin-panel').classList.remove('hidden');
    document.getElementById('btn-start-game').addEventListener('click', masterActionStartGame);
    document.getElementById('btn-admin-next').addEventListener('click', masterActionNextRound);
    document.getElementById('btn-reset-game').addEventListener('click', masterResetEverything);
    document.getElementById('btn-launch-dashboard').addEventListener('click', masterLaunchFirstRound);
    document.getElementById('btn-force-resolve').addEventListener('click', () => {
        if (confirm("¿Forzar resolución de la ronda ahora?")) resolveRoundLogic();
    });

    // Escuchar votos en tiempo real para el panel admin
    listenAdminVotes();
}

// ==========================================
// PANEL ADMIN — escuchar todo en tiempo real
// ==========================================
function listenAdminVotes() {
    db.ref('game_room').on('value', (snap) => {
        const data = snap.val() || {};
        if (!data.mafias) return;

        // Tabla de mafias
        const tbody = document.getElementById('admin-mafia-tbody');
        if (!tbody) return;
        tbody.innerHTML = "";
        const arr = Object.values(data.mafias).sort((a, b) => b.money - a.money);
        arr.forEach(m => {
            tbody.innerHTML += `
                <tr>
                    <td><strong>${m.name}</strong></td>
                    <td>$${m.money}</td>
                    <td>${m.reputation}%</td>
                    <td>${m.influence}</td>
                    <td>${getVoteCountForMafia(data, m.id)}</td>
                </tr>`;
        });

        // Contadores generales
        const totalPlayers = data.players ? Object.keys(data.players).length : 0;
        const totalVotes = getGlobalVoteCount(data);
        const adminCountEl = document.getElementById('admin-vote-count');
        if (adminCountEl) adminCountEl.innerText = `${totalVotes} / ${totalPlayers} jugadores votaron`;

        // Log de última ronda en admin
        const adminLog = document.getElementById('admin-round-log');
        if (adminLog && data.lastRoundLogs) {
            adminLog.innerHTML = "";
            data.lastRoundLogs.forEach(txt => {
                const p = document.createElement('p');
                p.innerText = txt;
                adminLog.appendChild(p);
            });
        }

        // Ronda actual
        const roundEl = document.getElementById('admin-round-label');
        if (roundEl) roundEl.innerText = `Ronda ${data.round || 0} / 5 — Fase: ${data.currentPhase || 'LOGIN'}`;
    });
}

function getVoteCountForMafia(data, mafiaId) {
    if (!data.round || !data.votes) return '—';
    const roundVotes = data.votes[`ronda_${data.round}`];
    if (!roundVotes) return '0 votos';
    const count = Object.values(roundVotes).filter(v => v.mafiaSource === mafiaId).length;
    return `${count} voto${count !== 1 ? 's' : ''}`;
}

function getGlobalVoteCount(data) {
    if (!data.round || !data.votes) return 0;
    const roundVotes = data.votes[`ronda_${data.round}`];
    return roundVotes ? Object.keys(roundVotes).length : 0;
}

// ==========================================
// LISTENER GLOBAL DE ESTADO
// ==========================================
function listenToGlobalState() {
    db.ref('game_room').on('value', (snapshot) => {
        const data = snapshot.val() || {};
        globalGameState = data;

        const countEl = document.getElementById('player-count');
        if (countEl && data.players) {
            countEl.innerText = Object.keys(data.players).length;
        }

        if (data.players && myPlayerId && data.players[myPlayerId]) {
            const serverMe = data.players[myPlayerId];
            if (serverMe.mafiaId !== "sin_asignar" && myMafiaId === null) {
                myMafiaId = serverMe.mafiaId;
                enterAssignmentPhase();
            }
        }

        if (data.currentPhase) syncGamePhase(data.currentPhase);
    });
}

// ==========================================
// SINCRONIZACIÓN DE FASES
// ==========================================
function syncGamePhase(phase) {
    if (phase === 'ASSIGNMENT') {
        if (myMafiaId) enterAssignmentPhase();
        if (isHost) {
            const btn = document.getElementById('btn-launch-dashboard');
            if (btn) btn.classList.remove('hidden');
        }
    } else if (phase === 'DASHBOARD') {
        renderDashboard();
    } else if (phase === 'TRANSITION') {
        renderTransition();
    } else if (phase === 'END') {
        renderEndScreen();
    }
}

// ==========================================
// ACCIONES DEL HOST
// ==========================================
function masterActionStartGame() {
    SoundEffects.play('click');
    db.ref('game_room/players').once('value', (snap) => {
        const playersObj = snap.val();
        if (!playersObj) return alert("No hay suficientes jugadores en sala.");

        const keys = Object.keys(playersObj);
        const totalMafias = 7;
        const mafiasConfig = {};

        for (let m = 1; m <= totalMafias; m++) {
            mafiasConfig[`mafia_${m}`] = {
                id: `mafia_${m}`,
                name: `Sindicato Plumas ${m}`,
                money: 1200,
                reputation: 100,
                influence: 50,
                leaderId: ""
            };
        }

        const updates = {};
        keys.forEach((pId, index) => {
            const assignedMId = `mafia_${(index % totalMafias) + 1}`;
            updates[`players/${pId}/mafiaId`] = assignedMId;
            if (mafiasConfig[assignedMId].leaderId === "") {
                mafiasConfig[assignedMId].leaderId = pId;
            }
        });

        updates['mafias'] = mafiasConfig;
        updates['currentPhase'] = 'ASSIGNMENT';
        updates['round'] = 1;
        db.ref('game_room').update(updates);
    });
}

function masterLaunchFirstRound() {
    SoundEffects.play('click');
    const endTime = new Date().getTime() + (3 * 60 * 1000);
    const ev = EVENTOS[Math.floor(Math.random() * EVENTOS.length)];
    db.ref('game_room').update({ timerEndTime: endTime, currentEvent: ev, currentPhase: 'DASHBOARD' });
}

function masterActionNextRound() {
    SoundEffects.play('click');
    const nextR = globalGameState.round + 1;
    if (nextR > 5) {
        db.ref('game_room').update({ currentPhase: 'END' });
    } else {
        const endTime = new Date().getTime() + (3 * 60 * 1000);
        const ev = EVENTOS[Math.floor(Math.random() * EVENTOS.length)];
        db.ref('game_room').update({ round: nextR, timerEndTime: endTime, currentEvent: ev, currentPhase: 'DASHBOARD' });
    }
}

function masterResetEverything() {
    if (!confirm("¿Reiniciar toda la partida? Esto borrará todos los datos.")) return;
    SoundEffects.play('click');
    db.ref('game_room').set({ currentPhase: 'LOGIN' });
    window.location.reload();
}

// ==========================================
// PANTALLA ASIGNACIÓN
// ==========================================
function enterAssignmentPhase() {
    changeScreen('screen-assignment');
    db.ref(`game_room/mafias/${myMafiaId}`).on('value', (snap) => {
        const mData = snap.val();
        if (!mData) return;
        myMafiaName = mData.name;
        document.getElementById('assigned-mafia-name').innerText = myMafiaName;
        if (mData.leaderId === myPlayerId) {
            const box = document.getElementById('naming-box');
            if (box) box.classList.remove('hidden');
        }
    });

    const saveBtn = document.getElementById('btn-save-mafia-name');
    const newSaveBtn = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
    newSaveBtn.addEventListener('click', () => {
        const cName = document.getElementById('custom-mafia-name').value.trim();
        if (cName.length < 3) return alert("Nombre no apto.");
        SoundEffects.play('click');
        db.ref(`game_room/mafias/${myMafiaId}`).update({ name: cName });
        document.getElementById('naming-box').innerHTML = "<p>¡Identidad familiar establecida ante el Don!</p>";
    });
}

// ==========================================
// DASHBOARD
// ==========================================
function renderDashboard() {
    changeScreen('screen-dashboard');
    document.getElementById('dash-player-name').innerText = myPlayerName;
    document.getElementById('dash-mafia-name').innerText = myMafiaName;

    const roundLabel = document.getElementById('timer-label');
    if (roundLabel) roundLabel.innerText = `RONDA ${globalGameState.round || 1}/5`;

    db.ref(`game_room/mafias/${myMafiaId}`).on('value', (s) => {
        const m = s.val(); if (!m) return;
        document.getElementById('stat-money').innerText = `$${m.money}`;
        document.getElementById('stat-rep').innerText = `${m.reputation}%`;
        document.getElementById('stat-inf').innerText = m.influence;
    });

    const eventBanner = document.getElementById('event-banner');
    if (globalGameState.currentEvent) {
        eventBanner.classList.remove('hidden');
        document.getElementById('event-title').innerText = globalGameState.currentEvent.title;
        document.getElementById('event-desc').innerText = globalGameState.currentEvent.desc;
    } else {
        eventBanner.classList.add('hidden');
    }

    const targetSelect = document.getElementById('target-mafia');
    targetSelect.innerHTML = "";
    if (globalGameState.mafias) {
        Object.keys(globalGameState.mafias).forEach(mId => {
            if (mId !== myMafiaId) {
                const opt = document.createElement('option');
                opt.value = mId;
                opt.innerText = globalGameState.mafias[mId].name;
                targetSelect.appendChild(opt);
            }
        });
    }

    document.querySelectorAll('.btn-action').forEach(btn => {
        const newBtn = btn.cloneNode(true);
        btn.parentNode.replaceChild(newBtn, btn);
        newBtn.addEventListener('click', () => {
            const act = newBtn.getAttribute('data-action');
            const target = document.getElementById('target-mafia').value;
            document.querySelectorAll('.btn-action').forEach(b => b.classList.remove('selected'));
            newBtn.classList.add('selected');
            db.ref(`game_room/votes/ronda_${globalGameState.round}/${myPlayerId}`).set({
                player: myPlayerName, mafiaSource: myMafiaId, action: act, target: target
            });
            SoundEffects.play('click');
            document.getElementById('vote-status').innerText = `Voto enviado de forma encriptada.`;
        });
    });

    document.getElementById('panel-voting').classList.remove('hidden');
    document.getElementById('panel-waiting-results').classList.add('hidden');

    runClientTimer(globalGameState.timerEndTime);
    updateLiveRankingTable();
    listenInternalVotes();
}

function listenInternalVotes() {
    db.ref(`game_room/votes/ronda_${globalGameState.round}`).on('value', (snap) => {
        const vObj = snap.val() || {};
        const listUi = document.getElementById('internal-votes-list');
        if (!listUi) return;
        listUi.innerHTML = "";

        Object.keys(vObj).forEach(pId => {
            if (vObj[pId].mafiaSource === myMafiaId) {
                const li = document.createElement('li');
                li.innerText = `✔️ ${vObj[pId].player}: Criptovoto Listo`;
                listUi.appendChild(li);
            }
        });

        db.ref(`game_room/votes/ronda_${globalGameState.round}/${myPlayerId}`).once('value', (s) => {
            if (s.exists()) {
                document.getElementById('panel-voting').classList.add('hidden');
                document.getElementById('panel-waiting-results').classList.remove('hidden');
            } else {
                document.getElementById('panel-voting').classList.remove('hidden');
                document.getElementById('panel-waiting-results').classList.add('hidden');
            }
        });
    });
}

function updateLiveRankingTable() {
    const tbody = document.getElementById('live-ranking-body');
    if (!tbody || !globalGameState.mafias) return;
    tbody.innerHTML = "";
    Object.values(globalGameState.mafias).sort((a, b) => b.money - a.money).forEach(m => {
        tbody.innerHTML += `<tr><td><strong>${m.name}</strong></td><td>$${m.money}</td><td>${m.reputation}%</td><td>${m.influence} 👑</td></tr>`;
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
            const min = Math.floor((diff % 3600000) / 60000);
            const sec = Math.floor((diff % 60000) / 1000);
            document.getElementById('timer-display').innerText = `${min < 10 ? '0' : ''}${min}:${sec < 10 ? '0' : ''}${sec}`;
        }
    }, 1000);
}

// ==========================================
// TRANSICIÓN
// ==========================================
function renderTransition() {
    changeScreen('screen-transition');
    document.getElementById('rep-ronda-num').innerText = globalGameState.round;
    const logBox = document.getElementById('round-narrative-log');
    logBox.innerHTML = "";
    if (globalGameState.lastRoundLogs) {
        globalGameState.lastRoundLogs.forEach(txt => {
            const p = document.createElement('p');
            p.innerText = txt;
            logBox.appendChild(p);
        });
        if (globalGameState.lastRoundLogs.join(" ").includes("TRAICIÓN")) SoundEffects.play('traicion');
    }
    if (isHost) document.getElementById('btn-admin-next').classList.remove('hidden');
    document.getElementById('player-wait-next').style.display = isHost ? 'none' : 'block';
}

// ==========================================
// RESOLUCIÓN DE RONDA
// ==========================================
function resolveRoundLogic() {
    db.ref('game_room').once('value', (snap) => {
        const game = snap.val();
        const rVotes = game.votes ? game.votes[`ronda_${game.round}`] : null;
        const mafias = game.mafias;
        const logs = [];

        logs.push(`--- INFORME DEL MERCADO CLANDESTINO: RONDA ${game.round} ---`);

        const mafiaDecisions = {};
        Object.keys(mafias).forEach(mId => {
            mafiaDecisions[mId] = { action: 'cooperar', target: null, votesCount: {} };
        });

        if (rVotes) {
            Object.values(rVotes).forEach(v => {
                if (!mafiaDecisions[v.mafiaSource].votesCount[v.action]) mafiaDecisions[v.mafiaSource].votesCount[v.action] = 0;
                mafiaDecisions[v.mafiaSource].votesCount[v.action]++;
                mafiaDecisions[v.mafiaSource].target = v.target;
            });
            Object.keys(mafiaDecisions).forEach(mId => {
                const counts = mafiaDecisions[mId].votesCount;
                let max = 0;
                Object.keys(counts).forEach(act => { if (counts[act] > max) { max = counts[act]; mafiaDecisions[mId].action = act; } });
            });
        }

        const stats = game.estadisticasHistoricas || { traiciones: {}, cooperaciones: {} };

        Object.keys(mafias).forEach(mId => {
            const decision = mafiaDecisions[mId].action;
            const targetId = mafiaDecisions[mId].target || Object.keys(mafias).find(x => x !== mId);
            if (!stats.traiciones[mId]) stats.traiciones[mId] = 0;
            if (!stats.cooperaciones[mId]) stats.cooperaciones[mId] = 0;
            const repFactor = mafias[mId].reputation / 100;

            if (decision === 'cooperar') {
                let gain = 400 * repFactor;
                if (game.currentEvent?.code === "AUGE") gain *= 1.5;
                mafias[mId].money += Math.round(gain);
                mafias[mId].reputation = Math.min(100, mafias[mId].reputation + 10);
                stats.cooperaciones[mId]++;
                logs.push(`🕊️ [${mafias[mId].name}] COOPERÓ limpiamente.`);
            } else if (decision === 'traicionar') {
                mafias[mId].money += 800;
                mafias[mId].reputation = Math.max(10, mafias[mId].reputation - 35);
                mafias[targetId].money = Math.max(0, mafias[targetId].money - 400);
                stats.traiciones[mId]++;
                if (game.currentEvent?.code === "REDADA") { mafias[mId].money -= 500; logs.push(`🚨 REDADA: La traición de [${mafias[mId].name}] fue interceptada (-$500).`); }
                logs.push(`🗡️ ¡TRAICIÓN! [${mafias[mId].name}] robó recursos a [${mafias[targetId].name}].`);
            } else if (decision === 'robar') {
                mafias[mId].influence += 20;
                mafias[targetId].influence = Math.max(0, mafias[targetId].influence - 20);
                logs.push(`🥷 [${mafias[mId].name}] mermó la influencia de [${mafias[targetId].name}].`);
            } else if (decision === 'alianza') {
                if (mafiaDecisions[targetId]?.action === 'alianza' && mafiaDecisions[targetId]?.target === mId) {
                    mafias[mId].money += 600; mafias[mId].influence += 15;
                    logs.push(`📜 PACTO RATIFICADO: Alianza entre [${mafias[mId].name}] y [${mafias[targetId].name}].`);
                } else {
                    logs.push(`⚠️ El intento de alianza de [${mafias[mId].name}] fracasó.`);
                }
            }

            if (game.currentEvent?.code === "CRISIS") mafias[mId].money = Math.max(0, mafias[mId].money - 200);
        });

        if (game.currentEvent?.code === "LAVADO") {
            Object.keys(mafias).forEach(mId => {
                const bonus = mafias[mId].influence * 10;
                mafias[mId].money += bonus;
                logs.push(`💸 LAVADO: [${mafias[mId].name}] recibió $${bonus} por influencia.`);
            });
        }

        db.ref('game_room').update({ mafias, lastRoundLogs: logs, estadisticasHistoricas: stats, currentPhase: 'TRANSITION' });
    });
}

// ==========================================
// PANTALLA FINAL
// ==========================================
function renderEndScreen() {
    changeScreen('screen-end');
    SoundEffects.play('victoria');
    const mafiasArr = Object.values(globalGameState.mafias || {}).sort((a, b) => b.money - a.money);
    if (mafiasArr.length > 0) document.getElementById('winner-mafia-name').innerText = mafiasArr[0].name;

    const podiumUi = document.getElementById('final-podium');
    podiumUi.innerHTML = "";
    mafiasArr.slice(0, 3).forEach((m, i) => {
        podiumUi.innerHTML += `<div class="stat-card" style="background:#1a1d30;padding:10px;border-radius:6px;"><h3>#${i+1}</h3><h4>${m.name}</h4><p>$${m.money}</p></div>`;
    });

    const stats = globalGameState.estadisticasHistoricas;
    if (stats) {
        let maxT = -1, traidorId = "Ninguno", maxC = -1, confiableId = "Ninguno";
        Object.keys(stats.traiciones || {}).forEach(mId => { if (stats.traiciones[mId] > maxT) { maxT = stats.traiciones[mId]; traidorId = globalGameState.mafias[mId]?.name; } });
        Object.keys(stats.cooperaciones || {}).forEach(mId => { if (stats.cooperaciones[mId] > maxC) { maxC = stats.cooperaciones[mId]; confiableId = globalGameState.mafias[mId]?.name; } });
        document.getElementById('badge-trust-name').innerText = `${confiableId} (${maxC} veces)`;
        document.getElementById('badge-traitor-name').innerText = `${traidorId} (${maxT} veces)`;
    }

    if (isHost) document.getElementById('btn-reset-game').classList.remove('hidden');
}
