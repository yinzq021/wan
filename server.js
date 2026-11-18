const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const START_TIME = Date.now();

// ==================== 内存状态管理 ====================
const clients = new Map();
const rooms = new Map();
const chatHistories = {
  global: [],
  finance: [],
  ai: []
};
const MAX_CHAT_HISTORY = 50;

// ==================== 第二、三分页定时抓取缓存 ====================
const SCHEDULE_HOURS_BJT = ['08:30', '12:00', '15:30', '21:00'];
let lastScheduledSlot = '';

const portalCache = {
  lastUpdated: '初始化中...',
  nextSchedule: '08:30 / 12:00 / 15:30 / 21:00 (北京时间)',
  finance: {
    stocks: [
      { name: '上证指数', symbol: '000001.SS', price: '--', change: '--' },
      { name: '深证成指', symbol: '399001.SZ', price: '--', change: '--' },
      { name: '恒生指数', symbol: '^HSI', price: '--', change: '--' },
      { name: '纳斯达克', symbol: '^IXIC', price: '--', change: '--' },
      { name: '标普 500', symbol: '^GSPC', price: '--', change: '--' },
      { name: '道琼斯', symbol: '^DJI', price: '--', change: '--' }
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
    mediaGroups: [], // 东方财富网、新浪财经、微博、今日头条（每站>=5条）
    forumGroups: []  // 雪球、东方财富股吧、集思录（每站>=5条）
  },
  ai: {
    mediaGroups: [], // 量子位、36氪、新浪科技（每站>=5条）
    forumGroups: []  // 稀土掘金、V2EX、CSDN热榜（每站>=5条）
  }
};

function getBjtNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return { dateStr: `${yyyy}-${mm}-${dd}`, hm: `${hh}:${mi}`, full: `${yyyy}-${mm}-${dd} ${hh}:${mi} BJT` };
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'User-Agent': UA, ...(opts.headers || {}) },
    signal: AbortSignal.timeout(7000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchText(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'User-Agent': UA, ...(opts.headers || {}) },
    signal: AbortSignal.timeout(7000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function parseRssItems(xml, sourceName, limit = 6) {
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
      items.push({ title, url: link, meta: `${sourceName}${pubDate ? ' · ' + pubDate.slice(5, 16) : ''}` });
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

// 1. 东方财富网快讯 (>=5条)
async function fetchEastmoneyNews() {
  const url = 'https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=8&req_trace=' + Date.now();
  const data = await fetchJson(url, { headers: { Referer: 'https://kuaixun.eastmoney.com/' } });
  const list = data?.data?.fastNewsList || [];
  return list.slice(0, 6).map(it => ({
    title: it.title || (it.summary || '').slice(0, 50),
    url: it.code ? `https://finance.eastmoney.com/a/${it.code}.html` : 'https://kuaixun.eastmoney.com/',
    meta: `东方财富 · ${it.showTime || ''}`
  })).filter(x => x.title);
}

// 2. 新浪财经滚动新闻 (>=5条)
async function fetchSinaNews(lid = '2516', label = '新浪财经') {
  const url = `https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=${lid}&k=&num=8&page=1`;
  const data = await fetchJson(url, { headers: { Referer: 'https://finance.sina.com.cn/' } });
  const list = data?.result?.data || [];
  return list.slice(0, 6).map(it => ({
    title: it.title,
    url: it.url || it.wapurl || 'https://finance.sina.com.cn/',
    meta: `${label} · ${it.media_name || ''}`
  })).filter(x => x.title);
}

// 3. 微博热搜 (>=5条)
async function fetchWeiboHot() {
  const data = await fetchJson('https://weibo.com/ajax/side/hotSearch', {
    headers: { Referer: 'https://s.weibo.com/' }
  });
  const list = data?.data?.realtime || [];
  return list.slice(0, 6).map(it => ({
    title: it.word || it.note,
    url: `https://s.weibo.com/weibo?q=${encodeURIComponent('#' + (it.word || '') + '#')}`,
    meta: `微博热搜 · 热度 ${it.num || ''}`
  })).filter(x => x.title);
}

// 4. 今日头条热榜 (>=5条)
async function fetchToutiaoHot() {
  const data = await fetchJson('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc', {
    headers: { Referer: 'https://www.toutiao.com/' }
  });
  const list = data?.data || [];
  return list.slice(0, 6).map(it => ({
    title: it.Title,
    url: it.Url || 'https://www.toutiao.com/',
    meta: `今日头条 · 热度 ${it.HotValue || ''}`
  })).filter(x => x.title);
}

// 5. 国内三大财经论坛高点赞/热门帖（雪球、东方财富股吧、集思录）
async function fetchXueqiuHot() {
  // 先请求首页拿访客 cookie
  const homeRes = await fetch('https://xueqiu.com/', {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(6000)
  });
  const rawCookie = homeRes.headers.get('set-cookie') || '';
  const cookie = rawCookie.split(',').map(c => c.split(';')[0]).join('; ');
  const data = await fetchJson('https://xueqiu.com/statuses/hot/listV2.json?since_id=-1&max_id=-1&size=8', {
    headers: { Cookie: cookie, Referer: 'https://xueqiu.com/' }
  });
  const list = data?.items || data?.list || [];
  return list.slice(0, 6).map(it => {
    const st = it.original_status || it;
    const rawTitle = (st.title || st.text || '').replace(/<[^>]+>/g, '').trim();
    return {
      title: rawTitle.slice(0, 55) + (rawTitle.length > 55 ? '...' : ''),
      url: st.target ? `https://xueqiu.com${st.target}` : 'https://xueqiu.com/',
      meta: `雪球 · 👍 ${st.like_count || 0} 赞 · 💬 ${st.reply_count || 0}`
    };
  }).filter(x => x.title);
}

async function fetchGubaHot() {
  const url = 'https://guba.eastmoney.com/interface/GetData.aspx?path=newtopic/api/Topic/HomePageListRead&param=ps%3D8%26p%3D1%26type%3D0';
  const data = await fetchJson(url, { headers: { Referer: 'https://guba.eastmoney.com/' } });
  const list = data?.re || data?.data || [];
  return list.slice(0, 6).map(it => ({
    title: it.post_title || it.title,
    url: it.post_id ? `https://guba.eastmoney.com/news,${it.stockbar_code || 'cjpl'},${it.post_id}.html` : 'https://guba.eastmoney.com/',
    meta: `东方财富股吧 · 👍 ${it.post_like_count || 0} · 💬 ${it.post_comment_count || 0}`
  })).filter(x => x.title);
}

async function fetchJisiluHot() {
  const html = await fetchText('https://www.jisilu.cn/home/explore/', {
    headers: { Referer: 'https://www.jisilu.cn/' }
  });
  const items = [];
  const re = /<a[^>]+href="(https?:\/\/www\.jisilu\.cn\/question\/\d+|\/question\/\d+)"[^>]*>([^<]{4,80})<\/a>/gi;
  let m;
  const seen = new Set();
  while ((m = re.exec(html)) && items.length < 6) {
    const href = m[1].startsWith('http') ? m[1] : `https://www.jisilu.cn${m[1]}`;
    const title = m[2].trim();
    if (title && !seen.has(href)) {
      seen.add(href);
      items.push({ title, url: href, meta: '集思录热门讨论' });
    }
  }
  return items;
}

// 6. 中文 AI 技术论坛高点击（稀土掘金 AI、V2EX、CSDN）
async function fetchJuejinAi() {
  const data = await fetchJson('https://api.juejin.cn/recommend_api/v1/article/recommend_all_feed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Referer: 'https://juejin.cn/' },
    body: JSON.stringify({ id_type: 2, sort_type: 200, cate_id: '6809637773935378440', cursor: '0', limit: 8 })
  });
  const list = data?.data || [];
  return list.slice(0, 6).map(it => {
    const info = it.item_info?.article_info;
    if (!info) return null;
    return {
      title: info.title,
      url: `https://juejin.cn/post/${info.article_id}`,
      meta: `稀土掘金 · 👍 ${info.digg_count || 0} · 👀 ${info.view_count || 0}`
    };
  }).filter(Boolean);
}

async function fetchV2exHot() {
  const list = await fetchJson('https://www.v2ex.com/api/topics/hot.json');
  return (list || []).slice(0, 6).map(it => ({
    title: it.title,
    url: it.url || `https://www.v2ex.com/t/${it.id}`,
    meta: `V2EX · 💬 ${it.replies || 0} 回复`
  }));
}

async function fetchCsdnHot() {
  const data = await fetchJson('https://blog.csdn.net/phoenix/web/blog/hot-rank?page=0&pageSize=8', {
    headers: { Referer: 'https://blog.csdn.net/' }
  });
  const list = data?.data || [];
  return list.slice(0, 6).map(it => ({
    title: it.articleTitle,
    url: it.articleDetailUrl || 'https://blog.csdn.net/',
    meta: `CSDN 热榜 · 🔥 热度 ${it.hotRankScore || ''} · 👀 ${it.viewCount || 0}`
  })).filter(x => x.title);
}

async function safeGroup(name, fallbackUrl, fn) {
  try {
    const items = await fn();
    if (items && items.length > 0) return { name, url: fallbackUrl, items };
  } catch (e) {}
  return {
    name,
    url: fallbackUrl,
    items: [{ title: `暂未自动拉取到 ${name}（可能受机房IP限制），点击直接访问原站查看`, url: fallbackUrl, meta: '直达链接' }]
  };
}

async function refreshPortalData(reason = 'manual') {
  console.log(`[定时资讯] 开始刷新财经与中文 AI 前沿数据 (${reason})...`);
  const allQuoteItems = [
    ...portalCache.finance.stocks,
    ...portalCache.finance.futures,
    ...portalCache.finance.forex
  ];

  await Promise.allSettled(
    allQuoteItems.map(async (item) => {
      try {
        const q = await fetchYahooQuote(item.symbol);
        if (q) { item.price = q.price; item.change = q.change; item.up = q.up; }
      } catch (e) {}
    })
  );

  // 并行抓取第二分页（4大媒体 + 3大财经论坛，每站>=5条）
  const [em, sinaFin, wb, tt, xq, gb, jsl] = await Promise.all([
    safeGroup('东方财富网', 'https://kuaixun.eastmoney.com/', fetchEastmoneyNews),
    safeGroup('新浪财经', 'https://finance.sina.com.cn/', () => fetchSinaNews('2516', '新浪财经')),
    safeGroup('微博热搜', 'https://s.weibo.com/top/summary', fetchWeiboHot),
    safeGroup('今日头条', 'https://www.toutiao.com/', fetchToutiaoHot),
    safeGroup('雪球热门', 'https://xueqiu.com/', fetchXueqiuHot),
    safeGroup('东方财富股吧', 'https://guba.eastmoney.com/', fetchGubaHot),
    safeGroup('集思录', 'https://www.jisilu.cn/home/explore/', fetchJisiluHot)
  ]);
  portalCache.finance.mediaGroups = [em, sinaFin, wb, tt];
  portalCache.finance.forumGroups = [xq, gb, jsl];

  // 并行抓取第三分页（中文 AI 资讯 + 国内技术论坛高点击，每站>=5条）
  const [qbit, kr36, sinaTech, juejin, v2ex, csdn] = await Promise.all([
    safeGroup('量子位 AI', 'https://www.qbitai.com/', async () => parseRssItems(await fetchText('https://www.qbitai.com/feed'), '量子位', 6)),
    safeGroup('36氪科技', 'https://36kr.com/', async () => parseRssItems(await fetchText('https://www.36kr.com/feed'), '36氪', 6)),
    safeGroup('新浪科技 AI', 'https://tech.sina.com.cn/', () => fetchSinaNews('2515', '新浪科技')),
    safeGroup('稀土掘金 AI', 'https://juejin.cn/ai', fetchJuejinAi),
    safeGroup('V2EX 热门', 'https://www.v2ex.com/?tab=hot', fetchV2exHot),
    safeGroup('CSDN 热榜', 'https://blog.csdn.net/rank/list', fetchCsdnHot)
  ]);
  portalCache.ai.mediaGroups = [qbit, kr36, sinaTech];
  portalCache.ai.forumGroups = [juejin, v2ex, csdn];

  portalCache.lastUpdated = getBjtNow().full;
  console.log(`[定时资讯] 刷新完成，时间: ${portalCache.lastUpdated}`);
}

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

  if (urlPath === '/health' || urlPath === '/ping' || urlPath === '/keepalive') {
    const payload = {
      status: 'ok',
      service: '我的空间',
      uptimeSeconds: Math.floor((Date.now() - START_TIME) / 1000),
      onlineUsers: clients.size,
      activeRooms: rooms.size,
      timestamp: new Date().toISOString()
    };
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
    return;
  }

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

  let filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, indexData) => {
        if (err2) { res.writeHead(404); res.end('Not Found'); return; }
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
  try { client.socket.write(encodeWsFrame(JSON.stringify(obj))); } catch (e) {}
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
      openRooms.push({ id: r.id, game: r.game, hostNick: host ? host.nick : '玩家', createdAt: r.createdAt });
    }
  }
  broadcastAll({ type: 'room_list', rooms: openRooms });
}

function broadcastStats() {
  broadcastAll({ type: 'stats', onlineCount: clients.size, roomCount: rooms.size });
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
      if (clean) { client.nick = clean; sendToClient(client, { type: 'nick_updated', nick: client.nick }); }
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
  sendToClient(client, { type: 'welcome', id: clientId, nick: defaultNick, onlineCount: clients.size, roomCount: rooms.size, chatHistories, rooms: openRooms });
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
  console.log(`我的空间 服务器已启动: http://localhost:${PORT}`);
});
