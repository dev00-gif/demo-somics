#!/bin/sh
# ==============================================================================
# emqx-init-users — tạo/cập nhật user MQTT từ biến môi trường
#
# Password nằm trong .env / tab Environment Dokploy — KHÔNG nằm trong repo.
# Mỗi lần deploy, container này gọi EMQX HTTP API để tạo/cập nhật user → luôn đồng bộ.
#
# EMQX 6: REST API KHÔNG nhận Basic auth (user/password Dashboard) —
# phải POST /api/v5/login lấy Bearer token trước. Script làm sẵn bước đó.
#
# Biến môi trường (đặt trong tab Environment của Dokploy):
#   DASHBOARD_USERNAME / DASHBOARD_PASSWORD  — login Dashboard lấy token
#   MQTT_DEVICE_PASSWORD  — password chung cho device users
#   MQTT_APP_PASSWORD     — password cho web-backend (superuser)
# Optional:
#   MQTT_APP_USERNAME (default: web-backend)
#   MQTT_DEVICE_USERS (default: "device-01 device-02")
# ==============================================================================
set -eu

HOST="http://emqx:18083"
API="$HOST/api/v5"
DASH_USER="${DASHBOARD_USERNAME:-admin}"
DASH_PASS="${DASHBOARD_PASSWORD:?Set DASHBOARD_PASSWORD}"

APP_USER="${MQTT_APP_USERNAME:-web-backend}"
DEVICE_USERS="${MQTT_DEVICE_USERS:-device-01 device-02}"

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# ----- 1. Chờ EMQX sẵn sàng (tối đa 60s) -------------------------------------
echo "[init] Chờ EMQX API sẵn sàng..."
i=0
until curl -sf "$HOST/status" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -ge 30 ] && { echo "[init] LỖI: EMQX không phản hồi sau 60s"; exit 1; }
  sleep 2
done
echo "[init] EMQX OK"

# ----- 2. Đăng nhập lấy Bearer token (EMQX 6: không còn Basic auth) -----------
LOGIN=$(curl -s -X POST "$API/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$(json_escape "$DASH_USER")\",\"password\":\"$(json_escape "$DASH_PASS")\"}")

# Token nằm trong trường "token" của response
TOKEN=$(echo "$LOGIN" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')

if [ -z "$TOKEN" ]; then
  echo "[init] LỖI: Login Dashboard thất bại. Response: $LOGIN"
  echo "       → DASHBOARD_PASSWORD trong env không khớp password admin broker."
  echo "       → Fix: docker exec <emqx> emqx ctl admins passwd admin '<PW_TRONG_ENV>'"
  exit 1
fi
echo "[init] Đã lấy Bearer token ✓"

AUTH_HEADER="Authorization: Bearer $TOKEN"

# ----- 3. Hàm upsert user ------------------------------------------------------
upsert_user() {
  user="$1"
  pass="$2"
  superuser="$3"

  case "$superuser" in
    true|false) ;;
    *) echo "[init] LỖI: is_superuser không hợp lệ cho $user: $superuser"; exit 1 ;;
  esac

  json_user=$(json_escape "$user")
  json_pass=$(json_escape "$pass")
  update_body="{\"password\":\"$json_pass\",\"is_superuser\":$superuser}"
  create_body="{\"user_id\":\"$json_user\",\"password\":\"$json_pass\",\"is_superuser\":$superuser}"

  http_code=$(curl -s -o /tmp/resp.json -w "%{http_code}" \
    -X PUT "$API/authentication/password_based:built_in_database/users/$user" \
    -H "$AUTH_HEADER" \
    -H "Content-Type: application/json" \
    -d "$update_body")

  case "$http_code" in
    200) echo "[init] ✓ $user đã cập nhật (password từ env)" ;;
    404)
      http_code=$(curl -s -o /tmp/resp.json -w "%{http_code}" \
        -X POST "$API/authentication/password_based:built_in_database/users" \
        -H "$AUTH_HEADER" \
        -H "Content-Type: application/json" \
        -d "$create_body")

      case "$http_code" in
        201) echo "[init] ✓ $user đã tạo (password từ env)" ;;
        *)
          echo "[init] ✗ $user thất bại khi tạo (HTTP $http_code): $(cat /tmp/resp.json)"
          exit 1
          ;;
      esac
      ;;
    *)
      echo "[init] ✗ $user thất bại (HTTP $http_code): $(cat /tmp/resp.json)"
      exit 1
      ;;
  esac
}

# ----- 4. Device users (không superuser) --------------------------------------
for u in $DEVICE_USERS; do
  [ -z "$MQTT_DEVICE_PASSWORD" ] && { echo "[init] LỖI: MQTT_DEVICE_PASSWORD chưa đặt"; exit 1; }
  upsert_user "$u" "$MQTT_DEVICE_PASSWORD" "false"
done

# ----- 5. App user (superuser) -------------------------------------------------
upsert_user "$APP_USER" "${MQTT_APP_PASSWORD:?Set MQTT_APP_PASSWORD}" "true"

echo "[init] Hoàn tất — user MQTT đồng bộ từ biến môi trường."
