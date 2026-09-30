# Deploy EMQX MQTT Broker lên VPS Ubuntu bằng Dokploy

> File liên quan: `docker-compose.yml` · `.env.example` · `scripts/init-users.sh` (cùng thư mục)
>
> **User MQTT**: được tạo/cập nhật qua EMQX API bởi script `init-users.sh` chạy trong
> service `emqx-init` (compose root) — password lấy từ biến môi trường
> `MQTT_APP_PASSWORD` / `MQTT_DEVICE_PASSWORD`, không lưu trong repo.

## 1. Giải thích docker-compose.yml

| Khối | Giá trị | Ý nghĩa |
|---|---|---|
| `image` | `emqx/emqx:6.1.5` (overridable bằng `EMQX_VERSION`) | Bản stable open-source (dòng 6.1, tag mới nhất trên Docker Hub tại thời điểm viết). Ghim patch version để mọi lần deploy giống hệt nhau. |
| `hostname` + `EMQX_NODE_NAME` | `node1.emqx.local` / `emqx@node1.emqx.local` | EMQX lưu data theo node name (`data/mnesia/<node_name>`). Ghim cứng tránh việc container được tạo lại với node name mới (IP container) → **mất toàn bộ user/retained message**. |
| `EMQX_NODE__COOKIE` | chuỗi ngẫu nhiên | Cookie Erlang, bắt buộc khi sau này mở rộng cluster. Phải đổi khỏi giá trị mặc định. |
| `EMQX_DASHBOARD__DEFAULT_USERNAME/PASSWORD` | `admin` / bắt buộc đặt | Tài khoản đăng nhập Dashboard `:18083`. Nếu không đặt, EMQX dùng `admin/public` — cực kỳ nguy hiểm. |
| `EMQX_AUTHENTICATION__1__*` | `password_based` + `built_in_database` | Khai báo authenticator ngay khi boot. **Trong EMQX 5/6, chỉ cần có ≥1 authenticator là mọi kết nối không mang username/password bị từ chối** → đây chính là cách tắt anonymous access (không còn biến `EMQX_ALLOW_ANONYMOUS` như v4). |
| `EMQX_AUTHENTICATION__1__*` | `password_based` + `built_in_database` | Khai báo authenticator khi boot — mọi kết nối không có username/password bị từ chối (tắt anonymous). User được service `emqx-init` nạp qua API sau khi broker lên. |
| `ports: 1883` | `${MQTT_TCP_BIND:-0.0.0.0}:1883:1883` | MQTT TCP cho FE/BE và thiết bị nhúng. Bind ra mọi IP nhưng nên giới hạn bằng firewall. |
| `ports: 18083` | `${DASHBOARD_BIND:-127.0.0.1}:18083:18083` | Dashboard. **Mặc định chỉ bind localhost** → không lộ public; truy cập qua SSH tunnel hoặc gắn domain HTTPS qua Dokploy (mục 7). |
| `volumes` | `emqx_data`, `emqx_log` | Named volume do Docker quản lý: user MQTT, cấu hình, retained messages, log, crash dump sống sót qua restart/redeploy. |
| `healthcheck` | `emqx ctl status` mỗi 30s | Nếu broker treo, container chuyển `unhealthy` → orchestration restart. |
| `restart: unless-stopped` | — | Tự bật lại khi VPS reboot hoặc container crash; trừ khi bạn chủ động `docker stop`. |
| `deploy.resources.limits.memory` | 1g | Chặn broker ăn hết RAM VPS (cần Docker Compose v2 — Dokploy dùng sẵn). |
| `networks: dokploy-network (external)` | — | Join mạng overlay Dokploy tạo sẵn: BE Next.js chạy trong Dokploy gọi thẳng `mqtt://emqx:1883` nội bộ, và Dashboard có thể gắn domain/HTTPS qua Dokploy. |

## 2. Biến môi trường

