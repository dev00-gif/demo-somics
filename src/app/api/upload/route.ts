import { NextResponse } from "next/server";

/**
 * POST /api/upload
 * FormData: file=<File> (mp3/wav...)
 * -> BE nhận file, lưu lại và publish URL tải file qua MQTT để bên nhúng lấy về.
 */

import crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { publishFileAvailable, type FileAvailable } from "@/lib/mqtt";

export const runtime = "nodejs";
// Tăng timeout cho request upload file lớn
export const maxDuration = 60;

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.join(process.cwd(), "uploads");

function sanitizeStoredName(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase().replace(/[^a-z0-9.]/g, "");
  const base = path
    .basename(fileName, path.extname(fileName))
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);

  return `${base || "audio"}${ext || ".bin"}`;
}

function getPublicBaseUrl(request: Request): string {
  const configured = process.env.APP_PUBLIC_URL || process.env.NEXT_PUBLIC_APP_URL;
  if (configured) return configured.replace(/\/+$/, "");

  const forwardedHost = request.headers.get("x-forwarded-host");
  const host = forwardedHost?.split(",")[0]?.trim() || request.headers.get("host");
  if (!host) return "";

  const forwardedProto = request.headers.get("x-forwarded-proto");
  const proto = forwardedProto?.split(",")[0]?.trim() || "http";
  return `${proto}://${host}`;
}

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
    const id = crypto.randomUUID();
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    const storedName = `${id}-${sanitizeStoredName(file.name)}`;
    const uploadedAt = new Date().toISOString();

    await mkdir(UPLOAD_DIR, { recursive: true });
    await writeFile(path.join(UPLOAD_DIR, storedName), buffer, { flag: "wx" });

    const baseUrl = getPublicBaseUrl(request);
    const downloadPath = `/api/files/${id}`;
    const downloadUrl = baseUrl ? `${baseUrl}${downloadPath}` : downloadPath;

    const meta: FileAvailable & { storedName: string } = {
      id,
      fileName: file.name,
      storedName,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      sha256,
      downloadUrl,
      uploadedAt,
    };

    await writeFile(path.join(UPLOAD_DIR, `${id}.json`), JSON.stringify(meta, null, 2), {
      flag: "wx",
    });

    await publishFileAvailable(meta);

    return NextResponse.json({
      ok: true,
      message: `Đã upload "${meta.fileName}" và gửi URL tải file qua MQTT`,
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
export type { FileAvailable };
