import { NextResponse } from "next/server";

/**
 * /api/iot/devices
 *
 * GET  — danh sách thiết bị + trạng thái online cho website.
 * POST — admin đăng ký thiết bị mới + sinh mã kích hoạt (bước đầu của Luồng 1).
 *        Body JSON: { deviceId, code? }
 *
 * Sau khi tạo, admin đưa cặp (deviceId, activationCode) cho bên nhúng nạp vào
 * firmware. Thiết bị gọi POST /api/iot/activate để kích hoạt.
 */

import {
  createDeviceWithCode,
  getDevice,
  listDevices,
  ONLINE_WINDOW_MS,
} from "@/lib/devices";

export const runtime = "nodejs";

export async function GET() {
  // Không trả passwordHash ra ngoài — chỉ dùng nội bộ để xác thực /api/iot/token
  const devices = (await listDevices()).map(({ passwordHash, ...rest }) => rest);

  return NextResponse.json({
    ok: true,
    onlineWindowMs: ONLINE_WINDOW_MS,
    total: devices.length,
    onlineCount: devices.filter((d) => d.online).length,
    devices: devices.sort((a, b) => a.deviceId.localeCompare(b.deviceId)),
    checkedAt: new Date().toISOString(),
  });
}

// =============================================================================
// POST — đăng ký thiết bị mới
// =============================================================================

interface CreateDeviceBody {
  deviceId?: string;
  code?: string;
}

const DEVICE_ID_RE = /^[A-Z0-9][A-Z0-9-]{2,63}$/;

export async function POST(request: Request) {
  let body: CreateDeviceBody;
  try {
    body = (await request.json()) as CreateDeviceBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Body không phải JSON hợp lệ" },
      { status: 400 },
    );
  }

  const deviceId = body.deviceId?.trim().toUpperCase();
  if (!deviceId || !DEVICE_ID_RE.test(deviceId)) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "deviceId không hợp lệ — dùng 3-64 ký tự A-Z, 0-9, gạch ngang (vd SOMICS-000001)",
      },
      { status: 400 },
    );
  }

  if (await getDevice(deviceId)) {
    return NextResponse.json(
      { ok: false, error: `Thiết bị ${deviceId} đã tồn tại` },
      { status: 409 },
    );
  }

  const { device, activationCode } = await createDeviceWithCode({
    deviceId,
    code: body.code?.trim().toUpperCase() || undefined,
  });

  console.log(
    `[devices] Tạo device ${deviceId} với mã kích hoạt ${activationCode.code}`,
  );

  return NextResponse.json(
    {
      ok: true,
      message: "Đã tạo thiết bị — đưa deviceId + activationCode cho bên nhúng",
      device: {
        deviceId: device.deviceId,
        createdAt: device.createdAt,
      },
      activationCode: activationCode.code,
    },
    { status: 201 },
  );
}
