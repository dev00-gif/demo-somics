/**
 * DEVICE REGISTRY — lưu bằng JSON file (không cần DB).
 *
 * Cấu trúc thư mục (UPLOAD_DIR/data hoặc ./data):
 *   data/devices.json           — danh sách thiết bị + trạng thái
 *   data/activation-codes.json  — mã kích hoạt (code -> deviceId, used flag)
 *   data/device-tokens.json     — access token đang hiệu lực (token -> deviceId)
 *
 * Ghi file theo kiểu atomic (write temp -> rename) để không hỏng dữ liệu khi
 * process chết giữa chừng. Cache trong bộ nhớ, đọc lại khi file đổi (mtime).
 *
 * Production nhiều thiết bị nên thay bằng DB thật — interface ở đây giữ hẹp
 * (getDevice, saveDevice...) để việc thay backend lưu trữ sau này không đụng
 * vào API routes.
 */

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// ==============================================================================
// TYPES
// ==============================================================================

export interface Device {
  /** Định danh thiết bị, vd "SOMICS-000001" — cũng là username MQTT */
  deviceId: string;
  /** Thời điểm tạo thiết bị */
  createdAt: string;
  /** Thời điểm kích hoạt lần đầu (null = chưa kích hoạt) */
  activatedAt: string | null;
  /** Firmware version device báo lúc kích hoạt */
  firmwareVersion: string | null;
  /** SHA256 hash của MQTT password cấp lúc activate — dùng xác thực /api/iot/token */
  passwordHash: string | null;
  /** Thời điểm nhận heartbeat/status gần nhất qua MQTT */
  lastSeenAt: string | null;
  /** true nếu đang nhận status định kỳ (còn trong cửa sổ ONLINE_WINDOW_MS) */
  online: boolean;
}

export interface ActivationCode {
  /** Mã kích hoạt, vd "xxxx-xxxx-xxxx" */
  code: string;
  deviceId: string;
  /** "unused" | "used" | "revoked" */
  status: "unused" | "used" | "revoked";
  createdAt: string;
  usedAt: string | null;
}

export interface DeviceToken {
  /** Token (SHA256 hex của raw token) — lưu hash, không lưu raw */
  tokenHash: string;
  deviceId: string;
  createdAt: string;
  /** null = không hết hạn */
  expiresAt: string | null;
  /**
   * Loại token: "access" (tải file, TTL ngắn) | "refresh" (đổi cặp token mới,
   * TTL dài, dùng 1 lần — rotation). Token cũ không có trường này coi là access.
   */
  kind?: "access" | "refresh";
}

// ==============================================================================
// HELPERS — atomic JSON store
// ==============================================================================

const DATA_DIR = process.env.DEVICE_DATA_DIR ?? path.join(process.cwd(), "data");

const DEVICES_FILE = path.join(DATA_DIR, "devices.json");
const CODES_FILE = path.join(DATA_DIR, "activation-codes.json");
const TOKENS_FILE = path.join(DATA_DIR, "device-tokens.json");

/** Thiết bị coi là ONLINE nếu heartbeat trong khoảng này */
export const ONLINE_WINDOW_MS = 2 * 60 * 1000;

/** Access token hết hạn sau 10 phút (chỉ dùng cho 1 lần tải file) */
export const TOKEN_TTL_MS = 10 * 60 * 1000;

/** Refresh token hết hạn sau 30 ngày — dùng để đổi cặp token mới khi access hết hạn */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type Store<T> = {
  data: T;
  mtimeMs: number;
};

const cache = new Map<string, Store<unknown>>();

async function readStore<T>(file: string, fallback: T): Promise<T> {
  try {
    const st = await stat(file);
    const cached = cache.get(file) as Store<T> | undefined;
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.data;

    const data = JSON.parse(await readFile(file, "utf8")) as T;
    cache.set(file, { data, mtimeMs: st.mtimeMs });
    return data;
  } catch {
    return fallback;
  }
}

async function writeStore<T>(file: string, data: T): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, file); // atomic trên cùng filesystem
  try {
    const st = await stat(file);
    cache.set(file, { data, mtimeMs: st.mtimeMs });
  } catch {
    cache.delete(file);
  }
}

// ==============================================================================
// DEVICES
// ==============================================================================

export async function getDevice(deviceId: string): Promise<Device | null> {
  const d = await readStore<Record<string, Device>>(DEVICES_FILE, {});
  return d[deviceId] ?? null;
}

export async function listDevices(): Promise<Device[]> {
  const d = await readStore<Record<string, Device>>(DEVICES_FILE, {});
  const now = Date.now();
  return Object.values(d).map((dev) => ({
    ...dev,
    online:
      dev.lastSeenAt !== null &&
      now - new Date(dev.lastSeenAt).getTime() < ONLINE_WINDOW_MS,
  }));
}

