#!/bin/sh
# Đồng bộ user MQTT trên broker DEMO. Credentials chỉ đọc từ environment.
# DASHBOARD_PASSWORD phải là password Dashboard hiện tại trong data volume.
# Đổi env không tự đổi password Dashboard đã lưu trên broker.
set -eu

fail() {
  printf '[init] LỖI: %s\n' "$*" >&2
  exit 1
}

require_value() {
  [ -n "$2" ] || fail "Thiếu $1 — đặt trong Environment của service Docker Compose demo trên Dokploy, rồi redeploy."
}

HOST="${EMQX_API_URL:-http://emqx:18083}"
HOST="${HOST%/}"
HOST="${HOST%/api/v5}"
API="$HOST/api/v5"
DASH_USER="${DASHBOARD_USERNAME:-admin}"
DASH_PASS="${DASHBOARD_PASSWORD:-}"
APP_USER="${MQTT_APP_USERNAME:-web-backend}"
APP_PASS="${MQTT_APP_PASSWORD:-}"
# Giá trị rỗng chủ động tắt seed user legacy; thiết bị SOMICS được cấp qua API activate.
DEVICE_USERS="${MQTT_DEVICE_USERS-device-01 device-02}"
DEVICE_PASS="${MQTT_DEVICE_PASSWORD:-}"

printf '[init] Kiểm tra cấu hình trước khi gọi EMQX...\n'
require_value DASHBOARD_PASSWORD "$DASH_PASS"
require_value MQTT_APP_PASSWORD "$APP_PASS"
if [ -n "$DEVICE_USERS" ]; then require_value MQTT_DEVICE_PASSWORD "$DEVICE_PASS"; fi
for tool in curl sed mktemp; do
  command -v "$tool" >/dev/null 2>&1 || fail "Image init thiếu công cụ $tool"
done

WORK_DIR=$(mktemp -d) || fail "Không tạo được thư mục tạm cho EMQX response"
trap 'rm -rf "$WORK_DIR"' 0
RESPONSE="$WORK_DIR/response.json"

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

printf '[init] Chờ EMQX API sẵn sàng (tối đa 30 lần)...\n'
i=0
until curl -sf --connect-timeout 2 --max-time 2 "$HOST/status" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 30 ] || fail "EMQX API không phản hồi — kiểm tra EMQX_API_URL, alias demo-somics-broker và network mqtt-net"
  sleep 2
done
printf '[init] EMQX API OK\n'

# Dùng file response riêng và chỉ log bước/HTTP status, không log body/token/password.
request_api() {
  method="$1"
  path="$2"
  body="$3"
  if [ -n "$AUTH_HEADER" ]; then
    set -- -H "$AUTH_HEADER"
  else
    set --
  fi
  if ! HTTP_CODE=$(curl -sS --connect-timeout 3 --max-time 10 \
    -o "$RESPONSE" -w '%{http_code}' -X "$method" "$API$path" \
    -H 'Content-Type: application/json' "$@" -d "$body"); then
    fail "EMQX $method $path không truy cập được — kiểm tra listener API và network của broker demo"
  fi
}

AUTH_HEADER=""
printf '[init] Đăng nhập Dashboard...\n'
request_api POST /login "{\"username\":\"$(json_escape "$DASH_USER")\",\"password\":\"$(json_escape "$DASH_PASS")\"}"
case "$HTTP_CODE" in
  200) ;;
  401|403)
    fail "Login Dashboard HTTP $HTTP_CODE — DASHBOARD_USERNAME/DASHBOARD_PASSWORD không được broker demo chấp nhận. Đổi env không tự đổi password trong volume; dùng password Dashboard hiện tại." ;;
  *) fail "Login Dashboard HTTP $HTTP_CODE — kiểm tra URL API và log broker demo" ;;
esac
TOKEN=$(sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$RESPONSE")
[ -n "$TOKEN" ] || fail "Login HTTP 200 nhưng thiếu token — kiểm tra response API/proxy của broker demo"
AUTH_HEADER="Authorization: Bearer $TOKEN"
printf '[init] Đăng nhập Dashboard thành công\n'

upsert_user() {
  user="$1"
  pass="$2"
  superuser="$3"
  json_user=$(json_escape "$user")
  json_pass=$(json_escape "$pass")
  user_path="/authentication/password_based:built_in_database/users/$user"
  update_body="{\"password\":\"$json_pass\",\"is_superuser\":$superuser}"
  create_body="{\"user_id\":\"$json_user\",\"password\":\"$json_pass\",\"is_superuser\":$superuser}"

  request_api PUT "$user_path" "$update_body"
  if [ "$HTTP_CODE" = 404 ]; then
    request_api POST /authentication/password_based:built_in_database/users "$create_body"
    # Một tiến trình init khác có thể vừa tạo user sau lần PUT đầu.
    if [ "$HTTP_CODE" = 409 ]; then request_api PUT "$user_path" "$update_body"; fi
  fi
  case "$HTTP_CODE" in
    200|201|204) printf '[init] User %s đã đồng bộ\n' "$user" ;;
    401|403) fail "Đồng bộ user $user HTTP $HTTP_CODE — kiểm tra quyền tài khoản Dashboard demo" ;;
    *) fail "Đồng bộ user $user HTTP $HTTP_CODE — kiểm tra authenticator password_based:built_in_database của broker demo" ;;
  esac
}

upsert_user "$APP_USER" "$APP_PASS" true
for u in $DEVICE_USERS; do upsert_user "$u" "$DEVICE_PASS" false; done
printf '[init] Hoàn tất — user MQTT đồng bộ từ environment\n'
