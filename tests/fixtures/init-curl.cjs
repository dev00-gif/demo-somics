#!/usr/bin/env node
// Controlled curl transport for init tests; never contacts a broker.
const fs = require("node:fs");
const args = process.argv.slice(2);
const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const state = JSON.parse(fs.readFileSync(process.env.INIT_MOCK_STATE, "utf8"));
const headers = args.flatMap((arg, i) => arg === "-H" ? [args[i + 1]] : []);
state.requests.push({
  method: value("-X") || "GET",
  url: args.find((arg) => /^http:\/\//.test(arg)),
  body: value("-d") ? JSON.parse(value("-d")) : null,
  headers,
  timeout: value("--max-time"),
});
const response = state.responses.shift();
fs.writeFileSync(process.env.INIT_MOCK_STATE, JSON.stringify(state));
if (!response) process.exit(99);
if (response.exit) process.exit(response.exit);
const body = JSON.stringify(response.body || {});
if (value("-o")) fs.writeFileSync(value("-o"), body);
else process.stdout.write(body);
if (value("-w")) process.stdout.write(String(response.status));
if (args.includes("-sf") && response.status >= 400) process.exit(22);