export async function saveDevice(device: Device): Promise<void> {
  const d = await readStore<Record<string, Device>>(DEVICES_FILE, {});
  d[device.deviceId] = device;
  await writeStore(DEVICES_FILE, d);
}

/**
 * Cập nhật lastSeenAt (được gọi từ MQTT message handler khi device publish
 * status). Trả device sau khi cập nhật, null nếu device chưa đăng ký.
 */
export async function touchDevice(deviceId: string): Promise<Device | null> {
  const d = await readStore<Record<string, Device>>(DEVICES_FILE, {});
  const dev = d[deviceId];
  if (!dev) return null;

  const now = new Date().toISOString();
  dev.lastSeenAt = now;
  dev.online = true;
  await writeStore(DEVICES_FILE, d);
  return { ...dev, lastSeenAt: now, online: true };
}

// ==============================================================================
// ACTIVATION CODES
// ==============================================================================

export async function getActivationCode(
  code: string,
): Promise<ActivationCode | null> {
  const codes = await readStore<Record<string, ActivationCode>>(CODES_FILE, {});
  return codes[code.toUpperCase()] ?? null;
}

export async function saveActivationCode(ac: ActivationCode): Promise<void> {
  const codes = await readStore<Record<string, ActivationCode>>(CODES_FILE, {});
  codes[ac.code.toUpperCase()] = ac;
  await writeStore(CODES_FILE, codes);
}

/** Sinh mã kích hoạt ngẫu nhiên dạng XXXX-XXXX-XXXX (loại ký tự dễ nhầm) */
export function generateActivationCode(): string {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // không có I,L,O,0,1
  const buf = crypto.randomBytes(12);
  const out: string[] = [];
  for (let i = 0; i < 3; i++) {
    let seg = "";
    for (let j = 0; j < 4; j++) {
      seg += chars[buf[i * 4 + j] % chars.length];
    }
    out.push(seg);
  }
  return out.join("-");
}

// ==============================================================================
// DEVICE TOKENS (dùng cho download API)
// ==============================================================================

export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export async function saveDeviceToken(token: DeviceToken): Promise<void> {
  const tokens = await readStore<Record<string, DeviceToken>>(TOKENS_FILE, {});
  tokens[token.tokenHash] = token;
  await writeStore(TOKENS_FILE, tokens);
}

/**
 * Kiểm tra ACCESS token + trả deviceId. Token hết hạn hoặc không tồn tại → null.
 * Refresh token KHÔNG dùng tải file được (chỉ endpoint /api/iot/token/refresh).
 * Lười dọn token hết hạn (mỗi lần verify quét qua, xóa nếu > 1000 entries).
 */
export async function verifyDeviceToken(
  rawToken: string,
): Promise<{ deviceId: string } | null> {
  const tokens = await readStore<Record<string, DeviceToken>>(TOKENS_FILE, {});
  const entry = tokens[hashToken(rawToken)];
  if (!entry || entry.kind === "refresh") return null;

  if (entry.expiresAt !== null && new Date(entry.expiresAt).getTime() < Date.now()) {
    delete tokens[entry.tokenHash];
    await writeStore(TOKENS_FILE, tokens);
    return null;
  }
  return { deviceId: entry.deviceId };
}

/**
 * Tiêu thụ 1 refresh token (ROTATION — dùng 1 lần rồi chết):
 *   - token phải là loại "refresh", khớp deviceId, chưa hết hạn
 *   - xóa token cũ khỏi store trước khi cấp cặp mới (gọi issueDeviceTokenPair ngay sau)
 * Trả false nếu token không hợp lệ → route trả 401.
 */
export async function consumeRefreshToken(
  rawToken: string,
  deviceId: string,
): Promise<boolean> {
  const tokens = await readStore<Record<string, DeviceToken>>(TOKENS_FILE, {});
  const entry = tokens[hashToken(rawToken)];
  if (!entry || entry.kind !== "refresh" || entry.deviceId !== deviceId) return false;

  delete tokens[entry.tokenHash];
  await writeStore(TOKENS_FILE, tokens);

  if (entry.expiresAt !== null && new Date(entry.expiresAt).getTime() < Date.now()) {
    return false;
  }
  return true;
}

// ==============================================================================
// ACTIVATION FLOW — tạo credential + kích hoạt
// ==============================================================================

