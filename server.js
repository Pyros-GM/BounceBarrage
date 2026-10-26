// ========================
// Servidor Multiplayer Simples para Godot (Zee GameDev)
// Patched for Bounce Barrage:
//  - "find_match": pairs two players who both pressed Duel Someone
//  - "relay": forwards any message to the other player in the room (ball/brick state)
//  - rooms are capped at 2 players
// ========================

const express = require("express");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 9090;
const server = app.listen(PORT, () => {
    console.log(`Servidor iniciado na porta: ${PORT}`);
});

const wss = new WebSocket.Server({ server });

const rooms = new Map();
const MAX_PLAYERS = 2;

// Room code of the player currently waiting for a Duel Someone opponent (or null)
let waitingRoom = null;

function generateRoomCode(length = 5) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < length; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

function send(socket, cmd, content) {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ cmd, content }));
    }
}

const playerlist = {
    players: [],

    getAll: function () {
        return this.players;
    },

    get: function (uuid) {
        return this.players.find(player => player.uuid === uuid);
    },

    add: function (uuid, roomCode) {
        const playersInRoom = this.getByRoom(roomCode);
        const isFirstPlayer = playersInRoom.length === 0;

        let player = {
            uuid,
            room: roomCode,
            x: isFirstPlayer ? 550 : 700,
            y: 300,
        };

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
function createRoom(socket, uuid) {
    const newRoomId = generateRoomCode();
    socket.roomId = newRoomId;
    rooms.set(newRoomId, { players: {} });
    rooms.get(newRoomId).players[uuid] = socket;

    const newPlayer = playerlist.add(uuid, newRoomId);
    console.log(`Sala ${newRoomId} criada pelo jogador ${uuid}`);

    send(socket, "room_created", { code: newRoomId });
    send(socket, "spawn_local_player", { player: newPlayer });
    return newRoomId;
}

function joinRoom(socket, uuid, rawCode) {
    const roomCode = String(rawCode || "").toUpperCase();
    const roomToJoin = rooms.get(roomCode);

    if (!roomToJoin) {
        send(socket, "error", { msg: "Sala não encontrada." });
        return false;
    }
    if (Object.keys(roomToJoin.players).length >= MAX_PLAYERS) {
        send(socket, "error", { msg: "Sala cheia." });
        return false;
    }

    socket.roomId = roomCode;
    roomToJoin.players[uuid] = socket;

    const newPlayer = playerlist.add(uuid, socket.roomId);
    console.log(`Jogador ${uuid} entrou na sala ${socket.roomId}`);

    send(socket, "room_joined", { code: socket.roomId });
    send(socket, "spawn_local_player", { player: newPlayer });

    const roomPlayers = playerlist.getByRoom(socket.roomId).filter(p => p.uuid !== uuid);
    send(socket, "spawn_network_players", { players: roomPlayers });

    for (const clientUuid in roomToJoin.players) {
        const client = roomToJoin.players[clientUuid];
        if (client !== socket) {
            send(client, "spawn_new_player", { player: newPlayer });
        }
    }

    if (Object.keys(roomToJoin.players).length >= MAX_PLAYERS) {
        console.log(`Sala ${socket.roomId} atingiu o número de jogadores. Começando o jogo!`);
        for (const clientUuid in roomToJoin.players) {
            send(roomToJoin.players[clientUuid], "start_game", {});
        }
    }
    return true;
}

function sendToOthers(socket, cmd, content) {
    const room = rooms.get(socket.roomId);
    if (!room) return;
    for (const clientUuid in room.players) {
        const client = room.players[clientUuid];
        if (client !== socket) {
            send(client, cmd, content);
        }
    }
}

// ========================================
// Evento disparado quando um cliente conecta
// ========================================
wss.on("connection", (socket) => {
    const uuid = uuidv4();
    socket.uuid = uuid;
    console.log(`Cliente conectado: ${uuid}`);

    send(socket, "joined_server", { uuid: uuid });

    socket.on("message", (message) => {
        let data;
        try {
            data = JSON.parse(message.toString());
        } catch (err) {
            console.error("Erro ao parsear mensagem:", err);
            return;
        }
        const content = data.content || {};

        switch (data.cmd) {
            case "create_room": {
                if (socket.roomId) {
                    send(socket, "error", { msg: "Você já está em uma sala." });
                    break;
                }
                createRoom(socket, uuid);
                break;
            }

            case "join_room": {
                if (socket.roomId) {
                    send(socket, "error", { msg: "Você já está em uma sala." });
                    break;
                }
                joinRoom(socket, uuid, content.code);
                break;
            }

            // Duel Someone: join whoever is waiting, otherwise wait to be joined
            case "find_match": {
                if (socket.roomId) {
                    send(socket, "error", { msg: "Você já está em uma sala." });
                    break;
                }
                const waiting = waitingRoom ? rooms.get(waitingRoom) : null;
                if (waiting && Object.keys(waiting.players).length === 1) {
                    const code = waitingRoom;
                    waitingRoom = null;
                    joinRoom(socket, uuid, code);
                } else {
                    waitingRoom = createRoom(socket, uuid);
                }
                break;
            }

            case "position": {
                playerlist.update(uuid, content.x, content.y);
                sendToOthers(socket, "update_position", { uuid: uuid, x: content.x, y: content.y });
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
                    for (const clientUuid in room.players) {
                        send(room.players[clientUuid], "new_chat_message", { uuid: uuid, msg: content.msg });
                    }
                }
                break;
            }
        }
    });

    socket.on("close", () => {
        console.log(`Cliente desconectado: ${uuid}`);

        playerlist.remove(uuid);

        const room = rooms.get(socket.roomId);
        if (room) {
            delete room.players[uuid];

            for (const clientUuid in room.players) {
                send(room.players[clientUuid], "player_disconnected", { uuid: uuid });
            }

            if (Object.keys(room.players).length === 0) {
                rooms.delete(socket.roomId);
                console.log(`Sala ${socket.roomId} vazia e removida.`);
            }
        }
        if (socket.roomId && waitingRoom === socket.roomId) {
            waitingRoom = null;
        }
    });
});
