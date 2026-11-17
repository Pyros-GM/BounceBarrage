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
//  - GET /time: the server's clock, so the daily streak / challenge can't be farmed by
//    changing the phone's date
//  - POST /verify: checks a Google Play coin purchase with Google before the game pays it
//    out (needs GOOGLE_SERVICE_ACCOUNT_JSON; see verifyPurchase below)
//  - GET /events: events.json (holiday dates, a skipped event, a sale), so they can change
//    without a game update; the game has its own built-in calendar (events.gd)
//  - hardening: 16 KB message limit, a ping every 15 s that drops connections that don't
//    answer, and per-connection rate limits on messages and chat
// ========================

const express = require("express");
const WebSocket = require("ws");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 9090;
app.set("trust proxy", 1);  // Render's proxy: req.ip is the player's real address

app.get("/", (req, res) => res.type("text/plain").send("ok"));
app.get("/time", (req, res) => res.json({ now: Date.now() }));

// Holiday events: events.json next to this file. Edit it on GitHub and Render redeploys.
// Format (all optional; dates are the player's calendar days, both ends included):
//   {"events": {"winter": {"start": "2026-12-10", "end": "2027-01-06"}, "summer": {"off": true}},
//    "sale": {"percent": 20, "start": "2026-11-27", "end": "2026-11-30"}}
// Unreadable or missing: {} (the game uses its built-in dates).
const fs = require("fs");
const path = require("path");
app.get("/events", (req, res) => {
    try {
        res.json(JSON.parse(fs.readFileSync(path.join(__dirname, "events.json"), "utf8")));
    } catch (e) {
        res.json({});
    }
});

const server = app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

const MAX_PAYLOAD = 16 * 1024;          // bytes; the biggest game message is well under 1 KB
const HEARTBEAT_MS = 15000;             // ping every 15 s; no answer by the next ping = gone
const RATE_WINDOW_MS = 1000;
const RATE_MAX = 150;                   // messages per second per connection (a duel sends ~70)
const RATE_KICK = 600;                  // this many in one second: drop the connection
const CHAT_WINDOW_MS = 10000;
const CHAT_MAX = 5;                     // chat messages per 10 s
const CHAT_MAX_LEN = 200;

const wss = new WebSocket.Server({ server, maxPayload: MAX_PAYLOAD });

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

// ----------------------------------------------------------------
// Rate limits
// ----------------------------------------------------------------
// true if this socket may send another message now; drops the connection if it floods.
function allowMessage(socket) {
    if (socket.dropped) return false;
    const now = Date.now();
    if (now - socket.rateStart >= RATE_WINDOW_MS) {
        socket.rateStart = now;
        socket.rateCount = 0;
    }
    socket.rateCount++;
    if (socket.rateCount > RATE_KICK) {
        console.warn(`Dropping ${socket.uuid}: ${socket.rateCount} messages in a second`);
        socket.dropped = true;
        socket.terminate();
        return false;
    }
    return socket.rateCount <= RATE_MAX;
}

function allowChat(socket) {
    const now = Date.now();
    socket.chatTimes = socket.chatTimes.filter(t => now - t < CHAT_WINDOW_MS);
    if (socket.chatTimes.length >= CHAT_MAX) return false;
    socket.chatTimes.push(now);
    return true;
}

// ========================================
// A client connected
// ========================================
wss.on("connection", (socket) => {
    socket.uuid = uuidv4();
    socket.isAlive = true;
    socket.rateStart = Date.now();
    socket.rateCount = 0;
    socket.chatTimes = [];
    socket.on("pong", () => { socket.isAlive = true; });
    console.log(`Client connected: ${socket.uuid}`);

    send(socket, "joined_server", { uuid: socket.uuid });

    socket.on("message", (message) => {
        if (!allowMessage(socket)) return;
        let data;
        try {
            data = JSON.parse(message.toString());
        } catch (err) {
            console.error("Could not parse message:", err.message);
            return;
        }
        if (!data || typeof data !== "object") return;
        const content = (data.content && typeof data.content === "object") ? data.content : {};

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
                const queue = String(content.v ?? 0).slice(0, 40);
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
                const x = Number(content.x), y = Number(content.y);
                if (!Number.isFinite(x) || !Number.isFinite(y)) break;
                playerlist.update(socket.uuid, x, y);
                sendToOthers(socket, "update_position", { uuid: socket.uuid, x, y });
                break;
            }

            // Forwards an arbitrary payload to the other player in the room
            case "relay": {
                sendToOthers(socket, "relay", content);
                break;
            }

            case "chat": {
                if (!allowChat(socket)) break;
                const room = rooms.get(socket.roomId);
                if (room) {
                    const msg = String(content.msg ?? "").slice(0, CHAT_MAX_LEN);
                    for (const id in room.players) send(room.players[id], "new_chat_message", { uuid: socket.uuid, msg });
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

    socket.on("error", (err) => console.warn(`Socket error ${socket.uuid}: ${err.message}`));
});

// Heartbeat: a phone that lost signal never closes its connection. Ping everyone; whoever
// didn't answer the last ping is gone (the close handler then frees their spot / room).
const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
        if (!socket.isAlive) {
            socket.terminate();
            continue;
        }
        socket.isAlive = false;
        try { socket.ping(); } catch (e) { /* closing anyway */ }
    }
}, HEARTBEAT_MS);
wss.on("close", () => clearInterval(heartbeat));

