const { WebSocketServer } = require('ws');

const rooms = new Map(); // sheetId -> Set<ws>
let allClients = new Set();

function attach(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.sheetId = null;
    ws.presence = null;
    allClients.add(ws);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch (e) { return; }

      if (msg.type === 'join') {
        leaveRoom(ws);
        ws.sheetId = msg.sheetId;
        ws.presence = { name: msg.name || 'Guest', color: msg.color || '#888' };
        if (!rooms.has(ws.sheetId)) rooms.set(ws.sheetId, new Set());
        rooms.get(ws.sheetId).add(ws);
        broadcastPresence(ws.sheetId);
      } else if (msg.type === 'presence') {
        ws.presence = Object.assign({}, ws.presence, msg.patch || {});
        if (ws.sheetId) broadcastPresence(ws.sheetId);
      }
    });

    ws.on('close', () => {
      allClients.delete(ws);
      const sheetId = ws.sheetId;
      leaveRoom(ws);
      if (sheetId) broadcastPresence(sheetId);
    });
  });

  return wss;
}

function leaveRoom(ws) {
  if (ws.sheetId && rooms.has(ws.sheetId)) {
    rooms.get(ws.sheetId).delete(ws);
    if (rooms.get(ws.sheetId).size === 0) rooms.delete(ws.sheetId);
  }
}

function broadcastPresence(sheetId) {
  const set = rooms.get(sheetId);
  if (!set) return;
  const peers = Array.from(set).map((c) => c.presence).filter(Boolean);
  broadcast(sheetId, { type: 'presence', peers });
}

function broadcast(sheetId, message, exclude) {
  const set = rooms.get(sheetId);
  if (!set) return;
  const payload = JSON.stringify(message);
  set.forEach((client) => {
    if (client !== exclude && client.readyState === 1) client.send(payload);
  });
}

function broadcastAll(message, exclude) {
  const payload = JSON.stringify(message);
  allClients.forEach((client) => {
    if (client !== exclude && client.readyState === 1) client.send(payload);
  });
}

module.exports = { attach, broadcast, broadcastAll };
