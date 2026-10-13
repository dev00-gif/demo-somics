const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const script = path.resolve(__dirname, "../deploy/emqx/scripts/init-users.sh");
const credentials = {
  DASHBOARD_PASSWORD: 'dashboard-"secret\\value',
  MQTT_APP_PASSWORD: 'mqtt-"secret\\value',
  MQTT_DEVICE_PASSWORD: "device-secret",
  EMQX_API_URL: "http://demo-somics-broker:18083/api/v5/",
};
const ready = { status: 200 };
const login = { status: 200, body: { token: "private-test-token" } };

function run(responses, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-emqx-init-"));
  try {
    fs.copyFileSync(path.join(__dirname, "fixtures/init-curl.cjs"), path.join(dir, "curl"));
    fs.chmodSync(path.join(dir, "curl"), 0o755);
    const statePath = path.join(dir, "state.json");
    fs.writeFileSync(statePath, JSON.stringify({ responses, requests: [] }));
    const result = spawnSync("/bin/sh", [script], {
      encoding: "utf8", timeout: 10_000,
      env: { PATH: `${dir}:${path.dirname(process.execPath)}:${process.env.PATH}`, INIT_MOCK_STATE: statePath, ...credentials, ...env },
    });
    assert.ifError(result.error);
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return { ...result, requests: state.requests, log: `${result.stdout}${result.stderr}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const name of ["DASHBOARD_PASSWORD", "MQTT_APP_PASSWORD", "MQTT_DEVICE_PASSWORD"]) {
  test(`init identifies missing ${name} before contacting EMQX`, () => {
    const result = run([], { [name]: "" });
    assert.equal(result.status, 1);
    assert.match(result.log, new RegExp(`Thiếu ${name}`));
    assert.equal(result.requests.length, 0);
  });
}

test("init reports rejected Dashboard credentials without logging response secrets", () => {
  const result = run([ready, { status: 401, body: { token: "private-test-token", password: "response-secret" } }]);
  assert.equal(result.status, 1);
  assert.match(result.log, /Login Dashboard HTTP 401/);
  assert.match(result.log, /password.*volume/);
  assert.doesNotMatch(result.log, /private-test-token|response-secret|secret\\value/);
});

test("init updates the backend and creates legacy users with correct credentials and roles", () => {
  const result = run([ready, login, { status: 200 }, { status: 404 }, { status: 201 }, { status: 204 }]);
  assert.equal(result.status, 0, result.log);
  assert.match(result.log, /Hoàn tất/);
  assert.deepEqual(result.requests.map((request) => request.method), ["GET", "POST", "PUT", "PUT", "POST", "PUT"]);
  assert.equal(result.requests[1].url, "http://demo-somics-broker:18083/api/v5/login");
  assert.equal(result.requests[1].body.password, credentials.DASHBOARD_PASSWORD);
  assert.equal(result.requests[2].body.password, credentials.MQTT_APP_PASSWORD);
  assert.equal(result.requests[2].body.is_superuser, true);
  assert.equal(result.requests[4].body.user_id, "device-01");
  assert.equal(result.requests[4].body.is_superuser, false);
  for (const request of result.requests.slice(2)) {
    assert.ok(request.headers.includes("Authorization: Bearer private-test-token"));
    assert.equal(request.timeout, "10");
  }
  assert.doesNotMatch(result.log, /private-test-token|dashboard-.*secret|mqtt-.*secret|device-secret/);
});

test("init retries PUT when another initializer has just created the backend user", () => {
  const result = run([ready, login, { status: 404 }, { status: 409 }, { status: 200 }], {
    MQTT_DEVICE_USERS: "", MQTT_DEVICE_PASSWORD: "",
  });
  assert.equal(result.status, 0, result.log);
  assert.deepEqual(result.requests.map((request) => request.method), ["GET", "POST", "PUT", "POST", "PUT"]);
});

test("init distinguishes API transport failure from wrong credentials", () => {
  const result = run([ready, { exit: 28 }]);
  assert.equal(result.status, 1);
  assert.match(result.log, /POST \/login không truy cập được/);
  assert.doesNotMatch(result.log, /Login Dashboard HTTP 401/);
});

test("init fails on a successful login response without a token", () => {
  const result = run([ready, { status: 200 }]);
  assert.equal(result.status, 1);
  assert.match(result.log, /HTTP 200 nhưng thiếu token/);
});
