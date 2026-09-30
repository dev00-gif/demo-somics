# MQTT Station — Gửi bản tin & file nhạc qua MQTT

Ứng dụng **Next.js** (App Router + TypeScript + Tailwind) gồm:

- **FE**: giao diện web có nút upload file nhạc + form gửi bản tin text.
- **BE**: API routes nhận request từ FE, xử lý rồi **publish lên MQTT broker**.
- **MQTTX Web**: web client MQTT (connect/subscribe/publish trên browser) cho bên nhúng/QA.
- **Thiết bị nhúng**: subscribe topic MQTT, nhận bản tin/URL file, tải file và phát.

```
┌─────────┐    HTTP POST     ┌──────────┐     MQTT publish     ┌──────────────┐
│   FE    │ ───────────────▶ │ BE (Next)│ ───────────────────▶ │ MQTT Broker  │
│ (web UI)│                  │ API route│                      │              │
└─────────┘                  └──────────┘                      └──────┬───────┘
                                                                      │ subscribe
                                                                      ▼
                                                               ┌──────────────┐
                                                               │ Thiết bị nhúng│
                                                               │ (ESP32/RTOS) │
                                                               └──────────────┘
```

## Cài đặt & chạy

### Cách 1 — Full stack với Docker (broker + app, 1 lệnh)

```bash
nano .env                       # điền mật khẩu thật (openssl rand -base64 24)
docker compose up -d --build
```

Password user MQTT nằm hoàn toàn trong `.env` (không commit): mỗi lần deploy,
service `emqx-init` tự gọi EMQX API tạo/cập nhật user từ `MQTT_APP_PASSWORD`
(web-backend, superuser) và `MQTT_DEVICE_PASSWORD` (device-01, device-02).

> **Trên Dokploy:**
> - Không cần file `.env` — paste biến vào tab **Environment** của service (tùy chọn, compose có default).
> - App **không publish port** ra host (tránh đụng port 3000 của Dashboard Dokploy) — truy cập qua
>   **Domains** tab: thêm domain, port `3000`, service `app`, HTTPS Let's Encrypt. App đã join
>   `dokploy-network` sẵn trong compose.
> - Chạy ngoài Dokploy (VPS thuần): uncomment dòng ports 3000 trong compose và xóa
>   `dokploy-network` nếu chưa có.

→ App: `http://localhost:3000` · Dashboard EMQX: `ssh -L 18083:127.0.0.1:18083 <vps>` rồi mở `http://localhost:18083`

### Cách 2 — Dev local (app chạy npm, broker ngoài)

```bash
npm install
cp .env.example .env.local   # chỉnh MQTT_URL nếu cần (file .env ở root dành cho compose)
npm run dev                  # http://localhost:3000
```

Mặc định dùng broker public `ws://broker.emqx.io:8083/mqtt` để test nhanh.
Production nên đổi sang broker riêng (EMQX, HiveMQ, Mosquitto...).

### Deploy production lên Dokploy

Xem `deploy/app/README.md` (app) và `deploy/emqx/README.md` (broker) — khuyến nghị
deploy 2 service riêng để redeploy app không restart broker.

## MQTTX Web — giao diện MQTT client cho bên nhúng/QA

Compose đã kèm **MQTTX Web** (`emqx/mqttx-web`) — web client MQTT chính thức của EMQX,
chạy trên browser: connect, subscribe, publish không cần cài gì.

**Setup 1 lần trên Dokploy:**

1. Deploy lại compose (có service mới `mqttx-web`).
2. Service → **Domains** → **Add Domain** thứ 2:
   - Domain: `mqtt-client.<domain>` (DNS A record → VPS)
   - Service Name: chọn `mqttx-web`
   - Container Port: `80` (MQTTX Web là static web, chạy port 80 trong container)
   - HTTPS: bật

**Bên nhúng dùng:**

1. Mở `https://mqtt-client.<domain>`
2. **New Connection**:
   - Host: `ws://<IP-VPS>` · Port: `8083` (WebSocket — browser không nối TCP 1883 được)
   - Username: `device-01` · Password: giá trị `MQTT_DEVICE_PASSWORD` trong `.env` (mặc định `123123`)
