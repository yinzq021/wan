const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const START_TIME = Date.now();

// ==================== 内存状态管理 ====================
const clients = new Map(); // clientId -> { id, socket, nick, roomId, game, isAlive }
const rooms = new Map();   // roomId -> { id, game, hostId, guestId, createdAt, status }
const globalChatHistory = []; // 保留最近 50 条全局聊天记录
const MAX_CHAT_HISTORY = 50;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// ==================== HTTP 服务与保活接口 ====================
const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  // 保活专用健康检查接口（供 UptimeRobot / cron-job / 自检调用）
  if (urlPath === '/health' || urlPath === '/ping' || urlPath === '/keepalive') {
    const payload = {
      status: 'ok',
      service: '我的游戏空间',
      uptimeSeconds: Math.floor((Date.now() - START_TIME) / 1000),
      onlineUsers: clients.size,
      activeRooms: rooms.size,
      timestamp: new Date().toISOString()
    };
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(payload));
    return;
  }

  // 静态文件服务
  let filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA 回退到 index.html
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, indexData) => {
        if (err2) {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(indexData);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ==================== 原生 RFC 6455 WebSocket 实现 ====================
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeWsFrame(str, opcode = 0x1) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function sendToClient(client, obj) {
  if (!client || client.socket.destroyed || !client.socket.writable) return;
  try {
    client.socket.write(encodeWsFrame(JSON.stringify(obj)));
  } catch (e) {
    // ignore write error on closing socket
  }
}

function broadcastAll(obj, excludeId = null) {
  const frame = encodeWsFrame(JSON.stringify(obj));
  for (const [id, c] of clients.entries()) {
    if (id !== excludeId && !c.socket.destroyed && c.socket.writable) {
      try {
        c.socket.write(frame);
      } catch (e) {}
    }
  }
}

function broadcastRoomList() {
  const openRooms = [];
  for (const r of rooms.values()) {
    if (r.status === 'waiting') {
      const host = clients.get(r.hostId);
      openRooms.push({
        id: r.id,
        game: r.game,
        hostNick: host ? host.nick : '玩家',
        createdAt: r.createdAt
      });
    }
  }
  broadcastAll({ type: 'room_list', rooms: openRooms });
}

function broadcastStats() {
  broadcastAll({
    type: 'stats',
    onlineCount: clients.size,
    roomCount: rooms.size
  });
}

function cleanupClientRoom(client) {
  if (!client.roomId) return;
  const room = rooms.get(client.roomId);
  const oldRoomId = client.roomId;
  client.roomId = null;
  if (!room) return;

  const otherId = room.hostId === client.id ? room.guestId : room.hostId;
  const other = otherId ? clients.get(otherId) : null;
  if (other) {
    other.roomId = null;
    sendToClient(other, {
      type: 'opponent_left',
      roomId: oldRoomId,
      nick: client.nick
    });
  }
  rooms.delete(oldRoomId);
  broadcastRoomList();
  broadcastStats();
}

function generateRoomId() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms.has(code));
  return code;
}

