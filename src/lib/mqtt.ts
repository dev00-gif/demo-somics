/**
 * MQTT helper dùng chung cho backend (Next.js API routes).
 *
 * Kiến trúc: SINGLETON CLIENT — 1 kết nối dài hạn tới broker, chia sẻ giữa
 * mọi API routes, tự reconnect khi đứt (mất mạng, broker restart, VPS reboot).
 *
 * Vì sao singleton thay vì connect-per-request:
 *   - Handshake TCP + MQTT CONNECT tốn ~1 RTT mỗi request → không cần thiết
 *   - EMQX phải duy trì session, log connect/disconnect spam
 *   - Không thể dùng QoS 1 flow hiệu quả khi connection chết ngay sau publish
 *
 * Lưu ý Next.js dev: module được reload khi hot-reload → cache client trên
 * globalThis để không bị leak connection mỗi lần sửa code.
 */

import mqtt, { type MqttClient } from "mqtt";

export const TOPIC_BASE = process.env.MQTT_TOPIC_BASE ?? "station/player";

/** Topics mà bên nhúng sẽ lắng nghe */
export const TOPICS = {
  /** Gửi bản tin dạng text (JSON) */
  announcement: `${TOPIC_BASE}/announcement`,
  /** Metadata file nhạc (JSON), gửi trước khi push chunk */
  fileMeta: `${TOPIC_BASE}/file/meta`,
  /** Các chunk binary của file nhạc */
  fileChunk: `${TOPIC_BASE}/file/chunk`,
  /** Tín hiệu file đã gửi xong */
  fileEnd: `${TOPIC_BASE}/file/end`,
  /** Thông báo file đã sẵn sàng để thiết bị tải qua HTTP */
  fileAvailable: `${TOPIC_BASE}/file/available`,
  /** Lệnh điều khiển phát (play/stop/skip...) */
  control: `${TOPIC_BASE}/control`,
} as const;

/** Kích thước 1 chunk (bytes) — an toàn cho hầu hết broker (default max packet 1MB) */
export const CHUNK_SIZE = 32 * 1024;

// ==============================================================================
// SINGLETON CLIENT
// ==============================================================================

declare global {
  // eslint-disable-next-line no-var
  var __mqttClient: MqttClient | undefined;
  // eslint-disable-next-line no-var
  var __mqttConnecting: Promise<MqttClient> | undefined;
}

function createClient(): MqttClient {
  const url = process.env.MQTT_URL ?? "mqtt://emqx:1883";
  const clientId = `${process.env.MQTT_CLIENT_ID_PREFIX ?? "web-uploader"}-${process.pid}`;

  const client = mqtt.connect(url, {
    clientId,
    username: process.env.MQTT_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || undefined,
    keepalive: 30,
    // Tự reconnect mỗi 5s khi đứt kết nối (mqtt.js không hỗ trợ backoff tăng dần,
    // khoảng cố định 5s là hợp lý: không spam broker, không chờ quá lâu)
    reconnectPeriod: 5000,
    resubscribe: true, // tự re-subscribe sau khi reconnect
    connectTimeout: 10_000,
    clean: true,
  });

  // Log lifecycle để debug trên Dokploy (`docker logs` / Dokploy UI logs)
  client.on("connect", () => {
    console.log(`[mqtt] connected to ${url} (clientId=${clientId})`);
  });
  client.on("reconnect", () => {
    console.warn(`[mqtt] reconnecting to ${url}...`);
  });
  client.on("close", () => {
    console.warn("[mqtt] connection closed");
  });
  client.on("error", (err) => {
    // Log thay vì crash — thư viện tự reconnect. Lỗi auth sai user sẽ lặp lại ở đây.
    console.error("[mqtt] client error:", err.message);
  });
  client.on("offline", () => {
    console.warn("[mqtt] client offline (đang chờ reconnect)");
  });

  return client;
}

/**
 * Lấy client singleton. Lần đầu gọi sẽ tạo + chờ CONNECT thành công
 * (hoặc timeout 10s → throw). Các lần gọi sau trả ngay client đã có.
 */
export function getMqttClient(): Promise<MqttClient> {
  // Kết nối đang sẵn sàng
  if (globalThis.__mqttClient?.connected) {
    return Promise.resolve(globalThis.__mqttClient);
  }

  // Client chưa có hoặc đang reconnect → tái dùng promise đang chờ (tránh tạo 2 client)
  if (!globalThis.__mqttConnecting) {
    const client = globalThis.__mqttClient ?? createClient();
    globalThis.__mqttClient = client;

    globalThis.__mqttConnecting = new Promise<MqttClient>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("MQTT connect timeout sau 10s — kiểm tra MQTT_URL/credentials"));
      }, 10_000);

      const onConnect = () => {
        clearTimeout(timeout);
        cleanup();
        globalThis.__mqttConnecting = undefined;
        resolve(client);
      };
      const onError = (err: Error) => {
        clearTimeout(timeout);
        cleanup();
        // Không xóa __mqttClient: thư viện đang tự retry, request này fail nhưng
        // các request sau vẫn dùng lại client khi broker lên lại.
        globalThis.__mqttConnecting = undefined;
        reject(err);
      };
      const cleanup = () => {
        client.off("connect", onConnect);
        client.off("error", onError);
      };

      // "connect" chỉ bắn khi handshake thành công lần đầu hoặc sau mỗi lần reconnect
      client.once("connect", onConnect);
      client.once("error", onError);
    });
  }

  return globalThis.__mqttConnecting;
}

