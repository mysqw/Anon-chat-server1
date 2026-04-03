const WebSocket = require("ws");
const http = require("http");

const server = http.createServer();
const wss = new WebSocket.Server({ server });

// ─── State (RAM only, no DB, no logs) ────────────────────────────────────────
const rooms    = {};   // roomId → Set<ws>
const sessions = {};   // sessionId → { ws, alias, publicKey, history[], strikes }
const muted    = new Set();

// ─── Moderation config ────────────────────────────────────────────────────────
const BAD_WORDS   = ["amk", "orospu", "siktir", "piç", "göt", "oç"];
const SPAM_WINDOW = 4;    // last N messages checked
const SPAM_LIMIT  = 3;    // same msg X times → ban
const FLOOD_MS    = 800;  // min ms between messages
const MAX_LENGTH  = 500;  // max chars per message
const STRIKE_BAN  = 3;    // strikes before shadow ban

// ─── Moderation helpers ───────────────────────────────────────────────────────

function isToxic(msg) {
    const lower = msg.toLowerCase();
    return BAD_WORDS.some(w => lower.includes(w));
}

function isSpam(sid, msg) {
    const s = sessions[sid];
    if (!s) return false;
    const recent = s.history.slice(-SPAM_WINDOW);
    return recent.filter(m => m === msg).length >= SPAM_LIMIT;
}

function isFlood(sid) {
    const s = sessions[sid];
    if (!s) return false;
    const now = Date.now();
    if (s.lastMsg && (now - s.lastMsg) < FLOOD_MS) return true;
    s.lastMsg = now;
    return false;
}

function isTooLong(msg) {
    return msg.length > MAX_LENGTH;
}

function trackMsg(sid, msg) {
    const s = sessions[sid];
    if (!s) return;
    s.history.push(msg);
    if (s.history.length > 20) s.history.shift();
}

function strike(ws, sid) {
    const s = sessions[sid];
    if (!s) return;
    s.strikes = (s.strikes || 0) + 1;
    if (s.strikes >= STRIKE_BAN) {
        muted.add(ws); // shadow ban — user doesn't know
    }
}

// ─── Room helpers ─────────────────────────────────────────────────────────────

function joinRoom(ws, roomId) {
    if (!rooms[roomId]) rooms[roomId] = new Set();
    rooms[roomId].add(ws);
    ws._room = roomId;
}

function leaveRoom(ws) {
    const roomId = ws._room;
    if (roomId && rooms[roomId]) {
        rooms[roomId].delete(ws);
        if (rooms[roomId].size === 0) delete rooms[roomId];
    }
}

function broadcastRoom(roomId, payload, excludeWs = null) {
    if (!rooms[roomId]) return;
    const json = JSON.stringify(payload);
    rooms[roomId].forEach(client => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            client.send(json);
        }
    });
}

function broadcastUsersList(roomId) {
    if (!rooms[roomId]) return;
    const users = [];
    rooms[roomId].forEach(ws => {
        const s = sessions[ws._sessionId];
        if (s) users.push({ sessionId: ws._sessionId, alias: s.alias, publicKey: s.publicKey });
    });
    broadcastRoom(roomId, { type: "users", users });
}

// ─── Connection handler ───────────────────────────────────────────────────────

wss.on("connection", (ws, req) => {

    ws.on("message", (data) => {
        let parsed;
        try { parsed = JSON.parse(data.toString()); }
        catch { return; }

        const { type } = parsed;

        // ── JOIN ──────────────────────────────────────────────────────────────
        if (type === "join") {
            const { room, sessionId, alias, publicKey } = parsed;
            if (!room || !sessionId || !alias || !publicKey) return;

            ws._sessionId = sessionId;

            sessions[sessionId] = {
                ws, alias, publicKey,
                history: [], strikes: 0, lastMsg: 0
            };

            joinRoom(ws, room);

            broadcastRoom(room, { type: "system", msg: `${alias} joined` }, ws);
            broadcastUsersList(room);
            return;
        }

        // ── CHAT ──────────────────────────────────────────────────────────────
        if (type === "chat") {
            const { room, sessionId, alias, msg, msgId } = parsed;
            if (!room || !sessionId || !msg) return;

            // Shadow mute check first
            if (muted.has(ws)) return;

            // Moderation checks — each adds a strike
            if (isTooLong(msg))     { strike(ws, sessionId); return; }
            if (isFlood(sessionId)) { strike(ws, sessionId); return; }
            if (isToxic(msg))       { muted.add(ws); return; }
            if (isSpam(sessionId, msg)) { muted.add(ws); return; }

            trackMsg(sessionId, msg);

            broadcastRoom(room, { type: "chat", room, sessionId, alias, msg, msgId });
            return;
        }

        // ── DM (E2E — server only relays, never reads) ────────────────────────
        if (type === "dm") {
            const { targetId, fromId, fromAlias, encrypted, msgId } = parsed;
            if (!targetId || !fromId || !encrypted) return;

            if (muted.has(ws)) return;

            const target = sessions[targetId];
            if (!target || target.ws.readyState !== WebSocket.OPEN) return;

            target.ws.send(JSON.stringify({
                type: "dm", targetId, fromId, fromAlias, encrypted, msgId
            }));
            return;
        }
    });

    ws.on("close", () => {
        const sid = ws._sessionId;
        const room = ws._room;

        if (sid && sessions[sid]) {
            const alias = sessions[sid].alias;
            leaveRoom(ws);
            delete sessions[sid];
            muted.delete(ws);
            if (room) {
                broadcastRoom(room, { type: "system", msg: `${alias} left` });
                broadcastUsersList(room);
            }
        }
    });

    ws.on("error", () => {}); // silent
});

// ─── Railway health check ─────────────────────────────────────────────────────
server.on("request", (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200);
        res.end("ok");
    } else {
        res.writeHead(404);
        res.end();
    }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
    console.log(`NobodyKnow ws server on :${PORT}`);
});
