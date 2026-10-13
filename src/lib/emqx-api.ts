/**
 * EMQX MANAGEMENT API CLIENT — cấp/thu hồi user MQTT động từ backend.
 *
 * API key/secret (Basic auth) được ưu tiên; nếu không có thì đăng nhập
 * Dashboard lấy Bearer token như deploy/emqx/scripts/init-users.sh.
 *
 * Biến môi trường:
 *   EMQX_API_URL        — http://emqx:18083 hoặc http://emqx:18083/api/v5
 *   EMQX_API_KEY / EMQX_API_SECRET — tài khoản API riêng (tùy chọn)
 *   EMQX_DASHBOARD_USERNAME / EMQX_DASHBOARD_PASSWORD — credentials admin
 *
 * Token dashboard cache 55 phút (EMQX token hết hạn sau ~1h), tự login lại khi
 * hết hạn. Fail → throw để /api/iot/activate trả 502 kèm message rõ ràng.
 */

type ApiStep = "config" | "login" | "authorization" | "user" | "acl" | "health";

/** Chỉ giữ mã lỗi, không đưa response/password/token của broker ra log hoặc API. */
export class EmqxApiError extends Error {
  readonly step: ApiStep;
  readonly status: number | null;
  readonly code: string | null;

  constructor(step: ApiStep, status: number | null, code: unknown = null) {
    const safeCode = typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
      ? code : null;
    const hint = status === 401
      ? "Kiểm tra credential quản trị EMQX; password trong env không tự đổi password đã lưu trên broker"
      : status === 403
        ? "Kiểm tra quyền ghi của tài khoản quản trị/API key EMQX"
        : status === 404
          ? "Kiểm tra URL API và authenticator/authorizer của đúng broker"
          : "Kiểm tra cấu hình và log EMQX trên server";
    super(`EMQX ${step} thất bại${status === null ? "" : ` (HTTP ${status})`}${safeCode ? ` [${safeCode}]` : ""} — ${hint}`);
    this.name = "EmqxApiError";
    this.step = step;
    this.status = status;
    this.code = safeCode;
  }
}

export function normalizeEmqxApiUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch {
    throw new EmqxApiError("config", null, "INVALID_API_URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new EmqxApiError("config", null, "INVALID_API_URL");
  }
  const base = url.href.replace(/\/+$/, "");
  return base.endsWith("/api/v5") ? base : `${base}/api/v5`;
}

function apiBase(): string {
  return normalizeEmqxApiUrl(process.env.EMQX_API_URL || "http://emqx:18083");
}

const DASH_USER = process.env.EMQX_DASHBOARD_USERNAME || process.env.DASHBOARD_USERNAME || "admin";
const DASH_PASS = process.env.EMQX_DASHBOARD_PASSWORD || process.env.DASHBOARD_PASSWORD || "";
const API_KEY = process.env.EMQX_API_KEY || "";
const API_SECRET = process.env.EMQX_API_SECRET || "";

interface CachedToken {
  token: string;
  expiresAt: number;
  apiBase: string;
  username: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __emqxToken: CachedToken | undefined;
}

const TOKEN_TTL_MS = 55 * 60 * 1000; // EMQX token ttl ~1h → cache 55m

async function requestApi(
  method: string, path: string, step: ApiStep, body?: unknown, authorization?: string,
): Promise<{ status: number; data: unknown }> {
  let res: Response;
  const url = `${apiBase()}${path}`;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Accept: "application/json", "Content-Type": "application/json",
        ...(authorization ? { Authorization: authorization } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
      cache: "no-store",
      redirect: "error",
    });
    // Đọc body trong timeout của request; response 204 không có JSON.
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* Proxy có thể trả HTML. */ }
    return { status: res.status, data };
  } catch {
    throw new EmqxApiError(step, null, "API_UNREACHABLE");
  }
}

function requireSuccess(result: { status: number; data: unknown }, step: ApiStep): void {
  if (result.status < 200 || result.status >= 300) {
    const code = (result.data as { code?: unknown } | null)?.code;
    throw new EmqxApiError(step, result.status, code);
  }
}

async function login(): Promise<string> {
  if (!DASH_PASS) throw new EmqxApiError("config", null, "MISSING_DASHBOARD_PASSWORD");
  const result = await requestApi("POST", "/login", "login", { username: DASH_USER, password: DASH_PASS });
  requireSuccess(result, "login");
  const data = result.data as { token?: string } | null;
  if (typeof data?.token !== "string" || !data.token) {
    throw new EmqxApiError("login", result.status, "MISSING_LOGIN_TOKEN");
  }
  return data.token;
}

async function getBearerToken(forceRefresh = false): Promise<string> {
  const cached = globalThis.__emqxToken;
  if (!forceRefresh && cached && cached.expiresAt > Date.now() && cached.apiBase === apiBase() && cached.username === DASH_USER) {
    return cached.token;
  }
  const token = await login();
  globalThis.__emqxToken = { token, expiresAt: Date.now() + TOKEN_TTL_MS, apiBase: apiBase(), username: DASH_USER };
  return token;
}

