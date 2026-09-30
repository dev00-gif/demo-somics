import { NextResponse } from "next/server";

/**
 * GET /api/health
 * Endpoint nhẹ cho Docker/K8s healthcheck — không chạm tới MQTT để tránh
 * healthcheck fail chỉ vì broker chậm hoặc không khả dụng.
 */

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    ok: true,
    service: "mqtt-station",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
}
