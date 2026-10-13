# Hướng dẫn kết nối thiết bị IoT với SOMICS

Bên IoT cần kết nối Internet, gọi API kích hoạt để nhận tài khoản MQTT, lưu tài khoản vào bộ nhớ bền vững, rồi kết nối broker để nhận lệnh và gửi trạng thái. Kết nối hoàn tất khi thiết bị subscribe được topic nhận lệnh và website hiển thị thiết bị Online sau khi nhận heartbeat.

Tài liệu này tập trung vào kết nối. Các domain, mã kích hoạt và mật khẩu trong ví dụ là giá trị minh họa; thay bằng thông tin team backend bàn giao.

## Thông tin cần nhận từ team backend

| Thông tin | Bên IoT dùng để làm gì |
|---|---|
| `APP_BASE_URL`, ví dụ `https://station.example.com` | Địa chỉ public của backend để gọi API; cấu hình riêng trong firmware, không có trong response kích hoạt. |
| `deviceId`, ví dụ `SOMICS-000001` | ID đã được tạo trên hệ thống; dùng 3–64 ký tự A–Z, 0–9 và dấu gạch ngang, bắt đầu bằng chữ hoặc số. |
| `activationCode` | Mã dành riêng cho `deviceId`, chưa sử dụng; backend cấp sau khi tạo thiết bị. |
| CA certificate của broker nếu dùng CA riêng | Firmware dùng để xác minh chứng chỉ server khi kết nối MQTT TLS. |
| Cấu hình kết nối dự kiến | Backend xác nhận domain/IP public, port và TLS đúng với broker đang chạy. Firmware lấy giá trị chính thức từ response kích hoạt. |