function handleWsMessage(client, rawText) {
  let msg;
  try {
    msg = JSON.parse(rawText);
  } catch (e) {
    return;
  }

  switch (msg.type) {
    case 'ping': {
      client.isAlive = true;
      sendToClient(client, { type: 'pong', ts: Date.now() });
      break;
    }

    case 'set_nick': {
      const clean = String(msg.nick || '').trim().slice(0, 16);
      if (clean) {
        client.nick = clean;
        sendToClient(client, { type: 'nick_updated', nick: client.nick });
      }
      break;
    }

    case 'set_game': {
      client.game = String(msg.game || 'lobby');
      break;
    }

    case 'chat_global': {
      const text = String(msg.text || '').trim().slice(0, 300);
      if (!text) return;
      const chatItem = {
        id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
        senderId: client.id,
        nick: client.nick,
        game: msg.game || client.game || 'lobby',
        text,
        time: new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
      };
      globalChatHistory.push(chatItem);
      if (globalChatHistory.length > MAX_CHAT_HISTORY) {
        globalChatHistory.shift();
      }
      broadcastAll({ type: 'chat_global', message: chatItem });
      break;
    }

    case 'chat_room': {
      if (!client.roomId) return;
      const room = rooms.get(client.roomId);
      if (!room) return;
      const text = String(msg.text || '').trim().slice(0, 300);
      if (!text) return;
      const chatItem = {
        senderId: client.id,
        nick: client.nick,
        text,
        time: new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
      };
      const host = clients.get(room.hostId);
      const guest = room.guestId ? clients.get(room.guestId) : null;
      if (host) sendToClient(host, { type: 'chat_room', message: chatItem });
      if (guest) sendToClient(guest, { type: 'chat_room', message: chatItem });
      break;
    }

    case 'create_room': {
      cleanupClientRoom(client);
      const game = String(msg.game || 'gomoku');
      const roomId = generateRoomId();
      const room = {
        id: roomId,
        game,
        hostId: client.id,
        guestId: null,
        status: 'waiting',
        createdAt: Date.now()
      };
      rooms.set(roomId, room);
      client.roomId = roomId;
      client.game = game;
      sendToClient(client, {
        type: 'room_created',
        roomId,
        game,
        role: 'host'
      });
      broadcastRoomList();
      broadcastStats();
      break;
    }

    case 'join_room': {
      const roomId = String(msg.roomId || '').trim();
      const room = rooms.get(roomId);
      if (!room) {
        sendToClient(client, { type: 'room_error', error: '房间不存在或已解散' });
        return;
      }
      if (room.game !== msg.game) {
        sendToClient(client, { type: 'room_error', error: `该房间是「${room.game}」房间，请切换到对应游戏加入` });
        return;
      }
      if (room.guestId || room.status !== 'waiting') {
        sendToClient(client, { type: 'room_error', error: '房间已满' });
        return;
      }
      if (room.hostId === client.id) {
        sendToClient(client, { type: 'room_error', error: '你已在该房间中' });
        return;
      }

      cleanupClientRoom(client);
      room.guestId = client.id;
      room.status = 'playing';
      client.roomId = roomId;
      client.game = room.game;

      const host = clients.get(room.hostId);
      sendToClient(client, {
        type: 'room_joined',
        roomId,
        game: room.game,
        role: 'guest',
        opponentNick: host ? host.nick : '房主'
      });
      if (host) {
        sendToClient(host, {
          type: 'opponent_joined',
          roomId,
          game: room.game,
          role: 'host',
          opponentNick: client.nick
        });
      }
      broadcastRoomList();
      broadcastStats();
      break;
    }

    case 'leave_room': {
      cleanupClientRoom(client);
      break;
    }

    case 'game_action': {
      if (!client.roomId) return;
      const room = rooms.get(client.roomId);
      if (!room) return;
      const targetId = room.hostId === client.id ? room.guestId : room.hostId;
      if (!targetId) return;
      const target = clients.get(targetId);
      if (target) {
        sendToClient(target, {
          type: 'game_action',
          game: room.game,
          action: msg.action,
          data: msg.data,
          fromNick: client.nick
        });
      }
      break;
    }

    default:
      break;
  }
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return;
  }
  const acceptKey = crypto
    .createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');

  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '\r\n'
    ].join('\r\n')
  );

  const clientId = crypto.randomBytes(6).toString('hex');
  const defaultNick = `玩家_${Math.floor(1000 + Math.random() * 9000)}`;
  const client = {
    id: clientId,
    socket,
    nick: defaultNick,
    roomId: null,
    game: 'lobby',
    isAlive: true
  };
  clients.set(clientId, client);

  // 发送初始化信息（自身ID、默认昵称、历史公屏消息、开放房间列表）
  const openRooms = [];
  for (const r of rooms.values()) {
    if (r.status === 'waiting') {
      const h = clients.get(r.hostId);
      openRooms.push({ id: r.id, game: r.game, hostNick: h ? h.nick : '玩家', createdAt: r.createdAt });
    }
  }
  sendToClient(client, {
    type: 'welcome',
    id: clientId,
    nick: defaultNick,
    onlineCount: clients.size,
    roomCount: rooms.size,
    chatHistory: globalChatHistory,
    rooms: openRooms
  });
  broadcastStats();

  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const firstByte = buffer[0];
      const secondByte = buffer[1];
      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (buffer.length < 4) break;
        payloadLen = buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (buffer.length < 10) break;
        payloadLen = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = isMasked ? 4 : 0;
      if (buffer.length < offset + maskLen + payloadLen) break;

      let payload = buffer.subarray(offset + maskLen, offset + maskLen + payloadLen);
      if (isMasked) {
        const mask = buffer.subarray(offset, offset + 4);
        const unmasked = Buffer.alloc(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
          unmasked[i] = payload[i] ^ mask[i % 4];
        }
        payload = unmasked;
      }

      buffer = buffer.subarray(offset + maskLen + payloadLen);
      client.isAlive = true;

      if (opcode === 0x8) {
        // Close frame
        socket.end();
        return;
      } else if (opcode === 0x9) {
        // Ping -> Pong
        socket.write(encodeWsFrame(payload.toString('utf8'), 0xA));
      } else if (opcode === 0xA) {
        // Pong
        client.isAlive = true;
      } else if (opcode === 0x1) {
        // Text frame
        handleWsMessage(client, payload.toString('utf8'));
      }
    }
  });

  const onClose = () => {
    cleanupClientRoom(client);
    clients.delete(clientId);
    broadcastStats();
  };

  socket.on('close', onClose);
  socket.on('error', onClose);
});

// ==================== WebSocket 心跳保活检测 ====================
setInterval(() => {
  for (const [id, c] of clients.entries()) {
    if (!c.isAlive) {
      c.socket.destroy();
      cleanupClientRoom(c);
      clients.delete(id);
      continue;
    }
    c.isAlive = false;
    try {
      c.socket.write(Buffer.from([0x89, 0x00])); // WebSocket Ping frame
    } catch (e) {}
  }
}, 25000);

// ==================== Render / 云平台自唤醒保活代码 ====================
const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL || '';
if (KEEP_ALIVE_URL) {
  const pingTarget = KEEP_ALIVE_URL.replace(/\/+$/, '') + '/ping';
  const requester = pingTarget.startsWith('https') ? https : http;
  console.log(`[保活模块] 已启用定时自唤醒，目标: ${pingTarget} (每 10 分钟一次)`);
  setInterval(() => {
    requester.get(pingTarget, (res) => {
      res.resume();
      console.log(`[保活模块] Ping ${pingTarget} -> HTTP ${res.statusCode}`);
    }).on('error', (err) => {
      console.warn(`[保活模块] Ping 失败: ${err.message}`);
    });
  }, 10 * 60 * 1000);
} else {
  console.log('[保活模块] /ping 与 /health 接口已就绪；如需服务端自唤醒，可设置环境变量 KEEP_ALIVE_URL 或 RENDER_EXTERNAL_URL');
}

server.listen(PORT, () => {
  console.log(`我的游戏空间 服务器已启动: http://localhost:${PORT}`);
});
