import { NextResponse } from "next/server";

/**
 * POST /api/iot/activate — Luồng 1: Kích hoạt thiết bị lần đầu.
 *
 * Body JSON: { deviceId, activationCode, firmwareVersion? }
 *
 * Kiểm tra (theo flowchart):
 *   1. deviceId có tồn tại trong registry?     → không: 403
 *   2. activationCode hợp lệ (thuộc device)?   → không: 403
 *   3. activationCode đã dùng?                 → rồi: 409
 *   4. Tạo MQTT credential (username/password random)
 *   5. Đăng ký credential với EMQX qua Management API
 *   6. Đánh dấu activationCode = USED
 *   7. Trả về mqttHost/mqttPort/mqttUsername/mqttPassword (chỉ 1 lần duy nhất)
 *
 * Device nhận xong sẽ tự kết nối mqtts://…:8883 và bắt đầu publish status —
 * BE nhận status qua subscription device/+/status → device chuyển ONLINE.
 */

import crypto from "node:crypto";

import {
  activateDevice,
  deviceTopics,
  generateMqttPassword,
  getActivationCode,
  getDevice,
  markCodeUsed,
  revokeDeviceTokens,
} from "@/lib/devices";
import {
  ensureBuiltInAuthzSource,
  setDeviceAcl,
  upsertMqttUser,
} from "@/lib/emqx-api";

export const runtime = "nodejs";

interface ActivateBody {
  deviceId?: string;
  activationCode?: string;
  firmwareVersion?: string;
}

/** Thông số MQTT trả cho thiết bị (có thể override bằng env khi deploy) */
function mqttConnectionInfo() {
  return {
    mqttHost: process.env.MQTT_PUBLIC_HOST ?? "mqtt.somics.vn",
    mqttPort: Number(process.env.MQTT_PUBLIC_PORT ?? 8883),
    mqttTls: (process.env.MQTT_PUBLIC_TLS ?? "true") !== "false",
  };
}

export async function POST(request: Request) {
  let body: ActivateBody;
  try {
    body = (await request.json()) as ActivateBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Body không phải JSON hợp lệ" },
      { status: 400 },
    );
  }

  const deviceId = body.deviceId?.trim().toUpperCase();
  const activationCode = body.activationCode?.trim().toUpperCase();
  const firmwareVersion = body.firmwareVersion?.trim() || null;

  if (!deviceId || !activationCode) {
    return NextResponse.json(
      { ok: false, error: "Thiếu deviceId hoặc activationCode" },
      { status: 400 },
    );
  }

  // --- Bước 1: deviceId có tồn tại? -------------------------------------------
  const device = await getDevice(deviceId);
  if (!device) {
    return NextResponse.json(
      { ok: false, error: "Từ chối kích hoạt: deviceId không tồn tại" },
      { status: 403 },
    );
  }

  // --- Bước 2: activationCode hợp lệ và thuộc device này? ---------------------
  const ac = await getActivationCode(activationCode);
  if (!ac || ac.deviceId !== deviceId) {
    return NextResponse.json(
      { ok: false, error: "Từ chối kích hoạt: activationCode không hợp lệ" },
      { status: 403 },
    );
  }

  // --- Bước 3: activationCode đã được sử dụng? --------------------------------
  if (ac.status === "revoked") {
    return NextResponse.json(
      { ok: false, error: "Từ chối kích hoạt: mã đã bị thu hồi" },
      { status: 403 },
    );
  }
  if (ac.status === "used") {
    return NextResponse.json(
      { ok: false, error: "activationCode đã được sử dụng" },
      { status: 409 },
    );
  }

  // --- Bước 4: tạo MQTT credential --------------------------------------------
  const mqttUsername = deviceId; // username = deviceId cho dễ truy vết
  const mqttPassword = generateMqttPassword();
  const topics = deviceTopics(deviceId);

  // --- Bước 5: đăng ký credential + ACL với EMQX ------------------------------
  // Re-provision: PUT user = override password cũ → credential cũ chết ngay;
  // access token cũ cũng thu hồi (đã chủ động cấp lại mã thì token cũ phải chết).
  let registered = false;
  try {
    await ensureBuiltInAuthzSource(); // idempotent — bỏ qua nếu đã tồn tại
    registered = await upsertMqttUser(mqttUsername, mqttPassword, false);
    if (registered) {
      // Device user chỉ được subscribe command + publish status của chính nó
      const aclOk = await setDeviceAcl(mqttUsername, topics.command, topics.status);
      if (!aclOk) {
        console.warn(
          `[activate] ACL cho ${mqttUsername} chưa ghi được — device vẫn hoạt động nhưng chưa bị giới hạn topic`,
        );
      }
    }
  } catch (err) {
    console.error("[activate] EMQX API lỗi:", err);
    return NextResponse.json(
      {
        ok: false,
        error: "Broker chưa sẵn sàng cấp credential — thử lại sau",
      },
      { status: 502 },
    );
  }
  if (!registered) {
    return NextResponse.json(
      { ok: false, error: "Đăng ký credential với broker thất bại" },
      { status: 502 },
    );
  }
  await revokeDeviceTokens(deviceId);

  // --- Bước 6: đánh dấu code = USED + ghi nhận firmware + hash credential ------
  await markCodeUsed(activationCode);
  const passwordHash = crypto.createHash("sha256").update(mqttPassword).digest("hex");
  const activated = await activateDevice(deviceId, firmwareVersion, passwordHash);

  // --- Bước 7: trả thông tin kết nối (password không bao giờ trả lại lần nữa) --
  const conn = mqttConnectionInfo();

  console.log(`[activate] Device ${deviceId} kích hoạt thành công (firmware=${firmwareVersion ?? "?"})`);

  return NextResponse.json({
    ok: true,
    message: "Kích hoạt thành công — lưu credential an toàn, không gửi lại lần nữa",
    device: {
      deviceId: activated.deviceId,
      activatedAt: activated.activatedAt,
      firmwareVersion: activated.firmwareVersion,
    },
    mqtt: {
      ...conn,
      username: mqttUsername,
      password: mqttPassword,
      commandTopic: topics.command,
      statusTopic: topics.status,
    },
  });
}