Trước khi bàn giao, team backend cần cấu hình `MQTT_PUBLIC_HOST`, `MQTT_PUBLIC_PORT`, `MQTT_PUBLIC_TLS` và xác nhận thiết bị truy cập được host/port đó từ mạng của mình. **Hai file Docker Compose trong repo đang comment các dòng cấu hình, publish port và mount certificate cho TLS 8883.** Nếu trả `mqttPort: 8883` và `mqttTls: true`, backend phải bật listener TLS tương ứng trước. Xem [hướng dẫn bật TLS cho broker](../deploy/emqx/README.md#8-mqtt-tls--port-8883-khuyến-nghị-cho-thiết-bị-nhúng).

Firmware cần có HTTP client, MQTT client, khả năng đọc JSON và bộ nhớ NVS/flash để lưu credential. Khi dùng TLS, cấu hình CA tin cậy, kiểm tra hostname và đồng bộ thời gian của thiết bị để kiểm tra hiệu lực chứng chỉ. Không dùng hostname Docker nội bộ `emqx` làm địa chỉ broker cho thiết bị ngoài server.

## Trình tự kết nối

```text
Kết nối WiFi hoặc LAN hoặc 4G
    → Chưa có credential: gọi API kích hoạt rồi lưu credential
    → Đã có credential: đọc credential đã lưu
    → Kết nối MQTT bằng host, port, TLS, username và password
    → Subscribe commandTopic
    → Publish heartbeat vào statusTopic ngay khi sẵn sàng
    → Tiếp tục gửi heartbeat mỗi 30 giây và nhận lệnh
```

### Kích hoạt lần đầu

Gọi `POST {APP_BASE_URL}/api/iot/activate`, với header `Content-Type: application/json`. `deviceId` và `activationCode` là bắt buộc; `firmwareVersion` là tùy chọn.

```json
{
  "deviceId": "SOMICS-000001",
  "activationCode": "ABCD-EFGH-JKMN",
  "firmwareVersion": "1.0.0"
}
```

Ví dụ gọi bằng curl trên máy tính để kiểm tra API:

```bash
APP_BASE_URL='https://station.example.com'
curl --request POST "$APP_BASE_URL/api/iot/activate" \
  --header 'Content-Type: application/json' \
  --data '{"deviceId":"SOMICS-000001","activationCode":"ABCD-EFGH-JKMN","firmwareVersion":"1.0.0"}'
```

**Dùng một thiết bị test khi chạy curl.** Gọi thành công sẽ dùng hết mã kích hoạt giống như firmware gọi. Nếu đã kích hoạt trên máy tính, phải đưa credential nhận được vào thiết bị hoặc nhờ backend cấp mã mới trước khi kích hoạt bằng firmware.

Response thành công có HTTP `200` và `ok: true`. Ví dụ rút gọn:

```json
{
  "ok": true,
  "mqtt": {
    "mqttHost": "mqtt.example.com",
    "mqttPort": 8883,
    "mqttTls": true,
    "username": "SOMICS-000001",
    "password": "<MQTT_PASSWORD_DUOC_CAP>",
    "commandTopic": "station/player/device/SOMICS-000001/command",
    "statusTopic": "station/player/device/SOMICS-000001/status"
  }
}
```

Lưu `deviceId` cùng toàn bộ object `mqtt` vào NVS/flash **trước khi kết nối MQTT**. Mã kích hoạt chỉ dùng một lần và API không trả lại password đã cấp. Sau khi reboot hoặc mất mạng, đọc credential đã lưu để kết nối lại; không kích hoạt lại mỗi lần khởi động. Không ghi password vào log.

Nếu request kích hoạt bị timeout, backend có thể đã dùng mã và cấp credential nhưng thiết bị chưa nhận được response. Nếu thử lại nhận HTTP `409` và không có credential đã lưu, nhờ team backend cấp mã mới cho cùng `deviceId` qua luồng reprovision.

### Kết nối MQTT

Đọc trực tiếp các trường trong `mqtt`; không hardcode domain, port, password hoặc topic.

| Cấu hình MQTT client | Giá trị |
|---|---|
| Host | `mqtt.mqttHost`, chỉ domain/IP, không thêm đường dẫn HTTP. |
| Port | `mqtt.mqttPort`. |
| Transport | `mqtt.mqttTls = true`: MQTT qua TLS, dạng URL `mqtts://host:port`; `false`: MQTT TCP, dạng `mqtt://host:port`. |
| Username | `mqtt.username`. |
| Password | `mqtt.password`. Mã kích hoạt không phải password MQTT. |
| Client ID | Một ID riêng cho mỗi client; có thể dùng `deviceId` cho firmware và `deviceId` kèm hậu tố `-test` cho máy test. |
| Keepalive | Có thể dùng 30 giây. |
| Reconnect | Có thể thử lại sau 5 giây khi mất mạng hoặc broker ngắt kết nối. |

Nếu broker dùng CA riêng, nạp đúng CA được bàn giao. Cấu hình TLS một chiều trong repo dùng username/password để xác thực thiết bị; không yêu cầu client certificate nếu backend giữ cấu hình đó.

Chỉ thực hiện bước tiếp theo sau khi MQTT CONNECT thành công. Sau mỗi lần reconnect, đăng ký lại topic và gửi heartbeat mới.

### Subscribe lệnh và publish heartbeat

| Chiều dữ liệu | Topic | Cách gửi nhận |
|---|---|---|
| Backend → IoT | `mqtt.commandTopic` | Thiết bị subscribe với QoS `1`; nhận payload JSON. Backend gửi lệnh với QoS `1`, `retain: false`. |
| IoT → backend | `mqtt.statusTopic` | Thiết bị publish JSON với QoS `1`, `retain: false`, ngay sau khi subscribe thành công và mỗi 30 giây. |

Ví dụ heartbeat khi thiết bị sẵn sàng:

```json
{
  "deviceId": "SOMICS-000001",
  "state": "IDLE"
}
```

Firmware dùng đúng `commandTopic` và `statusTopic` được trả về, vì topic gốc có thể thay đổi theo cấu hình backend. Chỉ subscribe topic command của thiết bị và publish vào topic status của thiết bị; không subscribe `station/player/#` bằng tài khoản được cấp cho thiết bị.

Backend cập nhật `lastSeenAt` khi nhận message trên status topic. Website coi thiết bị Online nếu heartbeat gần nhất **cách thời điểm hiện tại dưới 120 giây**; ngừng heartbeat từ 120 giây trở lên sẽ chuyển Offline ở lần cập nhật danh sách tiếp theo. MQTT keepalive không thay thế heartbeat JSON. Tiếp tục gửi heartbeat ngay cả khi không có lệnh hoặc đang tải/phát file.

## Test kết nối bằng MQTTX Desktop

Có thể dùng [MQTTX Desktop](https://mqttx.app/docs) để thử kết nối MQTT/MQTTS, subscribe và publish trước khi chạy firmware.

1. Kích hoạt một thiết bị test và giữ lại response `mqtt`.
2. Tạo kết nối trong MQTTX Desktop với host, port, username, password từ response. Dùng Client ID riêng, ví dụ `SOMICS-000001-test`.
3. Nếu `mqttTls: true`, chọn MQTT qua TLS và cấu hình CA phù hợp; giữ kiểm tra chứng chỉ server. Xem [cách cấu hình TLS trong MQTTX](https://mqttx.app/ja/docs/get-started).
4. Connect rồi subscribe chính xác `commandTopic`, QoS `1`.
5. Publish heartbeat mẫu vào `statusTopic`, QoS `1`, tắt Retain.
6. Kiểm tra website hiện thiết bị Online. Để thử nhận lệnh, chọn thiết bị test trên web rồi gửi một file audio; MQTTX phải nhận được JSON có `type: "file"`, `action: "download"` và `fileId` trên `commandTopic`.

MQTTX Web trong trình duyệt chỉ kết nối qua WebSocket `ws://` hoặc `wss://`; để test MQTT TCP/TLS theo response kích hoạt, dùng bản Desktop. Xem [khác biệt của MQTTX Web](https://mqttx.app/zh/docs/web/get-started).

Nhận được lệnh file xác nhận chiều backend → IoT hoạt động. Khi triển khai tải file, firmware gọi `POST /api/iot/token` bằng `deviceId` và `mqttPassword` để lấy access token, rồi gọi `GET /api/files/:fileId` với `Authorization: Bearer <accessToken>`. Các endpoint trong lệnh file là đường dẫn tương đối, cần ghép với `APP_BASE_URL` của backend. Xem hợp đồng tải file và điều khiển phát trong [README](../README.md#hợp-đồng-mqtt-cho-bên-nhúng-embedded).

## Xử lý lỗi kết nối

Các lỗi HTTP của API kích hoạt có body dạng `{"ok": false, "error": "..."}`. Đọc cả HTTP status và `error` để xử lý.

| Hiện tượng | Bên IoT cần làm gì |
|---|---|
| Kích hoạt trả `400` | Kiểm tra JSON, header và hai trường bắt buộc `deviceId`, `activationCode`. |
| Kích hoạt trả `403` | Nhờ backend xác nhận thiết bị đã được tạo và mã đúng thiết bị, chưa bị thu hồi. |
| Kích hoạt trả `409` | Mã đã dùng. Dùng credential đã lưu; nếu mất credential, nhờ backend cấp mã mới. |
| Kích hoạt trả `502` | Broker hoặc luồng cấp user chưa sẵn sàng; thử lại sau và báo backend nếu lỗi tiếp diễn. |
| MQTT timeout hoặc connection refused | Kiểm tra Internet, DNS, host, port; nhờ backend kiểm tra listener và firewall. Với TLS 8883, xác nhận đã bật cấu hình TLS trên broker. |
| TLS handshake thất bại | Kiểm tra CA, hostname khớp chứng chỉ và thời gian thiết bị. |
| MQTT từ chối username/password | Dùng credential được trả sau kích hoạt; kiểm tra có bị thay credential do kích hoạt lại hay không. |
| MQTT connect được nhưng subscribe/publish bị từ chối | Dùng đúng topic và chiều dữ liệu; nếu vẫn lỗi, nhờ backend kiểm tra ACL của user. |
| MQTT connect được nhưng web vẫn Offline | Kiểm tra heartbeat được publish đúng status topic. Backend có thể chưa khởi tạo MQTT client; gọi `GET {APP_BASE_URL}/api/broker-status?init=1` để khởi tạo và kiểm tra `connected: true`, `ok: true`, rồi gửi heartbeat mới. |
| Reboot làm mất credential | Cần lưu vào NVS/flash; nhờ backend cấp mã mới nếu credential cũ đã mất. |

Firmware tự reconnect khi mất mạng, subscribe lại và tiếp tục heartbeat. Nếu mất credential, backend cấp mã mới cho thiết bị đã tồn tại bằng `POST /api/iot/devices/:deviceId/reprovision`; bên IoT nhận mã mới rồi gọi lại API kích hoạt. Lần kích hoạt mới thay password MQTT, vì vậy cần thay credential đã lưu.

## Điều kiện hoàn tất kết nối

- [ ] Kích hoạt thành công và lưu được toàn bộ credential.
- [ ] MQTT CONNECT thành công, subscribe được `commandTopic`.
- [ ] Publish heartbeat mỗi 30 giây vào `statusTopic`, website hiển thị Online.
- [ ] Nhận được lệnh do web gửi trên `commandTopic`.
- [ ] Reboot vẫn kết nối bằng credential đã lưu, không gọi lại API kích hoạt.
- [ ] Mất mạng rồi có lại mạng thì reconnect, subscribe lại và gửi heartbeat mới.
- [ ] Ngừng heartbeat từ 120 giây trở lên thì website cập nhật Offline.
