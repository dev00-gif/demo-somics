import { NextResponse } from "next/server";
import { getDevice, ONLINE_WINDOW_MS } from "@/lib/devices";
import { publishDeviceCommand } from "@/lib/mqtt";
import { isDuration, isFileId } from "@/lib/playback";

export const runtime = "nodejs";

const ACTIONS = new Set(["set_volume", "pause", "resume", "next", "previous", "set_repeat", "seek"]);

/** POST /api/iot/devices/:deviceId/control — gửi lệnh phát nhạc tới thiết bị online. */
export async function POST(
  request: Request,
  context: { params: Promise<{ deviceId: string }> },
) {
  const { deviceId: rawId } = await context.params;
  const deviceId = rawId.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{2,63}$/.test(deviceId)) {
    return NextResponse.json({ ok: false, error: "deviceId không hợp lệ" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Body không phải JSON hợp lệ" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ ok: false, error: "Body phải là một JSON object" }, { status: 400 });
  }

  const { action, volume, repeat, fileId, positionSeconds } = body as Record<string, unknown>;
  if (typeof action !== "string" || !ACTIONS.has(action)) {
    return NextResponse.json({ ok: false, error: "Lệnh điều khiển không hợp lệ" }, { status: 400 });
  }
  if (action === "set_volume" && (typeof volume !== "number" || !Number.isInteger(volume) || volume < 0 || volume > 100)) {
    return NextResponse.json({ ok: false, error: "Âm lượng phải là số nguyên từ 0 đến 100" }, { status: 400 });
  }
  if (action === "set_repeat" && repeat !== "off" && repeat !== "one") {
    return NextResponse.json({ ok: false, error: "Chế độ lặp lại phải là off hoặc one" }, { status: 400 });
  }
  if (action === "seek" && (!isFileId(fileId) || typeof positionSeconds !== "number" || !Number.isFinite(positionSeconds) || positionSeconds < 0)) {
    return NextResponse.json({ ok: false, error: "Thiếu fileId hoặc vị trí tua không hợp lệ" }, { status: 400 });
  }

  try {
    const device = await getDevice(deviceId);
    if (!device || !device.activatedAt) {
      return NextResponse.json({ ok: false, error: "Thiết bị không tồn tại hoặc chưa kích hoạt" }, { status: 404 });
    }
    const lastSeenAt = device.lastSeenAt ? Date.parse(device.lastSeenAt) : NaN;
    if (!Number.isFinite(lastSeenAt) || Date.now() - lastSeenAt >= ONLINE_WINDOW_MS) {
      return NextResponse.json({ ok: false, error: `Thiết bị ${deviceId} đã mất kết nối` }, { status: 409 });
    }
    if (action === "seek") {
      const playback = device.playback;
      if (!playback || playback.fileId !== fileId || !["PLAYING", "PAUSED"].includes(playback.state) || !isDuration(playback.durationSeconds)) {
        return NextResponse.json({ ok: false, error: "Bài đang phát đã đổi hoặc chưa có thời lượng để tua. Vui lòng thử lại." }, { status: 409 });
      }
      if ((positionSeconds as number) > playback.durationSeconds) {
        return NextResponse.json({ ok: false, error: "Vị trí tua vượt quá thời lượng bài" }, { status: 400 });
      }
    }

    const id = crypto.randomUUID();
    await publishDeviceCommand(deviceId, {
      id,
      type: "control",
      action,
      ...(action === "set_volume" ? { volume } : {}),
      ...(action === "set_repeat" ? { repeat } : {}),
      ...(action === "seek" ? { fileId, positionSeconds } : {}),
    });

    return NextResponse.json({ ok: true, id, deviceId, action, message: "Đã gửi lệnh điều khiển qua MQTT" });
  } catch (err) {
    console.error("[device-control] publish failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Gửi lệnh điều khiển thất bại" },
      { status: 502 },
    );
  }
}