/** Sinh mật khẩu MQTT ngẫu nhiên cho device (không lưu ở đây — chỉ return 1 lần) */
export function generateMqttPassword(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/** Sinh 1 token raw (trả về cho device), lưu hash + loại trong store */
async function issueToken(
  deviceId: string,
  kind: "access" | "refresh",
  ttlMs: number,
): Promise<{ raw: string; expiresAt: string }> {
  const raw = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  await saveDeviceToken({
    tokenHash: hashToken(raw),
    deviceId,
    createdAt: new Date().toISOString(),
    expiresAt,
    kind,
  });
  return { raw, expiresAt };
}

/**
 * Cấp CẶP token cho device sau khi xác thực credential:
 *   - access: TTL 10 phút, dùng tải file (Authorization: Bearer)
 *   - refresh: TTL 30 ngày, dùng 1 lần để đổi cặp mới khi access hết hạn
 */
export async function issueDeviceTokenPair(deviceId: string): Promise<{
  access: { raw: string; expiresAt: string };
  refresh: { raw: string; expiresAt: string };
}> {
  const access = await issueToken(deviceId, "access", TOKEN_TTL_MS);
  const refresh = await issueToken(deviceId, "refresh", REFRESH_TOKEN_TTL_MS);
  return { access, refresh };
}

/**
 * Thu hồi mọi token của device (access + refresh) — dùng khi re-provision:
 * credential cũ chết → mọi token cấp từ credential cũ cũng phải chết theo.
 */
export async function revokeDeviceTokens(deviceId: string): Promise<number> {
  const tokens = await readStore<Record<string, DeviceToken>>(TOKENS_FILE, {});
  let n = 0;
  for (const key of Object.keys(tokens)) {
    if (tokens[key].deviceId === deviceId) {
      delete tokens[key];
      n++;
    }
  }
  if (n > 0) await writeStore(TOKENS_FILE, tokens);
  return n;
}

/** Tạo device mới (chưa kích hoạt) + mã kích hoạt tương ứng */
export async function createDeviceWithCode(input: {
  deviceId: string;
  code?: string;
}): Promise<{ device: Device; activationCode: ActivationCode }> {
  const device: Device = {
    deviceId: input.deviceId,
    createdAt: new Date().toISOString(),
    activatedAt: null,
    firmwareVersion: null,
    passwordHash: null,
    lastSeenAt: null,
    online: false,
  };
  await saveDevice(device);

  const ac = await createCodeForDevice(input.deviceId, input.code);
  return { device, activationCode: ac };
}

/**
 * Tạo mã kích hoạt cho device đã tồn tại — dùng cho re-provision.
 * Thu hồi các mã "unused" cũ của device trước khi tạo mã mới để 1 device
 * chỉ có tối đa 1 mã đang chờ dùng.
 */
export async function createCodeForDevice(
  deviceId: string,
  code?: string,
): Promise<ActivationCode> {
  await revokePendingCodes(deviceId);

  const ac: ActivationCode = {
    code: code ?? generateActivationCode(),
    deviceId,
    status: "unused",
    createdAt: new Date().toISOString(),
    usedAt: null,
  };
  await saveActivationCode(ac);
  return ac;
}

/**
 * Thu hồi mọi mã "unused" của device (đặt status = revoked).
 * Trả danh sách mã đã thu hồi — route re-provision dùng để invalidate code cũ.
 */
export async function revokePendingCodes(deviceId: string): Promise<string[]> {
  const codes = await readStore<Record<string, ActivationCode>>(CODES_FILE, {});
  const revoked: string[] = [];
  for (const key of Object.keys(codes)) {
    const ac = codes[key];
    if (ac.deviceId === deviceId && ac.status === "unused") {
      ac.status = "revoked";
      revoked.push(ac.code);
    }
  }
  if (revoked.length > 0) await writeStore(CODES_FILE, codes);
  return revoked;
}

/** Đánh dấu mã đã dùng (sau khi activate thành công) */
export async function markCodeUsed(code: string): Promise<void> {
  const codes = await readStore<Record<string, ActivationCode>>(CODES_FILE, {});
  const ac = codes[code.toUpperCase()];
  if (ac) {
    ac.status = "used";
    ac.usedAt = new Date().toISOString();
    await writeStore(CODES_FILE, codes);
  }
}

/**
 * Ghi nhận kích hoạt: firmware version + hash của MQTT password vừa cấp.
 * Hash dùng để xác thực request đổi access token tại /api/iot/token.
 */
export async function activateDevice(
  deviceId: string,
  firmwareVersion: string | null,
  passwordHash: string,
): Promise<Device> {
  const d = await readStore<Record<string, Device>>(DEVICES_FILE, {});
  const dev = d[deviceId];
  if (!dev) throw new Error(`Device ${deviceId} không tồn tại`);

  dev.activatedAt = new Date().toISOString();
  dev.firmwareVersion = firmwareVersion;
  dev.passwordHash = passwordHash;
  await writeStore(DEVICES_FILE, d);
  return { ...dev };
}

/** Danh sách topic MQTT của device (dùng chung cho BE và embedded docs) */
export function deviceTopics(deviceId: string): { command: string; status: string } {
  const base = process.env.MQTT_TOPIC_BASE ?? "station/player";
  return {
    command: `${base}/device/${deviceId}/command`,
    status: `${base}/device/${deviceId}/status`,
  };
}
