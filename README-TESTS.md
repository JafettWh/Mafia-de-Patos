# Tests para detectar bugs de concurrencia (jugadores expulsados / atascados)

Esta carpeta contiene dos tipos de pruebas distintas, hechas para encontrar
exactamente el tipo de bug que reportaste ("entra un jugador nuevo y saca a
los anteriores", o jugadores que se quedan atascados en una pantalla).

## 1. `run-e2e-tests.js` — Test end-to-end contra tu server.js REAL

Este test levanta tu `server.js` de verdad (sin modificarlo) y conecta
varios "jugadores" usando `socket.io-client` real — el mismo paquete que
usaría un navegador — con latencias de red simuladas para reproducir las
condiciones de un salón de clase con WiFi compartido entre 20-30 celulares.

No necesita una base de datos MySQL real: este script intercepta
`mysql2/promise` antes de que tu servidor lo cargue y lo reemplaza por un
mock en memoria, así que tu servidor arranca igual, pero sin tocar Aiven.

### Cómo correrlo

```bash
cd backend/                      # la carpeta donde está tu server.js real
npm install                      # si no lo has hecho
npm install --save-dev socket.io-client
node tests/run-e2e-tests.js
```

Si tu `server.js` no está justo un nivel arriba de esta carpeta `tests/`,
puedes indicar la ruta explícitamente:

```bash
node tests/run-e2e-tests.js ../ruta/a/tu/server.js
```

### Qué verifica

Crea una sala de prueba real (vía `POST /create-room`, el mismo endpoint
que usa tu pantalla de admin) y hace que 15 "jugadores" entren con
latencias de red variables (5-150ms) y timing escalonado aleatorio,
exactamente como ocurriría con 15-30 celulares reales conectándose casi a
la vez. Al final, verifica que **ninguno** de esos jugadores haya sido
expulsado erróneamente de su propio registro.

Si algún jugador falla (`❌`), el mensaje te dirá cuál, y puedes aumentar
el detalle agregando más `console.log` dentro de `simulatePlayerLogin`.

### Si quieres estresarlo más

Edita la constante `NUM_PLAYERS` (línea ~201) para subirla a 30+, o el
rango de latencia `[5, 150]` para hacerlo más agresivo (por ejemplo,
`[50, 400]` simula un WiFi de salón realmente saturado).

## 2. Harness en memoria (sin red, sin servidor real)

Durante el diagnóstico, también construí un segundo harness que reproduce
la lógica de tu protocolo (servidor + cliente) puramente en memoria, sin
necesitar Node con red. Fue clave para encontrar la causa raíz exacta del
bug de fase incorrecta para jugadores que entran tarde. Si quieres
reutilizarlo para seguir testeando lógica de carrera sin levantar sockets
reales, pídeme que te lo entregue también — no lo incluí aquí para no
duplicar herramientas, ya que el test end-to-end de arriba es más fiel a
producción.

## Qué SÍ se encontró y se corrigió en `app.js`

**Bug real:** cuando un jugador entraba a una sala **después** de que la
partida ya había avanzado de fase (por ejemplo, alguien que se reconecta
o entra tarde mientras el Don ya asignó los sindicatos), el código leía
`globalGameState.currentPhase` de forma **síncrona**, inmediatamente
después de registrar el listener — pero el primer dato real tarda en
llegar por la red (es asíncrono). En ese instante, `globalGameState` aún
tenía su valor por defecto (objeto vacío), así que el código asumía
siempre fase `LOGIN`, sin importar la fase real del juego. Esto podía
dejar a un jugador tardío con la pantalla equivocada.

**Qué no se encontró (a pesar de probarlo exhaustivamente):** una
condición de carrera donde un jugador nuevo expulse a uno que ya estaba.
Until tu guard de las líneas ~480-493 de `app.js` (la verificación con
`once()` antes de expulsar) parece estar protegiendo bien ese caso en
todos los escenarios de concurrencia que pude reproducir, incluyendo 30
jugadores entrando dentro de una ventana de 300ms con el admin
actualizando el estado global al mismo tiempo.

Si el síntoma de "me saca cuando entra alguien" sigue ocurriendo en la
práctica después de este fix, lo más útil que puedes hacer es: la próxima
vez que pase, pedirle a la persona afectada que abra la consola del
navegador (F12 → Console) ANTES de que vuelva a pasar, y guardar lo que
diga `console.log("Cambiando de pantalla de forma segura a: " + id)` —
eso nos diría exactamente a qué pantalla la mandó el código y en qué
momento, lo cual acortaría mucho la siguiente ronda de diagnóstico.
