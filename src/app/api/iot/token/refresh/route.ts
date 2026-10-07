import { NextResponse } from "next/server";

/**
 * POST /api/iot/token/refresh — Luồng 2b: đổi REFRESH token lấy CẶP token mới.
 *
 * Body JSON: { deviceId, refreshToken }
 *
 * Khi accessToken hết hạn (10 phút), thiết bị KHÔNG cần gửi lại mqttPassword —
 * chỉ cần gửi refreshToken (TTL 30 ngày) đã nhận từ /api/iot/token. BE:
 *   1. Xác minh refreshToken khớp deviceId, đúng loại, chưa hết hạn
 *   2. ROTATION: xóa refreshToken cũ (dùng 1 lần rồi chết — token bị lộ cũ
 *      không dùng lại được) rồi cấp cặp accessToken + refreshToken mới
 *   3. Re-provision/activate lại sẽ thu hồi cả access lẫn refresh token
 */

import { consumeRefreshToken, getDevice, issueDeviceTokenPair, REFRESH_TOKEN_TTL_MS, TOKEN_TTL_MS } from "@/lib/devices";

export const runtime = "nodejs";

interface RefreshBody {
  deviceId?: string;
  refreshToken?: string;
}

export async function POST(request: Request) {
  let body: RefreshBody;
  try {
    body = (await request.json()) as RefreshBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Body không phải JSON hợp lệ" },
      { status: 400 },
    );
  }

  const deviceId = body.deviceId?.trim().toUpperCase();
  const refreshToken = body.refreshToken ?? "";

  if (!deviceId || !refreshToken) {
    return NextResponse.json(
      { ok: false, error: "Thiếu deviceId hoặc refreshToken" },
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

  // Rotation: xóa refresh token cũ trước — dùng 1 lần duy nhất
  const consumed = await consumeRefreshToken(refreshToken, deviceId);
  if (!consumed) {
    return NextResponse.json(
      { ok: false, error: "Refresh token không hợp lệ, đã hết hạn hoặc đã dùng" },
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
  });
}
