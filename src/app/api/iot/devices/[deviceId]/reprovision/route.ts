import { NextResponse } from "next/server";

/**
 * POST /api/iot/devices/:deviceId/reprovision — RE-PROVISION
 *
 * Tình huống: thiết bị mất credential (flash bị xóa, firmware reset...).
 * Admin gọi API này để cấp mã kích hoạt mới cho device ĐÃ TỒN TẠI:
 *
 *   1. Thu hồi mọi mã "unused" cũ của device (chỉ 1 mã chờ tại 1 thời điểm)
 *   2. Sinh mã kích hoạt mới — admin đưa cho bên nhúng nạp vào firmware
 *   3. Thiết bị gọi POST /api/iot/activate như lần đầu → credential MỚI
 *      (PUT user trên EMQX = override password cũ; credential cũ chết ngay)
 *
 * Access token cũ chưa hết hạn sẽ bị thu hồi ngay tại đây (không đợi activate)
 * vì token chỉ dùng tải file — rò rỉ tối đa 1 lần tải là không chấp nhận được
 * khi đã chủ động re-provision.
 *
 * Body JSON: { code? } — bỏ trống để tự sinh mã.
 */

import {
  createCodeForDevice,
  getDevice,
  revokeDeviceTokens,
} from "@/lib/devices";

export const runtime = "nodejs";

interface ReprovisionBody {
  code?: string;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ deviceId: string }> },
) {
  const { deviceId: rawId } = await context.params;
  const deviceId = rawId?.trim().toUpperCase();

  if (!deviceId) {
    return NextResponse.json(
      { ok: false, error: "Thiếu deviceId trong URL" },
      { status: 400 },
    );
  }

  let body: ReprovisionBody = {};
  try {
    body = (await request.json()) as ReprovisionBody;
  } catch {
    // body rỗng hoặc không JSON — vẫn chấp nhận (dùng code tự sinh)
  }

  const device = await getDevice(deviceId);
  if (!device) {
    return NextResponse.json(
      { ok: false, error: `Thiết bị ${deviceId} không tồn tại` },
      { status: 404 },
    );
  }

  const activationCode = await createCodeForDevice(
    deviceId,
    body.code?.trim().toUpperCase() || undefined,
  );
  const revokedTokens = await revokeDeviceTokens(deviceId);

  console.log(
    `[reprovision] Cấp mã ${activationCode.code} cho ${deviceId}, thu hồi ${revokedTokens} access token cũ`,
  );

  return NextResponse.json({
    ok: true,
    message:
      "Đã cấp mã kích hoạt mới — credential cũ sẽ bị thay thế ngay khi thiết bị gọi /api/iot/activate",
    device: { deviceId: device.deviceId, activatedAt: device.activatedAt },
    activationCode: activationCode.code,
    revokedAccessTokens: revokedTokens,
    previousActivation: device.activatedAt,
  });
}