3. Subscribe `station/player/#` → nhận bản tin + URL tải file nhạc realtime
4. Publish thử lên `station/player/control` nếu thiết bị có xử lý lệnh điều khiển

> WS listener 8083 đã bật sẵn trong compose (`EMQX_LISTENERS__WS__DEFAULT__BIND`).
> Nếu muốn qua HTTPS domain riêng cho broker: dùng `wss://` + port 443 qua Traefik (cần TLS cert).

## Biến môi trường (`.env.local`)

| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `MQTT_URL` | URL broker (ws/wss/mqtt/tcp) | `ws://broker.emqx.io:8083/mqtt` |
| `MQTT_USERNAME` | Tên đăng nhập (nếu có) | — |
| `MQTT_PASSWORD` | Mật khẩu (nếu có) | — |
| `MQTT_CLIENT_ID_PREFIX` | Tiền tố client ID | `web-uploader` |
| `MQTT_TOPIC_BASE` | Gốc của các topic | `station/player` |
| `APP_PUBLIC_URL` | Domain public của app để tạo URL tải file | tự suy ra từ request |

## API

| Method | Endpoint | Body | Mô tả |
|---|---|---|---|
| `POST` | `/api/announcement` | JSON `{ title, content, priority? }` | Publish bản tin text |
| `POST` | `/api/upload` | FormData `file=<File>` | Upload file và publish URL tải file |
| `GET` | `/api/broker-status` | — | Kiểm tra kết nối broker |

## Hợp đồng MQTT cho bên nhúng (embedded)

Base topic: `station/player` (đổi qua `MQTT_TOPIC_BASE` nếu muốn).

### Kết nối từ thiết bị nhúng

- Trong mạng tin cậy: `mqtt://<VPS>:1883`
- Qua Internet (khuyến nghị): `mqtts://<VPS>:8883` (TLS) — xem `deploy/emqx/README.md` mục 8 để tạo chứng chỉ bằng `deploy/emqx/certs/gen-certs.sh`

### 1. `station/player/announcement` (JSON, QoS 1)

```json
{
  "type": "announcement",
  "id": "uuid",
  "title": "Tiêu đề",
  "content": "Nội dung thông báo",
  "priority": "normal",
  "sender": "web-frontend",
  "createdAt": "2026-09-30T09:00:00.000Z"
}
```

### 2. `station/player/file/available` (JSON, QoS 1)

Khi upload file nhạc, BE lưu file trên web server rồi publish JSON chứa URL tải file:

```json
{
  "type": "file",
  "delivery": "http",
  "id": "uuid",
  "fileName": "bai-hat.mp3",
  "mimeType": "audio/mpeg",
  "size": 1048576,
  "sha256": "hex_sha256",
  "downloadUrl": "https://station.example.com/api/files/uuid",
  "uploadedAt": "2026-09-30T09:00:00.000Z"
}
```

Thiết bị subscribe `station/player/#`, khi nhận `type=file` thì HTTP GET `downloadUrl`,
kiểm tra `sha256` nếu cần, rồi phát/lưu file.

### 3. `station/player/control` (JSON, tùy chọn)

Đặt lệnh điều khiển phát: `{ "action": "play" | "stop" | "skip", ... }`.

## Ghi chú kỹ thuật

- **MQTT client singleton**: BE giữ 1 kết nối dài hạn tới broker, chia sẻ cho mọi API routes, tự reconnect mỗi 5s khi broker restart/mất mạng (xem `src/lib/mqtt.ts`). Cache trên `globalThis` để an toàn với hot-reload của Next.js dev.
- QoS 1 đảm bảo message đến ít nhất 1 lần; bên nhúng nên dedupe bằng `id`.
- File lớn hơn 20MB bị từ chối ở cả FE lẫn BE.
- Set `APP_PUBLIC_URL=https://<domain-app>` khi deploy để `downloadUrl` là URL public cho thiết bị nhúng. Nếu bỏ trống, app tự suy ra từ request upload.