Copy `.env.example` → `.env` (hoặc dán vào tab **Environment** của service trong Dokploy):

```bash
EMQX_VERSION=6.1.5
EMQX_NODE_HOST=node1.emqx.local
EMQX_NODE_COOKIE=<openssl rand -base64 24>
DASHBOARD_USERNAME=admin
DASHBOARD_PASSWORD=<openssl rand -base64 24>
EMQX_LOG_LEVEL=warning
EMQX_MEM_LIMIT=1g
MQTT_TCP_BIND=0.0.0.0     # 127.0.0.1 nếu chỉ BE nội bộ kết nối
DASHBOARD_BIND=127.0.0.1  # giữ nguyên trừ khi dùng domain qua Dokploy
```

Đặt password user MQTT trong env (tab Environment Dokploy hoặc `.env`):

```bash
MQTT_APP_PASSWORD=<mật khẩu web-backend — superuser>
MQTT_DEVICE_PASSWORD=<mật khẩu chung cho device-01, device-02>
```

> `web-backend` là superuser (pub/sub mọi topic). Thiết bị để thường + giới hạn bằng ACL (Dashboard → Access Control → Authorization) nếu muốn.
> Mỗi lần deploy, `emqx-init` chạy `scripts/init-users.sh` → tạo/cập nhật user qua API → password luôn đồng bộ env, đổi mật khẩu = sửa env + redeploy.

## 3. Các bước deploy trên Dokploy

1. **Commit** thư mục `deploy/emqx/` lên repo.
2. Dokploy UI → **Projects** → tạo/chọn project → **Create Service → Docker Compose**.
3. Đặt tên (vd `emqx-broker`). Trong tab **General**:
   - **Source Type**: chọn Git (repo chứa file compose) hoặc dán trực tiếp nội dung `docker-compose.yml` vào ô compose.
   - Nếu dùng Git: trỏ tới branch + đường dẫn compose file (`deploy/emqx/docker-compose.yml`).
4. Tab **Environment**: dán các biến ở mục 2 (Dokploy inject vào compose khi deploy).
   - **Lưu ý user MQTT**: compose này dùng bootstrap CSV cũ — đã chuyển sang cơ chế `emqx-init` ở compose root. Nếu dùng file này standalone, tự chạy `scripts/init-users.sh` (thay hostname `emqx` bằng tên service) sau khi broker lên.
5. Bấm **Deploy**. Xem log ở tab **Deployments** — chờ tới dòng `EMQX ... is running now!`.
6. Kiểm tra container: SSH vào VPS → `docker ps | grep emqx` (status `Up (healthy)`).
7. Mở port 1883 nếu cần kết nối từ bên ngoài:
   ```bash
   sudo ufw allow from <IP_thiết_bị> to any port 1883 proto tcp
   # hoặc mở rộng: sudo ufw allow 1883/tcp
   ```
   **Không** mở 18083 ra public — dùng SSH tunnel hoặc domain HTTPS (mục 7).

## 4. Kiểm tra EMQX đã hoạt động

### 4.1 Kiểm tra nội bộ (trên VPS)

```bash
# Broker status
docker exec -t emqx /opt/emqx/bin/emqx ctl status
# → EMQX ... is running

# Health của node (dùng cho healthcheck trong compose)
docker exec -t emqx /opt/emqx/bin/emqx ctl health_check

# API trạng thái (chạy trong container)
docker exec -t emqx curl -s http://localhost:18083/status
# → {"node_status":"Running","uptime":...,"version":"..."}
```

### 4.2 SSH tunnel để mở Dashboard trên máy local

```bash
ssh -L 18083:127.0.0.1:18083 user@<VPS_IP>
# Giữ terminal này, mở browser: http://localhost:18083
```

### 4.3 Test publish/subscribe