// ----------------------------------------------------------------
// Google Play purchase check (POST /verify)
// ----------------------------------------------------------------
// Setup (once): a Google Cloud service account with the "Google Play Android Developer API"
// enabled, invited in the Play Console (Users and permissions) with access to this app's
// financial data / orders. Put its whole JSON key in the GOOGLE_SERVICE_ACCOUNT_JSON
// environment variable on Render.
// Until that variable is set, /verify answers {ok: true, verified: false} so coin purchases
// keep working; once it's set, every purchase is checked with Google.
const PACKAGE_NAME = process.env.PACKAGE_NAME || "com.eternalt.bouncebarrage";
const COIN_PRODUCTS = new Set(["starter_pack", "coins_500", "coins_1200", "coins_3000", "coins_7000"]);
let serviceAccount = null;
try {
    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
} catch (e) {
    console.error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON:", e.message);
}
console.log(serviceAccount ? "Purchase checks: ON" : "Purchase checks: OFF (GOOGLE_SERVICE_ACCOUNT_JSON not set)");

let googleToken = null;
let googleTokenExpires = 0;

function base64url(input) {
    return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// An OAuth access token for the service account (cached until shortly before it expires).
async function getGoogleToken() {
    if (googleToken && Date.now() < googleTokenExpires - 60000) return googleToken;
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = base64url(JSON.stringify({
        iss: serviceAccount.client_email,
        scope: "https://www.googleapis.com/auth/androidpublisher",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
    }));
    const signer = crypto.createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    const signature = signer.sign(serviceAccount.private_key).toString("base64")
        .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion: `${header}.${claims}.${signature}`,
        }),
    });
    if (!res.ok) throw new Error(`token request failed: ${res.status} ${await res.text()}`);
    const body = await res.json();
    googleToken = body.access_token;
    googleTokenExpires = Date.now() + Number(body.expires_in || 3600) * 1000;
    return googleToken;
}

// Small per-address limit on /verify.
const verifyHits = new Map();
function allowVerify(ip) {
    const now = Date.now();
    const hits = (verifyHits.get(ip) || []).filter(t => now - t < 60000);
    if (hits.length >= 20) { verifyHits.set(ip, hits); return false; }
    hits.push(now);
    verifyHits.set(ip, hits);
    return true;
}
setInterval(() => {
    const now = Date.now();
    for (const [ip, hits] of verifyHits) if (!hits.some(t => now - t < 60000)) verifyHits.delete(ip);
}, 60000);

// Answers: {ok: true, verified: true}            paid, not used yet: give the coins
//          {ok: true, verified: false}           checks not set up yet (see above)
//          {ok: false, reason: "pending"}        payment not finished yet
//          {ok: false, reason: "already_used"}   this purchase was already paid out
//          {ok: false, reason: "invalid"}        Google doesn't know it / it was cancelled
//          {ok: false, reason: "retry"}          couldn't ask Google right now (HTTP 502)
app.post("/verify", express.json({ limit: "4kb" }), async (req, res) => {
    if (!allowVerify(req.ip)) return res.status(429).json({ ok: false, reason: "retry" });
    const productId = String((req.body && req.body.product_id) || "");
    const token = String((req.body && req.body.token) || "");
    if (!COIN_PRODUCTS.has(productId) || token.length < 10 || token.length > 1000) {
        return res.status(400).json({ ok: false, reason: "invalid" });
    }
    if (!serviceAccount) return res.json({ ok: true, verified: false });
    try {
        const accessToken = await getGoogleToken();
        const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(PACKAGE_NAME)}` +
            `/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}`;
        const g = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (g.status === 400 || g.status === 404 || g.status === 410) {
            return res.json({ ok: false, reason: "invalid" });
        }
        if (!g.ok) {
            console.error(`Purchase check failed: ${g.status} ${await g.text()}`);
            return res.status(502).json({ ok: false, reason: "retry" });
        }
        const p = await g.json();
        // purchaseState: 0 purchased, 1 cancelled, 2 pending. consumptionState: 0 not yet, 1 consumed.
        if (p.purchaseState === 2) return res.json({ ok: false, reason: "pending" });
        if (p.purchaseState !== 0) return res.json({ ok: false, reason: "invalid" });
        if (p.consumptionState === 1) return res.json({ ok: false, reason: "already_used" });
        console.log(`Purchase OK: ${productId}${p.purchaseType === 0 ? " (test)" : ""}`);
        return res.json({ ok: true, verified: true });
    } catch (e) {
        console.error("Purchase check error:", e.message);
        return res.status(502).json({ ok: false, reason: "retry" });
    }
});
