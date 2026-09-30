import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { NextResponse } from "next/server";

export const runtime = "nodejs";

interface StoredFileMeta {
  id: string;
  fileName: string;
  storedName: string;
  mimeType: string;
  size: number;
  sha256: string;
  uploadedAt: string;
}

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? path.join(process.cwd(), "uploads");

function isValidId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

function safeContentDispositionName(fileName: string): string {
  return fileName.replace(/["\\\r\n]/g, "_");
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  if (!isValidId(id)) {
    return NextResponse.json({ ok: false, error: "File id không hợp lệ" }, { status: 400 });
  }

  try {
    const metaPath = path.join(UPLOAD_DIR, `${id}.json`);
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as StoredFileMeta;
    const filePath = path.join(UPLOAD_DIR, meta.storedName);
    const fileStat = await stat(filePath);

    const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;

    return new Response(stream, {
      headers: {
        "Content-Type": meta.mimeType || "application/octet-stream",
        "Content-Length": String(fileStat.size),
        "Content-Disposition": `attachment; filename="${safeContentDispositionName(meta.fileName)}"`,
        "Cache-Control": "public, max-age=86400",
        "X-File-Sha256": meta.sha256,
      },
    });
  } catch {
    return NextResponse.json({ ok: false, error: "Không tìm thấy file" }, { status: 404 });
  }
}
