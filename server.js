const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

app.use(express.json());
app.use(
  express.static("public", {
    etag: false,
    lastModified: false,
    setHeaders: (response) => response.setHeader("Cache-Control", "no-store"),
  })
);
app.get("/favicon.ico", (_request, response) => response.status(204).end());

const TEAMS = ["red", "blue", "green", "yellow"];
const INITIAL_DISTANCE = 0;
const FINISH_DISTANCE = 90;
const STEP_DISTANCE = 5;

function emptyTeam() {
  return { distance: INITIAL_DISTANCE, players: [] };
}

let gameState = {
  started: false,
  winner: null,
  raceNumber: 0,
  red: emptyTeam(),
  blue: emptyTeam(),
  green: emptyTeam(),
  yellow: emptyTeam(),
};

const playerBySocket = new Map();
const playerByClient = new Map();

function sendState(target = io) {
  target.emit("game-state", gameState);
}

function cleanName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 24);
}

function removePlayer(socketId) {
  const registration = playerBySocket.get(socketId);
  if (!registration) return false;

  const teamPlayers = gameState[registration.team].players;
  const index = teamPlayers.findIndex((player) => player.id === socketId);
  if (index !== -1) teamPlayers.splice(index, 1);
  playerBySocket.delete(socketId);
  return true;
}

function registerPlayer({ team, name, clientId }) {
  const cleanPlayerName = cleanName(name);
  const cleanClientId = String(clientId || "").slice(0, 80);

  if (!TEAMS.includes(team)) {
    return { ok: false, status: 400, message: "Equipo no válido." };
  }
  if (cleanPlayerName.length < 2) {
    return {
      ok: false,
      status: 400,
      message: "Escribe un nombre de al menos 2 letras.",
    };
  }
  if (!cleanClientId) {
    return { ok: false, status: 400, message: "Identificador no válido." };
  }

  const previous = playerByClient.get(cleanClientId);
  if (previous) {
    gameState[previous.team].players = gameState[previous.team].players.filter(
      (player) => player.id !== cleanClientId
    );
  }

  const eligibleRace = gameState.started
    ? gameState.raceNumber + 1
    : gameState.raceNumber + 1;
  const player = { id: cleanClientId, name: cleanPlayerName, eligibleRace };

  gameState[team].players.push(player);
  playerByClient.set(cleanClientId, {
    team,
    name: cleanPlayerName,
    eligibleRace,
  });

  console.log(`👤 ${cleanPlayerName} se unió al equipo ${team}`);
  sendState();
  return { ok: true, team, name: cleanPlayerName, eligibleRace };
}

function startRace() {
  gameState.raceNumber += 1;
  TEAMS.forEach((team) => {
    gameState[team].distance = INITIAL_DISTANCE;
  });
  gameState.started = true;
  gameState.winner = null;
  console.log("🏁 Carrera iniciada");
  sendState();
}

function resetRace() {
  TEAMS.forEach((team) => {
    gameState[team].distance = INITIAL_DISTANCE;
  });
  gameState.started = false;
  gameState.winner = null;
  console.log("🔄 Carrera reiniciada por el profesor");
  sendState();
}

function moveKart(team, clientId) {
  const registration = playerByClient.get(String(clientId || ""));
  if (!gameState.started) {
    return { ok: false, status: 409, message: "La carrera todavía no ha iniciado." };
  }
  if (!registration || registration.team !== team || !TEAMS.includes(team)) {
    return {
      ok: false,
      status: 403,
      message: "Vuelve a registrar tu nombre y equipo.",
    };
  }
  if (registration.eligibleRace > gameState.raceNumber) {
    return {
      ok: false,
      status: 409,
      message: "Espera a que el profesor inicie la siguiente carrera.",
    };
  }
  if (gameState.winner) {
    return { ok: false, status: 409, message: "La carrera ya terminó." };
  }

  gameState[team].distance = Math.min(
    gameState[team].distance + STEP_DISTANCE,
    FINISH_DISTANCE
  );
  if (gameState[team].distance >= FINISH_DISTANCE) {
    gameState.winner = team;
    gameState.started = false;
  }
  console.log(`🚦 ${registration.name} (${team}): ${gameState[team].distance}%`);
  sendState();
  return {
    ok: true,
    distance: gameState[team].distance,
    winner: gameState.winner,
  };
}

