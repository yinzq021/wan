# 我的空间 


零第三方依赖的 Node.js + 原生 WebSocket 多人联机与单机游戏大厅。
## 包含功能
- **欢迎页「我的游戏空间」**：在线人数、活跃房间、保活心跳状态展示
- **全页面实时聊天**：大厅公屏聊天 + 房间私密聊天 + 快捷短语
- **四款完整游戏**（均支持**单机模式**与**联机对战**）：
  1. 五子棋（15×15，简单/困难 AI + 联机房间）
  2. 中国象棋（完整走法校验与将军提示 + AI + 联机房间）
  3. 军棋/陆战棋（铁路、行营、大本营、山界、自动/手动布阵 + AI + 暗棋联机）
  4. 俄罗斯方块（幽灵落点、暂存、手机触控键 + 联机互发垃圾行对战）
- **保活机制**：
  - 服务端提供 `GET /ping` 与 `GET /health` 接口
  - 支持环境变量 `KEEP_ALIVE_URL` 或 Render 自带的 `RENDER_EXTERNAL_URL` 定时自唤醒
  - 客户端每 25 秒 WebSocket 心跳维持连接

## 本地运行
```bash
node server.js
# 浏览器访问 http://localhost:3000
```

## 上传与更新到 GitHub / Render
1. 将本压缩包解压后的所有文件（`package.json`、`server.js`、`public/index.html`、`README.md`）覆盖上传到你的 GitHub 仓库（如 `yinzq021/房间`）。
2. Render 绑定该仓库后，Build Command 可留空或填 `npm install`，Start Command 填 `node server.js`（或 `npm start`）。
3. 如需 24 小时不休眠，可在 UptimeRobot 添加 `HTTP(s)` 监控，URL 填 `https://你的域名.onrender.com/ping`，间隔设为 5 分钟。
