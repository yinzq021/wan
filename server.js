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
const chatHistories = {
  global: [],   // 第一分页：我的游戏空间公屏
  finance: [],  // 第二分页：我的财经独立聊天
  ai: []        // 第三分页：AI技术前沿独立聊天
};
const MAX_CHAT_HISTORY = 50;

// ==================== 第二、三分页定时抓取缓存 ====================
const SCHEDULE_HOURS_BJT = ['08:30', '12:00', '15:30', '21:00']; // 北京时间每日固定更新时间点
let lastScheduledSlot = '';

const portalCache = {
  lastUpdated: '初始化中...',
  nextSchedule: '08:30 / 12:00 / 15:30 / 21:00 (北京时间)',
  finance: {
    stocks: [
      { name: '上证指数', symbol: '000001.SS', price: '--', change: '--', region: '国内' },
      { name: '深证成指', symbol: '399001.SZ', price: '--', change: '--', region: '国内' },
      { name: '恒生指数', symbol: '^HSI', price: '--', change: '--', region: '港股' },
      { name: '纳斯达克', symbol: '^IXIC', price: '--', change: '--', region: '美股' },
      { name: '标普 500', symbol: '^GSPC', price: '--', change: '--', region: '美股' },
      { name: '道琼斯', symbol: '^DJI', price: '--', change: '--', region: '美股' }
    ],
    futures: [
      { name: 'COMEX 黄金', symbol: 'GC=F', price: '--', change: '--' },
      { name: 'WTI 原油', symbol: 'CL=F', price: '--', change: '--' },
      { name: 'COMEX 铜', symbol: 'HG=F', price: '--', change: '--' },
      { name: 'COMEX 白银', symbol: 'SI=F', price: '--', change: '--' }
    ],
    forex: [
      { name: '美元/人民币', symbol: 'USDCNY=X', price: '--', change: '--' },
      { name: '欧元/美元', symbol: 'EURUSD=X', price: '--', change: '--' },
      { name: '美元指数', symbol: 'DX-Y.NYB', price: '--', change: '--' },
      { name: '美元/日元', symbol: 'USDJPY=X', price: '--', change: '--' }
    ],
    news: []
  },
  ai: {
    news: [],
    forums: []
  }
};

function getBjtNow() {
  const now = new Date();
  const bjtMs = now.getTime() + 8 * 3600 * 1000;
  const d = new Date(bjtMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return { dateStr: `${yyyy}-${mm}-${dd}`, hm: `${hh}:${mi}`, full: `${yyyy}-${mm}-${dd} ${hh}:${mi} BJT` };
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'MyGameSpaceBot/1.0' },
    signal: AbortSignal.timeout(7000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'MyGameSpaceBot/1.0' },
    signal: AbortSignal.timeout(7000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function parseRssItems(xml, sourceName, limit = 8) {
  const items = [];
  const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) && items.length < limit) {
    const block = m[1];
    const getTag = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i');
      const mm = block.match(r);
      return mm ? mm[1].replace(/<[^>]+>/g, '').trim() : '';
    };
    const title = getTag('title');
    const link = getTag('link');
    const pubDate = getTag('pubDate');
    if (title && link) {
      items.push({ title, url: link, source: sourceName, time: pubDate ? pubDate.slice(0, 16) : '' });
    }
  }
  return items;
}

async function fetchYahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;
  const data = await fetchJson(url);
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta || typeof meta.regularMarketPrice !== 'number') return null;
  const price = meta.regularMarketPrice;
  const prev = meta.chartPreviousClose || meta.previousClose || price;
  const pct = prev ? ((price - prev) / prev) * 100 : 0;
  return {
    price: price >= 100 ? price.toFixed(2) : price.toFixed(4),
    change: `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`,
    up: pct >= 0
  };
}

