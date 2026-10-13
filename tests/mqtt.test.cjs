const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");

// Load the real helper with a controlled transport and clock, without the
// device registry or a production broker. Each harness is a server instance.
const source = ts.transpileModule(readFileSync(require.resolve("../src/lib/mqtt.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;

function harness(env = {}) {
  const clients = [];
  const timers = new Map();
  let timerId = 0;
  class Client extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.connected = false;
      this.reconnecting = false;
    }
    subscribe() {}
    end(_force, _options, callback) { callback(); }
    connectSuccessfully() {
      this.connected = true;
      this.emit("connect");
    }
  }
  const context = vm.createContext({
    exports: {}, Buffer, URL,
    process: { pid: 1, env: { MQTT_URL: "mqtt://demo-somics-broker:1883", ...env } },
    console: { log() {}, warn() {}, error() {} },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    require(name) {
      if (name === "mqtt") return { connect(_url, options) { const client = new Client(options); clients.push(client); return client; } };
      if (name === "@/lib/devices") return { touchDevice: async () => {} };
      return require(name);
    },
  });
  vm.runInContext(source, context);
  return {
    api: context.exports, clients, timers,
    expire() {
      for (const [id, timer] of [...timers]) {
        timers.delete(id);
        timer.fn();
      }
    },
  };
}

test("timeout releases the pending request and listeners; the next request can recover", async () => {
  const h = harness();
  const first = h.api.getMqttClient();
  assert.equal(h.api.getMqttClient(), first, "concurrent requests share one wait");
  assert.equal(h.clients.length, 1);
  const client = h.clients[0];
  h.expire();
  await assert.rejects(first, /timeout sau 10s.*demo-somics-broker/);
  assert.equal(client.listenerCount("connect"), 1, "only the lifecycle handler remains");
  assert.equal(client.listenerCount("error"), 1);

  const retry = h.api.getMqttClient();
  assert.notEqual(retry, first);
  assert.equal(h.clients.length, 1, "reuse the reconnecting singleton");
  client.connectSuccessfully();
  assert.equal(await retry, client);
  assert.equal(h.timers.size, 0);
  assert.equal(h.api.getMqttStatus().error, null);
});

test("repeated outages do not accumulate listeners or reuse a rejected promise", async () => {
  const h = harness();
  for (let i = 0; i < 4; i++) {
    const pending = h.api.getMqttClient();
    h.expire();
    await assert.rejects(pending, /timeout/);
    assert.equal(h.clients[0].listenerCount("connect"), 1);
    assert.equal(h.clients[0].listenerCount("error"), 1);
  }
  assert.equal(h.clients.length, 1);
});

test("a rejected CONNECT reports an auth error and permits later recovery", async () => {
  const h = harness();
  const pending = h.api.getMqttClient();
  const client = h.clients[0];
  assert.equal(client.options.reconnectOnConnackError, true);
  client.emit("error", Object.assign(new Error("Connection refused"), { code: 5 }));
  await assert.rejects(pending, /credential MQTT/);
  assert.match(h.api.getMqttStatus().error, /\[5\]/);
  assert.equal(h.timers.size, 0);
  const retry = h.api.getMqttClient();
  client.connectSuccessfully();
  assert.equal(await retry, client);
});

test("containers with the same PID get different client IDs", async () => {
  const a = harness();
  const b = harness();
  const first = a.api.getMqttClient();
  const second = b.api.getMqttClient();
  assert.notEqual(a.clients[0].options.clientId, b.clients[0].options.clientId);
  a.clients[0].connectSuccessfully();
  b.clients[0].connectSuccessfully();
  await Promise.all([first, second]);
});

test("missing URL fails clearly; Compose credentials can be reused for local dev", async () => {
  const missing = harness({ MQTT_URL: "" });
  assert.throws(() => missing.api.getMqttClient(), /Chưa cấu hình MQTT_URL/);
  assert.equal(missing.clients.length, 0);
  const h = harness({ MQTT_APP_USERNAME: "web-backend", MQTT_APP_PASSWORD: "demo-secret" });
  const pending = h.api.getMqttClient();
  assert.equal(h.clients[0].options.username, "web-backend");
  assert.equal(h.clients[0].options.password, "demo-secret");
  h.clients[0].connectSuccessfully();
  await pending;
});

test("broker diagnostics distinguish DNS failures and redact URL credentials", async () => {
  const h = harness({ MQTT_URL: "mqtt://private-user:private-password@demo-somics-broker:1883" });
  const pending = h.api.getMqttClient();
  h.clients[0].emit("error", Object.assign(new Error("private-password"), { code: "ENOTFOUND" }));
  await assert.rejects(pending, /Không resolve được host/);
  const status = h.api.getMqttStatus();
  assert.equal(status.broker, "mqtt://demo-somics-broker:1883");
  assert.doesNotMatch(status.error, /private-user|private-password/);
});
