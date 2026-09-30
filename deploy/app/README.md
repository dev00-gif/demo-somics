# Deploy app Next.js (MQTT Station) lên Dokploy

> File liên quan: `Dockerfile` (root) · `.dockerignore` · `src/app/api/health/route.ts`

App gồm FE (nút upload + form bản tin) và BE (API routes `/api/upload`, `/api/announcement`, `/api/broker-status`) trong cùng 1 image. BE publish MQTT tới EMQX đã deploy ở `deploy/emqx/`.

> **Chạy thử full stack ngoài Dokploy?** Dùng `docker-compose.yml` ở root repo:
> sửa mật khẩu trong `.env` (template có sẵn ở root) rồi `docker compose up -d --build` —
> gộp cả EMQX + app trên 1 mạng bridge, app gọi `mqtt://emqx:1883` nội bộ, chờ broker
> healthy trước khi start.

## 1. Cách image hoạt động

| Stage | Việc | Kết quả |
|---|---|---|
| `deps` | `npm ci` | Cache node_modules — chỉ build lại khi `package*.json` đổi |
| `builder` | `next build` với `output: "standalone"` | `.next/standalone/server.js` + static files |
| `runner` | node:22-alpine, user `nextjs` non-root | Image nhỏ (~180MB), healthcheck `/api/health` mỗi 30s |

Build-time chỉ dùng biến placeholder cho `MQTT_*` (Next.js inlines env lúc build với code client, nhưng các biến MQTT chỉ được đọc ở **server runtime** trong API routes nên inject lúc runtime là đủ và đúng).

## 2. Deploy trên Dokploy — từng bước

1. Commit code (kèm `Dockerfile`, `.dockerignore`, thư mục `public/`) lên GitHub.
2. Dokploy → Project → **Create Service → Application**.
3. Tab **General**:
   - **Source Type**: GitHub → chọn repo + branch `main`.
   - **Build Type**: **Dockerfile** (Dokploy tự nhận `Dockerfile` ở root; nếu khác path thì ghi rõ).
   - Watch paths (tùy chọn): thêm để chỉ redeploy khi thay đổi `src/**`, `Dockerfile`, `package*.json`.
4. Tab **Environment** — thêm biến (xem `.env.example`):

   **Cách A — BE chạy cùng Dokploy với EMQX (khuyến nghị):**
   ```bash
   MQTT_URL=mqtt://emqx:1883
   MQTT_USERNAME=web-backend
   MQTT_PASSWORD=<giá trị MQTT_APP_PASSWORD — đồng bộ qua service emqx-init>
   MQTT_TOPIC_BASE=station/player
   MQTT_CLIENT_ID_PREFIX=web-uploader
   NODE_ENV=production
   ```

   **Cách B — EMQX chạy nơi khác:** `MQTT_URL=mqtt://<VPS_IP>:1883` và mở port 1883 + firewall.

5. **Quan trọng — nối mạng với EMQX**: service app phải ở cùng mạng `dokploy-network` với EMQX thì mới resolve được hostname `emqx`.
   - Nếu cả 2 tạo trong **cùng project Dokploy**: mặc định Dokploy đã cho các service trong cùng project thấy nhau qua `dokploy-network` — hostname là **service name** của EMQX trong Dokploy (vd nếu service tên `emqx-broker` thì URL là `mqtt://emqx-broker:1883` — tên service Dokploy, KHÔNG phải alias `mqtt` trong compose, vì alias chỉ hiệu lực với container network nội bộ compose).
   - Nếu tạo ở **khác project**: vào service app → **Advanced → Networks** → thêm `dokploy-network` (Dokploy tạo sẵn và share toàn cục).
   - Mẹo kiểm tra: SSH vào VPS chạy
     ```bash
     docker exec -it <container-app> sh -c "node -e \"require('net').createConnection(1883,'emqx').on('connect',()=>{console.log('OK');process.exit(0)})\""
     ```
     (thay `emqx` bằng tên service thực tế). Hoặc đơn giản hơn — bấm **Deploy** rồi xem log `/api/broker-status` trả về gì.
6. Tab **Domains** → **Add Domain**:
   - Domain: `mqtt-station.yourdomain.com` (DNS A record → VPS).
   - Port: `3000`, HTTPS: **Let's Encrypt**.