**Bằng MQTTX (GUI):**
1. New Connection → Host: `<VPS_IP>`, Port: `1883`, ClientID tự do.
2. Username: `device-01`, Password: tương ứng trong CSV.
3. Subscribe topic `station/player/#`.
4. Tạo connection thứ 2 với `web-backend` (superuser) → Publish sang topic `station/player/announcement` với payload:
   ```json
   {"type":"announcement","title":"Test","content":"Xin chào từ BE"}
   ```
5. Connection 1 nhận được message → broker hoạt động đúng, auth đúng.

**Bằng mosquitto CLI (cài `apt install mosquitto-clients`):**

```bash
# Terminal 1 — subscribe (sẽ chờ nhận tin)
mosquitto_sub -h <VPS_IP> -p 1883 -t "station/player/#" \
  -u device-01 -P '<mật khẩu device-01>' -V mqttv5

# Terminal 2 — publish
mosquitto_pub -h <VPS_IP> -p 1883 -t "station/player/announcement" \
  -u web-backend -P '<mật khẩu web-backend>' \
  -m '{"title":"Hello","content":"Tin thử nghiệm"}'
```

**Kiểm chứng anonymous đã bị chặn:**

```bash
mosquitto_pub -h <VPS_IP> -p 1883 -t test -m "no-auth"
# → Connection error: Not authorised (codes 4/5) → anonymous đã tắt đúng
```

**Kiểm tra log:** `docker logs emqx --tail 100` hoặc volume `emqx_log`.

## 5. Cấu hình backend Node.js kết nối tới EMQX

Project Next.js này đã có sẵn `src/lib/mqtt.ts` dùng thư viện `mqtt`. Chỉ cần set env:

- **BE chạy trong Dokploy (khuyến nghị)** — cùng `dokploy-network` với EMQX:
  ```bash
  MQTT_URL=mqtt://emqx:1883          # alias "mqtt" đặt trong compose
  MQTT_USERNAME=web-backend
  MQTT_PASSWORD=<mật khẩu web-backend>
  MQTT_TOPIC_BASE=station/player
  ```
  Khi deploy BE trên Dokploy: service → Environment → thêm 4 biến trên → Deploy. Không cần mở port 1883 ra host.

- **BE chạy ngoài Docker**: `MQTT_URL=mqtt://<VPS_IP>:1883` (phải mở 1883 + firewall).

Mở `.env.local` (dev) theo mẫu `.env.example` ở root project, rồi chạy lại `npm run dev`. FE sẽ hiện log "MQTT broker đã kết nối" trong khung Nhật ký.

> **Kiến trúc connection**: `src/lib/mqtt.ts` dùng MQTT client singleton — 1 kết nối dài hạn tự reconnect (5s/lần), chia sẻ cho mọi API routes. Trạng thái xem qua `GET /api/broker-status?init=1` hoặc log `[mqtt] ...` trong container app.

## 6. Quản lý user MQTT sau khi deploy

Service `emqx-init` chạy mỗi lần deploy để đồng bộ các user khai báo trong env.
Với user ngoài danh sách bootstrap hoặc ACL chi tiết, quản lý qua Dashboard:

1. Truy cập Dashboard (tunnel hoặc domain) → **Access Control → Authentication**.
2. Chọn authenticator `password_based:built_in_database`.
3. **Users** → thêm/xóa/sửa user, bật/tắt superuser.
4. Giới hạn topic cho thiết bị: **Access Control → Authorization** → tạo ACL built-in database, ví dụ chỉ cho `device-*` subscribe `station/player/#` và không publish.

Đổi mật khẩu Dashboard: góc phải trên avatar → **Change Password**.

## 7. Domain + HTTPS cho Dashboard qua Dokploy (tùy chọn)

Thay vì SSH tunnel, có thể expose Dashboard an toàn qua reverse proxy của Dokploy:

