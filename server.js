const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const {
  CHARACTERS, MAP, SABOTAGE_TARGETS, addBot, beginMeeting, checkWin, createPlayer, createRoom,
  distance, findRoom, finishGame, isWalkable, livingPlayers, resolveMeeting, setMessage, snapshot, startGame
} = require("./src/game-state");

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 8;
const rooms = new Map();
const pendingRoomUpdates = new WeakMap();
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));
app.use("/vendor", express.static(path.join(__dirname, "node_modules", "three", "build")));
app.get("/reset", (req, res) => {
  rooms.clear();
  res.send("Rooms reset. <a href='/'>Return to Game</a>");
});

function emitRoom(room) {
  room.players.forEach(player => {
    if (player.connected && !player.isBot) io.to(player.id).emit("state", snapshot(room, player.id));
  });
}

function scheduleRoomUpdate(room) {
  if (pendingRoomUpdates.has(room)) return;
  const timer = setTimeout(() => {
    pendingRoomUpdates.delete(room);
    emitRoom(room);
  }, 35);
  pendingRoomUpdates.set(room, timer);
}

function getPlayerContext(socket) {
  const room = findRoom(rooms, socket.id);
  return { room, player: room?.players.get(socket.id) };
}

function joinRoom(socket, room, player) {
  socket.join(room.code);
  socket.emit("joined", { code: room.code, sessionId: player.sessionId });
  emitRoom(room);
}

function movePlayer(player, dx, dy, elapsedSeconds, direction, isRunning) {
  const speed = isRunning ? 220 : 130;
  const magnitude = Math.hypot(dx, dy);
  if (magnitude < 0.001) return;

  const normalizedX = dx / magnitude;
  const normalizedY = dy / magnitude;
  const step = Math.min(magnitude, speed * elapsedSeconds);

  if (typeof direction === "number" && !isNaN(direction)) {
    player.direction = direction;
  } else {
    player.direction = Math.atan2(normalizedX, normalizedY);
  }
  player.isRunning = !!isRunning;

  const targetX = player.x + normalizedX * step;
  const targetY = player.y + normalizedY * step;

  if (isWalkable(targetX, targetY)) {
    player.x = targetX;
    player.y = targetY;
  } else {
    // Smooth wall sliding
    if (isWalkable(targetX, player.y)) {
      player.x = targetX;
    } else if (isWalkable(player.x, targetY)) {
      player.y = targetY;
    }
  }
}