7. **Deploy** → chờ build xong. Verify:
   - `https://<domain>/api/health` → `{"ok":true,...}`
   - `https://<domain>/api/broker-status` → `{"connected":true,...}`
   - Mở trang chủ → gửi thử 1 bản tin → xem Dashboard EMQX (Access Control → là sees clients) hoặc MQTTX sub `station/player/#`.

## 3. Cập nhật ứng dụng

- Push code mới lên `main` → Dokploy auto-deploy (nếu bật Auto Deploy) hoặc bấm **Deploy** tay.
- Docker build cache: layer `deps` chỉ chạy lại khi `package*.json` đổi → build lại nhanh.
- Rollback: tab **Deployments** → chọn bản cũ → **Redeploy**.
- Tự động: workflow `.github/workflows/deploy.yml` trigger mỗi khi push lên `main` (mục 4 bên dưới).

## 4. Kết hợp với docker-compose của EMQX

Khuyến nghị 2 service riêng biệt (EMQX = Docker Compose service, App = Application service) trong cùng 1 project Dokploy:

```
Project "mqtt-system"
├── emqx-broker   (Docker Compose — deploy/emqx/docker-compose.yml)
└── mqtt-station  (Application — Dockerfile root)
```

Lý do tách: EMQX ít thay đổi (redeploy hiếm, giữ state), app thay đổi thường xuyên (CI/CD mỗi commit). GitHub Actions: workflow duy nhất `.github/workflows/deploy.yml` — pipeline gồm 5 bước:

1. **Validate secrets** — fail sớm với hướng dẫn nếu thiếu `DOKPLOY_URL` / `DOKPLOY_API_KEY` / `DOKPLOY_COMPOSE_ID`
2. **Trigger deploy** — `POST /api/compose.deploy` (service Docker Compose gộp)
3. **Poll trạng thái** — hỏi `/api/compose.readStatus` tối đa 10 phút (best-effort)
4. **Health check** — poll `/api/health` trên domain public (tùy chọn qua secret `HEALTH_CHECK_URL`)
5. **Summary** — bảng kết quả trong tab Summary của run

**Secrets cần cấu hình** (GitHub → Settings → Secrets and variables → Actions):

| Secret | Giá trị | Bắt buộc |
|---|---|---|
| `DOKPLOY_URL` | `https://<domain-dokploy>` (không có `/` cuối) | ✅ |
| `DOKPLOY_API_KEY` | API key từ Dokploy: avatar → Profile → API Keys | ✅ |
| `DOKPLOY_COMPOSE_ID` | ID của service Docker Compose (xem trong URL khi mở service) | ✅ |
| `HEALTH_CHECK_URL` | `https://mqtt-station.yourdomain.com/api/health` | tùy chọn |

Lấy `DOKPLOY_COMPOSE_ID` nhanh bằng:

```bash
curl -s "https://<domain-dokploy>/api/project.all" -H "x-api-key: <key>" \
  | jq '.. | objects | select(has("composeId")) | {name, composeId}'
```

## 5. Troubleshooting

| Hiện tượng | Xử lý |
|---|---|
| `/api/broker-status` → `connected: false` | Xem log app: `[mqtt] reconnecting...` → sai `MQTT_URL`/credentials hoặc app chưa cùng mạng với EMQX (mục 2, bước 5). Log `[mqtt] connected` = OK. |
| Build fail ở `npm ci` | Commit `package-lock.json` lên repo. |
| Container unhealthy liên tục | Xem log app trong Dokploy; thường do thiếu biến env MQTT. |
| Upload file >1MB lỗi 413 | Không liên quan Docker — do body limit; route handler Next.js 15 mặc định OK với 20MB, kiểm tra reverse proxy (Dokploy dùng Traefik/Caddy, mặc định không giới hạn). |
| 502 từ domain | Port trong tab Domains phải là `3000` (khác thì sửa). |
| Workflow poll `readStatus` luôn timeout | Endpoint/format phản hồi có thể khác giữa các bản Dokploy — pipeline vẫn pass nhờ health check; xem log trực tiếp trong Dokploy UI. |
