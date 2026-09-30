import { NextResponse } from "next/server";

/**
 * POST /api/announcement
 * Body JSON: { title, content, priority? }
 * -> Publish bản tin lên MQTT cho bên nhúng nhận và hiển thị.
 */

import { publishAnnouncement } from "@/lib/mqtt";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      title?: string;
      content?: string;
      priority?: "low" | "normal" | "high";
    };

    const title = body.title?.trim();
    const content = body.content?.trim();

    if (!title || !content) {
      return NextResponse.json(
        { ok: false, error: "Thiếu title hoặc content" },
        { status: 400 },
      );
    }

    await publishAnnouncement({
      id: crypto.randomUUID(),
      title,
      content,
      priority: body.priority ?? "normal",
      sender: "web-frontend",
    });

    return NextResponse.json({ ok: true, message: "Đã publish bản tin lên MQTT" });
  } catch (err) {
    console.error("[announcement] publish failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Publish thất bại" },
      { status: 502 },
    );
  }
}
