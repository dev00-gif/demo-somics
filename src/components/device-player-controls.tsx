"use client";

import { useEffect, useRef, useState } from "react";

type PlayerAction = "set_volume" | "pause" | "resume" | "next" | "previous";

interface DevicePlayerControlsProps {
  deviceId: string;
  onLog: (kind: "success" | "error", message: string) => void;
}

const ACTION_LABELS: Record<PlayerAction, string> = {
  set_volume: "đổi âm lượng",
  pause: "tạm dừng",
  resume: "tiếp tục phát",
  next: "chuyển bài tiếp theo",
  previous: "quay lại bài trước",
};

export default function DevicePlayerControls({ deviceId, onLog }: DevicePlayerControlsProps) {
  const [volume, setVolume] = useState(50);
  const [paused, setPaused] = useState(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const pendingRef = useRef(false);
  const lastVolumeRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const sendControl = async (action: PlayerAction, nextVolume?: number) => {
    if (pendingRef.current) return;
    if (action === "set_volume" && nextVolume === lastVolumeRef.current) return;

    pendingRef.current = true;
    setPending(true);
    setFeedback(null);

    try {
      const res = await fetch(`/api/iot/devices/${encodeURIComponent(deviceId)}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...(action === "set_volume" ? { volume: nextVolume } : {}) }),
      });
      const data = (await res.json().catch(() => null)) as { ok: boolean; error?: string } | null;
      if (!res.ok || !data?.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);

      const message = action === "set_volume"
        ? `Đã gửi mức âm lượng ${nextVolume}% tới ${deviceId}`
        : `Đã gửi lệnh ${ACTION_LABELS[action]} tới ${deviceId}`;
      onLog("success", message);
      if (mountedRef.current) {
        if (action === "set_volume") lastVolumeRef.current = nextVolume!;
        if (action === "pause") setPaused(true);
        if (action === "resume") setPaused(false);
        setFeedback({ ok: true, text: message });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Không gửi được lệnh điều khiển";
      onLog("error", `Điều khiển ${deviceId} lỗi: ${message}`);
      if (mountedRef.current) {
        if (action === "set_volume") setVolume(lastVolumeRef.current ?? 50);
        setFeedback({ ok: false, text: message });
      }
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setPending(false);
    }
  };

  const changeVolume = (value: number) => {
    const nextVolume = Math.max(0, Math.min(100, value));
    setVolume(nextVolume);
    void sendControl("set_volume", nextVolume);
  };

  const buttonClass = "flex min-h-11 items-center justify-center gap-2 rounded-lg border border-slate-600 px-3 py-2 text-sm text-slate-200 transition hover:border-emerald-400 hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-emerald-400 disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <section aria-label={`Điều khiển phát nhạc ${deviceId}`} className="mb-4 rounded-xl border border-emerald-700/50 bg-slate-900/60 p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-200">🎛️ Điều khiển phát nhạc</h3>
        <span className="max-w-full break-all text-xs text-emerald-400">● {deviceId} đã kết nối</span>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <button type="button" disabled={pending} onClick={() => void sendControl("previous")} className={buttonClass}>
          <span aria-hidden="true">⏮</span> Bài trước
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => void sendControl(paused ? "resume" : "pause")}
          className={`${buttonClass} border-emerald-600 bg-emerald-600/20 text-emerald-300`}
        >
          <span aria-hidden="true">{paused ? "▶" : "⏸"}</span> {paused ? "Tiếp tục" : "Tạm dừng"}
        </button>
        <button type="button" disabled={pending} onClick={() => void sendControl("next")} className={buttonClass}>
          <span aria-hidden="true">⏭</span> Bài tiếp
        </button>
      </div>

      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between text-sm">
          <label htmlFor={`volume-${deviceId}`} className="text-slate-400">Âm lượng</label>
          <output htmlFor={`volume-${deviceId}`} className="font-mono text-emerald-300">{volume}%</output>
        </div>
        <div className="flex items-center gap-3">
          <button type="button" aria-label="Giảm âm lượng" disabled={pending || volume === 0} onClick={() => changeVolume(volume - 5)} className={`${buttonClass} w-11 shrink-0 text-lg`}>−</button>
          <input
            id={`volume-${deviceId}`}
            type="range"
            min={0}
            max={100}
            step={1}
            value={volume}
            disabled={pending}
            aria-valuetext={`${volume}%`}
            onChange={(e) => setVolume(Number(e.target.value))}
            onPointerUp={(e) => void sendControl("set_volume", Number(e.currentTarget.value))}
            onKeyUp={(e) => {
              if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(e.key)) {
                void sendControl("set_volume", Number(e.currentTarget.value));
              }
            }}
            onBlur={(e) => {
              if (lastVolumeRef.current !== null || Number(e.currentTarget.value) !== 50) {
                void sendControl("set_volume", Number(e.currentTarget.value));
              }
            }}
            className="h-11 min-w-0 flex-1 cursor-pointer accent-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
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
