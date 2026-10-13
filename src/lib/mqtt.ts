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

import { randomUUID } from "node:crypto";
import mqtt, { type MqttClient } from "mqtt";

import { touchDevice } from "@/lib/devices";

export const TOPIC_BASE = process.env.MQTT_TOPIC_BASE ?? "station/player";

/** Topics chung (luồng cũ, giữ tương thích MQTTX) */
export const TOPICS = {
  /** Gửi bản tin dạng text (JSON) */
  announcement: `${TOPIC_BASE}/announcement`,
  /** Thông báo file đã sẵn sàng để thiết bị tải qua HTTP */
  fileAvailable: `${TOPIC_BASE}/file/available`,
  /** Lệnh điều khiển phát (play/stop/skip...) */
  control: `${TOPIC_BASE}/control`,
} as const;

/** Topics riêng cho từng thiết bị (luồng mới — xem src/lib/devices.ts deviceTopics) */
export function topicsForDevice(deviceId: string): { command: string; status: string } {
  return {
    command: `${TOPIC_BASE}/device/${encodeURIComponent(deviceId)}/command`,
    status: `${TOPIC_BASE}/device/${encodeURIComponent(deviceId)}/status`,
  };
}

// ==============================================================================
// SINGLETON CLIENT
// ==============================================================================

declare global {
  // eslint-disable-next-line no-var
  var __mqttClient: MqttClient | undefined;
  // eslint-disable-next-line no-var
  var __mqttConnecting: Promise<MqttClient> | undefined;
  // eslint-disable-next-line no-var
  var __mqttLastError: string | undefined;
}

/** Endpoint cho log/API: không chứa username/password trong URL. */
function brokerEndpoint(value = process.env.MQTT_URL): string {
  if (!value) return "chưa cấu hình MQTT_URL";
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "MQTT_URL không hợp lệ";
  }
}

function connectionError(err: Error): Error {
  const code = (err as Error & { code?: string | number }).code;
  let hint: string;
  if ([4, 5, 134, 135].includes(Number(code))) {
    hint = "Broker từ chối credential MQTT; kiểm tra MQTT_USERNAME/MQTT_PASSWORD của broker demo (khác tài khoản Dashboard)";
  } else if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    hint = "Không resolve được host broker; kiểm tra MQTT_URL và mạng Docker. Host nội bộ chỉ dùng trong cùng network";
  } else if (code === "ECONNREFUSED") {
    hint = "Broker chưa mở listener tại host/port này; kiểm tra container và port mapping";
  } else if (typeof code === "string" && /CERT|TLS|SSL/.test(code)) {
    hint = "TLS thất bại; kiểm tra hostname, CA và chứng chỉ của đúng broker demo";
  } else {
    hint = "Chưa nhận được MQTT CONNACK; kiểm tra host/port, giao thức, firewall và mạng Docker của broker demo";
  }
  // Không đưa err.message/URL gốc ra API vì có thể chứa credential.
  const safeCode = typeof code === "number" || (typeof code === "string" && /^[A-Z0-9_]+$/.test(code))
    ? ` [${code}]` : "";
  return new Error(`MQTT ${brokerEndpoint()}${safeCode} — ${hint}`);
}