async function refreshPortalData(reason = 'manual') {
  console.log(`[定时资讯] 开始刷新财经与 AI 前沿数据 (${reason})...`);
  const allQuoteItems = [
    ...portalCache.finance.stocks,
    ...portalCache.finance.futures,
    ...portalCache.finance.forex
  ];

  // 并发抓取股市/期市/汇市行情
  await Promise.allSettled(
    allQuoteItems.map(async (item) => {
      try {
        const q = await fetchYahooQuote(item.symbol);
        if (q) {
          item.price = q.price;
          item.change = q.change;
          item.up = q.up;
        }
      } catch (e) {}
    })
  );

  // 抓取财经媒体热门新闻 (Yahoo Finance RSS + CNBC RSS)
  const finNews = [];
  for (const feed of [
    { url: 'https://finance.yahoo.com/news/rssindex', name: 'Yahoo Finance' },
    { url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', name: 'CNBC 财经' }
  ]) {
    try {
      const xml = await fetchText(feed.url);
      finNews.push(...parseRssItems(xml, feed.name, 6));
    } catch (e) {}
  }
  if (finNews.length > 0) portalCache.finance.news = finNews.slice(0, 12);

  // 抓取 AI 技术前沿资讯 (arXiv cs.AI + HuggingFace/OpenAI/TechCrunch AI RSS)
  const aiNews = [];
  for (const feed of [
    { url: 'https://techcrunch.com/category/artificial-intelligence/feed/', name: 'TechCrunch AI' },
    { url: 'https://export.arxiv.org/rss/cs.AI', name: 'arXiv cs.AI' }
  ]) {
    try {
      const xml = await fetchText(feed.url);
      aiNews.push(...parseRssItems(xml, feed.name, 6));
    } catch (e) {}
  }
  if (aiNews.length > 0) portalCache.ai.news = aiNews.slice(0, 12);

  // 抓取各论坛高点击文章 (Hacker News Top Stories + Reddit r/LocalLLaMA)
  const forumPosts = [];
  try {
    const ids = await fetchJson('https://hacker-news.firebaseio.com/v0/topstories.json');
    const topIds = (ids || []).slice(0, 18);
    const stories = await Promise.allSettled(
      topIds.map(id => fetchJson(`https://hacker-news.firebaseio.com/v0/item/${id}.json`))
    );
    stories.forEach(s => {
      if (s.status === 'fulfilled' && s.value && s.value.title) {
        const st = s.value;
        forumPosts.push({
          title: st.title,
          url: st.url || `https://news.ycombinator.com/item?id=${st.id}`,
          source: 'Hacker News',
          score: st.score || 0,
          comments: st.descendants || 0
        });
      }
    });
  } catch (e) {}

  try {
    const rd = await fetchJson('https://www.reddit.com/r/LocalLLaMA/hot.json?limit=8');
    const children = rd?.data?.children || [];
    children.forEach(c => {
      const d = c.data;
      if (d && d.title && !d.stickied) {
        forumPosts.push({
          title: d.title,
          url: `https://www.reddit.com${d.permalink}`,
          source: 'Reddit r/LocalLLaMA',
          score: d.ups || 0,
          comments: d.num_comments || 0
        });
      }
    });
  } catch (e) {}

  if (forumPosts.length > 0) {
    forumPosts.sort((a, b) => (b.score || 0) - (a.score || 0));
    portalCache.ai.forums = forumPosts.slice(0, 14);
  }

  portalCache.lastUpdated = getBjtNow().full;
  console.log(`[定时资讯] 刷新完成，时间: ${portalCache.lastUpdated}`);
}

// 每分钟检查是否到达每日固定更新时间点 (08:30, 12:00, 15:30, 21:00 BJT)
setInterval(() => {
  const { dateStr, hm } = getBjtNow();
  if (SCHEDULE_HOURS_BJT.includes(hm)) {
    const slotKey = `${dateStr}_${hm}`;
    if (lastScheduledSlot !== slotKey) {
      lastScheduledSlot = slotKey;
      refreshPortalData(`定时 ${hm} BJT`);
    }
  }
}, 30 * 1000);

// 启动后立即拉取一次
setTimeout(() => refreshPortalData('startup'), 500);

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
const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || '/').split('?')[0];

  // 保活专用健康检查接口
  if (urlPath === '/health' || urlPath === '/ping' || urlPath === '/keepalive') {
    const payload = {
      status: 'ok',
      service: '我的游戏空间',
      uptimeSeconds: Math.floor((Date.now() - START_TIME) / 1000),
      onlineUsers: clients.size,
      activeRooms: rooms.size,
      timestamp: new Date().toISOString()
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
    return;
  }

  // 财经与 AI 资讯缓存接口
  if (urlPath === '/api/portal') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(portalCache));
    return;
  }

  if (urlPath === '/api/portal/refresh') {
    await refreshPortalData('manual');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(portalCache));
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
  } catch (e) {}
}

