"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface UploadResult {
  ok: boolean;
  message?: string;
  error?: string;
  meta?: {
    id: string;
    fileName: string;
    size: number;
    sha256: string;
    downloadUrl: string;
  };
}

type LogKind = "info" | "success" | "error";

interface LogEntry {
  time: string;
  kind: LogKind;
  text: string;
}

const MAX_SIZE = 20 * 1024 * 1024; // 20MB

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<UploadResult | null>(null);

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [priority, setPriority] = useState<"low" | "normal" | "high">("normal");
  const [sending, setSending] = useState(false);
  const [announceResult, setAnnounceResult] = useState<string | null>(null);

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const addLog = useCallback((kind: LogKind, text: string) => {
    const time = new Date().toLocaleTimeString("vi-VN");
    setLogs((prev) => [{ time, kind, text }, ...prev].slice(0, 50));
  }, []);

  // Kiểm tra broker lúc mount + mỗi 30s (?init=1 để kích hoạt kết nối từ phía server)
  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const res = await fetch("/api/broker-status?init=1");
        const data = await res.json();
        if (active) {
          if (data.connected) {
            addLog("success", "MQTT broker đã kết nối");
          } else if (data.reconnecting) {
            addLog("info", "MQTT đang thử kết nối lại broker...");
          } else {
            addLog("error", `Broker lỗi: ${data.error ?? "không xác định"}`);
          }
        }
      } catch {
        if (active) addLog("error", "Không gọi được API broker-status");
      }
    };
    check();
    const timer = setInterval(check, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [addLog]);

  /** Xử lý khi chọn file */
  const handleSelectFile = (selected: File | null) => {
    setResult(null);
    setProgress(0);
    if (!selected) {
      setFile(null);
      return;
    }
    if (selected.size > MAX_SIZE) {
      addLog("error", `File "${selected.name}" vượt quá 20MB`);
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setFile(selected);
    addLog("info", `Đã chọn file: ${selected.name} (${formatBytes(selected.size)})`);
  };

  /** Gửi file lên BE -> publish MQTT */
  const handleUpload = async () => {
    if (!file || uploading) return;

    setUploading(true);
    setResult(null);
    setProgress(0);
    addLog("info", `Bắt đầu gửi "${file.name}" lên server...`);

    try {
      const data = await new Promise<UploadResult>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const formData = new FormData();
        formData.append("file", file);

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            setProgress(pct);
            if (pct === 100) addLog("info", "Server đang publish lên MQTT...");
          }
        };
        xhr.onload = () => {
          try {
            const parsed = JSON.parse(xhr.responseText) as UploadResult;
            if (xhr.status >= 200 && xhr.status < 300) {
              resolve(parsed);
            } else {
              reject(new Error(parsed.error ?? `HTTP ${xhr.status}`));
            }
          } catch {
            reject(new Error(`HTTP ${xhr.status} — response không phải JSON`));
          }
        };
        xhr.onerror = () => reject(new Error("Lỗi mạng khi upload"));
        xhr.open("POST", "/api/upload");
        xhr.send(formData);
      });

      setResult(data);
      setProgress(100);
      addLog("success", data.message ?? "Đã đẩy file lên MQTT thành công");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Upload thất bại";
      setResult({ ok: false, error: msg });
      addLog("error", `Upload lỗi: ${msg}`);
    } finally {
      setUploading(false);
    }
  };

  /** Gửi bản tin text */
  const handleSendAnnouncement = async () => {
    if (!title.trim() || !content.trim() || sending) return;

    setSending(true);
    setAnnounceResult(null);
    addLog("info", `Đang gửi bản tin "${title.trim()}"...`);

    try {
      const res = await fetch("/api/announcement", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), content: content.trim(), priority }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };

      if (data.ok) {
        setAnnounceResult("Đã gửi bản tin qua MQTT ✓");
        addLog("success", `Bản tin "${title.trim()}" đã lên MQTT`);
        setTitle("");
        setContent("");
        setPriority("normal");
      } else {
        setAnnounceResult(data.error ?? "Gửi thất bại");
        addLog("error", `Bản tin lỗi: ${data.error}`);
      }
    } catch {
      setAnnounceResult("Lỗi mạng khi gửi bản tin");
      addLog("error", "Lỗi mạng khi gửi bản tin");
    } finally {
      setSending(false);
    }
  };

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 text-slate-100">
      <div className="mx-auto max-w-5xl px-4 py-10">
        {/* Header */}
        <header className="mb-8 flex flex-col gap-1">
          <h1 className="text-3xl font-bold tracking-tight">
            📡 MQTT Station — Gửi bản tin &amp; file nhạc
          </h1>
          <p className="text-sm text-slate-400">
            FE upload → BE xử lý → publish MQTT → thiết bị nhúng tải &amp; phát
          </p>
        </header>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* ===== Card 1: Upload file nhạc ===== */}
          <section className="rounded-2xl border border-slate-700 bg-slate-800/60 p-6 shadow-lg">
            <h2 className="mb-1 text-lg font-semibold">🎵 Gửi file nhạc</h2>
            <p className="mb-4 text-sm text-slate-400">
              Chọn file mp3/wav (tối đa 20MB). BE sẽ gửi URL tải file qua MQTT.
            </p>

            {/* Nút upload */}
            <label
              className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed p-8 text-center transition ${
                uploading
                  ? "border-slate-600 opacity-60"
                  : "border-slate-500 hover:border-emerald-400 hover:bg-slate-700/40"
              }`}
            >
              <input
                ref={inputRef}
                type="file"
                accept="audio/*,.mp3,.wav,.ogg,.m4a"
                className="hidden"
                disabled={uploading}
                onChange={(e) => handleSelectFile(e.target.files?.[0] ?? null)}
              />
              <span className="text-4xl">📤</span>
              <span className="mt-2 font-medium text-emerald-400">
                {file ? file.name : "Chọn file để upload"}
              </span>
              <span className="text-xs text-slate-400">
                {file ? formatBytes(file.size) : "Bấm để chọn hoặc kéo thả"}
              </span>
            </label>

            {/* Progress bar */}
            {(uploading || progress > 0) && (
              <div className="mt-4">
                <div className="h-2 overflow-hidden rounded-full bg-slate-700">
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-all duration-200"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <p className="mt-1 text-right text-xs text-slate-400">{progress}%</p>
              </div>
            )}

            {/* Kết quả */}
            {result && (
              <div
                className={`mt-4 rounded-lg p-3 text-sm ${
                  result.ok
                    ? "bg-emerald-900/40 text-emerald-300"
                    : "bg-red-900/40 text-red-300"
                }`}
              >
                {result.ok ? `✅ ${result.message}` : `❌ ${result.error}`}
              </div>
            )}

            <button
              onClick={handleUpload}
              disabled={!file || uploading}
              className="mt-4 w-full rounded-xl bg-emerald-600 px-4 py-3 font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-slate-600 disabled:text-slate-400"
            >
              {uploading ? "Đang xử lý..." : "Gửi lên MQTT"}
            </button>
            <button
              onClick={() => handleSelectFile(null)}
              disabled={uploading}
              className="mt-2 w-full rounded-xl border border-slate-600 px-4 py-2 text-sm text-slate-300 transition hover:bg-slate-700 disabled:opacity-50"
            >
              Xóa file đã chọn
            </button>
          </section>

          {/* ===== Card 2: Gửi bản tin ===== */}
          <section className="rounded-2xl border border-slate-700 bg-slate-800/60 p-6 shadow-lg">
            <h2 className="mb-1 text-lg font-semibold">📢 Gửi bản tin</h2>
            <p className="mb-4 text-sm text-slate-400">
              Nội dung dạng text, BE sẽ publish JSON lên topic
              <code className="mx-1 rounded bg-slate-900 px-1.5 py-0.5 text-emerald-400">
                station/player/announcement
              </code>
            </p>

            <div className="space-y-3">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Tiêu đề bản tin"
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-emerald-400"
              />
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Nội dung bản tin..."
                rows={5}
                className="w-full resize-none rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-emerald-400"
              />
              <div className="flex items-center gap-3">
                <label className="text-sm text-slate-400">Ưu tiên:</label>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as typeof priority)}
                  className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm outline-none focus:border-emerald-400"
                >
                  <option value="low">Thấp</option>
                  <option value="normal">Bình thường</option>
                  <option value="high">Cao</option>
                </select>
              </div>

              {announceResult && (
                <div
                  className={`rounded-lg p-3 text-sm ${
                    announceResult.includes("✓")
                      ? "bg-emerald-900/40 text-emerald-300"
                      : "bg-red-900/40 text-red-300"
                  }`}
                >
                  {announceResult}
                </div>
              )}

              <button
                onClick={handleSendAnnouncement}
                disabled={sending || !title.trim() || !content.trim()}
                className="w-full rounded-xl bg-sky-600 px-4 py-3 font-semibold text-white transition hover:bg-sky-500 disabled:cursor-not-allowed disabled:bg-slate-600 disabled:text-slate-400"
              >
                {sending ? "Đang gửi..." : "Gửi bản tin"}
              </button>
            </div>
          </section>

          {/* ===== Card 3: Log ===== */}
          <section className="rounded-2xl border border-slate-700 bg-slate-800/60 p-6 shadow-lg lg:col-span-2">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold">🧾 Nhật ký hoạt động</h2>
              <button
                onClick={() => setLogs([])}
                className="text-xs text-slate-400 hover:text-slate-200"
              >
                Xóa log
              </button>
            </div>
            <div className="h-48 overflow-y-auto rounded-lg bg-slate-900 p-3 font-mono text-xs">
              {logs.length === 0 ? (
                <p className="text-slate-500">Chưa có hoạt động nào...</p>
              ) : (
                logs.map((log, i) => (
                  <div key={i} className="flex gap-2 py-0.5">
                    <span className="text-slate-500">{log.time}</span>
                    <span
                      className={
                        log.kind === "success"
                          ? "text-emerald-400"
                          : log.kind === "error"
                            ? "text-red-400"
                            : "text-slate-300"
                      }
                    >
                      {log.text}
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>
        </div>

        <footer className="mt-8 text-center text-xs text-slate-500">
          Topics: station/player/announcement · station/player/file/available
        </footer>
      </div>
    </main>
  );
}
