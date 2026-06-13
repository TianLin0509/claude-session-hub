# Hub Mobile · 部署与开发指引

让华为 Mate X6（鸿蒙 NEXT，按安卓兼容方式跑）能给家里 Hub 的 Claude Code 发消息、看回复。

## 架构

```
┌─────────────┐         ┌──────────────────┐         ┌──────────────────┐
│ PWA / 安卓壳 │  WSS    │ VPS Gateway      │  WSS    │ Hub mobile-bridge│
│ (Mate X6)   │ ──────► │ 138.128.192.245  │ ◄────── │ (Windows 家)     │
│             │         │ HTTPS :443       │ outbound│                  │
│             │ ◄────── │ 哑转发 + Pairing │ ──────► │ sessionManager   │
└─────────────┘         └──────────────────┘         └──────────────────┘
```

详见 `docs/superpowers/specs/2026-06-06-hub-mobile-pwa-design.md`。

## 部署步骤（首次）

### 0. 准备

- VPS 已就绪（搬瓦工 138.128.192.245 + sing-box）
- 可选：境外注册商域名（NameSilo 推荐，支持支付宝）。MVP 可以先用 DuckDNS 免费三级域名。
- 家里 Hub Windows 跑着

### 1. 域名解析

**A. 走 DuckDNS（免费，5 分钟）**
```bash
# 浏览器访问 https://www.duckdns.org/，GitHub OAuth 登录
# 注册 lintian-hub.duckdns.org，A 记录指向 138.128.192.245
# 复制 DuckDNS 后台的 token

# VPS 上跑：
mkdir -p /opt/duckdns
cat > /opt/duckdns/duck.sh <<'EOF'
echo url="https://www.duckdns.org/update?domains=lintian-hub&token=YOUR_TOKEN&ip=" | curl -k -o /tmp/duck.log -K -
EOF
chmod +x /opt/duckdns/duck.sh
# crontab 每 5 分钟更新 IP（防 VPS 重启 IP 变）
(crontab -l 2>/dev/null; echo "*/5 * * * * /opt/duckdns/duck.sh >/dev/null 2>&1") | crontab -
```

**B. 走 NameSilo 自有域名**（域名办好之后）
- NameSilo 控制台 → DNS Manager → A 记录 `hub` → `138.128.192.245`，TTL 3600

### 2. VPS 上签 SSL（Let's Encrypt）

```bash
# Ubuntu 22.04
apt update && apt install -y certbot

# 临时停掉占用 443 的服务（sing-box 用 443 的话先停）
systemctl stop sing-box  # 如果在用

# 签证书
certbot certonly --standalone -d lintian-hub.duckdns.org \
  --non-interactive --agree-tos -m peemyqjr5461@hotmail.com

# 证书路径：
#   /etc/letsencrypt/live/lintian-hub.duckdns.org/fullchain.pem
#   /etc/letsencrypt/live/lintian-hub.duckdns.org/privkey.pem
# 自动续期已经写进 /etc/cron.d/certbot
```

**注意**：如果 VPS 443 端口已被 sing-box 占用（VLESS-REALITY），需要：
- 选项 A：把 sing-box 改到其他端口（推荐另起 8443），443 让给 gateway
- 选项 B：gateway 改用 8444 / 9443，PWA 用非标准 HTTPS 端口（地址 https://...:8444）
- 选项 C：在 VPS 前面套一个 nginx，按 SNI/路径分流（443 SNI 路由）

MVP 推荐**选项 A**：sing-box 改 8443，gateway 占 443，PWA 体验最干净。

### 3. 部署 Gateway

```bash
# 在 VPS 上
mkdir -p /opt/hub-mobile-gateway
cd /opt/hub-mobile-gateway

# 把 mobile/vps-gateway/ 和 mobile/shared/ 同步上来
# 用 rsync 或 scp 从家里同步
# 假设 SSH 已配密钥免密
# scp -r mobile/vps-gateway/* root@138.128.192.245:/opt/hub-mobile-gateway/
# scp -r mobile/shared root@138.128.192.245:/opt/hub-mobile-gateway/../shared
# 或者把 shared 复制到 gateway 里：
# cp -r mobile/shared/ mobile/vps-gateway/../shared

# 装依赖
npm install --omit=dev

# 配置环境变量
cat > .env <<EOF
GATEWAY_PORT=443
TLS_CERT_PATH=/etc/letsencrypt/live/lintian-hub.duckdns.org/fullchain.pem
TLS_KEY_PATH=/etc/letsencrypt/live/lintian-hub.duckdns.org/privkey.pem
HUB_BEARER_TOKEN=$(openssl rand -hex 32)
EOF
# 把 .env 里的 HUB_BEARER_TOKEN 复制下来，等下家里 Hub 端要配同样的

# 注册 systemd
cp systemd/hub-mobile-gateway.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now hub-mobile-gateway

# 验证
journalctl -u hub-mobile-gateway -f
# 看到 "[gateway] listening on 443 (wss)" 就成
curl -k https://lintian-hub.duckdns.org/healthz
# 应返回 {"ok":true,"hubOnline":false,"pwaCount":0,...}
```

