# MQTT Station — Gửi bản tin & file nhạc qua MQTT

Ứng dụng **Next.js** (App Router + TypeScript + Tailwind) gồm:

- **FE**: giao diện web có nút upload file nhạc + form gửi bản tin text.
- **BE**: API routes nhận request từ FE, xử lý rồi **publish lên MQTT broker**.
- **Thiết bị nhúng**: subscribe các topic MQTT, nhận bản tin/file, ghép chunk và phát.

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
nano deploy/emqx/emqx/auth-bootstrap.csv  # sửa mật khẩu user MQTT khớp .env
docker compose up -d --build
```

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

## Biến môi trường (`.env.local`)

| Biến | Ý nghĩa | Mặc định |
|---|---|---|
| `MQTT_URL` | URL broker (ws/wss/mqtt/tcp) | `ws://broker.emqx.io:8083/mqtt` |
| `MQTT_USERNAME` | Tên đăng nhập (nếu có) | — |
| `MQTT_PASSWORD` | Mật khẩu (nếu có) | — |
| `MQTT_CLIENT_ID_PREFIX` | Tiền tố client ID | `web-uploader` |
| `MQTT_TOPIC_BASE` | Gốc của các topic | `station/player` |

## API

| Method | Endpoint | Body | Mô tả |
|---|---|---|---|
| `POST` | `/api/announcement` | JSON `{ title, content, priority? }` | Publish bản tin text |
| `POST` | `/api/upload` | FormData `file=<File>` | Publish file nhạc (chia chunk) |
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

### 2. Truyền file nhạc gồm 3 bước

**Bước 1 — `station/player/file/meta`** (JSON, QoS 1): thông tin file, gửi trước.

```json
{
  "id": "uuid",
  "fileName": "bai-hat.mp3",
  "mimeType": "audio/mpeg",
  "size": 1048576,
  "chunkSize": 32768,
  "totalChunks": 32,
  "sha256": null,
  "uploadedAt": "2026-09-30T09:00:00.000Z"
}
```

**Bước 2 — `station/player/file/chunk`** (binary, QoS 1): từng chunk.

```
[ 4 bytes: chunk index (big-endian uint32) ][ dữ liệu nhị phân ≤ 32KB ]
```

→ Bên nhúng dùng 4 bytes đầu để ghép đúng thứ tự, đủ `totalChunks` chunk là xong.

**Bước 3 — `station/player/file/end`** (JSON, QoS 1): báo hoàn tất.

```json
{ "id": "uuid", "fileName": "bai-hat.mp3", "totalChunks": 32, "size": 1048576 }
```

### 3. `station/player/control` (JSON, tùy chọn)

Đặt lệnh điều khiển phát: `{ "action": "play" | "stop" | "skip", ... }`.

## Ghi chú kỹ thuật

- **MQTT client singleton**: BE giữ 1 kết nối dài hạn tới broker, chia sẻ cho mọi API routes, tự reconnect mỗi 5s khi broker restart/mất mạng (xem `src/lib/mqtt.ts`). Cache trên `globalThis` để an toàn với hot-reload của Next.js dev.
- Chunk 32KB an toàn với broker mặc định giới hạn packet 1MB; chỉnh `CHUNK_SIZE` trong `src/lib/mqtt.ts` nếu broker cho phép lớn hơn.
- QoS 1 đảm bảo message đến ít nhất 1 lần; bên nhúng nên dedupe bằng `id` + `chunk index`.
- File lớn hơn 20MB bị từ chối ở cả FE lẫn BE.