/** Trạng thái hiện tại của client (cho /api/broker-status, không tạo connection mới) */
export function getMqttStatus(): {
  connected: boolean;
  reconnecting: boolean;
  clientId: string | null;
} {
  const client = globalThis.__mqttClient;
  return {
    connected: client?.connected ?? false,
    reconnecting: client ? !client.connected && client.reconnecting : false,
    clientId: client?.options.clientId as string | undefined ?? null,
  };
}

// ==============================================================================
// PUBLISH HELPERS
// ==============================================================================

/** Promise wrapper cho client.publish */
export function publishAsync(
  client: MqttClient,
  topic: string,
  payload: string | Buffer,
  qos: 0 | 1 = 1,
): Promise<void> {
  return new Promise((resolve, reject) => {
    client.publish(topic, payload, { qos }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/** Publish qua singleton — API routes gọi hàm này, không tự quản lý connection */
async function publish(topic: string, payload: string | Buffer, qos: 0 | 1 = 1): Promise<void> {
  const client = await getMqttClient();
  await publishAsync(client, topic, payload, qos);
}

/** Gửi bản tin dạng JSON lên topic announcement */
export async function publishAnnouncement(payload: {
  id: string;
  title: string;
  content: string;
  priority?: "low" | "normal" | "high";
  sender?: string;
  createdAt?: string;
}): Promise<void> {
  const message = {
    ...payload,
    type: "announcement",
    createdAt: payload.createdAt ?? new Date().toISOString(),
  };
  await publish(TOPICS.announcement, JSON.stringify(message));
}

export interface FileMeta {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  chunkSize: number;
  totalChunks: number;
  sha256?: string;
  uploadedAt: string;
}

export interface FileAvailable {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  downloadUrl: string;
  uploadedAt: string;
}

/** Gửi thông báo file đã upload xong; thiết bị dùng downloadUrl để tải file. */
export async function publishFileAvailable(file: FileAvailable): Promise<void> {
  await publish(
    TOPICS.fileAvailable,
    JSON.stringify({
      ...file,
      type: "file",
      delivery: "http",
    }),
  );
}

/**
 * Gửi 1 file nhị phân (mp3/wav...) lên broker theo giao thức:
 *  1) topic file/meta  -> JSON mô tả file
 *  2) topic file/chunk -> từng chunk Buffer (có header index 4 bytes + hash id)
 *  3) topic file/end   -> JSON báo hoàn tất
 *
 * Dùng connection dài hạn — các chunk publish tuần tự trên cùng socket.
 */
export async function publishFile(
  file: { buffer: Buffer; fileName: string; mimeType: string },
  meta?: { id?: string; sha256?: string },
  onProgress?: (percent: number) => void,
): Promise<FileMeta> {
  const id = meta?.id ?? crypto.randomUUID();
  const totalChunks = Math.max(1, Math.ceil(file.buffer.length / CHUNK_SIZE));

  const fileMeta: FileMeta = {
    id,
    fileName: file.fileName,
    mimeType: file.mimeType,
    size: file.buffer.length,
    chunkSize: CHUNK_SIZE,
    totalChunks,
    sha256: meta?.sha256,
    uploadedAt: new Date().toISOString(),
  };

  // Lấy client 1 lần cho cả 3 bước — không re-await getMqttClient() mỗi chunk
  const client = await getMqttClient();

  // 1. Metadata
  await publishAsync(client, TOPICS.fileMeta, JSON.stringify(fileMeta));

  // 2. Chunks — header 4 bytes big-endian là index của chunk để bên nhúng ghép đúng thứ tự
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.buffer.length);
    const data = file.buffer.subarray(start, end);

    const header = Buffer.alloc(4);
    header.writeUInt32BE(i, 0);
    const payload = Buffer.concat([header, data]);

    await publishAsync(client, TOPICS.fileChunk, payload);
    onProgress?.(Math.round(((i + 1) / totalChunks) * 100));
  }

  // 3. Báo kết thúc
  await publishAsync(
    client,
    TOPICS.fileEnd,
    JSON.stringify({ id, fileName: fileMeta.fileName, totalChunks, size: fileMeta.size }),
  );

  return fileMeta;
}

/** Graceful shutdown (dùng khi server đóng — vd signal SIGTERM trên container) */
export async function closeMqttClient(): Promise<void> {
  const client = globalThis.__mqttClient;
  if (client) {
    await new Promise<void>((resolve) => client.end(false, {}, () => resolve()));
    globalThis.__mqttClient = undefined;
    globalThis.__mqttConnecting = undefined;
    console.log("[mqtt] client closed");
  }
}
