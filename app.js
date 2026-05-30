// ==========================================
// CONFIGURACIÓN DE FIREBASE OFICIAL INTEGRADA
// ==========================================
const firebaseConfig = {
    apiKey: "AIzaSyAG9BbgcQKuVAXPeXJgjz_7VA4FXnYST6Y",
    authDomain: "mafia-de-patos-a9e22.firebaseapp.com",
    projectId: "mafia-de-patos-a9e22",
    storageBucket: "mafia-de-patos-a9e22.firebasestorage.app",
    messagingSenderId: "32475436802",
    appId: "1:32475436802:web:7c3d0011c40bdd11a9541b",
    databaseURL: "https://mafia-de-patos-a9e22-default-rtdb.firebaseio.com/" // Forzado nativo para SDK v8
};

// Inicialización de la red
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// VARIABLES DE INSTANCIA LOCAL
let myPlayerId = null;
let myPlayerName = "";
let myMafiaId = null;
let myMafiaName = "";
let isHost = false;
let globalGameState = {};
let timerInterval = null;

const SoundEffects = {
    ctx: new (window.AudioContext || window.webkitAudioContext)(),
    play(type) {
        try {
            let osc = this.ctx.createOscillator();
            let gain = this.ctx.createGain();
            osc.connect(gain); gain.connect(this.ctx.destination);
            if (type === 'click') {
                osc.frequency.setValueAtTime(400, this.ctx.currentTime);
                gain.gain.setValueAtTime(0.1, this.ctx.currentTime);
                osc.start(); osc.stop(this.ctx.currentTime + 0.05);
            } else if (type === 'traicion') {
                osc.type = 'sawtooth';
                osc.frequency.setValueAtTime(140, this.ctx.currentTime);
                gain.gain.setValueAtTime(0.2, this.ctx.currentTime);
                osc.start(); osc.stop(this.ctx.currentTime + 0.35);
            } else if (type === 'victoria') {
                osc.frequency.setValueAtTime(440, this.ctx.currentTime);
                gain.gain.setValueAtTime(0.15, this.ctx.currentTime);
                osc.start(); osc.stop(this.ctx.currentTime + 0.5);
            }
        } catch(e){}
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

// INICIALIZACIÓN
document.addEventListener("DOMContentLoaded", () => {
    // Determinar asignación de Rol de Profesor (Host)
    if (!localStorage.getItem('mafia_host_token')) {
        db.ref('game_room/host_assigned').transaction((current) => {
            if (current === null) return true;
            return current;
        }, (error, committed, snapshot) => {
            if (committed && snapshot.val() === true && !myPlayerId) {
                localStorage.setItem('mafia_host_token', 'true');
                activateAdminMode();
            }
        });
    } else {
        activateAdminMode();
    }

    setupLoginLogic();
    listenToGlobalState();
});

function activateAdminMode() {
    isHost = true;
    document.getElementById('admin-panel').classList.remove('hidden');
    document.getElementById('btn-start-game').addEventListener('click', masterActionStartGame);
    document.getElementById('btn-admin-next').addEventListener('click', masterActionNextRound);
    document.getElementById('btn-reset-game').addEventListener('click', masterResetEverything);
}

function setupLoginLogic() {
    document.getElementById('btn-join').addEventListener('click', () => {
        let nameIn = document.getElementById('player-name').value.trim();
        if (nameIn.length < 2) return alert("¡Alias de mafioso inválido!");
        myPlayerName = nameIn;
        SoundEffects.play('click');

        let pRef = db.ref('game_room/players').push();
        myPlayerId = pRef.key;
        
        pRef.set({ name: myPlayerName, mafiaId: "sin_asignar", online: true });
        pRef.onDisconnect().remove();

        document.getElementById('btn-join').disabled = true;
        document.getElementById('lobby-status').innerText = "¡Ingresaste al Callejón! Esperando que el Profesor inicie la simulación...";
    });
}

function listenToGlobalState() {
    db.ref('game_room').on('value', (snapshot) => {
        const data = snapshot.val() || {};
        globalGameState = data;

        if (data.players) {
            document.getElementById('player-count').innerText = Object.keys(data.players).length;
            if (myPlayerId && data.players[myPlayerId]) {
                let serverMe = data.players[myPlayerId];
                if (serverMe.mafiaId !== "sin_asignar" && myMafiaId === null) {
                    myMafiaId = serverMe.mafiaId;
                    enterAssignmentPhase();
                }
            }
        }
        if (data.currentPhase) syncGamePhase(data.currentPhase);
    });
}

function masterActionStartGame() {
    SoundEffects.play('click');
    db.ref('game_room/players').once('value', (snap) => {
        let playersObj = snap.val();
        if (!playersObj) return alert("No hay suficientes alumnos en sala.");
        
        let keys = Object.keys(playersObj);
        let totalMafias = 7;
        let mafiasConfig = {};
        
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

        let updates = {};
        keys.forEach((pId, index) => {
            let assignedMId = `mafia_${(index % totalMafias) + 1}`;
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

function enterAssignmentPhase() {
    changeScreen('screen-assignment');
    db.ref(`game_room/mafias/${myMafiaId}`).on('value', (snap) => {
        let mData = snap.val();
        if (!mData) return;
        myMafiaName = mData.name;
        document.getElementById('assigned-mafia-name').innerText = myMafiaName;

        if (mData.leaderId === myPlayerId) {
            let box = document.getElementById('naming-box');
            if (box) box.classList.remove('hidden');
        }
    });

    document.getElementById('btn-save-mafia-name').addEventListener('click', () => {
        let cName = document.getElementById('custom-mafia-name').value.trim();
        if (cName.length < 3) return alert("Nombre no apto.");
        SoundEffects.play('click');
        db.ref(`game_room/mafias/${myMafiaId}`).update({ name: cName });
        document.getElementById('naming-box').innerHTML = "<p>¡Identidad familiar establecida ante el Don!</p>";
    });
}

function syncGamePhase(phase) {
    if (phase === 'DASHBOARD') renderDashboard();
    else if (phase === 'TRANSITION') renderTransition();
    else if (phase === 'END') renderEndScreen();
}

function renderDashboard() {
    changeScreen('screen-dashboard');
    document.getElementById('dash-player-name').innerText = myPlayerName;
    document.getElementById('dash-mafia-name').innerText = myMafiaName;

    db.ref(`game_room/mafias/${myMafiaId}`).on('value', (s) => {
        let m = s.val(); if (!m) return;
        document.getElementById('stat-money').innerText = `$${m.money}`;
        document.getElementById('stat-rep').innerText = `${m.reputation}%`;
        document.getElementById('stat-inf').innerText = m.influence;
    });

    if (globalGameState.currentEvent) {
        document.getElementById('event-banner').classList.remove('hidden');
        document.getElementById('event-title').innerText = globalGameState.currentEvent.title;
        document.getElementById('event-desc').innerText = globalGameState.currentEvent.desc;
    }

    let targetSelect = document.getElementById('target-mafia');
    targetSelect.innerHTML = "";
    if (globalGameState.mafias) {
        Object.keys(globalGameState.mafias).forEach(mId => {
            if (mId !== myMafiaId) {
                let opt = document.createElement('option');
                opt.value = mId; opt.innerText = globalGameState.mafias[mId].name;
                targetSelect.appendChild(opt);
            }
        });
    }

    document.querySelectorAll('.btn-action').forEach(btn => {
        let newBtn = btn.cloneNode(true); btn.parentNode.replaceChild(newBtn, btn);
        newBtn.addEventListener('click', () => {
            let act = newBtn.getAttribute('data-action');
            let target = document.getElementById('target-mafia').value;
            document.querySelectorAll('.btn-action').forEach(b => b.classList.remove('selected'));
            newBtn.classList.add('selected');
            
            db.ref(`game_room/votes/ronda_${globalGameState.round}/${myPlayerId}`).set({
                player: myPlayerName, mafiaSource: myMafiaId, action: act, target: target
            });
            SoundEffects.play('click');
            document.getElementById('vote-status').innerText = `Voto enviado de forma encriptada.`;
        });
    });

    runClientTimer(globalGameState.timerEndTime);
    updateLiveRankingTable();
    listenInternalVotes();
}

function listenInternalVotes() {
    db.ref(`game_room/votes/ronda_${globalGameState.round}`).on('value', (snap) => {
        let vObj = snap.val() || {};
        let listUi = document.getElementById('internal-votes-list');
        if (!listUi) return; listUi.innerHTML = "";
        
        Object.keys(vObj).forEach(pId => {
            if (vObj[pId].mafiaSource === myMafiaId) {
                let li = document.createElement('li');
                li.innerText = `✔️ ${vObj[pId].player}: Criptovoto Listo`;
                listUi.appendChild(li);
            }
        });

        db.ref(`game_room/votes/ronda_${globalGameState.round}/${myPlayerId}`).once('value', (s)=>{
            if(s.exists()){
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
    let tbody = document.getElementById('live-ranking-body');
    if (!tbody || !globalGameState.mafias) return; tbody.innerHTML = "";
    let arr = Object.values(globalGameState.mafias).sort((a,b) => b.money - a.money);
    arr.forEach(m => {
        tbody.innerHTML += `<tr><td><strong>${m.name}</strong></td><td>$${m.money}</td><td>${m.reputation}%</td><td>${m.influence} 👑</td></tr>`;
    });
}

function runClientTimer(endTime) {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        let diff = endTime - new Date().getTime();
        if (diff <= 0) {
            clearInterval(timerInterval);
            document.getElementById('timer-display').innerText = "00:00";
            if (isHost) resolveRoundLogic();
        } else {
            let min = Math.floor((diff % 3600000) / 60000);
            let sec = Math.floor((diff % 60000) / 1000);
            document.getElementById('timer-display').innerText = `${min < 10 ? '0':''}${min}:${sec < 10 ? '0':''}${sec}`;
        }
    }, 1000);
}

function renderTransition() {
    changeScreen('screen-transition');
    document.getElementById('rep-ronda-num').innerText = globalGameState.round;
    let logBox = document.getElementById('round-narrative-log'); logBox.innerHTML = "";
    
    if (globalGameState.lastRoundLogs) {
        globalGameState.lastRoundLogs.forEach(txt => {
            let p = document.createElement('p'); p.innerText = txt; logBox.appendChild(p);
        });
        if(globalGameState.lastRoundLogs.join(" ").includes("TRAICIONÓ")) SoundEffects.play('traicion');
    }
    if (isHost) document.getElementById('btn-admin-next').classList.remove('hidden');
}

function resolveRoundLogic() {
    db.ref('game_room').once('value', (snap) => {
        let game = snap.val();
        let rVotes = game.votes ? game.votes[`ronda_${game.round}`] : null;
        let mafias = game.mafias;
        let logs = [];

        logs.push(`--- INFORME DEL MERCADO CLANDESTINO: RONDA ${game.round} ---`);

        let mafiaDecisions = {};
        Object.keys(mafias).forEach(mId => { mafiaDecisions[mId] = { action: 'cooperar', target: null, votesCount: {} }; });

        if (rVotes) {
            Object.values(rVotes).forEach(v => {
                if (!mafiaDecisions[v.mafiaSource].votesCount[v.action]) mafiaDecisions[v.mafiaSource].votesCount[v.action] = 0;
                mafiaDecisions[v.mafiaSource].votesCount[v.action]++;
                mafiaDecisions[v.mafiaSource].target = v.target;
            });
            Object.keys(mafiaDecisions).forEach(mId => {
                let counts = mafiaDecisions[mId].votesCount; let max = 0;
                Object.keys(counts).forEach(act => { if (counts[act] > max) { max = counts[act]; mafiaDecisions[mId].action = act; } });
            });
        }

        let stats = game.estadisticasHistoricas || { traiciones: {}, cooperaciones: {} };

        Object.keys(mafias).forEach(mId => {
            let decision = mafiaDecisions[mId].action;
            let targetId = mafiaDecisions[mId].target || Object.keys(mafias).find(x => x !== mId);
            if(!stats.traiciones[mId]) stats.traiciones[mId] = 0;
            if(!stats.cooperaciones[mId]) stats.cooperaciones[mId] = 0;

            let repFactor = mafias[mId].reputation / 100;

            if (decision === 'cooperar') {
                let gain = 400 * repFactor; if (game.currentEvent?.code === "AUGE") gain *= 1.5;
                mafias[mId].money += Math.round(gain);
                mafias[mId].reputation = Math.min(100, mafias[mId].reputation + 10);
                stats.cooperaciones[mId]++;
                logs.push(`🕊️ El sindicato [${mafias[mId].name}] COOPERÓ limpiamente.`);
            } else if (decision === 'traicionar') {
                mafias[mId].money += 800; mafias[mId].reputation = Math.max(10, mafias[mId].reputation - 35);
                mafias[targetId].money = Math.max(0, mafias[targetId].money - 400);
                stats.traiciones[mId]++;
                if (game.currentEvent?.code === "REDADA") { mafias[mId].money -= 500; logs.push(`🚨 REDADA: La traición de [${mafias[mId].name}] fue interceptada (-$500).`); }
                logs.push(`🗡️ ¡TRAICIÓN! [${mafias[mId].name}] robó recursos a [${mafias[targetId].name}].`);
            } else if (decision === 'robar') {
                mafias[mId].influence += 20; mafias[targetId].influence = Math.max(0, mafias[targetId].influence - 20);
                logs.push(`🥷 [${mafias[mId].name}] mermó la influencia de [${mafias[targetId].name}].`);
            } else if (decision === 'alianza') {
                if (mafiaDecisions[targetId]?.action === 'alianza' && mafiaDecisions[targetId]?.target === mId) {
                    mafias[mId].money += 600; mafias[mId].influence += 15;
                    logs.push(`📜 PACTO RATIFICADO: Alianza formal entre [${mafias[mId].name}] y [${mafias[targetId].name}].`);
                } else logs.push(`⚠️ El intento de alianza de [${mafias[mId].name}] fracasó.`);
            }
            if(game.currentEvent?.code === "CRISIS") mafias[mId].money = Math.max(0, mafias[mId].money - 200);
        });

        db.ref('game_room').update({ mafias: mafias, lastRoundLogs: logs, estadisticasHistoricas: stats, currentPhase: 'TRANSITION' });
    });
}

function masterActionNextRound() {
    SoundEffects.play('click');
    let nextR = globalGameState.round + 1;
    if (nextR > 5) db.ref('game_room').update({ currentPhase: 'END' });
    else {
        let endTime = new Date().getTime() + (3 * 60 * 1000);
        let ev = EVENTOS[Math.floor(Math.random() * EVENTOS.length)];
        db.ref('game_room').update({ round: nextR, timerEndTime: endTime, currentEvent: ev, currentPhase: 'DASHBOARD' });
    }
}

function renderEndScreen() {
    changeScreen('screen-end'); SoundEffects.play('victoria');
    let mafiasArr = Object.values(globalGameState.mafias || {});
    mafiasArr.sort((a,b) => b.money - a.money);

    if(mafiasArr.length > 0) document.getElementById('winner-mafia-name').innerText = mafiasArr[0].name;

    let podiumUi = document.getElementById('final-podium'); podiumUi.innerHTML = "";
    mafiasArr.slice(0, 3).forEach((m, index) => {
        podiumUi.innerHTML += `<div class="stat-card" style="background:#1a1d30; padding:10px; border-radius:6px;"><h3>#${index+1}</h3><h4>${m.name}</h4><p>$${m.money}</p></div>`;
    });

    let stats = globalGameState.estadisticasHistoricas;
    if(stats) {
        let maxTraiciones = -1; let traidorId = "Ninguno";
        let maxCooperas = -1; let confiableId = "Ninguno";
        Object.keys(stats.traiciones || {}).forEach(mId => { if(stats.traiciones[mId] > maxTraiciones) { maxTraiciones = stats.traiciones[mId]; traidorId = globalGameState.mafias[mId]?.name; } });
        Object.keys(stats.cooperaciones || {}).forEach(mId => { if(stats.cooperaciones[mId] > maxCooperas) { maxCooperas = stats.cooperaciones[mId]; confiableId = globalGameState.mafias[mId]?.name; } });
        document.getElementById('badge-trust-name').innerText = `${confiableId} (${maxCooperas} veces)`;
        document.getElementById('badge-traitor-name').innerText = `${traidorId} (${maxTraiciones} veces)`;
    }
    if (isHost) document.getElementById('btn-reset-game').classList.remove('hidden');
}

function masterResetEverything() {
    SoundEffects.play('click');
    db.ref('game_room').set({ currentPhase: 'LOGIN', host_assigned: true });
    window.location.reload();
}