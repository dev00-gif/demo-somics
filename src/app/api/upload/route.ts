import { NextResponse } from "next/server";

/**
 * POST /api/upload
 * FormData: file=<File> (mp3/wav...)
 * -> BE nhận file, chia chunk và publish lên MQTT theo giao thức meta/chunk/end
 *    để bên nhúng nhận về ghép lại và phát.
 */

import { publishFile, type FileMeta } from "@/lib/mqtt";

export const runtime = "nodejs";
// Tăng timeout cho request upload file lớn
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { ok: false, error: "Thiếu file trong FormData (key: 'file')" },
        { status: 400 },
      );
    }

    // Giới hạn 20MB
    if (file.size > 20 * 1024 * 1024) {
      return NextResponse.json(
        { ok: false, error: "File quá lớn (tối đa 20MB)" },
        { status: 413 },
      );
    }

    // Chấp nhận audio hoặc bất kỳ file nào người dùng chọn
    const buffer = Buffer.from(await file.arrayBuffer());

    const meta = await publishFile(
      { buffer, fileName: file.name, mimeType: file.type || "application/octet-stream" },
      undefined,
      // progress callback không tiện stream về client bằng response thường,
      // mình log ra server để debug
      (percent) => console.log(`[upload] ${file.name}: ${percent}%`),
    );

    return NextResponse.json({
      ok: true,
      message: `Đã đẩy "${meta.fileName}" lên MQTT (${meta.totalChunks} chunks)`,
      meta,
    });
  } catch (err) {
    console.error("[upload] publish failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Upload thất bại" },
      { status: 502 },
    );
  }
}

// Type helper (không dùng runtime)
export type { FileMeta };
