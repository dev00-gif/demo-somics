/**
 * EMQX MANAGEMENT API CLIENT — cấp/thu hồi user MQTT động từ backend.
 *
 * Cùng cơ chế với deploy/emqx/scripts/init-users.sh:
 *   1. POST /api/v5/login (Dashboard credentials) → Bearer token
 *   2. PUT/POST /api/v5/authentication/password_based:built_in_database/users
 *
 * Biến môi trường:
 *   EMQX_API_URL        — mặc định http://emqx:18083 (mạng nội bộ Docker)
 *   EMQX_DASHBOARD_USERNAME / EMQX_DASHBOARD_PASSWORD — credentials admin
 *
 * Token dashboard cache 55 phút (EMQX token hết hạn sau ~1h), tự login lại khi
 * hết hạn. Fail → throw để /api/iot/activate trả 502 kèm message rõ ràng.
 */

const API_URL = process.env.EMQX_API_URL ?? "http://emqx:18083";
const API_BASE = `${API_URL}/api/v5`;

const DASH_USER = process.env.EMQX_DASHBOARD_USERNAME ?? "admin";
const DASH_PASS = process.env.EMQX_DASHBOARD_PASSWORD ?? "";

interface CachedToken {
  token: string;
  expiresAt: number;
}

declare global {
  // eslint-disable-next-line no-var
  var __emqxToken: CachedToken | undefined;
}

const TOKEN_TTL_MS = 55 * 60 * 1000; // EMQX token ttl ~1h → cache 55m

async function login(): Promise<string> {
  const res = await fetch(`${API_BASE}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: DASH_USER, password: DASH_PASS }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) {
    throw new Error(
      `EMQX login thất bại (HTTP ${res.status}) — kiểm tra EMQX_DASHBOARD_USERNAME/PASSWORD`,
    );
  }
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new Error("EMQX login response thiếu token");
  return data.token;
}

async function getBearerToken(forceRefresh = false): Promise<string> {
  const cached = globalThis.__emqxToken;
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }
  const token = await login();
  globalThis.__emqxToken = { token, expiresAt: Date.now() + TOKEN_TTL_MS };
  return token;
}

/** Gọi API; nếu 401 thì login lại đúng 1 lần rồi retry */
async function callApi<T>(
  method: "GET" | "PUT" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T | null }> {
  let token = await getBearerToken();
  let res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });

  if (res.status === 401) {
    token = await getBearerToken(true);
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
  }

  let data: T | null = null;
  try {
    data = (await res.json()) as T;
  } catch {
    // response rỗng hoặc không JSON — OK với DELETE
  }
  return { status: res.status, data };
}

// ==============================================================================
// USER MANAGEMENT
// ==============================================================================

/**
 * Tạo hoặc cập nhật user MQTT trong authenticator built-in database.
 * Trả true nếu tạo/cập nhật thành công (HTTP 200/201), false nếu khác.
 */
export async function upsertMqttUser(
  username: string,
  password: string,
  isSuperuser: boolean,
): Promise<boolean> {
  const path = `/authentication/password_based:built_in_database/users/${encodeURIComponent(username)}`;

  // PUT để update — nếu user chưa tồn tại, EMQX trả 404 → POST tạo mới
  let { status } = await callApi<unknown>("PUT", path, {
    password,
    is_superuser: isSuperuser,
  });

  if (status === 404) {
    const created = await callApi<unknown>(
      "POST",
      "/authentication/password_based:built_in_database/users",
      { user_id: username, password, is_superuser: isSuperuser },
    );
    status = created.status;
  }

  return status === 200 || status === 201;
}

/** Xóa user MQTT (thu hồi credential khi device bị deactivate) */
export async function deleteMqttUser(username: string): Promise<boolean> {
  const { status } = await callApi<unknown>(
    "DELETE",
    `/authentication/password_based:built_in_database/users/${encodeURIComponent(username)}`,
  );
  return status === 200 || status === 204;
}

// =============================================================================
// AUTHORIZATION (ACL) — giới hạn topic cho từng device user
// =============================================================================

/**
 * Đảm bảo authorizer built_in_database đã được tạo trên broker.
 * Compose chỉ khai báo authentication (built_in_database) — authorization
 * nguồn này phải tạo qua API nếu chưa có (idempotent, bỏ qua 400 đã tồn tại).
 */
export async function ensureBuiltInAuthzSource(): Promise<void> {
  const { status } = await callApi<unknown>(
    "POST",
    "/authorization/sources",
    { enable: true, type: "built_in_database", max_rules: 100 },
  );
  // 200/201 = tạo mới OK; 400 = đã tồn tại (idempotent) — cả hai đều coi là OK
  if (status !== 200 && status !== 201 && status !== 400) {
    throw new Error(`Tạo authorizer built_in_database thất bại (HTTP ${status})`);
  }
}

/**
 * Ghi ACL cho 1 device user — chỉ cho phép:
 *   - subscribe  topic command riêng của nó (<base>/device/<ID>/command)
 *   - publish    topic status riêng của nó (<base>/device/<ID>/status)
 *
 * Rule được EMQX duyệt theo thứ tự, first-match thắng. Rule `deny all #` ở cuối
 * là bắt buộc: nếu thiếu, topic không khớp rule nào sẽ rơi vào `no_match` của
 * authorizer (mặc định allow) → ACL vô hiệu.
 *
 * PUT = thay toàn bộ rules cũ của user → gọi lại lúc re-provision cũng an toàn.
 */
export async function setDeviceAcl(
  username: string,
  commandTopic: string,
  statusTopic: string,
): Promise<boolean> {
  const rules = [
    {
      topic: commandTopic,
      permission: "allow",
      action: "subscribe",
      qos: [0, 1],
      retain: "all",
    },
    {
      topic: statusTopic,
      permission: "allow",
      action: "publish",
      qos: [0, 1],
      retain: "all",
    },
    {
      // Chặn mọi topic khác (kể cả subscribe trộm topic của thiết bị khác)
      topic: "#",
      permission: "deny",
      action: "all",
    },
  ];

  const { status } = await callApi<unknown>(
    "PUT",
    `/authorization/sources/built_in_database/rules/users/${encodeURIComponent(username)}`,
    { username, rules },
  );
  return status === 200 || status === 201;
}

/** Xóa ACL của user (gọi khi xóa device) */
export async function deleteDeviceAcl(username: string): Promise<boolean> {
  const { status } = await callApi<unknown>(
    "DELETE",
    `/authorization/sources/built_in_database/rules/users/${encodeURIComponent(username)}`,
  );
  return status === 200 || status === 204 || status === 404;
}

/** Kiểm tra EMQX API reachable + login được (cho trang admin / health check) */
export async function checkEmqxApi(): Promise<{ ok: boolean; error?: string }> {
  try {
    await getBearerToken();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
