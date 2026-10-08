export type RepeatMode = "off" | "one";
export type PlaybackState = "IDLE" | "DOWNLOADED" | "PLAYING" | "PAUSED" | "DONE" | "ERROR";

export interface TrackInfo {
  fileId: string;
  fileName: string;
  durationSeconds: number | null;
}

export interface DevicePlayback {
  fileId: string | null;
  fileName: string | null;
  durationSeconds: number | null;
  positionSeconds: number;
  positionUpdatedAt: string;
  state: PlaybackState;
  repeat: RepeatMode;
  volume: number | null;
}

export type PlayerCommand =
  | { action: "set_volume"; volume: number }
  | { action: "pause" | "resume" | "next" | "previous" }
  | { action: "set_repeat"; repeat: RepeatMode }
  | { action: "seek"; fileId: string; positionSeconds: number };

export function isFileId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function isDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Prefer the reported file; legacy firmware can still control the file just uploaded. */
export function controlTrack(playback?: DevicePlayback, uploadedTrack?: TrackInfo): TrackInfo | undefined {
  if (!playback?.fileId) return uploadedTrack;
  const matchingUpload = uploadedTrack?.fileId === playback.fileId ? uploadedTrack : undefined;
  return {
    fileId: playback.fileId,
    fileName: playback.fileName ?? matchingUpload?.fileName ?? "Bài đang phát",
    durationSeconds: isDuration(playback.durationSeconds) ? playback.durationSeconds : matchingUpload?.durationSeconds ?? null,
  };
}

export function canSeekTrack(playback: DevicePlayback | undefined, track: TrackInfo | undefined): boolean {
  if (!track || !isFileId(track.fileId) || !isDuration(track.durationSeconds)) return false;
  if (playback?.fileId && playback.fileId !== track.fileId) return false;
  return playback?.state !== "DONE" && playback?.state !== "ERROR";
}

export function formatPlaybackTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "--:--";
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

export function playbackPosition(playback: DevicePlayback, now = Date.now()): number {
  const elapsed = playback.state === "PLAYING"
    ? Math.max(0, (now - Date.parse(playback.positionUpdatedAt)) / 1000) || 0
    : 0;
  const position = Math.max(0, playback.positionSeconds + elapsed);
  return isDuration(playback.durationSeconds) ? Math.min(position, playback.durationSeconds) : position;
}

const STATES = new Set<unknown>(["IDLE", "DOWNLOADED", "PLAYING", "PAUSED", "DONE", "ERROR"]);

/** Merge a device heartbeat without resetting the progress clock on unrelated updates. */
export function mergePlaybackStatus(
  previous: DevicePlayback | undefined,
  status: Record<string, unknown>,
  track: TrackInfo | null,
  now = Date.now(),
): DevicePlayback {
  const timestamp = new Date(now).toISOString();
  const base: DevicePlayback = previous ?? {
    fileId: null, fileName: null, durationSeconds: null,
    positionSeconds: 0, positionUpdatedAt: timestamp,
    state: "IDLE", repeat: "off", volume: null,
  };
  const state = STATES.has(status.state) ? status.state as PlaybackState : base.state;
  const fileId = state === "IDLE" || status.fileId === null
    ? null
    : isFileId(status.fileId) ? status.fileId : base.fileId;
  const changedTrack = fileId !== base.fileId;
  const durationSeconds = fileId === null ? null
    : track?.fileId === fileId && isDuration(track.durationSeconds) ? track.durationSeconds
    : !changedTrack && isDuration(base.durationSeconds) ? base.durationSeconds
    : isDuration(status.durationSeconds) ? status.durationSeconds : null;
  const fileName = fileId === null ? null
    : track?.fileId === fileId ? track.fileName
    : typeof status.fileName === "string" && status.fileName.trim() ? status.fileName.slice(0, 512)
    : changedTrack ? null : base.fileName;
  const reportedPosition = typeof status.positionSeconds === "number"
    && Number.isFinite(status.positionSeconds) && status.positionSeconds >= 0;
  const resetClock = changedTrack || state !== base.state || reportedPosition;
  let positionSeconds = changedTrack || fileId === null ? 0
    : state !== base.state ? playbackPosition(base, now) : base.positionSeconds;
  if (fileId !== null && reportedPosition) positionSeconds = status.positionSeconds as number;
  if (state === "DONE" && !reportedPosition && durationSeconds !== null) positionSeconds = durationSeconds;
  if (durationSeconds !== null) positionSeconds = Math.min(positionSeconds, durationSeconds);

  return {
    fileId, fileName, durationSeconds, positionSeconds, state,
    positionUpdatedAt: resetClock ? timestamp : base.positionUpdatedAt,
    repeat: status.repeat === "one" || status.repeat === "off" ? status.repeat : base.repeat,
    volume: typeof status.volume === "number" && Number.isInteger(status.volume) && status.volume >= 0 && status.volume <= 100
      ? status.volume : base.volume,
  };
}