function createClient(): MqttClient {
  const url = process.env.MQTT_URL?.trim();
  if (!url) {
    throw new Error("Chưa cấu hình MQTT_URL — npm run dev cần .env.local trỏ tới broker demo; Docker Compose tự inject URL nội bộ");
  }
  try {
    if (!["mqtt:", "mqtts:", "ws:", "wss:"].includes(new URL(url).protocol)) throw new Error();
  } catch {
    throw new Error("MQTT_URL không hợp lệ — dùng mqtt://, mqtts://, ws:// hoặc wss://");
  }
  // PID thường là 1 trong Docker; thêm UUID để nhiều container không kick nhau.
  const clientId = `${process.env.MQTT_CLIENT_ID_PREFIX ?? "web-uploader"}-${process.pid}-${randomUUID().slice(0, 8)}`;

  const client = mqtt.connect(url, {
    clientId,
    username: process.env.MQTT_USERNAME || process.env.MQTT_APP_USERNAME || undefined,
    password: process.env.MQTT_PASSWORD || process.env.MQTT_APP_PASSWORD || undefined,
    keepalive: 30,
    // Tự reconnect mỗi 5s khi đứt kết nối (mqtt.js không hỗ trợ backoff tăng dần,
    // khoảng cố định 5s là hợp lý: không spam broker, không chờ quá lâu)
    reconnectPeriod: 5000,
    // User có thể chưa được emqx-init tạo lúc app bắt đầu kết nối.
    reconnectOnConnackError: true,
    resubscribe: true, // tự re-subscribe sau khi reconnect
    connectTimeout: 10_000,
    clean: true,
  });

  // Log lifecycle để debug trên Dokploy (`docker logs` / Dokploy UI logs)
  client.on("connect", () => {
    globalThis.__mqttLastError = undefined;
    console.log(`[mqtt] connected to ${brokerEndpoint(url)} (clientId=${clientId})`);
  });
  client.on("reconnect", () => {
    console.warn(`[mqtt] reconnecting to ${brokerEndpoint(url)}...`);
  });
  client.on("close", () => {
    console.warn("[mqtt] connection closed");
  });
  client.on("error", (err) => {
    // Log thay vì crash — thư viện tự reconnect. Lỗi auth sai user sẽ lặp lại ở đây.
    globalThis.__mqttLastError = connectionError(err).message;
    console.error("[mqtt] client error:", globalThis.__mqttLastError);
  });
  client.on("offline", () => {
    console.warn("[mqtt] client offline (đang chờ reconnect)");
  });

  // Subscribe status của mọi thiết bị — BE cập nhật lastSeenAt để web hiển thị
  // Online/Offline. `resubscribe: true` tự đăng ký lại sau mỗi lần reconnect.
  client.subscribe(`${TOPIC_BASE}/device/+/status`, { qos: 1 }, (err) => {
    if (err) console.error("[mqtt] subscribe device status thất bại:", err.message);
  });

  // Nhận status từ thiết bị: { deviceId, state, ... } → touch device registry
  client.on("message", (topic, payload) => {
    if (!topic.endsWith("/status")) return;
    const match = topic.match(/device\/([^/]+)\/status$/);
    if (!match) return;
    const deviceId = decodeURIComponent(match[1]);
    let status: Record<string, unknown> | undefined;
    try {
      const msg: unknown = JSON.parse(payload.toString());
      if (msg && typeof msg === "object" && !Array.isArray(msg)) status = msg as Record<string, unknown>;
      console.log(`[mqtt] status từ ${deviceId}: ${String(status?.state ?? "?")}`);
    } catch {
      console.warn(`[mqtt] payload status không phải JSON từ ${deviceId}`);
    }
    void touchDevice(deviceId, status).catch((err) =>
      console.error(`[mqtt] touch device ${deviceId} lỗi:`, err.message),
    );
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

    const connecting = new Promise<MqttClient>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        const error = new Error(`MQTT connect timeout sau 10s (${brokerEndpoint()}) — kiểm tra host/port, giao thức và mạng Docker của broker demo`);
        globalThis.__mqttLastError = error.message;
        reject(error);
      }, 10_000);

      const onConnect = () => {
        clearTimeout(timeout);
        cleanup();
        resolve(client);
      };
      const onError = (err: Error) => {
        clearTimeout(timeout);
        cleanup();
        // Không xóa __mqttClient: thư viện đang tự retry, request này fail nhưng
        // các request sau vẫn dùng lại client khi broker lên lại.
        reject(connectionError(err));
      };
      const cleanup = () => {
        client.off("connect", onConnect);
        client.off("error", onError);
      };

      // "connect" chỉ bắn khi handshake thành công lần đầu hoặc sau mỗi lần reconnect
      client.once("connect", onConnect);
      client.once("error", onError);
    });
    const pending = connecting.finally(() => {
      // Dọn cả nhánh timeout; request sau phải được chờ một lần kết nối mới.
      if (globalThis.__mqttConnecting === pending) globalThis.__mqttConnecting = undefined;
    });
    globalThis.__mqttConnecting = pending;
  }

  return globalThis.__mqttConnecting;
}

/** Trạng thái hiện tại của client (cho /api/broker-status, không tạo connection mới) */
export function getMqttStatus(): {
  connected: boolean;
  reconnecting: boolean;
  clientId: string | null;
  broker: string;
  error: string | null;
} {
  const client = globalThis.__mqttClient;
  return {
    connected: client?.connected ?? false,
    reconnecting: client ? !client.connected && client.reconnecting : false,
    clientId: client?.options.clientId as string | undefined ?? null,
    broker: brokerEndpoint(),
    error: client?.connected ? null : globalThis.__mqttLastError ?? null,
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
  retain = false,
): Promise<void> {
  return new Promise((resolve, reject) => {
    client.publish(topic, payload, { qos, retain }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/** Publish qua singleton — API routes gọi hàm này, không tự quản lý connection */
async function publish(
  topic: string,
  payload: string | Buffer,
  qos: 0 | 1 = 1,
  retain = false,
): Promise<void> {
  const client = await getMqttClient();
  await publishAsync(client, topic, payload, qos, retain);
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

export interface FileAvailable {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  downloadUrl: string;
  uploadedAt: string;
  durationSeconds?: number | null;
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
    1,
    true,
  );
}

/**
 * Gửi lệnh/file tới 1 thiết bị cụ thể qua topic command riêng của nó.
 * Dùng cho luồng mới: BE publish { fileId, action } → device tải file bằng
 * access token (xem /api/upload và /api/files/[id]).
 */
export async function publishDeviceCommand(
  deviceId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const { command } = topicsForDevice(deviceId);
  const message = { ...payload, sentAt: new Date().toISOString() };
  await publish(command, JSON.stringify(message));
}

/** Graceful shutdown (dùng khi server đóng — vd signal SIGTERM trên container) */
export async function closeMqttClient(): Promise<void> {
  const client = globalThis.__mqttClient;
  if (client) {
    await new Promise<void>((resolve) => client.end(false, {}, () => resolve()));
    globalThis.__mqttClient = undefined;
    globalThis.__mqttConnecting = undefined;
    globalThis.__mqttLastError = undefined;
    console.log("[mqtt] client closed");
  }
}
