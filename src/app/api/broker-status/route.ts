import { NextResponse } from "next/server";

/**
 * GET /api/broker-status
 * Đọc trạng thái của MQTT client singleton (không tạo connection mới, không
 * blocking) — FE poll endpoint này mỗi 30s để hiển thị trạng thái.
 *
 * Lưu ý: lần đầu tiên server khởi động, client chưa được tạo → trả
 * `connected: false, initialized: false`. Client sẽ tự connect ở request
 * publish đầu tiên (hoặc gọi GET ?init=1 để chủ động kích hoạt kết nối).
 */

import { getMqttStatus, getMqttClient } from "@/lib/mqtt";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const shouldInit = url.searchParams.get("init") === "1";

  // ?init=1: chủ động kích hoạt kết nối (dùng sau khi deploy để kiểm tra
  // MQTT_URL/credentials ngay mà không cần đợi request publish đầu tiên)
  if (shouldInit) {
    try {
      await getMqttClient();
    } catch (err) {
      const status = getMqttStatus();
      return NextResponse.json({
        ...status,
        initialized: true,
        ok: false,
        error: err instanceof Error ? err.message : "Không kết nối được broker",
        checkedAt: new Date().toISOString(),
      });
    }
  }

  const status = getMqttStatus();
  return NextResponse.json({
    ...status,
    initialized: shouldInit || status.clientId !== null,
    ok: status.connected,
    checkedAt: new Date().toISOString(),
  });
}
