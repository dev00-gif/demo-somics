import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { NextResponse } from "next/server";

import { verifyDeviceToken } from "@/lib/devices";

export const runtime = "nodejs";

interface StoredFileMeta {
  id: string;
  fileName: string;
  storedName: string;
  mimeType: string;
  size: number;
  sha256: string;
  uploadedAt: string;
  /** deviceId đã tải file này (gán khi BE publish command) — null = chưa gửi */
  sentTo?: string | null;
}

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.join(process.cwd(), "uploads");

function isValidId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

function safeContentDispositionName(fileName: string): string {
  return fileName.replace(/["\\\r\n]/g, "_");
}

/** Trích Bearer token từ header Authorization */
function extractBearerToken(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  if (!isValidId(id)) {
    return NextResponse.json({ ok: false, error: "File id không hợp lệ" }, { status: 400 });
  }

  // --- Bắt buộc Access Token (luồng mới — file không còn public) ---------------
  const token = extractBearerToken(request);
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "Thiếu Access Token — header: Authorization: Bearer <token>" },
      {
        status: 401,
        headers: { "WWW-Authenticate": 'Bearer realm="device-file-download"' },
      },
    );
  }

  const verified = await verifyDeviceToken(token);
  if (!verified) {
    return NextResponse.json(
      { ok: false, error: "Access Token không hợp lệ hoặc đã hết hạn" },
      { status: 401 },
    );
  }

  try {
    const metaPath = path.join(UPLOAD_DIR, `${id}.json`);
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as StoredFileMeta;

    // --- Kiểm tra quyền: chỉ device được chỉ định mới tải được file này --------
    if (meta.sentTo && meta.sentTo !== verified.deviceId) {
      return NextResponse.json(
        { ok: false, error: "Thiết bị không có quyền tải file này" },
        { status: 403 },
      );
    }

    const filePath = path.join(UPLOAD_DIR, meta.storedName);
    const fileStat = await stat(filePath);

    const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;

    return new Response(stream, {
      headers: {
        "Content-Type": meta.mimeType || "application/octet-stream",
        "Content-Length": String(fileStat.size),
        "Content-Disposition": `attachment; filename="${safeContentDispositionName(meta.fileName)}"`,
        "Cache-Control": "private, no-store",
        "X-File-Sha256": meta.sha256,
      },
    });
  } catch {
    return NextResponse.json({ ok: false, error: "Không tìm thấy file" }, { status: 404 });
  }
}