1. Trỏ DNS: tạo bản ghi `A` — vd `mqtt-dashboard.yourdomain.com` → `<VPS_IP>`.
2. Trong compose, đổi `DASHBOARD_BIND=0.0.0.0` (hoặc bỏ bind) để port 18083 lắng nghe trên host — **chỉ làm bước này khi đi qua Dokploy domain**, vì vẫn bị public ở mức host; reverse proxy của Dokploy (Traefik/Caddy) sẽ handle HTTPS.
3. Dokploy UI → service **emqx-broker** → tab **Domains** → **Add Domain**:
   - Domain: `mqtt-dashboard.yourdomain.com`
   - Port: `18083`
   - HTTPS: bật **Let's Encrypt** — Dokploy tự cấp và gia hạn chứng chỉ.
   - Service name: `emqx` (container trong compose).
4. Deploy lại. Truy cập `https://mqtt-dashboard.yourdomain.com`.
5. **Bật thêm lớp bảo vệ**: trong EMQX Dashboard → **Settings → General → HTTPS** đã do reverse proxy đảm nhiệm; quan trọng nhất là mật khẩu Dashboard mạnh (bước 2 mục 2) và có thể thêm Basic Auth/IP allowlist ở tầng proxy nếu Dokploy hỗ trợ.

> Nếu không cần truy cập Dashboard từ xa, giữ `DASHBOARD_BIND=127.0.0.1` + SSH tunnel là an toàn nhất (không expose gì thêm).

## 8. MQTT TLS — port 8883 (khuyến nghị cho thiết bị nhúng)

Thiết bị nhúng kết nối qua Internet nên đi qua `mqtts://<VPS>:8883` (TLS encrypt) thay vì `mqtt://:1883` (plain text — chỉ dùng trong mạng tin cậy hoặc nội bộ).

### 8.1 Tạo chứng chỉ

```bash
cd deploy/emqx/certs
./gen-certs.sh <domain-hoặc-IP-của-VPS>   # vd: ./gen-certs.sh 203.0.113.10
```

Script tạo trong cùng thư mục:
- `ca.crt` — copy về thiết bị nhúng (client dùng verify server)
- `server.crt` / `server.key` — broker dùng (đã mount qua compose)

Cert có SAN đúng domain/IP nên client không cần `--insecure`. Thư mục `certs/` đã gitignore private key.

> Có domain thật? Dùng Let's Encrypt thay self-signed:
> `sudo certbot certonly --standalone -d mqtt.example.com` rồi đổi mount trong compose
> tới `/etc/letsencrypt/live/mqtt.example.com/{fullchain.pem,privkey.pem}` (certbot renew cần restart container — thêm cron hoặc deploy hook).

### 8.2 Compose đã bật sẵn gì

- Listener `ssl.default` bind `0.0.0.0:8883`, trỏ tới 3 file cert mount vào `/opt/emqx/etc/certs/`
- Port publish `${MQTT_TLS_BIND:-0.0.0.0}:8883:8883` (điều khiển bằng biến `MQTT_TLS_BIND`)
- One-way TLS: client xác thực bằng username/password (authenticator built-in database vẫn áp dụng cho 8883)

### 8.3 Test TLS

```bash
# MQTTX CLI
mqttx sub -h <VPS> -p 8883 --protocol mqtts --ca ca.crt -u device-01 -P '***' -t 'test'

# mosquitto
mosquitto_sub -h <VPS> -p 8883 --cafile ca.crt -u device-01 -P '***' -t test -V mqttv5

# Kiểm tra handshake thô
openssl s_client -connect <VPS>:8883 -CAfile ca.crt < /dev/null | head -20
```

MQTTX GUI: bật TLS/SSL trong Connection settings → CA file chọn `ca.crt`.

### 8.4 Khóa port 1883 với Internet (sau khi TLS chạy ổn)

```bash
sudo ufw deny 1883/tcp          # hoặc: ufw allow from <IP_tin_cậy> to any port 1883
sudo ufw allow 8883/tcp
```

App BE trong Dokploy vẫn nối `mqtt://emqx:1883` bình thường — traffic nội bộ docker network không qua firewall host.

