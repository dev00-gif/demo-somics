"use client";

import { useEffect, useRef, useState } from "react";
import {
  canSeekTrack, controlTrack, formatPlaybackTime, isDuration, playbackPosition,
  type DevicePlayback, type PlayerCommand, type RepeatMode, type TrackInfo,
} from "@/lib/playback";

interface DevicePlayerControlsProps {
  deviceId: string;
  playback?: DevicePlayback;
  uploadedTrack?: TrackInfo;
  onLog: (kind: "success" | "error", message: string) => void;
}

interface SeekPosition {
  fileId: string;
  positionSeconds: number;
}

const RANGE_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);
const ACTION_LABELS = { pause: "tạm dừng", resume: "tiếp tục phát", next: "chuyển bài tiếp theo", previous: "quay lại bài trước" };

function commandMessage(command: PlayerCommand): string {
  if (command.action === "set_volume") return `mức âm lượng ${command.volume}%`;
  if (command.action === "set_repeat") return command.repeat === "one" ? "lệnh bật lặp lại bài hiện tại" : "lệnh tắt lặp lại";
  if (command.action === "seek") return `lệnh tua tới ${formatPlaybackTime(command.positionSeconds)}`;
  return `lệnh ${ACTION_LABELS[command.action]}`;
}

export default function DevicePlayerControls({ deviceId, playback, uploadedTrack, onLog }: DevicePlayerControlsProps) {
  const track = controlTrack(playback, uploadedTrack);
  const trackRef = useRef(track);
  trackRef.current = track;
  const [volume, setVolume] = useState(playback?.volume ?? 50);
  const [paused, setPaused] = useState(playback?.state === "PAUSED");
  const [repeat, setRepeat] = useState<RepeatMode>(playback?.repeat ?? "off");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [seekPreview, setSeekPreview] = useState<SeekPosition | null>(null);
  const [seekOverride, setSeekOverride] = useState<(SeekPosition & { updatedAt: number }) | null>(null);
  const seekDraftRef = useRef<SeekPosition | null>(null);
  const pendingRef = useRef(false);
  const lastVolumeRef = useRef<number | null>(playback?.volume ?? null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (playback?.volume != null) {
      setVolume(playback.volume);
      lastVolumeRef.current = playback.volume;
    }
  }, [playback?.volume]);

  useEffect(() => { setPaused(playback?.state === "PAUSED"); }, [playback?.state]);
  useEffect(() => { setRepeat(playback?.repeat ?? "off"); }, [playback?.repeat]);

  useEffect(() => {
    setClock(Date.now());
    if (playback?.state !== "PLAYING") return;
    const timer = setInterval(() => setClock(Date.now()), 500);
    return () => clearInterval(timer);
  }, [playback?.state, playback?.fileId]);

  useEffect(() => {
    seekDraftRef.current = null;
    setSeekPreview(null);
  }, [track?.fileId]);

  useEffect(() => {
    setClock(Date.now());
    setSeekOverride((current) => current && current.fileId === track?.fileId
      && (playback?.fileId !== current.fileId || Date.parse(playback.positionUpdatedAt) < current.updatedAt) ? current : null);
  }, [track?.fileId, playback?.fileId, playback?.positionUpdatedAt]);
  const duration = track?.durationSeconds ?? null;
  const activeTrack = playback?.fileId === track?.fileId && ["PLAYING", "PAUSED"].includes(playback?.state ?? "");
  const canSeek = canSeekTrack(playback, track);
  const positionPlayback = playback && seekOverride?.fileId === playback.fileId
    ? { ...playback, positionSeconds: seekOverride.positionSeconds, positionUpdatedAt: new Date(seekOverride.updatedAt).toISOString() }
    : playback;
  const position = seekPreview?.fileId === track?.fileId ? seekPreview?.positionSeconds ?? 0
    : positionPlayback?.fileId === track?.fileId && positionPlayback ? playbackPosition(positionPlayback, clock)
    : seekOverride?.fileId === track?.fileId ? seekOverride?.positionSeconds ?? 0 : 0;

  const clearSeekPreview = () => {
    seekDraftRef.current = null;
    setSeekPreview(null);
  };

  const sendControl = async (command: PlayerCommand) => {
    if (pendingRef.current) return;
    if (command.action === "set_volume" && command.volume === lastVolumeRef.current) return;

    pendingRef.current = true;
    setPending(true);
    setFeedback(null);

    try {
      const res = await fetch(`/api/iot/devices/${encodeURIComponent(deviceId)}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      const data = (await res.json().catch(() => null)) as { ok: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);

      const message = `Đã gửi ${commandMessage(command)} tới ${deviceId}`;
      onLog("success", message);
      if (mountedRef.current) {
        if (command.action === "set_volume") lastVolumeRef.current = command.volume;
        if (command.action === "pause") setPaused(true);
        if (command.action === "resume") setPaused(false);
        if (command.action === "set_repeat") setRepeat(command.repeat);
        if (command.action === "seek") {
          if (trackRef.current?.fileId === command.fileId) {
            const updatedAt = Date.now();
            setSeekOverride({ fileId: command.fileId, positionSeconds: command.positionSeconds, updatedAt });
            setClock(updatedAt);
          }
          clearSeekPreview();
        }
        setFeedback({ ok: true, text: message });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Không gửi được lệnh điều khiển";
      onLog("error", `Điều khiển ${deviceId} lỗi: ${message}`);
      if (mountedRef.current) {
        if (command.action === "set_volume") setVolume(lastVolumeRef.current ?? 50);
        if (command.action === "seek") clearSeekPreview();
        setFeedback({ ok: false, text: message });
      }
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setPending(false);
    }
  };

  const commitSeek = () => {
    const draft = seekDraftRef.current;
    if (!draft || pendingRef.current) return;
    if (draft.fileId !== trackRef.current?.fileId) { clearSeekPreview(); return; }
    void sendControl({ action: "seek", ...draft });
  };

  const changeVolume = (value: number) => {
    const nextVolume = Math.max(0, Math.min(100, value));
    setVolume(nextVolume);
    void sendControl({ action: "set_volume", volume: nextVolume });
  };

  const buttonClass = "flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-200 transition hover:border-emerald-400 hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-emerald-400 disabled:cursor-not-allowed disabled:opacity-50";
  const rangeClass = "h-11 min-w-0 cursor-pointer accent-emerald-500 disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <section aria-label={`Điều khiển phát nhạc ${deviceId}`} className="mb-4 rounded-xl border border-emerald-700/50 bg-slate-900/60 p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-200">🎛️ Điều khiển phát nhạc</h3>
        <span className="max-w-full break-all text-xs text-emerald-400">● {deviceId} đã kết nối</span>
      </div>

      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-slate-200" title={track?.fileName}>{track?.fileName ?? "Chưa có bài đang phát"}</p>
          <p className="mt-1 text-xs text-slate-400">
            {activeTrack ? playback?.state === "PAUSED" ? "Đã tạm dừng" : "Đang phát"
              : playback?.state === "DONE" && playback.fileId ? "Đã kết thúc"
              : track ? "File đã gửi tới thiết bị" : "Gửi file nhạc để bắt đầu"}
          </p>
        </div>
        <button type="button" aria-label="Lặp lại bài hiện tại" aria-pressed={repeat === "one"}
          title={repeat === "one" ? "Tắt lặp lại bài hiện tại" : "Bật lặp lại bài hiện tại"}
          disabled={pending} onClick={() => void sendControl({ action: "set_repeat", repeat: repeat === "one" ? "off" : "one" })}
          className={`${buttonClass} shrink-0 ${repeat === "one" ? "border-emerald-500 bg-emerald-600/20 text-emerald-300" : ""}`}
        >
          <span aria-hidden="true">🔁</span> {repeat === "one" ? "Lặp 1 bài" : "Lặp lại"}
        </button>
      </div>

      <div className="mb-4">
        <label htmlFor={`seek-${deviceId}`} className="sr-only">Tua bài hát</label>
        <input key={track?.fileId ?? "no-track"} id={`seek-${deviceId}`} type="range" min={0}
          max={isDuration(duration) ? duration : 1} step={0.1} value={isDuration(duration) ? Math.min(position, duration) : 0}
          disabled={pending || !canSeek} aria-valuetext={`${formatPlaybackTime(position)} trên ${formatPlaybackTime(duration)}`}
          onChange={(e) => {
            if (!track) return;
            const draft = { fileId: track.fileId, positionSeconds: Number(e.target.value) };
            seekDraftRef.current = draft;
            setSeekPreview(draft);
          }}
          onPointerUp={commitSeek} onPointerCancel={clearSeekPreview}
          onKeyUp={(e) => { if (RANGE_KEYS.has(e.key)) commitSeek(); }} onBlur={commitSeek}
          className={`${rangeClass} block w-full`}
        />
        <div className="flex justify-between font-mono text-xs text-slate-400">
          <output htmlFor={`seek-${deviceId}`}>{formatPlaybackTime(position)}</output>
          <span aria-label="Tổng thời lượng">{formatPlaybackTime(duration)}</span>
        </div>
        {canSeek ? <p className="mt-1 text-xs text-slate-500">Kéo thanh để tua đến đoạn muốn nghe.</p>
          : track && <p className="mt-1 text-xs text-slate-500">{isDuration(duration) ? "Bài đã kết thúc hoặc đang lỗi." : "Chưa xác định được thời lượng của file."}</p>}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <button type="button" disabled={pending} onClick={() => void sendControl({ action: "previous" })} className={buttonClass}><span aria-hidden="true">⏮</span> Bài trước</button>
        <button type="button" disabled={pending} onClick={() => void sendControl({ action: paused ? "resume" : "pause" })} className={`${buttonClass} border-emerald-600 bg-emerald-600/20 text-emerald-300`}>
          <span aria-hidden="true">{paused ? "▶" : "⏸"}</span> {paused ? "Tiếp tục" : "Tạm dừng"}
        </button>
        <button type="button" disabled={pending} onClick={() => void sendControl({ action: "next" })} className={buttonClass}><span aria-hidden="true">⏭</span> Bài tiếp</button>
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between text-sm">
          <label htmlFor={`volume-${deviceId}`} className="text-slate-400">Âm lượng</label>
          <output htmlFor={`volume-${deviceId}`} className="font-mono text-emerald-300">{volume}%</output>
        </div>
        <div className="flex items-center gap-3">
          <button type="button" aria-label="Giảm âm lượng" disabled={pending || volume === 0} onClick={() => changeVolume(volume - 5)} className={`${buttonClass} w-11 shrink-0 text-lg`}>−</button>
          <input id={`volume-${deviceId}`} type="range" min={0} max={100} step={1} value={volume} disabled={pending} aria-valuetext={`${volume}%`}
            onChange={(e) => setVolume(Number(e.target.value))}
            onPointerUp={(e) => void sendControl({ action: "set_volume", volume: Number(e.currentTarget.value) })}
            onKeyUp={(e) => { if (RANGE_KEYS.has(e.key)) void sendControl({ action: "set_volume", volume: Number(e.currentTarget.value) }); }}
            onBlur={(e) => { if (lastVolumeRef.current !== null || Number(e.currentTarget.value) !== 50) void sendControl({ action: "set_volume", volume: Number(e.currentTarget.value) }); }}
            className={`${rangeClass} flex-1`}
          />
          <button type="button" aria-label="Tăng âm lượng" disabled={pending || volume === 100} onClick={() => changeVolume(volume + 5)} className={`${buttonClass} w-11 shrink-0 text-lg`}>+</button>
        </div>
      </div>

      <p role="status" aria-live="polite" className={`mt-2 text-xs ${feedback?.ok === false ? "text-red-300" : "text-slate-400"}`}>
        {pending ? "Đang gửi lệnh..." : feedback?.text ?? "Chọn mức âm lượng hoặc gửi lệnh phát nhạc đến thiết bị."}
      </p>
    </section>
  );
}
