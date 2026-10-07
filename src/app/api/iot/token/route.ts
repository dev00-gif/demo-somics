import { NextResponse } from "next/server";

/**
 * POST /api/iot/token — Luồng 2: đổi MQTT credential lấy CẶP token.
 *
 * Body JSON: { deviceId, mqttPassword, fileId? }
 *
 * Thiết bị đã kết nối MQTT (đã xác thực bằng credential lúc activate) gọi API này
 * khi nhận lệnh có fileId từ topic command. BE kiểm tra credential khớp registry →
 * cấp:
 *   - accessToken  TTL 10 phút — dùng ngay để tải file:
 *       GET /api/files/:fileId với header: Authorization: Bearer <token>
 *   - refreshToken TTL 30 ngày — giữ lại, khi accessToken hết hạn gọi
 *       POST /api/iot/token/refresh để lấy cặp mới (không cần gửi mqttPassword)
 */

import crypto from "node:crypto";

import {
  getDevice,
  issueDeviceTokenPair,
  REFRESH_TOKEN_TTL_MS,
  TOKEN_TTL_MS,
} from "@/lib/devices";

export const runtime = "nodejs";

interface TokenBody {
  deviceId?: string;
  mqttPassword?: string;
  fileId?: string;
}

/**
 * Xác thực: đối chiếu SHA256(mqttPassword) với hash lưu trong registry lúc
 * activate. Khi re-provision, hash mới chỉ được ghi sau khi credential mới
 * được cấp thành công trên broker → password cũ tự chết ở cả 2 lớp
 * (EMQX từ chối CONNECT, endpoint này từ chối cấp token).
 */
export async function POST(request: Request) {
  let body: TokenBody;
  try {
    body = (await request.json()) as TokenBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Body không phải JSON hợp lệ" },
      { status: 400 },
    );
  }

  const deviceId = body.deviceId?.trim().toUpperCase();
  const mqttPassword = body.mqttPassword ?? "";

  if (!deviceId || !mqttPassword) {
    return NextResponse.json(
      { ok: false, error: "Thiếu deviceId hoặc mqttPassword" },
      { status: 400 },
    );
  }

  const device = await getDevice(deviceId);
  if (!device || device.activatedAt === null) {
    return NextResponse.json(
      { ok: false, error: "Thiết bị chưa kích hoạt" },
      { status: 403 },
    );
  }

  // Xác thực credential bằng cách để broker xác minh: gọi EMQX API không hỗ trợ
  // verify trực tiếp nên ta đối chiếu hash đã lưu lúc activate.
  const storedHash = device.passwordHash ?? null;
  if (!storedHash) {
    return NextResponse.json(
      { ok: false, error: "Thiết bị chưa có credential — chưa kích hoạt" },
      { status: 403 },
    );
  }
  const givenHash = crypto.createHash("sha256").update(mqttPassword).digest("hex");
  if (givenHash !== storedHash) {
    return NextResponse.json(
      { ok: false, error: "Credential không hợp lệ" },
      { status: 401 },
    );
  }

  const { access, refresh } = await issueDeviceTokenPair(deviceId);

  return NextResponse.json({
    ok: true,
    accessToken: access.raw,
    refreshToken: refresh.raw,
    tokenType: "Bearer",
    expiresIn: Math.floor(TOKEN_TTL_MS / 1000),
    expiresAt: access.expiresAt,
    refreshExpiresIn: Math.floor(REFRESH_TOKEN_TTL_MS / 1000),
    refreshExpiresAt: refresh.expiresAt,
    refreshEndpoint: "/api/iot/token/refresh",
    fileId: body.fileId ?? null,
  });
}