### 8.5 Nâng lên mTLS (tùy chọn)

Đổi trong compose:

```yaml
EMQX_LISTENERS__SSL__DEFAULT__SSL_OPTIONS__VERIFY: verify_peer
EMQX_LISTENERS__SSL__DEFAULT__SSL_OPTIONS__FAIL_IF_NO_PEER_CERT: "true"
```

Và ký client cert cho từng thiết bị (dùng `ca.key` tạo client cert, trong đó thêm `extendedKeyUsage = clientAuth`). Khi đó thiết bị phải trình cả client cert + key ngoài username/password.

### 8.6 BE Next.js dùng TLS (nếu BE nằm ngoài docker network)

```bash
MQTT_URL=mqtts://<VPS>:8883
MQTT_USERNAME=web-backend
MQTT_PASSWORD=***
```

Với self-signed CA, thêm vào `src/lib/mqtt.ts` options: `ca: fs.readFileSync("ca.crt")` (hoặc `rejectUnauthorized: false` — không khuyến nghị). BE trong docker network giữ nguyên `mqtt://emqx:1883`.

## 9. Troubleshooting

| Hiện tượng | Nguyên nhân & cách xử lý |
|---|---|
| `Not authorised` khi client kết nối | Sai username/password, hoặc user chưa tồn tại. Check Dashboard → Authentication → Users. |
| Mất user sau khi tạo lại container | `EMQX_NODE_NAME`/`hostname` bị đổi → data mnesia thành thư mục khác. Giữ nguyên 2 biến này. |
| User MQTT không tồn tại sau deploy | Service `emqx-init` fail — xem log nó trong Dokploy; thường do `DASHBOARD_PASSWORD` env chưa khớp password admin broker. |
| Container `unhealthy` liên tục | Xem `docker logs emqx`. Thường do RAM thiếu (tăng `EMQX_MEM_LIMIT`) hoặc cookie/node name xung đột. |
| Quên mật khẩu Dashboard | `docker exec -it emqx emqx ctl admins passwd <user> '<new-password>'` (hoặc xóa volume + deploy lại, mất toàn bộ user MQTT). |
| Port 1883 không nối từ ngoài | `sudo ufw status` — chưa mở port, hoặc `MQTT_TCP_BIND=127.0.0.1`. |
| TLS 8883 handshake fail (`certificate verify failed`) | Client chưa có `ca.crt` hoặc sai file — client phải dùng đúng CA đã ký server cert. |
| TLS lỗi `Hostname/IP does not match certificate` | Cert tạo thiếu SAN — chạy lại `./gen-certs.sh <đúng domain/IP client dùng>`. |
| Broker không start sau khi thêm TLS | `docker logs emqx` — thường do thiếu file cert (chưa chạy gen-certs.sh) hoặc key có passphrase. |

## 10. GitHub Actions — deploy tự động

Workflow duy nhất `.github/workflows/deploy.yml` (root repo) trigger khi push lên `main`: gọi `POST /api/compose.deploy` redeploy service Docker Compose gộp (EMQX + app), poll trạng thái rồi health check app.

Cần set **Repository Secrets** (GitHub → Settings → Secrets and variables → Actions):

| Secret | Giá trị |
|---|---|
| `DOKPLOY_URL` | `https://<domain-dokploy-của-bạn>` (không có `/` cuối) |
| `DOKPLOY_API_KEY` | API key tạo ở Dokploy: avatar → **Profile → API Keys** → Create |
| `DOKPLOY_COMPOSE_ID` | ID của service Docker Compose (xem trong URL khi mở service) |
| `HEALTH_CHECK_URL` | (tùy chọn) `https://<domain-app>/api/health` để health check sau deploy |

> Nếu sau này tách EMQX và app thành 2 service riêng (để redeploy app không restart broker), quay lại dùng 2 workflow riêng gọi `compose.deploy` (EMQX) và `application.deploy` (app).
