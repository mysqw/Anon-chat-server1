const WebSocket = require("ws");

const wss = new WebSocket.Server({ port: process.env.PORT || 3000 });

let muted = new Set();

wss.on("connection", (ws) => {

    ws.on("message", (data) => {
        try {
            const { room, msg } = JSON.parse(data.toString());

            if (isToxic(msg)) {
                muted.add(ws);
                return;
            }

            if (muted.has(ws)) return;

            broadcast(msg);

        } catch (e) {}
    });

});

function isToxic(msg) {
    const bad = ["amk", "orospu", "siktir"];
    return bad.some(w => msg.toLowerCase().includes(w));
}

function broadcast(msg) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ msg }));
        }
    });
}