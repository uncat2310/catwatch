<div align="center">

# 🐱 薛定谔的项目 (Schrödinger's Portal)

**Editorial / Gallery 气质的轻量自托管服务导航与健康状态 Portal**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/Node.js-18%2B-brightgreen.svg)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ed.svg)](https://www.docker.com/)

*心之所向，触手可及。*

<br/>

### Light Mode

![Light Mode](docs/screenshots/light.png)

### Dark Mode

![Dark Mode](docs/screenshots/dark.png)

</div>

---

## 📖 项目简介

**薛定谔的项目 (Schrödinger's Portal)** 是一个基于 **Vite + Vanilla JavaScript + Node.js** 的轻量个人服务器导航面板：用 Apple 风格卡片聚合常用服务，服务端持续探测并记录可用率，掉线和恢复时推送通知。

一句话：**好看的导航页 + 轻量版状态监控，一个容器搞定**。无数据库、无前端框架依赖。

---

## ✨ 核心特性

- 🗞️ **Editorial / Gallery 视觉**：暖纸色 Light、博物馆夜间 Dark，克制的环境色与材质感。
- 🧩 **Node.js 首屏预渲染**：服务端注入项目卡片，降低首屏空白。
- 🔍 **Spotlight 搜索**：`Ctrl + K` / `⌘ K`，键盘导航与回车直达。
- 💓 **服务端后台健康探针**：可信项目由服务端 daemon 探测；浏览器主要读取缓存；自定义项目才主动探测。
- 📊 **24h 可用率条**：每张卡片显示近 24 小时（48 段 × 30 分钟）的可用情况与在线率，悬停查看延迟；历史保留 7 天并落盘。
- 🔔 **掉线 / 恢复通知**：连续 3 次探测失败才判定离线（防抖），支持 Telegram、Bark、Server酱、通用 Webhook。
- 🌐 **公开状态页 `/status`**：只展示你勾选公开的服务，只有名称、状态和 24h 可用率，不暴露任何链接或域名，适合分享给朋友。
- ☁️ **服务器同步编辑**：设置 `ADMIN_TOKEN` 后，页面上的增删改直接写回 `config/projects.json`，所有设备一致；未设置时保持浏览器本地编辑。
- 🖼️ **服务图标自动获取**：服务端读取服务页面声明的图标并缓存，同源加载；可手动指定；拿不到时显示首字母头像。
- 🐳 **Docker / Compose / Node / PM2** 多种部署方式。

---

## 🚀 快速开始

### 方式一：Docker 一键拉取（推荐）

```bash
docker run -d \
  --name schrodinger-portal \
  --restart unless-stopped \
  -p 3000:3000 \
  ghcr.io/uncat2310/schrodinger-portal:latest
```

访问 `http://你的服务器IP:3000`。

### 方式二：Docker Compose

```bash
git clone https://github.com/uncat2310/schrodinger-portal.git
cd schrodinger-portal
docker compose up -d
```

说明：`docker-compose.yml` 同时声明了 `image` 与 `build`。正式部署会优先使用 GHCR 镜像；本地也可 `docker compose build` 自行构建。

### 方式三：Node.js

要求：Node.js 18+。

```bash
npm ci
npm run build
npm start
```

可选 PM2：

```bash
npm install -g pm2
pm2 start server.js --name "schrodinger-portal"
pm2 save
```

可选 systemd（推荐生产）：

> 生产环境建议使用**独立非 root 用户**运行 Node 服务。

```bash
# 创建专用用户与目录权限
sudo useradd --system --home /srv/schrodinger-portal --shell /usr/sbin/nologin schrodinger
sudo chown -R schrodinger:schrodinger /srv/schrodinger-portal

cat >/etc/systemd/system/schrodinger-portal.service <<'EOF'
[Unit]
Description=Schrodinger Portal - Service Navigation and Health Probe
After=network.target

[Service]
Type=simple
User=schrodinger
Group=schrodinger
WorkingDirectory=/srv/schrodinger-portal
ExecStart=/usr/bin/node /srv/schrodinger-portal/server.js
Restart=always
RestartSec=5
Environment=PORT=3000
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now schrodinger-portal.service
```

常用命令：

```bash
systemctl status schrodinger-portal
systemctl restart schrodinger-portal
journalctl -u schrodinger-portal -f
```

反向代理只需指向 `127.0.0.1:3000`（与 unit 名称无关）。若你曾使用旧名 `aetherhub`，请改用 `schrodinger-portal`。

---

## ⚙️ 配置

### 服务端默认项目

优先读取：

```text
config/projects.json
```

该文件已在 `.gitignore` / `.dockerignore` 中忽略，用于存放你自己的服务列表（可含内网地址）。公开仓库请使用示例文件：

```bash
mkdir -p config
cp config/projects.example.json config/projects.json
```

示例仅包含 `github.com` / `vercel.com` / `cloudflare.com` 等公开站点。

Docker 挂载示例（推荐挂载**目录**，这样页面编辑可以写回，探测历史也能在重启后保留）：

```bash
mkdir -p config data
sudo chown -R 1000:1000 config data   # 容器内以 node 用户 (uid 1000) 运行

docker run -d \
  --name schrodinger-portal \
  --restart unless-stopped \
  -p 3000:3000 \
  -e ADMIN_TOKEN="$(openssl rand -hex 24)" \
  -v "$PWD/config:/app/config" \
  -v "$PWD/data:/app/data" \
  ghcr.io/uncat2310/schrodinger-portal:latest
```

只想手工维护配置、不在页面上编辑时，也可以只读挂载单个文件：`-v "$PWD/config/projects.json:/app/config/projects.json:ro"`。

### 环境变量

| 变量 | 默认 | 说明 |
| :--- | :--- | :--- |
| `PORT` | `3000` | 监听端口 |
| `CORS_ORIGIN` | 空 | 默认同源，不返回 `Access-Control-Allow-Origin: *`；需要跨域时显式设置 |
| `ALLOW_INSECURE_TLS` | `false` | 为 `true` 时探针才忽略 TLS 证书错误；默认严格校验 |
| `TRUST_PROXY` | `false` | 仅当服务位于**可信反向代理**之后，且后端端口不对公网直接暴露时，才设为 `true` 以信任 `X-Forwarded-For`；默认不信任客户端伪造的转发头 |
| `ADMIN_TOKEN` | 空 | 管理口令。设置后启用「服务器模式」：页面增删改写回 `config/projects.json`。请使用足够长的随机串 |
| `DATA_DIR` | `./data` | 探测历史 `history.json` 的存放目录 |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | 空 | Telegram 通知（两者都要填） |
| `BARK_URL` | 空 | Bark 通知，如 `https://api.day.app/<key>` |
| `SERVERCHAN_SENDKEY` | 空 | Server酱 Turbo 通知 |
| `NOTIFY_WEBHOOK_URL` | 空 | 通用 Webhook，POST JSON：`{ title, body, event }` |

---

## 💾 数据持久化说明

服务列表有两种模式，取决于是否设置了 `ADMIN_TOKEN`：

| | 服务器模式（设置了 `ADMIN_TOKEN`） | 本地模式（未设置） |
| :--- | :--- | :--- |
| 服务列表来源 | `config/projects.json` | `config/projects.json` 作为初始值，之后以浏览器 LocalStorage 为准 |
| 页面上增删改 | 首次需输入管理口令，写回 `config/projects.json` | 只写入当前浏览器 |
| 多设备同步 | ✅ | ❌ |
| 可用率历史 / 通知 | ✅ 全部服务 | 仅 `config/projects.json` 中的服务 |

- 管理口令保存在当前浏览器，可在「设置 → 服务器同步」中退出。
- 从本地模式切换到服务器模式后，若浏览器里还留有旧的本地列表，可在「设置 → 服务器同步」中一键上传或丢弃。
- 主题、标题等个人偏好始终只保存在浏览器。
- 探测历史保存在 `DATA_DIR/history.json`，每 5 分钟及进程退出时写盘。

---

## 🌐 公开状态页

访问 `https://你的域名/status` 即可看到一个只读的状态页：

- 只显示勾选了「在公开状态页显示」的服务（编辑服务弹窗中设置，需服务器模式；也可以在 `config/projects.json` 中写 `"statusPublic": true`）
- 只包含服务名称、当前状态、24h 可用率条和百分比，**不包含 URL、hostname、内部 ID**
- 数据接口为 `GET /api/status`，同样只返回公开服务
- 页面每分钟自动刷新，服务端预渲染，禁用 JS 也能看

如果你的主页本身放在密码后面，可以只放行状态页相关路径，例如 Caddy：

```caddy
portal.example.com {
    @public path /status /api/status /api/status-icon/* /assets/* /favicon.svg
    handle @public {
        reverse_proxy 127.0.0.1:3000
    }
    handle {
        basic_auth {
            admin <caddy hash-password 生成的哈希>
        }
        reverse_proxy 127.0.0.1:3000
    }
}
```

---

## 🔔 状态通知

服务端每 12 秒探测一次 `config/projects.json` 中启用探针的服务：

- **连续 3 次失败**（约 36 秒）才判定为不可用并通知，单次抖动不会打扰你
- 恢复后第一次成功即发送恢复通知，并附上中断时长
- 状态写入历史文件，重启后不会重复通知同一次故障

配置任意通知渠道的环境变量即可启用；登录管理后可在「设置 → 服务器同步」中发送测试通知。

---

## 💓 健康探针说明

- 主路径：服务端根据可信项目 ID 或经过校验的 URL 发起 HTTP(S) 探测
- 客户端任意 URL 探测会拒绝 localhost / 私网 / link-local / 云 metadata 等目标（防 SSRF）
- HTTPS 默认启用证书校验
- 状态文案：`在线` / `不可用` / `检测中`
- 浏览器 `no-cors` fallback 只能说明请求可能发出，**不是高精度真实测速**

---

## 🖼️ 服务图标

图标由**服务端**获取并缓存，浏览器统一从同源的 `/api/icon/<服务ID>` 加载：

1. 编辑服务时填写的「图标地址」优先
2. 否则读取服务首页 HTML 中声明的 `<link rel="icon">` / `apple-touch-icon`，优先 SVG 和高分辨率图标
3. 再退回站点根目录的 `/favicon.ico`
4. 都拿不到时显示首字母头像（颜色由服务名称决定）

说明：

- 只抓取 `config/projects.json` 中的服务；跨主机的图标地址按公网规则做 SSRF 校验；响应限制大小并按文件头确认确实是图片（登录页之类的 HTML 不会被当成图标）
- 缓存在 `DATA_DIR/icons/`，24 小时刷新一次；源站暂时不可用时继续使用旧图标
- 不经过任何第三方图标服务，也不会因为门户是 HTTPS 而被浏览器拦截 HTTP 服务的图标
- 公开状态页使用不含服务 ID 的 `/api/status-icon/<随机键>`，只对已公开的服务返回图标
- 仅保存在浏览器本地的服务（本地模式下自行添加的）由浏览器直接加载手动图标地址或站点 `/favicon.ico`

---

## 🔄 Docker 更新

```bash
docker pull ghcr.io/uncat2310/schrodinger-portal:latest
docker stop schrodinger-portal
docker rm schrodinger-portal
docker run -d \
  --name schrodinger-portal \
  --restart unless-stopped \
  -p 3000:3000 \
  ghcr.io/uncat2310/schrodinger-portal:latest
```

Compose：

```bash
docker compose pull
docker compose up -d
```

---

## 🌐 反向代理示例

### Caddy

```caddy
portal.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

### Nginx（可选）

```nginx
server {
    listen 80;
    server_name portal.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 🔐 安全建议

- 建议通过 HTTPS 反向代理对外提供服务
- 不要把私有 `config/projects.json`、token、密钥提交进公开仓库
- 探针仅用于 HTTP/HTTPS 健康检查，不要把任意公网实例当作开放 SSRF 入口
- 暴露在公网时请使用最新镜像 / 最新代码

---

## 🛠️ 项目结构

```text
schrodinger-portal/
├── public/                      # 静态资源
│   ├── avatar.jpg               # 默认头像 / Apple Touch Icon
│   ├── favicon.svg              # 浏览器 Favicon
│   └── icons/                   # 可选本地图标
├── config/
│   └── projects.example.json    # 公开示例配置（复制为 projects.json）
├── docs/screenshots/            # README 真实界面截图
├── shared/                      # 前后端共用小工具（转义 / URL / 问候 / favicon / SSRF / 可用率条）
├── lib/                         # 服务端模块：探测历史、通知、配置写入、图标抓取
├── test/                        # node:test 单元测试
├── src/
│   ├── data/defaultConfig.js    # 前端默认配置
│   ├── services/pingService.js  # 前端探针客户端
│   ├── app.js                   # 前端交互与状态
│   └── style.css                # Vanilla CSS
├── index.html                   # 主页
├── status.html                  # 公开状态页
├── server.js                    # 生产静态服务 + SSR + 探针 API
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
└── README.md
```

---

## ⌨️ 快捷键

| 快捷键 | 功能 |
| :--- | :--- |
| `Ctrl + K` / `Cmd + K` | 打开 Spotlight 搜索 |
| `↑` / `↓` | 搜索结果导航 |
| `Enter` | 打开所选服务 |
| `ESC` | 关闭弹窗 |

---

## 🤝 参与贡献

欢迎提交 Issue 与 Pull Request。

1. Fork 本仓库
2. 创建分支 (`git checkout -b feature/AmazingFeature`)
3. 提交修改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送分支 (`git push origin feature/AmazingFeature`)
5. 开启 Pull Request

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 协议开源。