/** Gọi API; nếu 401 thì login lại đúng 1 lần rồi retry */
async function callApi<T>(
  method: "GET" | "PUT" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  step: ApiStep = "user",
): Promise<{ status: number; data: T | null }> {
  const useApiKey = Boolean(API_KEY || API_SECRET);
  if (useApiKey && (!API_KEY || !API_SECRET)) {
    throw new EmqxApiError("config", null, "INCOMPLETE_API_CREDENTIALS");
  }
  const authorization = useApiKey
    ? `Basic ${Buffer.from(`${API_KEY}:${API_SECRET}`).toString("base64")}`
    : `Bearer ${await getBearerToken()}`;
  let result = await requestApi(method, path, step, body, authorization);
  if (result.status === 401 && !useApiKey) {
    globalThis.__emqxToken = undefined;
    result = await requestApi(method, path, step, body, `Bearer ${await getBearerToken(true)}`);
  }
  return { status: result.status, data: result.data as T | null };
}

// ==============================================================================
// USER MANAGEMENT
// ==============================================================================

/**
 * Tạo hoặc cập nhật user MQTT trong authenticator built-in database.
 * Trả true khi thành công; lỗi giữ nguyên bước, HTTP status và mã EMQX.
 */
export async function upsertMqttUser(
  username: string,
  password: string,
  isSuperuser: boolean,
): Promise<boolean> {
  const path = `/authentication/password_based:built_in_database/users/${encodeURIComponent(username)}`;

  // PUT để update — nếu user chưa tồn tại, EMQX trả 404 → POST tạo mới
  const updateBody = {
    password,
    is_superuser: isSuperuser,
  };
  let result = await callApi<unknown>("PUT", path, updateBody);

  if (result.status === 404) {
    result = await callApi<unknown>(
      "POST",
      "/authentication/password_based:built_in_database/users",
      { user_id: username, password, is_superuser: isSuperuser },
    );
    // Một request khác có thể tạo user giữa PUT và POST.
    if (result.status === 409) result = await callApi<unknown>("PUT", path, updateBody);
  }
  requireSuccess(result, "user");
  return true;
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
 * nguồn này phải tạo qua API nếu chưa có. Không coi mọi HTTP 400 là "đã có".
 * Nguồn database phải đứng trước file ACL để deny/allow theo thiết bị có hiệu lực.
 */
export async function ensureBuiltInAuthzSource(): Promise<void> {
  type Source = { type: string; enable: boolean };
  async function sources(): Promise<Source[]> {
    const result = await callApi<{ sources?: Source[] }>("GET", "/authorization/sources", undefined, "authorization");
    requireSuccess(result, "authorization");
    if (!Array.isArray(result.data?.sources)) {
      throw new EmqxApiError("authorization", result.status, "INVALID_SOURCE_RESPONSE");
    }
    return result.data.sources;
  }
  let list = await sources();
  let index = list.findIndex((source) => source.type === "built_in_database");
  if (index === -1) {
    const created = await callApi<unknown>("POST", "/authorization/sources",
      { enable: true, type: "built_in_database", max_rules: 100 }, "authorization");
    if (created.status !== 400 && created.status !== 409) requireSuccess(created, "authorization");
    // Bao gồm trường hợp POST 204 và một request đồng thời đã tạo source.
    list = await sources();
    index = list.findIndex((source) => source.type === "built_in_database");
    if (index === -1) {
      requireSuccess(created, "authorization");
      throw new EmqxApiError("authorization", null, "AUTHORIZER_NOT_FOUND");
    }
  }
  if (list[index].enable !== true) {
    throw new EmqxApiError("authorization", null, "AUTHORIZER_DISABLED");
  }
  if (index > 0) {
    const moved = await callApi<unknown>("POST", "/authorization/sources/built_in_database/move",
      { position: "top" }, "authorization");
    requireSuccess(moved, "authorization");
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

  const result = await callApi<unknown>(
    "PUT",
    `/authorization/sources/built_in_database/rules/users/${encodeURIComponent(username)}`,
    { username, rules },
    "acl",
  );
  requireSuccess(result, "acl");
  return true;
}

/** Xóa ACL của user (gọi khi xóa device) */
export async function deleteDeviceAcl(username: string): Promise<boolean> {
  const { status } = await callApi<unknown>(
    "DELETE",
    `/authorization/sources/built_in_database/rules/users/${encodeURIComponent(username)}`,
    undefined,
    "acl",
  );
  return status === 200 || status === 204 || status === 404;
}

/** Kiểm tra EMQX API reachable + login được (cho trang admin / health check) */
export async function checkEmqxApi(): Promise<{ ok: boolean; error?: string }> {
  try {
    const result = await callApi<unknown>("GET", "/authentication/password_based:built_in_database", undefined, "health");
    requireSuccess(result, "health");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