app.post("/api/join", (request, response) => {
  const result = registerPlayer(request.body || {});
  response.status(result.status || 200).json(result);
});

app.post("/api/start", (_request, response) => {
  startRace();
  response.json({ ok: true });
});

app.post("/api/reset", (_request, response) => {
  resetRace();
  response.json({ ok: true });
});

app.post("/api/move", (request, response) => {
  const result = moveKart(request.body && request.body.team, request.body && request.body.clientId);
  response.status(result.status || 200).json(result);
});

io.on("connection", (socket) => {
  console.log(`✅ Dispositivo conectado: ${socket.id}`);
  socket.emit("server-ready", { version: "4-teams-v2" });
  sendState(socket);

  // El celular solicita esta comprobación después de instalar sus receptores.
  socket.on("check-server", (acknowledge = () => {}) => {
    acknowledge({ ok: true, version: "4-teams-v3" });
  });

  socket.on("join-team", (data, acknowledge = () => {}) => {
    const team = data && data.team;
    const name = cleanName(data && data.name);
    console.log(`📝 Solicitud de registro: "${name}" → ${team}`);

    if (!TEAMS.includes(team)) {
      const result = { ok: false, message: "Equipo no válido." };
      socket.emit("registration-result", result);
      acknowledge(result);
      return;
    }

    if (name.length < 2) {
      const result = {
        ok: false,
        message: "Escribe un nombre de al menos 2 letras.",
      };
      socket.emit("registration-result", result);
      acknowledge(result);
      return;
    }

    removePlayer(socket.id);
    // Si se registra con una carrera ya activa, espera a la siguiente.
    const requestedRace = Number(data && data.eligibleRace);
    const isReturningPlayer =
      gameState.started &&
      Number.isInteger(requestedRace) &&
      requestedRace > 0 &&
      requestedRace <= gameState.raceNumber;
    const eligibleRace = isReturningPlayer
      ? requestedRace
      : gameState.raceNumber + 1;

    gameState[team].players.push({ id: socket.id, name, eligibleRace });
    playerBySocket.set(socket.id, { team, name, eligibleRace });

    console.log(`👤 ${name} se unió al equipo ${team}`);
    sendState();
    const result = { ok: true, team, name, eligibleRace };
    socket.emit("registration-result", result);
    acknowledge(result);
  });

  socket.on("start-race", (acknowledge = () => {}) => {
    startRace();
    acknowledge({ ok: true });
  });

  socket.on("reset-race", (acknowledge = () => {}) => {
    resetRace();
    acknowledge({ ok: true });
  });

  socket.on("move-kart", (team, acknowledge = () => {}) => {
    const registration = playerBySocket.get(socket.id);

    if (!gameState.started) {
      acknowledge({ ok: false, message: "La carrera todavía no ha iniciado." });
      return;
    }

    if (!registration || registration.team !== team || !TEAMS.includes(team)) {
      acknowledge({ ok: false, message: "Vuelve a registrar tu nombre y equipo." });
      return;
    }

    if (registration.eligibleRace > gameState.raceNumber) {
      acknowledge({
        ok: false,
        message: "Espera a que el profesor inicie la siguiente carrera.",
      });
      return;
    }

    if (gameState.winner) {
      acknowledge({ ok: false, message: "La carrera ya terminó." });
      return;
    }

    gameState[team].distance = Math.min(
      gameState[team].distance + STEP_DISTANCE,
      FINISH_DISTANCE
    );

    if (gameState[team].distance >= FINISH_DISTANCE) {
      gameState.winner = team;
      gameState.started = false;
    }

    console.log(
      `🚦 ${registration.name} (${team}): ${gameState[team].distance}%`
    );

    sendState();
    acknowledge({
      ok: true,
      distance: gameState[team].distance,
      winner: gameState.winner,
    });
  });

  socket.on("disconnect", (reason) => {
    const removed = removePlayer(socket.id);
    if (removed) sendState();
    console.log(`❌ Dispositivo desconectado: ${socket.id} (${reason})`);
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Servidor ejecutándose en el puerto ${PORT}`);
});
