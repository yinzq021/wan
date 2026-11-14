// 联机中国象棋服务器：零依赖，只需 Node.js（Termux: pkg install nodejs）
// 运行：node server.js   （端口可用 PORT=3000 node server.js 修改）
const http = require('http'), os = require('os');
const PORT = process.env.PORT || 8080;
const rooms = new Map();
const clean = (s, n) => String(s || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, n).toUpperCase();

function getRoom(c) {
  let r = rooms.get(c);
  if (!r) { r = { red: null, black: null, moves: [], resign: null, chat: [], cl: new Set(), t: 0 }; rooms.set(c, r); }
  r.t = Date.now(); return r;
}
const seat = (r, id) => (r.red && r.red.id === id ? 1 : r.black && r.black.id === id ? -1 : 0);
const send = (res, ev, d) => res.write('event: ' + ev + '\ndata: ' + JSON.stringify(d) + '\n\n');
const view = (r, id) => ({ you: seat(r, id), redName: r.red ? r.red.name : '', blackName: r.black ? r.black.name : '', hasBlack: !!r.black, moves: r.moves, resign: r.resign });
const push = r => { for (const c of r.cl) send(c.res, 'state', view(r, c.id)); };
const chatView = (m, id) => ({ name: m.name, text: m.text, me: m.id === id });

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/events') {
    const code = clean(u.searchParams.get('room'), 8), id = clean(u.searchParams.get('id'), 40);
    const name = String(u.searchParams.get('name') || '').slice(0, 10) || '棋友';
    if (code.length < 3 || !id) { res.writeHead(400); return res.end(); }
    const r = getRoom(code);
    if (!r.red || r.red.id === id) r.red = { id, name };
    else if (!r.black || r.black.id === id) r.black = { id, name };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(':ok\n\n');
    const cl = { res, id }; r.cl.add(cl);
    send(res, 'hist', r.chat.map(m => chatView(m, id)));
    push(r);
    req.on('close', () => { r.cl.delete(cl); r.t = Date.now(); });
    return;
  }
  if (u.pathname === '/act' && req.method === 'POST') {
    const code = clean(u.searchParams.get('room'), 8), id = clean(u.searchParams.get('id'), 40);
    let body = '';
    req.on('data', d => { body += d; if (body.length > 2048) req.destroy(); });
    req.on('end', () => {
      let a; try { a = JSON.parse(body); } catch (e) { res.writeHead(400); return res.end(); }
      const r = rooms.get(code); if (!r) { res.writeHead(404); return res.end(); }
      r.t = Date.now();
      const s = seat(r, id);
      if (a.type === 'move') {
        const turn = r.moves.length % 2 ? -1 : 1, x = a.x;
        if (!s || s !== turn || !r.black || r.resign || !Number.isInteger(x) || x < 0 || (x >> 7) > 89 || (x & 127) > 89) { res.writeHead(409); return res.end(); }
        r.moves.push(x); push(r);
      } else if (a.type === 'chat') {
        const text = String(a.text || '').slice(0, 120).trim(); if (!text) { res.writeHead(400); return res.end(); }
        const nm = s === 1 ? r.red.name : s === -1 ? r.black.name : '观众';
        const m = { id, name: nm, text }; r.chat.push(m); if (r.chat.length > 60) r.chat.shift();
        for (const c of r.cl) send(c.res, 'chat', chatView(m, c.id));
      } else if (a.type === 'resign') {
        if (s && r.black && !r.resign) { r.resign = s === 1 ? 'r' : 'b'; push(r); }
      } else if (a.type === 'again') {
        if (s && r.black && (r.moves.length || r.resign)) { const t = r.red; r.red = r.black; r.black = t; r.moves = []; r.resign = null; push(r); }
      }
      res.writeHead(200); res.end('ok');
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(PAGE);
}).listen(PORT, '0.0.0.0', () => {
  console.log('象棋服务器已启动，端口 ' + PORT);
  console.log('本机访问: http://localhost:' + PORT);
  for (const l of Object.values(os.networkInterfaces()).flat())
    if (l && l.family === 'IPv4' && !l.internal) console.log('局域网访问: http://' + l.address + ':' + PORT);
});
setInterval(() => { for (const r of rooms.values()) for (const c of r.cl) c.res.write(':\n\n'); }, 20000);
setInterval(() => { for (const [k, r] of rooms) if (!r.cl.size && Date.now() - r.t > 6 * 3600e3) rooms.delete(k); }, 1800e3);

const PAGE = String.raw`<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>联机中国象棋</title>
<style>
:root{--bg:#f3ead9;--fg:#3b2a17;--btn:#8a5a2b;--btnfg:#fff;--card:#fff8e8;--bd:#d8c7a3;color-scheme:light;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#241a10;--fg:#f0e2c8;--btn:#a8743a;--card:#33261a;--bd:#5a4630;color-scheme:dark}}
body{margin:0;background:var(--bg);color:var(--fg);font-family:-apple-system,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif;display:flex;flex-direction:column;align-items:center;gap:10px;padding:10px 8px 24px}
h1{font-size:20px;margin:6px 0 0}
#st{font-size:17px;font-weight:600;min-height:24px;text-align:center}
#pl{font-size:14px;display:flex;gap:14px;flex-wrap:wrap;justify-content:center}
canvas{border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.35);max-width:100%;touch-action:manipulation}
.row{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;align-items:center}
button{font-size:15px;padding:9px 15px;border-radius:8px;border:0;background:var(--btn);color:var(--btnfg)}
button.g{background:var(--card);color:var(--fg);border:1px solid var(--bd)}
input{font-size:16px;padding:9px 10px;border-radius:8px;border:1px solid var(--bd);background:var(--card);color:var(--fg);min-width:0}
.card{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:12px;width:100%;max-width:520px;box-sizing:border-box}
#chat{height:170px;overflow-y:auto;display:flex;flex-direction:column;gap:5px;font-size:15px;margin-bottom:8px}
.m{max-width:85%;padding:5px 9px;border-radius:10px;background:var(--bg);word-break:break-all}
.m.me{align-self:flex-end;background:var(--btn);color:#fff}
.m b{font-size:12px;opacity:.7;display:block}
.hide{display:none!important}
.note{font-size:13px;opacity:.75;text-align:center;max-width:520px}
#game{display:flex;flex-direction:column;align-items:center;gap:10px;width:100%}
</style></head><body>
<h1>联机中国象棋</h1>
<div id="lobby" class="card">
<div class="row" style="margin-bottom:10px"><input id="nick" placeholder="你的昵称" maxlength="10" style="flex:1"></div>
<div class="row"><input id="code" placeholder="房间号" maxlength="8" style="width:110px;text-transform:uppercase">
<button id="join">加入房间</button><button id="create" class="g">创建新房间</button></div>
<div class="note" style="margin-top:10px">输入相同房间号即可对战；把本页网址（含房间号）发给好友最方便</div>
</div>
<div id="game" class="hide">
<div id="st"></div><div id="conn" class="note"></div><div id="pl"></div>
<canvas id="cv"></canvas>
<div class="row"><button id="resign" class="g">认输</button><button id="again" class="g">再来一局</button><button id="leave" class="g">离开</button></div>
<div class="card"><div id="chat"></div>
<div class="row" style="flex-wrap:nowrap"><input id="msg" placeholder="说点什么…" maxlength="120" style="flex:1"><button id="send">发送</button></div>
<div class="row" style="margin-top:8px" id="qk"></div></div>
</div>
<script>
const $=id=>document.getElementById(id);
const b=new Array(90).fill(0),kp=[85,4];
const D4=[[1,0],[-1,0],[0,1],[0,-1]],KN=[[-2,-1,-1,0],[-2,1,-1,0],[2,-1,1,0],[2,1,1,0],[-1,-2,0,-1],[1,-2,0,-1],[-1,2,0,1],[1,2,0,1]];
function init(){b.fill(0);const k=[1,2,3,4,5,4,3,2,1];for(let c=0;c<9;c++){b[c]=-k[c];b[81+c]=k[c]}
b[19]=b[25]=-6;b[64]=b[70]=6;for(let c=0;c<9;c+=2){b[27+c]=-7;b[54+c]=7}kp[0]=85;kp[1]=4}
function mk(x){const f=x>>7,t=x&127,p=b[f],cap=b[t];b[t]=p;b[f]=0;if(p===5)kp[0]=t;else if(p===-5)kp[1]=t;return cap}
function un(x,cap){const f=x>>7,t=x&127,p=b[t];b[f]=p;b[t]=cap;if(p===5)kp[0]=f;else if(p===-5)kp[1]=f}
function att(k,s){const r=k/9|0,c=k%9;
for(const[dr,dc]of D4){let rr=r+dr,cc=c+dc,n=0;
while(rr>=0&&rr<10&&cc>=0&&cc<9){const q=b[rr*9+cc];if(q){const a=q*s<0?Math.abs(q):0;
if(n===0){if(a===1||a===5)return true;n=1}else{if(a===6)return true;break}}rr+=dr;cc+=dc}}
for(const[dr,dc]of KN){const rr=r+dr,cc=c+dc;if(rr<0||rr>9||cc<0||cc>8)continue;
const q=b[rr*9+cc];if(q*s<0&&Math.abs(q)===2){const l1=rr+(Math.abs(dr)===2?-dr/2:0),l2=cc+(Math.abs(dc)===2?-dc/2:0);if(!b[l1*9+l2])return true}}
const e=s>0?1:-1,pr=r-e;if(pr>=0&&pr<10){const q=b[pr*9+c];if(q*s<0&&Math.abs(q)===7)return true}
for(const dc of[-1,1]){const cc=c+dc;if(cc>=0&&cc<9){const q=b[r*9+cc];if(q*s<0&&Math.abs(q)===7)return true}}
return false}
function gen(s){const m=[];
for(let i=0;i<90;i++){const p=b[i];if(p*s<=0)continue;const a=p*s,r=i/9|0,c=i%9;
const add=(rr,cc)=>{if(rr<0||rr>9||cc<0||cc>8)return 0;const to=rr*9+cc,q=b[to];if(q*s>0)return 0;m.push(i<<7|to);return q?2:1};
const pal=(rr,cc)=>cc>=3&&cc<=5&&(s>0?rr>=7:rr<=2);
if(a===1){for(const[dr,dc]of D4){for(let k=1;add(r+dr*k,c+dc*k)===1;k++);}}
else if(a===6){for(const[dr,dc]of D4){let k=1,rr,cc;
for(;;k++){rr=r+dr*k;cc=c+dc*k;if(rr<0||rr>9||cc<0||cc>8||b[rr*9+cc])break;m.push(i<<7|rr*9+cc)}
for(k++;;k++){rr=r+dr*k;cc=c+dc*k;if(rr<0||rr>9||cc<0||cc>8)break;const q=b[rr*9+cc];if(q){if(q*s<0)m.push(i<<7|rr*9+cc);break}}}}
else if(a===2){for(const[dr,dc,lr,lc]of KN){if(b[(r+lr)*9+c+lc])continue;add(r+dr,c+dc)}}
else if(a===3){for(const dr of[-2,2])for(const dc of[-2,2]){const rr=r+dr;if(s>0?rr<5:rr>4)continue;if(b[(r+dr/2)*9+c+dc/2])continue;add(rr,c+dc)}}
else if(a===4){for(const dr of[-1,1])for(const dc of[-1,1])if(pal(r+dr,c+dc))add(r+dr,c+dc)}
else if(a===5){for(const[dr,dc]of D4)if(pal(r+dr,c+dc))add(r+dr,c+dc)}
else{const f=s>0?-1:1;add(r+f,c);if(s>0?r<=4:r>=5){add(r,c-1);add(r,c+1)}}}
return m}
function legal(s){const ki=s>0?0:1;return gen(s).filter(x=>{const cap=mk(x),bad=att(kp[ki],s);un(x,cap);return!bad})}
const cv=$('cv'),ctx=cv.getContext('2d');
const RN=['','车','马','相','仕','帅','炮','兵'],BN=['','车','马','象','士','将','炮','卒'];
let W=360,code='',G=null,es=null,mc=0,fl=false,turn=1,sel=-1,tg=[],last=null,winner=0,busy=false,rsT=0,pn;
const ID=(()=>{const g=()=>Math.random().toString(36).slice(2)+Date.now().toString(36);try{let v=sessionStorage.getItem('xq-id');if(!v){v=g();sessionStorage.setItem('xq-id',v)}return v}catch(e){return g()}})();
const dm=i=>fl?89-i:i;
try{$('nick').value=localStorage.getItem('xq-nick')||''}catch(e){}
function resize(){const d=window.devicePixelRatio||1;W=Math.max(270,Math.min(innerWidth-16,520));
cv.style.width=W+'px';cv.style.height=(W*10/9)+'px';cv.width=W*d;cv.height=W*10/9*d;ctx.setTransform(d,0,0,d,0,0);draw()}
function draw(){const cs=W/9,X=c=>(c+.5)*cs,Y=r=>(r+.5)*cs;
ctx.fillStyle='#e8c27a';ctx.fillRect(0,0,W,W*10/9);ctx.strokeStyle='#5a3a1a';ctx.lineWidth=1.3;ctx.beginPath();
for(let r=0;r<10;r++){ctx.moveTo(X(0),Y(r));ctx.lineTo(X(8),Y(r))}
for(let c=0;c<9;c++){if(c%8===0){ctx.moveTo(X(c),Y(0));ctx.lineTo(X(c),Y(9))}else{ctx.moveTo(X(c),Y(0));ctx.lineTo(X(c),Y(4));ctx.moveTo(X(c),Y(5));ctx.lineTo(X(c),Y(9))}}
for(const[a,bb,c,d]of[[3,0,5,2],[5,0,3,2],[3,7,5,9],[5,7,3,9]]){ctx.moveTo(X(a),Y(bb));ctx.lineTo(X(c),Y(d))}
ctx.stroke();ctx.strokeRect(X(0)-4,Y(0)-4,X(8)-X(0)+8,Y(9)-Y(0)+8);
ctx.font='bold '+(cs*.5)+'px "KaiTi","STKaiti","Noto Serif CJK SC",serif';ctx.textAlign='center';ctx.textBaseline='middle';
ctx.fillStyle='#5a3a1a';ctx.fillText('楚 河',X(1.5),Y(4.5));ctx.fillText('汉 界',X(6.5),Y(4.5));
if(last)for(const j of last){const i=dm(j);ctx.strokeStyle='#2e7d32';ctx.lineWidth=3;ctx.strokeRect(X(i%9)-cs*.46,Y(i/9|0)-cs*.46,cs*.92,cs*.92)}
for(let j=0;j<90;j++){const p=b[j];if(!p)continue;const i=dm(j),x=X(i%9),y=Y(i/9|0),R=cs*.43;
ctx.beginPath();ctx.arc(x,y,R,0,7);ctx.fillStyle='#fbefd0';ctx.fill();ctx.lineWidth=j===sel?4:2;
ctx.strokeStyle=j===sel?'#1565c0':(p>0?'#c0392b':'#222');ctx.stroke();
ctx.beginPath();ctx.arc(x,y,R*.82,0,7);ctx.lineWidth=1;ctx.strokeStyle=p>0?'#c0392b':'#222';ctx.stroke();
ctx.fillStyle=p>0?'#c0392b':'#222';ctx.fillText((p>0?RN:BN)[Math.abs(p)],x,y+1)}
for(const j of tg){const i=dm(j);ctx.beginPath();ctx.arc(X(i%9),Y(i/9|0),b[j]?cs*.45:cs*.12,0,7);
if(b[j]){ctx.strokeStyle='#d32f2f';ctx.lineWidth=3;ctx.stroke()}else{ctx.fillStyle='#2e7d32';ctx.fill()}}}
function onGame(){if(!G)return;
mc=G.you;fl=mc===-1;init();for(const x of G.moves)mk(x);
const n=G.moves.length;turn=n%2?-1:1;const prev=pn;pn=n;
last=n?[G.moves[n-1]>>7,G.moves[n-1]&127]:null;sel=-1;tg=[];busy=false;
winner=G.resign==='r'?-1:G.resign==='b'?1:0;
if(!winner&&G.hasBlack&&!legal(turn).length)winner=-turn;
$('pl').textContent='';
const mkp=(t,c)=>{const s=document.createElement('span');s.textContent=t;s.style.color=c;s.style.fontWeight=600;$('pl').appendChild(s)};
mkp('红：'+G.redName+(mc===1?'（你）':''),'#c0392b');mkp('黑：'+(G.hasBlack?G.blackName:'等待加入')+(mc===-1?'（你）':''),'var(--fg)');
let t;
if(!G.hasBlack)t='房间号 '+code+'，等待对手加入…';
else if(winner)t=mc?(winner===mc?'你赢了！':'你输了'):(winner===1?'红方胜':'黑方胜');
else{const chk=att(kp[turn>0?0:1],turn)?'将军！':'';
t=chk+(mc?(turn===mc?'轮到你走':'等待对手走棋'):'观战中 · '+(turn===1?'红':'黑')+'方走')}
$('st').textContent=t;
$('resign').classList.toggle('hide',!mc||!!winner||!G.hasBlack);
$('again').classList.toggle('hide',!mc||!(winner&&G.hasBlack));
if(prev!==undefined&&n>prev&&turn===mc){try{navigator.vibrate&&navigator.vibrate(40)}catch(e){}}
draw()}
function post(type,extra){return fetch('/act?room='+code+'&id='+ID,{method:'POST',body:JSON.stringify(Object.assign({type:type},extra||{}))})}
cv.addEventListener('pointerdown',e=>{if(!G||!mc||turn!==mc||winner||!G.hasBlack||busy)return;
const rc=cv.getBoundingClientRect(),cs=rc.width/9,c=Math.floor((e.clientX-rc.left)/cs),r=Math.floor((e.clientY-rc.top)/cs);
if(c<0||c>8||r<0||r>9)return;const j=dm(r*9+c);
if(sel>=0&&tg.includes(j)){busy=true;post('move',{x:sel<<7|j}).then(r=>{if(!r.ok)busy=false}).catch(()=>{busy=false});return}
if(b[j]*mc>0){sel=j;tg=legal(mc).filter(x=>x>>7===j).map(x=>x&127)}else{sel=-1;tg=[]}draw()});
$('resign').onclick=()=>{if(!rsT){$('resign').textContent='再点一次确认';rsT=setTimeout(()=>{rsT=0;$('resign').textContent='认输'},3000);return}
clearTimeout(rsT);rsT=0;$('resign').textContent='认输';post('resign')};
$('again').onclick=()=>post('again');
$('leave').onclick=()=>{if(es)es.close();es=null;G=null;pn=undefined;$('game').classList.add('hide');$('lobby').classList.remove('hide');$('chat').textContent='';try{history.replaceState(null,'',location.pathname)}catch(e){}};
function addChat(m){const box=$('chat'),d=document.createElement('div');d.className='m'+(m.me?' me':'');
const n=document.createElement('b');n.textContent=m.name;const t=document.createElement('span');t.textContent=m.text;d.append(n,t);box.appendChild(d);box.scrollTop=box.scrollHeight}
function enter(cd){cd=cd.toUpperCase().replace(/[^A-Z0-9]/g,'');if(cd.length<3){alert('请输入至少3位的房间号');return}
const nm=($('nick').value.trim()||'棋友'+Math.floor(Math.random()*900+100)).slice(0,10);
try{localStorage.setItem('xq-nick',nm)}catch(e){}
code=cd;$('lobby').classList.add('hide');$('game').classList.remove('hide');resize();
try{location.hash=cd}catch(e){}
if(es)es.close();
es=new EventSource('/events?room='+cd+'&id='+ID+'&name='+encodeURIComponent(nm));
es.addEventListener('state',e=>{G=JSON.parse(e.data);onGame()});
es.addEventListener('hist',e=>{$('chat').textContent='';JSON.parse(e.data).forEach(addChat)});
es.addEventListener('chat',e=>addChat(JSON.parse(e.data)));
es.onopen=()=>{$('conn').textContent=''};
es.onerror=()=>{$('conn').textContent='连接中断，正在重连…'}}
$('join').onclick=()=>enter($('code').value);
$('create').onclick=()=>{const A='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let s='';for(let i=0;i<4;i++)s+=A[Math.random()*A.length|0];enter(s)};
function sendChat(t){t=(t||'').trim();if(t)post('chat',{text:t})}
$('send').onclick=()=>{sendChat($('msg').value);$('msg').value=''};
$('msg').addEventListener('keydown',e=>{if(e.key==='Enter'){sendChat($('msg').value);$('msg').value=''}});
for(const q of['好棋！','稍等一下','手滑了','再来一局？']){const bt=document.createElement('button');bt.className='g';bt.textContent=q;bt.onclick=()=>sendChat(q);$('qk').appendChild(bt)}
addEventListener('resize',resize);
const h=(location.hash||'').slice(1);if(h){$('code').value=h.toUpperCase();$('code').focus()}
</script></body></html>`;