function updateBots(room, now) {
  const bots = [...room.players.values()].filter(p => p.isBot && p.alive);
  if (bots.length === 0) return;

  if (room.phase === "playing") {
    let stateChanged = false;

    bots.forEach(bot => {
      // 1. Check for nearby dead bodies
      const nearbyBody = room.bodies.find(b => distance(bot, b) < 120);
      if (nearbyBody && now - bot.lastMeeting > 30000 && !room.meeting) {
        bot.lastMeeting = now;
        room.bodies = room.bodies.filter(b => b.id !== nearbyBody.id);
        beginMeeting(room, bot);
        stateChanged = true;
        return;
      }

      // 2. Hollow bot elimination
      if (bot.role === "hollow") {
        const canEliminate = now - bot.lastElimination > 16000;
        if (canEliminate) {
          const victim = [...room.players.values()].find(p => p.alive && p.connected && p.role === "crew" && distance(bot, p) < 70);
          if (victim && Math.random() < 0.35) {
            bot.lastElimination = now;
            victim.alive = false;
            room.bodies.push({ id: victim.id, x: victim.x, y: victim.y });
            setMessage(room, `${victim.name} vanished into the shadow of the sea.`);
            checkWin(room);
            stateChanged = true;
            return;
          }
        }
      }

      // 3. Bot Navigation & Wandering on the Grand Galleon
      if (!bot.botState) {
        bot.botState = { targetX: 1100, targetY: 650, nextDecisionTime: 0, targetTaskId: null, workingUntil: 0 };
      }

      if (bot.botState.workingUntil > now) {
        return;
      }

      if (now > bot.botState.nextDecisionTime || distance(bot, { x: bot.botState.targetX, y: bot.botState.targetY }) < 40) {
        // Complete current task if arrived
        if (bot.botState.targetTaskId && bot.role === "crew") {
          const task = room.tasks.find(t => t.id === bot.botState.targetTaskId);
          if (task && !task.done) {
            task.done = true;
            setMessage(room, `${bot.name} completed: ${task.name}.`);
            checkWin(room);
            stateChanged = true;
          }
        }

        // Pick next destination
        const unfinished = room.tasks.filter(t => !t.done);
        if (unfinished.length > 0 && Math.random() < 0.65) {
          const pick = unfinished[Math.floor(Math.random() * unfinished.length)];
          bot.botState.targetX = pick.x + (Math.random() * 30 - 15);
          bot.botState.targetY = pick.y + (Math.random() * 30 - 15);
          bot.botState.targetTaskId = pick.id;
          bot.botState.workingUntil = now + (3500 + Math.random() * 3500);
        } else {
          // Key waypoints across the massive galleon
          const waypoints = [
            { x: 1700, y: 650 }, // Forecastle bow
            { x: 1100, y: 480 }, // Port waist
            { x: 1100, y: 820 }, // Starboard waist
            { x: 1780, y: 380 }, // Poop deck helm
            { x: 420, y: 440 },  // Captain's great cabin
            { x: 440, y: 880 },  // Cargo hold
            { x: 1100, y: 960 }, // Engine & bilge
            { x: 1750, y: 920 }  // Cannons
          ];
          const wp = waypoints[Math.floor(Math.random() * waypoints.length)];
          bot.botState.targetX = wp.x + (Math.random() * 40 - 20);
          bot.botState.targetY = wp.y + (Math.random() * 40 - 20);
          bot.botState.targetTaskId = null;
        }
        bot.botState.nextDecisionTime = now + (7000 + Math.random() * 7000);
      }

      // Move toward target
      const dx = bot.botState.targetX - bot.x;
      const dy = bot.botState.targetY - bot.y;
      if (Math.hypot(dx, dy) > 15) {
        movePlayer(bot, dx, dy, 0.4, null, false);
        stateChanged = true;
      }
    });

    if (stateChanged) {
      scheduleRoomUpdate(room);
    }
  } else if (room.phase === "meeting" && room.meeting) {
    // Deliberate meeting voting: bots vote gradually across the 45s meeting timer
    const elapsed = Date.now() - (room.meeting.endsAt - 45000);
    let voted = false;

    bots.forEach((bot, idx) => {
      // Stagger bot votes across meeting
      const thresholdTime = 10000 + idx * 7000;
      if (!room.meeting.votes[bot.id] && elapsed > thresholdTime) {
        const eligible = [...room.players.values()].filter(p => p.alive && p.connected && p.id !== bot.id);
        if (eligible.length > 0) {
          const target = eligible[Math.floor(Math.random() * eligible.length)];
          room.meeting.votes[bot.id] = Math.random() < 0.25 ? "skip" : target.id;
          voted = true;
        }
      }
    });

    if (voted) {
      emitRoom(room);
    }
  }
}

