#!/usr/bin/env bash
# ==============================================================================
# Tạo chứng chỉ self-signed cho MQTT TLS (listener 8883 của EMQX).
#
# Dùng:
#   ./gen-certs.sh <tên-miền-hoặc-IP-của-VPS>
#   VD: ./gen-certs.sh mqtt.example.com
#       ./gen-certs.sh 203.0.113.10
#
# Kết quả (thư mục certs/):
#   ca.crt        — CA cert: copy về thiết bị nhúng & client để verify server
#   server.crt    — server cert (đã ghép intermediate nếu có)
#   server.key    — private key server (KHÔNG đưa vào git)
#   server.csr    — CSR (có thể xóa)
#
# Lưu ý bảo mật:
#   - Self-signed phù hợp thiết bị nhúng (client pin CA). Production có domain
#     nên dùng Let's Encrypt (certbot) rồi trỏ đường dẫn cert vào compose.
#   - Server cert có SAN bao gồm cả tên miền VÀ IP (nếu param là IP) để client
#     không cần --insecure.
# ==============================================================================
set -euo pipefail

SERVER_NAME="${1:?Dùng: ./gen-certs.sh <domain-hoặc-IP-VPS>}"
DAYS="${DAYS:-825}"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "==> Tạo CA (CA.key chỉ dùng để ký, giữ an toàn hoặc xóa sau khi ký)"
openssl genrsa -out ca.key 4096 2>/dev/null

openssl req -x509 -new -nodes -key ca.key -sha256 -days 3650 -out ca.crt \
  -subj "/CN=MQTT-Station-Root-CA/O=MQTT Station"

echo "==> Tạo server key + CSR"
openssl genrsa -out server.key 4096 2>/dev/null
openssl req -new -key server.key -out server.csr \
  -subj "/CN=${SERVER_NAME}"

echo "==> Ký server cert (SAN bao gồm ${SERVER_NAME})"
if [[ "$SERVER_NAME" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  SAN="IP:${SERVER_NAME}"
else
  SAN="DNS:${SERVER_NAME}"
fi

cat > server-ext.cnf <<EOF
authorityKeyIdentifier=keyid,issuer
basicConstraints=CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = ${SAN}
EOF

openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out server.crt -days "$DAYS" -sha256 -extfile server-ext.cnf 2>/dev/null

# Kiểm tra key khi chưa đụng passphrase
openssl rsa -in server.key -check -noout >/dev/null 2>&1

rm -f server.csr server-ext.cnf ca.srl

echo ""
echo "✅ Đã tạo xong trong $(pwd):"
ls -l ca.crt server.crt server.key

echo ""
echo "Bước tiếp theo:"
echo "  1. Copy ca.crt về thiết bị nhúng (client dùng nó verify server)."
echo "  2. restart compose:  docker compose up -d --force-recreate emqx"
echo "  3. Test:  mqttx sub -h ${SERVER_NAME} -p 8883 --protocol mqtts --ca ca.crt -u device-01 -P '<pass>' -t 'test'"
echo "     (mosquitto:  mosquitto_sub -h ${SERVER_NAME} -p 8883 --cafile ca.crt -u device-01 -P '<pass>' -t test)"
