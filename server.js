// ========================
// Servidor Multiplayer Simples para Godot (Zee GameDev)
// Patched for Bounce Barrage:
//  - "find_match": pairs two players who both pressed Ranked / Unranked
//  - "relay": forwards any message to the other player in the room (ball/brick state)
//  - rooms are capped at 2 players
//  - find_match only pairs players on the same queue (content.v: game version + mode)
//  - room codes are always unique among the rooms that are open
//  - errors are in English and carry a code the game can match on
//  - "rejoin": a player who drops out of a match that has started has REJOIN_GRACE ms to
//    reconnect and take their place back; the other player is told "opponent_away" /
//    "opponent_back" meanwhile, and "player_disconnected" only if they never come back
//  - GET / answers "ok", so the game can wake a sleeping Render server with a plain request
// ========================

const express = require("express");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 9090;

app.get("/", (req, res) => res.type("text/plain").send("ok"));

const server = app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

const wss = new WebSocket.Server({ server });

const rooms = new Map();
const MAX_PLAYERS = 2;
const CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const REJOIN_GRACE = Number(process.env.REJOIN_GRACE || 15000); // ms a dropped player may take to come back

// Room code of the player currently waiting for an opponent, one per queue ("v" in
// find_match; builds from before the version check count as 0), so a player is only ever
// paired with someone running the same version of the game, in the same mode.
const waitingRooms = new Map();

// Error codes the game matches on (the text is a fallback for older builds).
const ERRORS = {
    room_not_found: "No room with that code.",
    room_full: "That room is already full.",
    already_in_room: "You're already in a room.",
    rejoin_failed: "The match is over or could not be found.",
};

function sendError(socket, code) {
    send(socket, "error", { code, msg: ERRORS[code] || code });
}

function generateRoomCode(length = 5) {
    // 36^5 = 60 million codes, so a clash is rare, but never hand out one that's in use.
    for (let attempt = 0; attempt < 1000; attempt++) {
        let result = "";
        for (let i = 0; i < length; i++) result += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
        if (!rooms.has(result)) return result;
    }
    // Practically unreachable; a longer code can't clash with any 5-character one.
    return generateRoomCode(length + 1);
}

function send(socket, cmd, content) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ cmd, content }));
    }
}

const playerlist = {
    players: [],

    get: function (uuid) {
        return this.players.find(player => player.uuid === uuid);
    },

    add: function (uuid, roomCode) {
        const isFirstPlayer = this.getByRoom(roomCode).length === 0;
        const player = { uuid, room: roomCode, x: isFirstPlayer ? 550 : 700, y: 300 };
        this.players.push(player);
        return player;
    },

    update: function (uuid, newX, newY) {
        const player = this.get(uuid);
        if (player) {
            player.x = newX;
            player.y = newY;
        }
    },

    remove: function (uuid) {
        this.players = this.players.filter(player => player.uuid !== uuid);
    },

    getByRoom: function (roomCode) {
        return this.players.filter(player => player.room === roomCode);
    }
};

// ----------------------------------------------------------------
// Room helpers
// ----------------------------------------------------------------
function createRoom(socket) {
    const code = generateRoomCode();
    socket.roomId = code;
    rooms.set(code, { players: {}, started: false, away: {} });
    rooms.get(code).players[socket.uuid] = socket;

    const newPlayer = playerlist.add(socket.uuid, code);
    console.log(`Room ${code} created by ${socket.uuid}`);

    send(socket, "room_created", { code });
    send(socket, "spawn_local_player", { player: newPlayer });
    return code;
}

function joinRoom(socket, rawCode) {
    const code = String(rawCode || "").trim().toUpperCase();
    const room = rooms.get(code);

    if (!room) {
        sendError(socket, "room_not_found");
        return false;
    }
    if (Object.keys(room.players).length >= MAX_PLAYERS || room.started) {
        sendError(socket, "room_full");
        return false;
    }

    socket.roomId = code;
    room.players[socket.uuid] = socket;

    const newPlayer = playerlist.add(socket.uuid, code);
    console.log(`${socket.uuid} joined room ${code}`);

    send(socket, "room_joined", { code });
    send(socket, "spawn_local_player", { player: newPlayer });
    send(socket, "spawn_network_players", { players: playerlist.getByRoom(code).filter(p => p.uuid !== socket.uuid) });

    for (const id in room.players) {
        if (room.players[id] !== socket) send(room.players[id], "spawn_new_player", { player: newPlayer });
    }

    if (Object.keys(room.players).length >= MAX_PLAYERS) {
        room.started = true;
        console.log(`Room ${code} is full. Starting the match!`);
        for (const id in room.players) send(room.players[id], "start_game", {});
    }
    return true;
}

function sendToOthers(socket, cmd, content) {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    for (const id in room.players) {
        const client = room.players[id];
        if (client !== socket) send(client, cmd, content);
    }
}

