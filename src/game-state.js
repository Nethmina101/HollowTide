const crypto = require("crypto");

const MAP = { width: 1200, height: 760 };
const TASKS = [
  { id: "compass", name: "Recalibrate the compass", x: 960, y: 170, room: "Navigation" },
  { id: "lantern", name: "Refill the lanterns", x: 600, y: 130, room: "Main Deck" },
  { id: "logbook", name: "Check the ship's log", x: 220, y: 180, room: "Captain's Cabin" },
  { id: "cannon", name: "Secure the cannon", x: 980, y: 500, room: "Cannon Deck" },
  { id: "bilge", name: "Pump the bilge", x: 600, y: 620, room: "Engine & Bilge" },
  { id: "cargo", name: "Inspect the relic crate", x: 240, y: 500, room: "Cargo Hold" }
];
const COLORS = ["#b9a078", "#7e9990", "#8c4a43", "#9c8355", "#b8b1a0", "#637c83", "#876f83", "#a56e4f"];
const CHARACTERS = ["Captain", "Deckhand", "Navigator", "Shipwright", "Surgeon", "Smuggler", "Occultist", "Cursed One"];
const SABOTAGE_TARGETS = { lights: { x: 600, y: 130 }, helm: { x: 960, y: 170 }, flood: { x: 600, y: 620 } };

const cloneTasks = () => TASKS.map(task => ({ ...task, done: false }));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const livingPlayers = room => [...room.players.values()].filter(player => player.alive && player.connected);

function createRoomCode(rooms) {
  let roomCode;
  do roomCode = crypto.randomBytes(3).toString("hex").toUpperCase(); while (rooms.has(roomCode));
  return roomCode;
}

function createPlayer(socket, name, sessionId, isHost = false) {
  return {
    id: socket.id,
    sessionId: sessionId || crypto.randomUUID(),
    name: String(name || "Pirate").trim().slice(0, 18) || "Pirate",
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    character: CHARACTERS[Math.floor(Math.random() * CHARACTERS.length)],
    direction: 0,
    x: 600 + Math.random() * 50 - 25,
    y: 340 + Math.random() * 50 - 25,
    role: null,
    alive: true,
    connected: true,
    isHost,
    lastMove: 0,
    lastAction: 0,
    lastMeeting: 0,
    lastElimination: 0
  };
}

function createRoom(rooms, host, name, sessionId) {
  const code = createRoomCode(rooms);
  const room = {
    code, phase: "lobby", hostId: host.id, players: new Map(), tasks: cloneTasks(), bodies: [],
    meeting: null, sabotage: null, message: "Waiting for the crew to board.", winner: null,
    startedAt: null, endedAt: null
  };
  room.players.set(host.id, createPlayer(host, name, sessionId, true));
  rooms.set(code, room);
  return room;
}

function findRoom(rooms, socketId) {
  return [...rooms.values()].find(room => room.players.has(socketId)) || null;
}

function safePlayer(player) {
  const { id, name, color, character, direction, x, y, alive, isHost, connected } = player;
  return { id, name, color, character, direction, x, y, alive, isHost, connected };
}

function snapshot(room, viewerId) {
  const viewer = room.players.get(viewerId);
  return {
    code: room.code, phase: room.phase, hostId: room.hostId,
    players: [...room.players.values()].map(player => ({ ...safePlayer(player), ...(room.phase === "ended" ? { role: player.role } : {}) })),
    me: viewer ? {
      id: viewer.id, role: viewer.role, alive: viewer.alive, character: viewer.character,
      hollowIds: viewer.role === "hollow" ? [...room.players.values()].filter(player => player.role === "hollow").map(player => player.id) : []
    } : null,
    tasks: room.tasks.map(task => ({ ...task })), taskCount: room.tasks.length,
    completedTasks: room.tasks.filter(task => task.done).length,
    bodies: room.bodies.map(body => ({ ...body })),
    meeting: room.meeting && { endsAt: room.meeting.endsAt, votes: Object.keys(room.meeting.votes).length, eligible: livingPlayers(room).length },
    sabotage: room.sabotage && { ...room.sabotage },
    message: room.message, winner: room.winner, startedAt: room.startedAt, map: MAP
  };
}

function setMessage(room, text) { room.message = text; }

function finishGame(room, winner, reason) {
  room.phase = "ended";
  room.winner = winner;
  room.endedAt = Date.now();
  room.sabotage = null;
  room.meeting = null;
  setMessage(room, reason);
}

function checkWin(room) {
  if (room.phase !== "playing") return false;
  const players = [...room.players.values()];
  const crew = players.filter(player => player.alive && player.role === "crew").length;
  const hollow = players.filter(player => player.alive && player.role === "hollow").length;
  if (hollow === 0) finishGame(room, "crew", "The Hollow have been cast out. The crew survives.");
  // A two-player voyage begins 1:1. The Hollow only win that duel after eliminating the Crew.
  else if (crew === 0 || (players.length > 2 && hollow >= crew)) finishGame(room, "hollow", "The Hollow outnumber the living crew. The ship belongs to the tide.");
  else if (room.tasks.every(task => task.done)) finishGame(room, "crew", "The escape sequence is complete. The crew launches into the fog.");
  return room.phase === "ended";
}

function startGame(room) {
  const players = [...room.players.values()];
  if (room.phase !== "lobby" || players.length < 2) return false;
  players.forEach((player, index) => {
    player.role = "crew";
    player.alive = true;
    player.x = 600 + (index % 4) * 22;
    player.y = 350 + Math.floor(index / 4) * 22;
  });
  const hollowCount = players.length === 2 ? 1 : players.length >= 6 ? 2 : 1;
  [...players].sort(() => Math.random() - 0.5).slice(0, hollowCount).forEach(player => { player.role = "hollow"; });
  room.phase = "playing";
  room.startedAt = Date.now();
  room.endedAt = null;
  room.tasks = cloneTasks();
  room.bodies = [];
  room.meeting = null;
  room.sabotage = null;
  room.winner = null;
  setMessage(room, "The voyage begins. Repair the ship, but trust no shadow.");
  return true;
}

function beginMeeting(room, reporter) {
  if (room.phase !== "playing" || room.meeting) return false;
  room.meeting = { endsAt: Date.now() + 45000, votes: {}, reporter: reporter.id };
  room.phase = "meeting";
  setMessage(room, `${reporter.name} rang the bell. Discuss what you saw, then vote.`);
  return true;
}

function resolveMeeting(room) {
  if (!room.meeting) return false;
  const counts = {};
  Object.values(room.meeting.votes).forEach(target => {
    if (target && target !== "skip") counts[target] = (counts[target] || 0) + 1;
  });
  const ranked = Object.entries(counts).sort(([, a], [, b]) => b - a);
  const [top] = ranked;
  const tied = top && ranked[1]?.[1] === top[1];
  if (top && !tied) {
    const target = room.players.get(top[0]);
    if (target?.alive) {
      target.alive = false;
      setMessage(room, `${target.name} was thrown into the sea. They were ${target.role === "hollow" ? "one of The Hollow" : "loyal crew"}.`);
    } else setMessage(room, "The vote changed nothing.");
  } else setMessage(room, "The vote was tied or skipped. No one was cast out.");
  room.meeting = null;
  room.phase = "playing";
  checkWin(room);
  return true;
}

module.exports = { CHARACTERS, MAP, SABOTAGE_TARGETS, beginMeeting, checkWin, createPlayer, createRoom, distance, findRoom, finishGame, livingPlayers, resolveMeeting, setMessage, snapshot, startGame };