### 4. 配置家里 Hub

在家里 Windows 上：

```powershell
# 设环境变量（永久，注销重登生效）
[System.Environment]::SetEnvironmentVariable("CLAUDE_HUB_MOBILE_ENABLED", "true", "User")
[System.Environment]::SetEnvironmentVariable("MOBILE_VPS_URL", "wss://lintian-hub.duckdns.org/agent", "User")
# BEARER_TOKEN 用上面 VPS 上生成的同一份
[System.Environment]::SetEnvironmentVariable("MOBILE_BEARER_TOKEN", "<paste-from-vps-env>", "User")

# 或临时（仅本次 powershell 启动 Hub 时生效）：
$env:CLAUDE_HUB_MOBILE_ENABLED = "true"
$env:MOBILE_VPS_URL = "wss://lintian-hub.duckdns.org/agent"
$env:MOBILE_BEARER_TOKEN = "<from-vps-env>"
# 然后启动 Hub
.\node_modules\electron\dist\electron.exe .
```

启动 Hub，看 console 输出有 `[mobile-bridge] connected to wss://...` 就 OK。

### 5. 部署 PWA 静态资源

PWA 静态资源跟 gateway **同源**部署（同一 domain 443）。两种方式：

**A. nginx 前置（推荐）**

```bash
apt install -y nginx
cat > /etc/nginx/sites-available/hub.conf <<'EOF'
server {
    listen 80;
    server_name lintian-hub.duckdns.org;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name lintian-hub.duckdns.org;
    ssl_certificate /etc/letsencrypt/live/lintian-hub.duckdns.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/lintian-hub.duckdns.org/privkey.pem;

    # PWA 静态资源压缩：app.js/styles.css/sw.js 首屏体积直接降一档
    gzip on;
    gzip_vary on;
    gzip_comp_level 6;
    gzip_min_length 1024;
    gzip_types
        text/plain
        text/css
        text/javascript
        application/javascript
        application/json
        application/manifest+json
        image/svg+xml;
    
    # 静态 PWA
    root /opt/hub-mobile-pwa;
    index index.html;
    
    # WSS 走 gateway
    location ~ ^/(agent|pwa)$ {
        proxy_pass http://127.0.0.1:8765;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }
    # POST /api/pair
    location /api/pair {
        proxy_pass http://127.0.0.1:8765;
        proxy_set_header Host $host;
    }
    location /healthz {
        proxy_pass http://127.0.0.1:8765;
    }
}
EOF
ln -sf /etc/nginx/sites-available/hub.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

然后调整 gateway 不再监听 443（让 nginx 跑 443），改成内部 8765：
```bash
# /opt/hub-mobile-gateway/.env
GATEWAY_PORT=8765
GATEWAY_INSECURE=true  # 走 nginx 终结 TLS，gateway 不需要再处理证书
# 删除 TLS_* 两行
systemctl restart hub-mobile-gateway
```

**B. gateway 自己 serve 静态**（不推荐，不灵活）
需要改 server.js 加 static file handler，MVP 不做。

### 6. 同步 PWA 静态资源到 VPS

```bash
# 家里
scp -r mobile/pwa/* root@138.128.192.245:/opt/hub-mobile-pwa/
```

### 7. 配对！

1. 桌面 Hub 启动时 console 看到 `[mobile-bridge] enabled` ✓
2. 在桌面 Hub 任意位置（暂用 console 调用，UI 设置面板 V1+ 才做）：
   ```js
   // 桌面 Hub renderer 的 DevTools console（F12 后）
   const { ipcRenderer } = require('electron');  // 或通过 preload 暴露的 API
   // MVP 简化：直接在 Hub main 进程 console 跑：
   // global.__mobileBridge.generatePin()
   ```
   或者临时在 main.js 加一个键盘快捷键弹出 PIN 显示，详见 TODO。
3. 拿到 6 位 PIN，5 分钟内在手机浏览器打开 `https://lintian-hub.duckdns.org`
4. 输入 PIN → 配对成功 → device token 写入 PWA localStorage
5. 发消息测试 → Hub 端 spawn Claude → 回复显示在 PWA

**临时 PIN 生成办法（M1 阶段，没 UI）**：

```powershell
# 在 Hub main 进程外通过 hook server 触发？暂时手工：
# Hub main.js 启动后，console 里看到 [mobile-bridge] enabled。
# 临时方案：加一行调试代码生成 PIN 并打印（M1 验证用）。
# 后续在 Hub 设置面板加按钮。
```

→ 见 TODO 节。

## 本地开发

### 跑 PWA 静态资源（无 gateway）

```powershell
cd mobile\pwa
python -m http.server 8765
# 访问 http://127.0.0.1:8765
# 配对屏可视化 OK；发消息会停在"连接中…"（无 WSS 端）
```

### 跑 gateway 本地（无 TLS）

```powershell
cd mobile\vps-gateway
$env:HUB_BEARER_TOKEN = "dev-bearer-token-test"
$env:GATEWAY_INSECURE = "true"
$env:GATEWAY_PORT = "9000"
node server.js
# gateway 监听 ws://127.0.0.1:9000
```

### 跑 hub-bridge 联调本地 gateway

```powershell
$env:CLAUDE_HUB_MOBILE_ENABLED = "true"
$env:MOBILE_VPS_URL = "ws://127.0.0.1:9000/agent"
$env:MOBILE_BEARER_TOKEN = "dev-bearer-token-test"
# 启动隔离 Hub（不污染生产）
$env:CLAUDE_HUB_DATA_DIR = "C:\temp\hub-mobile-dev"
.\node_modules\electron\dist\electron.exe . --remote-debugging-port=9333
```

### 跑测试

```powershell
cd mobile\vps-gateway
node --test  # 25 tests

cd ..\hub-bridge
node --test  # 10 tests
```

## TODO（M2+）

- [ ] Hub 设置面板加"添加设备"按钮（调 `global.__mobileBridge.generatePin()`），显示大字 PIN 倒计时 UI
- [ ] Hub 设置面板加"已配对设备列表"（调 `listDevices()` / `revokeDevice()`）
- [ ] PWA artifact 全屏 iframe 渲染
- [ ] PWA 离线返回分隔线
- [ ] PWA 连接状态 4 态颗粒度（已设计，未全部接线）
- [ ] PWA PTY 视图切换
- [ ] Android Wrapper（沉浸全屏 WebView）
- [ ] HMS Push（后台推送）

## 文件结构

```
mobile/
├── shared/
│   └── protocol.js              # 协议常量（MSG/ERR/CONN）
├── vps-gateway/                 # VPS 端（部署到 138.128.192.245）
│   ├── server.js
│   ├── routes/{agent,pwa,pair}.js
│   ├── lib/{auth,relay}.js
│   ├── tests/                   # 25 tests
│   └── systemd/hub-mobile-gateway.service
├── pwa/                         # 静态资源（部署到 /opt/hub-mobile-pwa）
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   ├── sw.js
│   ├── manifest.json
│   └── icons/
├── hub-bridge/                  # 家里 Hub 端模块
│   ├── index.js                 # 入口 startMobileBridge()
│   ├── outbound-client.js       # WSS client（重连/心跳）
│   ├── pair-manager.js          # PIN + device 列表
│   ├── session-binder.js        # 绑定 mobile-default session
│   └── tests/                   # 10 tests
└── README.md                    # 本文件
```

## 安全说明

- 通信全程 WSS over TLS 443
- Hub ↔ VPS：BEARER_TOKEN（32 字节 hex，env 配置）
- PWA ↔ VPS：device_token（128-bit random，配对时颁发）
- PIN：6 位数字，5 分钟有效，一次性消耗，3 次失败 5 分钟冷却（按 IP）
- 消息明文经 VPS（内存路由后丢弃，0 落盘）
- device 列表存 `${HubDataDir}/mobile-devices.json`，可手动 revoke
- VPS gateway 进程 systemd hardening（NoNewPrivileges、ProtectSystem 等）

## 故障排查

| 症状 | 排查 |
|---|---|
| PWA 顶栏卡在"连接中…" | F12 console 看 WSS 连接报错；`curl https://<DOMAIN>/healthz` 看 gateway 是否返回 |
| `healthz` 返回 `hubOnline: false` | 家里 Hub 没启用 mobile-bridge（env 没设？BEARER_TOKEN 不匹配？） |
| PWA 配对显示 "Hub 离线" | 同上 |
| PWA 配对失败 invalid_pin | PIN 输错或过期；让 Hub 重新生成 |
| Hub console 报 `auth failed (4003)` | BEARER_TOKEN 不匹配（家里 vs VPS） |
| Hub console 报 reconnect 循环 | VPS 不可达（防火墙？域名解析飘了？sing-box 占了 443？） |