function broadcastAll(obj, excludeId = null) {
  const frame = encodeWsFrame(JSON.stringify(obj));
  for (const [id, c] of clients.entries()) {
    if (id !== excludeId && !c.socket.destroyed && c.socket.writable) {
      try { c.socket.write(frame); } catch (e) {}
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
    sendToClient(other, { type: 'opponent_left', roomId: oldRoomId, nick: client.nick });
  }
  rooms.delete(oldRoomId);
  broadcastRoomList();
  broadcastStats();
}

function generateRoomId() {
  let code;
  do { code = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(code));
  return code;
}

function handleWsMessage(client, rawText) {
  let msg;
  try { msg = JSON.parse(rawText); } catch (e) { return; }

  switch (msg.type) {
    case 'ping':
      client.isAlive = true;
      sendToClient(client, { type: 'pong', ts: Date.now() });
      break;

    case 'set_nick': {
      const clean = String(msg.nick || '').trim().slice(0, 16);
      if (clean) {
        client.nick = clean;
        sendToClient(client, { type: 'nick_updated', nick: client.nick });
      }
      break;
    }

    case 'set_game':
      client.game = String(msg.game || 'lobby');
      break;

    case 'chat_channel': {
      const ch = ['global', 'finance', 'ai'].includes(msg.channel) ? msg.channel : 'global';
      const text = String(msg.text || '').trim().slice(0, 300);
      if (!text) return;
      const chatItem = {
        id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
        senderId: client.id,
        nick: client.nick,
        game: ch === 'global' ? (msg.game || client.game || 'lobby') : ch,
        text,
        time: new Date().toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
      };
      chatHistories[ch].push(chatItem);
      if (chatHistories[ch].length > MAX_CHAT_HISTORY) chatHistories[ch].shift();
      broadcastAll({ type: 'chat_channel', channel: ch, message: chatItem });
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
      chatHistories.global.push(chatItem);
      if (chatHistories.global.length > MAX_CHAT_HISTORY) chatHistories.global.shift();
      broadcastAll({ type: 'chat_channel', channel: 'global', message: chatItem });
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
      rooms.set(roomId, { id: roomId, game, hostId: client.id, guestId: null, status: 'waiting', createdAt: Date.now() });
      client.roomId = roomId;
      client.game = game;
      sendToClient(client, { type: 'room_created', roomId, game, role: 'host' });
      broadcastRoomList();
      broadcastStats();
      break;
    }

    case 'join_room': {
      const roomId = String(msg.roomId || '').trim();
      const room = rooms.get(roomId);
      if (!room) { sendToClient(client, { type: 'room_error', error: '房间不存在或已解散' }); return; }
      if (room.game !== msg.game) { sendToClient(client, { type: 'room_error', error: `该房间是「${room.game}」房间` }); return; }
      if (room.guestId || room.status !== 'waiting') { sendToClient(client, { type: 'room_error', error: '房间已满' }); return; }
      if (room.hostId === client.id) { sendToClient(client, { type: 'room_error', error: '你已在该房间中' }); return; }

      cleanupClientRoom(client);
      room.guestId = client.id;
      room.status = 'playing';
      client.roomId = roomId;
      client.game = room.game;

      const host = clients.get(room.hostId);
      sendToClient(client, { type: 'room_joined', roomId, game: room.game, role: 'guest', opponentNick: host ? host.nick : '房主' });
      if (host) sendToClient(host, { type: 'opponent_joined', roomId, game: room.game, role: 'host', opponentNick: client.nick });
      broadcastRoomList();
      broadcastStats();
      break;
    }

    case 'leave_room':
      cleanupClientRoom(client);
      break;

    case 'game_action': {
      if (!client.roomId) return;
      const room = rooms.get(client.roomId);
      if (!room) return;
      const targetId = room.hostId === client.id ? room.guestId : room.hostId;
      if (!targetId) return;
      const target = clients.get(targetId);
      if (target) sendToClient(target, { type: 'game_action', game: room.game, action: msg.action, data: msg.data, fromNick: client.nick });
      break;
    }
  }
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const acceptKey = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey}`,
    '\r\n'
  ].join('\r\n'));

  const clientId = crypto.randomBytes(6).toString('hex');
  const defaultNick = `玩家_${Math.floor(1000 + Math.random() * 9000)}`;
  const client = { id: clientId, socket, nick: defaultNick, roomId: null, game: 'lobby', isAlive: true };
  clients.set(clientId, client);

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
    chatHistories,
    rooms: openRooms
  });
  broadcastStats();

  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      const isMasked = (buffer[1] & 0x80) !== 0;
      let payloadLen = buffer[1] & 0x7f;
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
        for (let i = 0; i < payloadLen; i++) unmasked[i] = payload[i] ^ mask[i % 4];
        payload = unmasked;
      }
      buffer = buffer.subarray(offset + maskLen + payloadLen);
      client.isAlive = true;
      if (opcode === 0x8) { socket.end(); return; }
      else if (opcode === 0x9) socket.write(encodeWsFrame(payload.toString('utf8'), 0xA));
      else if (opcode === 0x1) handleWsMessage(client, payload.toString('utf8'));
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

setInterval(() => {
  for (const [id, c] of clients.entries()) {
    if (!c.isAlive) { c.socket.destroy(); cleanupClientRoom(c); clients.delete(id); continue; }
    c.isAlive = false;
    try { c.socket.write(Buffer.from([0x89, 0x00])); } catch (e) {}
  }
}, 25000);

const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL || '';
if (KEEP_ALIVE_URL) {
  const pingTarget = KEEP_ALIVE_URL.replace(/\/+$/, '') + '/ping';
  const requester = pingTarget.startsWith('https') ? https : http;
  setInterval(() => {
    requester.get(pingTarget, (res) => { res.resume(); }).on('error', () => {});
  }, 10 * 60 * 1000);
}

server.listen(PORT, () => {
  console.log(`我的游戏空间 服务器已启动: http://localhost:${PORT}`);
});