// A player is gone for good: tell the room and tidy up.
function removePlayer(code, uuid) {
    playerlist.remove(uuid);
    const room = rooms.get(code);
    if (!room) return;
    delete room.players[uuid];
    if (room.away[uuid]) {
        clearTimeout(room.away[uuid]);
        delete room.away[uuid];
    }
    for (const id in room.players) send(room.players[id], "player_disconnected", { uuid });
    if (Object.keys(room.players).length === 0) {
        for (const id in room.away) clearTimeout(room.away[id]);
        rooms.delete(code);
        console.log(`Room ${code} is empty and was removed.`);
    }
}

// ========================================
// A client connected
// ========================================
wss.on("connection", (socket) => {
    socket.uuid = uuidv4();
    console.log(`Client connected: ${socket.uuid}`);

    send(socket, "joined_server", { uuid: socket.uuid });

    socket.on("message", (message) => {
        let data;
        try {
            data = JSON.parse(message.toString());
        } catch (err) {
            console.error("Could not parse message:", err);
            return;
        }
        const content = data.content || {};

        switch (data.cmd) {
            case "create_room": {
                if (socket.roomId) { sendError(socket, "already_in_room"); break; }
                createRoom(socket);
                break;
            }

            case "join_room": {
                if (socket.roomId) { sendError(socket, "already_in_room"); break; }
                joinRoom(socket, content.code);
                break;
            }

            // Ranked / Unranked: join whoever is waiting in the same queue, otherwise wait to be joined
            case "find_match": {
                if (socket.roomId) { sendError(socket, "already_in_room"); break; }
                const queue = String(content.v ?? 0);
                const code = waitingRooms.get(queue);
                const waiting = code ? rooms.get(code) : null;
                if (waiting && !waiting.started && Object.keys(waiting.players).length === 1) {
                    waitingRooms.delete(queue);
                    joinRoom(socket, code);
                } else {
                    socket.waitVersion = queue;
                    waitingRooms.set(queue, createRoom(socket));
                }
                break;
            }

            // Back after a dropped connection: take our old place in the match.
            // Render's proxy can take ~10 s to tell us a connection died, so the player may
            // be back before we noticed they left: then the new connection replaces the old one.
            case "rejoin": {
                const code = String(content.code || "").toUpperCase();
                const oldUuid = String(content.uuid || "");
                const room = rooms.get(code);
                const stale = room ? room.players[oldUuid] : null;
                if (socket.roomId || !room || !room.started || (!room.away[oldUuid] && !stale)) {
                    sendError(socket, "rejoin_failed");
                    break;
                }
                if (room.away[oldUuid]) {
                    clearTimeout(room.away[oldUuid]);
                    delete room.away[oldUuid];
                } else if (stale !== socket) {
                    stale.replaced = true;  // its close handler then leaves the room alone
                    stale.terminate();
                }
                socket.uuid = oldUuid;  // same player as before, so paddle messages still match
                socket.roomId = code;
                room.players[oldUuid] = socket;
                console.log(`${oldUuid} rejoined room ${code}`);
                send(socket, "rejoined", { uuid: oldUuid, code });
                sendToOthers(socket, "opponent_back", { uuid: oldUuid });
                break;
            }

            case "position": {
                playerlist.update(socket.uuid, content.x, content.y);
                sendToOthers(socket, "update_position", { uuid: socket.uuid, x: content.x, y: content.y });
                break;
            }

            // Forwards an arbitrary payload to the other player in the room
            case "relay": {
                sendToOthers(socket, "relay", content);
                break;
            }

            case "chat": {
                const room = rooms.get(socket.roomId);
                if (room) {
                    for (const id in room.players) send(room.players[id], "new_chat_message", { uuid: socket.uuid, msg: content.msg });
                }
                break;
            }
        }
    });

    socket.on("close", () => {
        if (socket.replaced) return;  // a rejoin already took this player's place
        const uuid = socket.uuid;
        const code = socket.roomId;
        console.log(`Client disconnected: ${uuid}`);
        if (code && waitingRooms.get(socket.waitVersion) === code) {
            waitingRooms.delete(socket.waitVersion);
        }
        const room = rooms.get(code);
        if (!room) {
            playerlist.remove(uuid);
            return;
        }
        if (room.players[uuid] !== socket) return;  // an older socket of a player who already rejoined
        // A match in progress with someone still in it: hold the place for a while.
        const others = Object.keys(room.players).filter(id => id !== uuid);
        if (room.started && others.length > 0) {
            delete room.players[uuid];
            for (const id of others) send(room.players[id], "opponent_away", { uuid, seconds: Math.round(REJOIN_GRACE / 1000) });
            room.away[uuid] = setTimeout(() => {
                delete room.away[uuid];
                removePlayer(code, uuid);
            }, REJOIN_GRACE);
            return;
        }
        removePlayer(code, uuid);
    });
});
