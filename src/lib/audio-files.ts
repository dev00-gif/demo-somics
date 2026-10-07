import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDuration, isFileId, type TrackInfo } from "@/lib/playback";

/** Read only metadata for a file assigned to this device, never its audio contents. */
export async function readUploadedTrack(fileId: string, deviceId: string): Promise<TrackInfo | null> {
  if (!isFileId(fileId)) return null;
  try {
    const uploadDir = process.env.UPLOAD_DIR ?? path.join(process.cwd(), "uploads");
    const meta = JSON.parse(await readFile(path.join(uploadDir, `${fileId}.json`), "utf8")) as Record<string, unknown>;
    if (meta.id !== fileId || meta.sentTo !== deviceId || typeof meta.fileName !== "string") return null;
    return { fileId, fileName: meta.fileName, durationSeconds: isDuration(meta.durationSeconds) ? meta.durationSeconds : null };
  } catch {
    return null;
  }
}
