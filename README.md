# Mafia de Patos — Backend propio con MySQL (reemplazo de Firebase)

Esta carpeta contiene tu juego migrado de Firebase a una base de datos MySQL
propia, manteniendo el 100% de tu lógica de juego ya corregida.

```
proyecto/
├── frontend/        → sube esto a GitHub Pages / Netlify (igual que antes)
│   ├── index.html
│   ├── app.js        (solo cambió el bloque de configuración del inicio)
│   ├── style.css     (sin cambios)
│   └── db-shim.js     (NUEVO: reemplaza al SDK de Firebase)
└── backend/         → sube esto a Render (servidor nuevo)
    ├── server.js
    ├── package.json
    ├── schema.sql
    └── .env.example
```

## Por qué esta arquitectura

MySQL no se puede conectar directamente desde el navegador (a diferencia de
Firebase). Por eso ahora hay un servidor intermedio (`backend/`) que recibe
las peticiones del navegador por Socket.IO y es el único que le habla a
MySQL. Ese servidor **imita la misma API de Firebase** que ya usaba tu
`app.js`, así que tu lógica de juego —incluyendo los 5 bugs que ya
corregimos— no tuvo que tocarse.

---

## Paso 1 — Base de datos MySQL gratis en Aiven

1. Entra a https://aiven.io/free-mysql-database y crea una cuenta (no pide
   tarjeta de crédito).
2. Crea un servicio **MySQL** en el plan **Free**, elige una región cercana
   (ej. una de AWS/GCP en EE.UU.).
3. Cuando el servicio esté listo (estado "Running"), entra a su panel y
   copia estos datos de conexión: **Host**, **Port**, **User**, **Password**,
   **Database name** (normalmente `defaultdb`).
4. Abre la consola SQL integrada de Aiven (o conéctate con cualquier cliente
   MySQL) y ejecuta el contenido de `backend/schema.sql` para crear la
   tabla.
5. ⚠️ El plan gratuito de Aiven se **apaga automáticamente** si pasa mucho
   tiempo sin usarse (te avisan antes por correo). Si no has usado el juego
   en semanas, entra al panel de Aiven y reactívalo antes de tu siguiente
   clase.

## Paso 2 — Backend en Render (gratis)

1. Sube la carpeta `backend/` a un repositorio nuevo en GitHub (puede ser
   privado).
2. Entra a https://render.com, crea una cuenta (no pide tarjeta), y crea un
   **New → Web Service** apuntando a ese repositorio.
3. Configuración del servicio:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free
4. En la sección **Environment**, agrega estas variables (con los datos que
   copiaste de Aiven en el paso 1):

   | Variable | Valor |
   |---|---|
   | `DB_HOST` | el host de Aiven |
   | `DB_PORT` | el puerto de Aiven (normalmente algo como 12345, no 3306) |
   | `DB_USER` | usuario de Aiven |
   | `DB_PASSWORD` | contraseña de Aiven |
   | `DB_NAME` | `defaultdb` |
   | `DB_SSL` | `true` |
   | `FRONTEND_ORIGIN` | la URL exacta de tu GitHub Pages/Netlify, ej. `https://tuusuario.github.io` |

5. Despliega. Cuando termine, Render te da una URL pública tipo
   `https://mafia-de-patos-backend.onrender.com`. Guárdala.

### ⚠️ Importante: el "sueño" del plan gratuito

Render apaga el servidor tras 15 minutos sin tráfico. La siguiente petición
lo despierta, pero tarda 30-50 segundos. Para tu juego en clase:

- **Antes de empezar la sesión**, abre tú mismo
  `https://tu-backend.onrender.com/healthz` en el navegador 2-3 minutos
  antes de que entren los estudiantes, para "despertarlo".
- Si quieres que se mantenga despierto durante todo el horario de clase sin
  que tengas que pensar en ello, puedes usar un servicio gratuito como
  **UptimeRobot** (https://uptimerobot.com) para que haga ping a
  `/healthz` cada 5 minutos mientras dure tu clase.

## Paso 3 — Conectar el frontend al backend

1. Abre `frontend/index.html` y reemplaza esta línea con tu URL real de
   Render:
   ```js
   window.MAFIA_BACKEND_URL = "https://TU-BACKEND-EN-RENDER.onrender.com";
   ```
2. Sube la carpeta `frontend/` a GitHub Pages o Netlify, igual que ya lo
   tenías con la versión de Firebase.

## Paso 4 — Probar con el grupo grande

1. Despierta el backend (paso 2).
2. Abre el link del frontend desde 30+ dispositivos/pestañas.
3. Revisa `https://tu-backend.onrender.com/healthz` — te muestra cuántos
   jugadores hay conectados ahora mismo, útil para confirmar que todos
   llegaron al servidor.

---

## Notas técnicas

- **Persistencia:** el estado completo del juego vive en memoria del
  servidor (rápido y sin condiciones de carrera) y se guarda en MySQL medio
  segundo después de cada cambio, y también justo antes de apagarse. Así
  sobrevive a que Render reinicie el proceso por inactividad.
- **`backend/test-logic.js`:** valida la lógica interna de manejo de rutas
  (equivalente a `.set()`, `.update()`, `.push()`, `onDisconnect()` de
  Firebase). Puedes ejecutarlo con `node test-logic.js` si en el futuro
  modificas `server.js` y quieres confirmar que nada se rompió.
- **Capacidad:** con 30-40 jugadores el tráfico es mínimo (mensajes JSON
  pequeños); el cuello de botella real es el plan gratuito de Render/Aiven
  "durmiéndose" por inactividad, no la capacidad de procesar jugadores.
xd