io.on("connection", socket => {
  socket.on("createRoom", ({ name, sessionId } = {}) => {
    const room = createRoom(rooms, socket, name, sessionId);
    joinRoom(socket, room, room.players.get(socket.id));
  });

  socket.on("joinRoom", ({ code, name, sessionId } = {}) => {
    const room = rooms.get(String(code || "").trim().toUpperCase());
    if (!room) return socket.emit("errorMessage", "That room code was not found.");
    if (room.phase !== "lobby") return socket.emit("errorMessage", "This voyage has already begun.");
    if (room.players.size >= MAX_PLAYERS) return socket.emit("errorMessage", "This ship is full (8 pirates maximum).");
    const player = createPlayer(socket, name, sessionId);
    room.players.set(socket.id, player);
    setMessage(room, `${player.name} has boarded the Mourning Wren.`);
    joinRoom(socket, room, player);
  });

  socket.on("addBot", () => {
    const { room, player } = getPlayerContext(socket);
    if (!room || !player?.isHost || room.phase !== "lobby") return;
    const bot = addBot(room);
    if (!bot) return socket.emit("errorMessage", "The ship cannot hold any more pirates.");
    setMessage(room, `${bot.name} (AI Crewmate) has boarded the Mourning Wren.`);
    emitRoom(room);
  });

  socket.on("removeBot", () => {
    const { room, player } = getPlayerContext(socket);
    if (!room || !player?.isHost || room.phase !== "lobby") return;
    const bot = [...room.players.values()].reverse().find(p => p.isBot);
    if (bot) {
      room.players.delete(bot.id);
      setMessage(room, `${bot.name} left the ship.`);
      emitRoom(room);
    }
  });

  socket.on("rejoinRoom", ({ code, sessionId, name } = {}) => {
    const room = rooms.get(String(code || "").trim().toUpperCase());
    if (!room) return socket.emit("errorMessage", "That room no longer exists.");
    const oldPlayer = [...room.players.values()].find(player => player.sessionId === sessionId);
    if (!oldPlayer) return socket.emit("errorMessage", "Your old seat could not be recovered.");
    room.players.delete(oldPlayer.id);
    oldPlayer.id = socket.id;
    oldPlayer.connected = true;
    oldPlayer.name = String(name || oldPlayer.name).trim().slice(0, 18) || oldPlayer.name;
    if (oldPlayer.isHost) room.hostId = socket.id;
    room.players.set(socket.id, oldPlayer);
    setMessage(room, `${oldPlayer.name} has returned to the ship.`);
    joinRoom(socket, room, oldPlayer);
  });

  socket.on("selectCharacter", character => {
    const { room, player } = getPlayerContext(socket);
    if (!player || room.phase !== "lobby" || !CHARACTERS.includes(character)) return;
    player.character = character;
    emitRoom(room);
  });

  socket.on("startGame", () => {
    const { room, player } = getPlayerContext(socket);
    if (!room || !player?.isHost) return socket.emit("errorMessage", "Only the captain who created the room can start.");
    if (!startGame(room)) return socket.emit("errorMessage", "Could not start voyage.");
    emitRoom(room);
  });

  socket.on("move", ({ dx = 0, dy = 0, direction = null, isRunning = false } = {}) => {
    const { room, player } = getPlayerContext(socket);
    if (!room || room.phase !== "playing" || !player?.alive || !player.connected) return;
    const now = Date.now();
    if (now - player.lastMove < 25) return;
    const elapsedSeconds = player.lastMove ? Math.min((now - player.lastMove) / 1000, 0.1) : 0.035;
    player.lastMove = now;
    movePlayer(player, Number(dx) || 0, Number(dy) || 0, elapsedSeconds, direction, isRunning);
    scheduleRoomUpdate(room);
  });

  socket.on("interact", taskId => {
    const { room, player } = getPlayerContext(socket);
    if (!room || room.phase !== "playing" || !player?.alive || player.role !== "crew") return;
    const task = room.tasks.find(candidate => candidate.id === taskId);
    if (!task || task.done || distance(player, task) > 110) return socket.emit("errorMessage", "Move closer to an unfinished task first.");
    task.done = true;
    setMessage(room, `${player.name} completed: ${task.name}.`);
    checkWin(room);
    emitRoom(room);
  });

  socket.on("sabotage", type => {
    const { room, player } = getPlayerContext(socket);
    if (!room || room.phase !== "playing" || !player?.alive || player.role !== "hollow" || room.sabotage || Date.now() - player.lastAction < 18000) return;
    if (!Object.hasOwn(SABOTAGE_TARGETS, type)) return;
    player.lastAction = Date.now();
    room.sabotage = { type, endsAt: Date.now() + (type === "helm" ? 35000 : 30000), x: player.x, y: player.y };
    setMessage(room, type === "lights" ? "The lanterns gutter out across the ship!" : type === "helm" ? "The helm has jammed! The ship drifts toward the rocks!" : "Black bilge water is flooding the lower deck!");
    emitRoom(room);
  });

  socket.on("repairSabotage", () => {
    const { room, player } = getPlayerContext(socket);
    if (!room || room.phase !== "playing" || !player?.alive || player.role !== "crew" || !room.sabotage) return;
    if (distance(player, SABOTAGE_TARGETS[room.sabotage.type]) > 140) return socket.emit("errorMessage", "Get to the affected station to repair it.");
    room.sabotage = null;
    setMessage(room, `${player.name} repaired the ship's system.`);
    emitRoom(room);
  });

  socket.on("eliminate", targetId => {
    const { room, player } = getPlayerContext(socket);
    const target = room?.players.get(targetId);
    if (!room || room.phase !== "playing" || !player?.alive) return;
    if (player.role !== "hollow") return socket.emit("errorMessage", "Only The Hollow can eliminate. You are Crew.");
    if (!target || target.id === player.id || !target.alive || !target.connected || target.role !== "crew") return socket.emit("errorMessage", "That pirate cannot be eliminated.");
    if (distance(player, target) > 90) return socket.emit("errorMessage", "Get closer to the Crew member before eliminating.");
    const cooldownRemaining = 12000 - (Date.now() - player.lastElimination);
    if (cooldownRemaining > 0) return socket.emit("errorMessage", `Elimination is recharging (${Math.ceil(cooldownRemaining / 1000)}s).`);
    player.lastElimination = Date.now();
    target.alive = false;
    room.bodies.push({ id: target.id, x: target.x, y: target.y });
    setMessage(room, `${target.name} has vanished beneath the tide.`);
    checkWin(room);
    emitRoom(room);
  });

  socket.on("report", bodyId => {
    const { room, player } = getPlayerContext(socket);
    if (!room || room.phase !== "playing" || !player?.alive) return;
    if (bodyId) {
      const body = room.bodies.find(candidate => candidate.id === bodyId);
      if (!body || distance(player, body) > 120) return;
      room.bodies = room.bodies.filter(candidate => candidate.id !== bodyId);
    } else if (Date.now() - player.lastMeeting < 60000) return socket.emit("errorMessage", "The emergency bell is still cooling down.");
    player.lastMeeting = Date.now();
    if (beginMeeting(room, player)) emitRoom(room);
  });

  socket.on("vote", targetId => {
    const { room, player } = getPlayerContext(socket);
    if (!room || room.phase !== "meeting" || !player?.alive || !room.meeting || room.meeting.votes[player.id]) return;
    if (targetId !== "skip" && ![...room.players.values()].some(target => target.id === targetId && target.alive)) return;
    room.meeting.votes[player.id] = targetId;
    setMessage(room, `${player.name} has cast a vote.`);

    // If everyone (including bots) has now voted, end meeting
    const living = livingPlayers(room);
    if (Object.keys(room.meeting.votes).length >= living.length) {
      resolveMeeting(room);
    }
    emitRoom(room);
  });

  socket.on("disconnect", () => {
    const { room, player } = getPlayerContext(socket);
    if (!room || !player) return;
    player.connected = false;
    if (room.phase === "lobby") {
      room.players.delete(socket.id);
      if (room.hostId === socket.id) {
        const nextHost = room.players.values().next().value;
        if (!nextHost) return rooms.delete(room.code);
        nextHost.isHost = true;
        room.hostId = nextHost.id;
      }
    }
    emitRoom(room);
  });
});

setInterval(() => {
  const now = Date.now();
  rooms.forEach(room => {
    updateBots(room, now);
    if (room.meeting && now >= room.meeting.endsAt) {
      // Cast votes for any remaining bots or players who timed out
      const living = livingPlayers(room);
      living.forEach(p => {
        if (!room.meeting.votes[p.id]) room.meeting.votes[p.id] = "skip";
      });
      resolveMeeting(room);
      emitRoom(room);
    }
    if (room.sabotage && now >= room.sabotage.endsAt) {
      if (room.sabotage.type === "lights") {
        room.sabotage = null;
        setMessage(room, "The lanterns sputter back to life.");
      } else finishGame(room, "hollow", room.sabotage.type === "helm" ? "The escape route is lost. The Hollow claim the ship." : "The bilge floods beyond saving. The Hollow claim the ship.");
      emitRoom(room);
    }
    if (room.phase === "ended" && now - room.endedAt > 120000) rooms.delete(room.code);
  });
}, 350);

server.listen(PORT, () => console.log(`THE HOLLOW TIDE listening on http://localhost:${PORT}`));
