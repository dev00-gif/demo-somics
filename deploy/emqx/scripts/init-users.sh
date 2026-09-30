#!/bin/sh
# ==============================================================================
# emqx-init-users — tạo/cập nhật user MQTT từ biến môi trường
#
# Vì sao: bootstrap CSV chỉ chạy 1 lần (không ghi đè user cũ) và password nằm
# cứng trong file. Cách này: mỗi lần deploy, container init gọi EMQX HTTP API
# để PUT user với password lấy từ env → password luôn đồng bộ với .env,
# không bao giờ nằm trong repo.
#
# Biến môi trường bắt buộc (đặt trong tab Environment của Dokploy):
#   DASHBOARD_USERNAME / DASHBOARD_PASSWORD  — để gọi EMQX API
#   MQTT_DEVICE_PASSWORD  — password chung cho các user device-01, device-02
#   MQTT_APP_PASSWORD     — password cho web-backend (superuser)
#
# Optional:
#   MQTT_APP_USERNAME  (default: web-backend)
#   MQTT_DEVICE_USERS  (default: device-01 device-02)
#
# Service này chạy xong là thoát (container ngắn hạn).
# ==============================================================================
set -eu

API="http://emqx:18083/api/v5"
AUTH="${DASHBOARD_USERNAME:-admin}:${DASHBOARD_PASSWORD:?Set DASHBOARD_PASSWORD}"

APP_USER="${MQTT_APP_USERNAME:-web-backend}"
DEVICE_USERS="${MQTT_DEVICE_USERS:-device-01 device-02}"

# Chờ EMQX sẵn sàng (tối đa 60s)
echo "[init] Chờ EMQX API sẵn sàng..."
i=0
until curl -sf -u "$AUTH" "$API/status" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -ge 30 ] && { echo "[init] LỖI: EMQX không phản hồi sau 60s"; exit 1; }
  sleep 2
done
echo "[init] EMQX OK"

upsert_user() {
  user="$1"
  pass="$2"
  superuser="$3"

  body="{
    \"user_id\": \"$user\",
    \"password\": \"$pass\",
    \"is_superuser\": $superuser
  }"

  # PUT = tạo mới hoặc cập nhật đều được
  http_code=$(curl -s -o /tmp/resp.json -w "%{http_code}" -u "$AUTH" \
    -X PUT "$API/authentication/password_based:built_in_database/users/$user" \
    -H "Content-Type: application/json" \
    -d "$body")

  case "$http_code" in
    200|201) echo "[init] ✓ $user đã cập nhật (password từ env)" ;;
    *)
      echo "[init] ✗ $user thất bại (HTTP $http_code): $(cat /tmp/resp.json)"
      exit 1
      ;;
  esac
}

# ----- Device users (không phải superuser) -----
for u in $DEVICE_USERS; do
  pass_var="MQTT_DEVICE_PASSWORD"
  pass=$(eval echo "\$$pass_var")
  [ -z "$pass" ] && { echo "[init] LỖI: $pass_var chưa đặt"; exit 1; }
  upsert_user "$u" "$pass" "false"
done

# ----- App user (superuser — BE pub/sub mọi topic) -----
upsert_user "$APP_USER" "${MQTT_APP_PASSWORD:?Set MQTT_APP_PASSWORD}" "true"

echo "[init] Hoàn tất — user MQTT đồng bộ từ biến môi trường."
