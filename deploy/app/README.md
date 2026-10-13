# Deploy app Next.js (MQTT Station) lên Dokploy

> File liên quan: `Dockerfile` (root) · `.dockerignore` · `src/app/api/health/route.ts`

App gồm FE (nút upload + form bản tin) và BE (API routes `/api/upload`, `/api/announcement`, `/api/broker-status`) trong cùng 1 image. BE publish MQTT tới EMQX đã deploy ở `deploy/emqx/`.

> **Chạy thử full stack ngoài Dokploy?** Dùng `docker-compose.yml` ở root repo:
> sửa mật khẩu trong `.env` (template có sẵn ở root) rồi `docker compose up -d --build` —
> gộp cả EMQX + app trên 1 mạng bridge, app gọi `mqtt://demo-somics-broker:1883` nội bộ,
> chờ broker healthy và `emqx-init` cấp user thành công trước khi start.

## Broker riêng khi chạy cùng somics-mqtt

`demo-somics` giữ broker, database user và volume riêng. `somics-mqtt` dùng mạng
`htttn-mqtt-backend`, alias `htttn-mqtt-broker`, TLS public `8883` và Dashboard host
`18083`. Demo dùng alias `demo-somics-broker`, TCP public `1883` và Dashboard host
`18084`. Nếu bật TLS demo, publish host port `8884` vào listener container `8883`,
đặt `MQTT_PUBLIC_PORT=8884`, `MQTT_PUBLIC_TLS=true` và chứng chỉ khớp domain demo.

Không trỏ app demo tới alias/domain của `somics-mqtt`: broker đó dùng credential
và ACL `htttn/devices/...`, còn demo dùng `station/player/device/...`.
Đặt `MQTT_PUBLIC_HOST` thành IP/domain của broker demo trước khi kích hoạt thiết bị.
Compose mặc định trả TCP `1883`, TLS `false`, khớp listener demo đang bật.

Dev chạy bằng npm cần `MQTT_URL=mqtt://<VPS_IP>:1883` trong `.env.local`; app có thể
dùng `MQTT_APP_USERNAME`/`MQTT_APP_PASSWORD` có sẵn trong `.env` nếu chưa đặt
`MQTT_USERNAME`/`MQTT_PASSWORD`. Management API demo dùng SSH tunnel sau redeploy:

```bash
ssh -L 18084:127.0.0.1:18084 user@<VPS_IP>
```

Sau đó đặt `EMQX_API_URL=http://127.0.0.1:18084` trong `.env.local` để cấp credential.

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
   MQTT_URL=mqtt://demo-somics-broker:1883
   MQTT_USERNAME=web-backend
   MQTT_PASSWORD=<giá trị MQTT_APP_PASSWORD — đồng bộ qua service emqx-init>
   MQTT_TOPIC_BASE=station/player
   APP_PUBLIC_URL=https://<domain-app>
   MQTT_CLIENT_ID_PREFIX=web-uploader
   NODE_ENV=production
   ```

   **Cách B — EMQX chạy nơi khác:** `MQTT_URL=mqtt://<VPS_IP>:1883` và mở port 1883 + firewall.

5. **Nối mạng với EMQX**: full stack root đã nối app và broker trên `mqtt-net` riêng.
   Nếu deploy app và `deploy/emqx/docker-compose.yml` riêng, cả hai phải cùng
   `dokploy-network`; alias `demo-somics-broker` được khai báo trên mạng đó. Alias
   chỉ resolve trên network nơi nó được khai báo, không phụ thuộc tên project.
   - Mẹo kiểm tra: SSH vào VPS chạy
     ```bash
     docker exec -it <container-app> sh -c "node -e \"require('net').createConnection(1883,'demo-somics-broker').on('connect',()=>{console.log('OK');process.exit(0)})\""
     ```
     Hoặc gọi `/api/broker-status?init=1`: `broker` cho biết endpoint app dùng;
     `error` phân biệt lỗi DNS, credential và timeout. Client ID có UUID để các
     container cùng PID không ngắt kết nối nhau.
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

Nếu broker Healthy nhưng deploy báo `emqx-init ... exit 2`, đọc log riêng của
container init; log Compose chỉ cho biết bước thất bại:

```bash
docker logs demosomics-demosomics-ftbr2y-emqx-init-1 --tail 80
```

Trong Environment của **service Compose demo**, cần `DASHBOARD_USERNAME=admin`,
`DASHBOARD_PASSWORD` là password Dashboard demo hiện tại và `MQTT_APP_PASSWORD`
là password user MQTT app. Dùng `.env.compose.example` cho full stack. Các biến
`EMQX_DASHBOARD_PASSWORD`/`MQTT_PASSWORD` trong template app chạy riêng không thay
thế hai biến Compose này. `.env` trên máy dev được ignore và không tự lên VPS.

Script mới báo rõ biến thiếu, lỗi login 401/403, lỗi API hoặc lỗi đồng bộ user.
Thay env không tự đổi password Dashboard đã lưu trong volume; cần dùng password
hiện tại hoặc đổi password Dashboard qua tài khoản quản trị trước rồi đồng bộ env.
Giữ app chờ init hoàn tất để tránh khởi động với user MQTT chưa được tạo.

| Hiện tượng | Xử lý |
|---|---|
| `/api/broker-status` → `connected: false` | Xem log app: `[mqtt] reconnecting...` → sai `MQTT_URL`/credentials hoặc app chưa cùng mạng với EMQX (mục 2, bước 5). Log `[mqtt] connected` = OK. |
| Build fail ở `npm ci` | Commit `package-lock.json` lên repo. |
| Container unhealthy liên tục | Xem log app trong Dokploy; thường do thiếu biến env MQTT. |
| Upload file >1MB lỗi 413 | Không liên quan Docker — do body limit; route handler Next.js 15 mặc định OK với 20MB, kiểm tra reverse proxy (Dokploy dùng Traefik/Caddy, mặc định không giới hạn). |
| 502 từ domain | Port trong tab Domains phải là `3000` (khác thì sửa). |
| Workflow poll `readStatus` luôn timeout | Endpoint/format phản hồi có thể khác giữa các bản Dokploy — pipeline vẫn pass nhờ health check; xem log trực tiếp trong Dokploy UI. |
