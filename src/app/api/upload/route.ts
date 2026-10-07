import { NextResponse } from "next/server";

/**
 * POST /api/upload — Luồng 2: Website gửi file âm thanh xuống IoT (theo thiết bị).
 *
 * FormData: file=<File>, deviceId=<deviceId đích>
 *
 * BE nhận file → kiểm tra định dạng/dung lượng → tính SHA256 → lưu storage private
 * → publish MQTT command { fileId, fileName, sha256, action: "download" } tới topic
 * riêng của thiết bị (KHÔNG gửi downloadUrl public nữa).
 *
 * Thiết bị nhận command → gọi POST /api/iot/token đổi credential lấy access token
 * → GET /api/files/:fileId với Bearer token → kiểm tra SHA256 → phát.
 */

import crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { getDevice } from "@/lib/devices";
import { publishDeviceCommand, type FileAvailable } from "@/lib/mqtt";

export const runtime = "nodejs";
// Tăng timeout cho request upload file lớn
export const maxDuration = 60;

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.join(process.cwd(), "uploads");

const ALLOWED_MIME = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/mp4",
  "audio/aac",
  "audio/x-m4a",
  "audio/m4a",
]);

function sanitizeStoredName(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase().replace(/[^a-z0-9.]/g, "");
  const base = path
    .basename(fileName, path.extname(fileName))
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);

  return `${base || "audio"}${ext || ".bin"}`;
}

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const deviceId = formData.get("deviceId")?.toString().trim().toUpperCase();

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { ok: false, error: "Thiếu file trong FormData (key: 'file')" },
        { status: 400 },
      );
    }
    if (!deviceId) {
      return NextResponse.json(
        { ok: false, error: "Thiếu deviceId — chọn thiết bị nhận file" },
        { status: 400 },
      );
    }

    // Thiết bị đích phải tồn tại + đã kích hoạt
    const device = await getDevice(deviceId);
    if (!device || device.activatedAt === null) {
      return NextResponse.json(
        { ok: false, error: `Thiết bị ${deviceId} không tồn tại hoặc chưa kích hoạt` },
        { status: 404 },
      );
    }

    // Giới hạn 20MB
    if (file.size > 20 * 1024 * 1024) {
      return NextResponse.json(
        { ok: false, error: "File quá lớn (tối đa 20MB)" },
        { status: 413 },
      );
    }

    // Kiểm tra định dạng audio (theo MIME; fallback chấp nhận nếu browser gửi rỗng)
    const mime = file.type || "";
    if (mime && !ALLOWED_MIME.has(mime) && !mime.startsWith("audio/")) {
      return NextResponse.json(
        { ok: false, error: `Định dạng không hỗ trợ: ${mime} — chỉ nhận file audio` },
        { status: 415 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const id = crypto.randomUUID();
    const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    const storedName = `${id}-${sanitizeStoredName(file.name)}`;
    const uploadedAt = new Date().toISOString();

    await mkdir(UPLOAD_DIR, { recursive: true });
    await writeFile(path.join(UPLOAD_DIR, storedName), buffer, { flag: "wx" });

    // Metadata lưu kèm sentTo = device được cấp quyền tải (chỉ device đó tải được)
    const meta: FileAvailable & { storedName: string; sentTo: string | null } = {
      id,
      fileName: file.name,
      storedName,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      sha256,
      downloadUrl: `/api/files/${id}`, // path nội bộ — device tải bằng access token
      uploadedAt,
      sentTo: deviceId,
    };

    await writeFile(path.join(UPLOAD_DIR, `${id}.json`), JSON.stringify(meta, null, 2), {
      flag: "wx",
    });

    // Publish command qua topic riêng của thiết bị — KHÔNG kèm URL public
    await publishDeviceCommand(deviceId, {
      type: "file",
      action: "download",
      fileId: id,
      fileName: meta.fileName,
      mimeType: meta.mimeType,
      size: meta.size,
      sha256: meta.sha256,
      tokenEndpoint: "/api/iot/token",
      refreshEndpoint: "/api/iot/token/refresh",
      downloadEndpoint: `/api/files/${id}`,
    });

    return NextResponse.json({
      ok: true,
      message: `Đã upload "${meta.fileName}" và gửi lệnh tải tới ${deviceId} qua MQTT`,
      meta: {
        id,
        fileName: meta.fileName,
        size: meta.size,
        sha256: meta.sha256,
        sentTo: deviceId,
      },
    });
  } catch (err) {
    console.error("[upload] publish failed:", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Upload thất bại" },
      { status: 502 },
    );
  }
}

export type { FileAvailable };
