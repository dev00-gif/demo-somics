const test = require("node:test");
const assert = require("node:assert/strict");
const { canSeekTrack, controlTrack, mergePlaybackStatus, playbackPosition, formatPlaybackTime } = require("../src/lib/playback.ts");

const time = Date.parse("2026-10-07T02:00:00Z");
const fileId = "11111111-1111-4111-8111-111111111111";
const nextFileId = "22222222-2222-4222-8222-222222222222";
const track = { fileId, fileName: "song.wav", durationSeconds: 120 };
const playing = () => mergePlaybackStatus(undefined, {
  state: "PLAYING", fileId, positionSeconds: 10, repeat: "off", volume: 50,
}, track, time);

test("uses the uploaded file duration and clamps positions to its end", () => {
  const status = mergePlaybackStatus(undefined, {
    state: "PLAYING", fileId, durationSeconds: 999, positionSeconds: 150,
  }, track, time);
  assert.equal(status.durationSeconds, 120);
  assert.equal(status.fileName, "song.wav");
  assert.equal(status.positionSeconds, 120);
  assert.equal(playbackPosition(status, time + 5000), 120);
});

test("a heartbeat without a position does not reset or double-count the progress clock", () => {
  const status = mergePlaybackStatus(playing(), { state: "PLAYING", repeat: "one" }, null, time + 5000);
  assert.equal(status.positionSeconds, 10);
  assert.equal(status.positionUpdatedAt, new Date(time).toISOString());
  assert.equal(playbackPosition(status, time + 7000), 17);
  assert.equal(status.repeat, "one");
});

test("pause freezes elapsed progress and resume starts from the paused position", () => {
  const paused = mergePlaybackStatus(playing(), { state: "PAUSED" }, null, time + 5000);
  assert.equal(playbackPosition(paused, time + 9000), 15);
  const resumed = mergePlaybackStatus(paused, { state: "PLAYING" }, null, time + 10000);
  assert.equal(playbackPosition(resumed, time + 12000), 17);
});

test("a reported seek replaces the old position and progress anchor", () => {
  const status = mergePlaybackStatus(playing(), { state: "PLAYING", fileId, positionSeconds: 80.5 }, null, time + 1000);
  assert.equal(playbackPosition(status, time + 2500), 82);
});

test("switching tracks clears old duration, position and filename", () => {
  const status = mergePlaybackStatus(playing(), { state: "PLAYING", fileId: nextFileId }, null, time + 5000);
  assert.equal(status.durationSeconds, null);
  assert.equal(status.positionSeconds, 0);
  assert.equal(status.fileName, null);
  assert.equal(status.fileId, nextFileId);
});

test("malformed position, duration, repeat and volume cannot poison stored playback", () => {
  const status = mergePlaybackStatus(playing(), {
    positionSeconds: NaN, durationSeconds: Infinity, volume: "100", repeat: "all", state: {},
  }, null, time + 1000);
  assert.equal(status.positionSeconds, 10);
  assert.equal(status.durationSeconds, 120);
  assert.equal(status.volume, 50);
  assert.equal(status.repeat, "off");
  assert.equal(status.state, "PLAYING");
});

test("completed tracks stop at their duration and idle clears the track", () => {
  const done = mergePlaybackStatus(playing(), { state: "DONE" }, null, time + 1000);
  assert.equal(playbackPosition(done, time + 10000), 120);
  const idle = mergePlaybackStatus(done, { state: "IDLE" }, null, time + 15000);
  assert.equal(idle.fileId, null);
  assert.equal(idle.durationSeconds, null);
  assert.equal(idle.positionSeconds, 0);
});

test("formats zero, fractional, unknown and long durations", () => {
  assert.equal(formatPlaybackTime(0), "0:00");
  assert.equal(formatPlaybackTime(125.9), "2:05");
  assert.equal(formatPlaybackTime(3605), "60:05");
  assert.equal(formatPlaybackTime(null), "--:--");
});

test("uploaded file with known duration is seekable before playback status arrives", () => {
  assert.equal(canSeekTrack(undefined, controlTrack(undefined, track)), true);
  const heartbeat = mergePlaybackStatus(undefined, { state: "IDLE" }, null, time);
  assert.equal(canSeekTrack(heartbeat, controlTrack(heartbeat, track)), true);
  const playingWithoutFile = mergePlaybackStatus(undefined, { state: "PLAYING" }, null, time);
  assert.equal(canSeekTrack(playingWithoutFile, controlTrack(playingWithoutFile, track)), true);
});

test("downloaded file can be sought and missing reported duration uses the same uploaded file", () => {
  const downloaded = mergePlaybackStatus(undefined, { state: "DOWNLOADED", fileId }, null, time);
  const selected = controlTrack(downloaded, track);
  assert.equal(selected.durationSeconds, 120);
  assert.equal(canSeekTrack(downloaded, selected), true);
});

test("seek cannot use another uploaded track's duration or an ended file", () => {
  const different = { fileId: nextFileId, fileName: "next.wav", durationSeconds: 10 };
  const selected = controlTrack(playing(), different);
  assert.equal(selected.fileId, fileId);
  assert.equal(selected.durationSeconds, 120);
  assert.equal(canSeekTrack(playing(), different), false);
  assert.equal(canSeekTrack(undefined, { ...track, durationSeconds: null }), false);
  assert.equal(canSeekTrack({ ...playing(), state: "DONE" }, track), false);
  assert.equal(canSeekTrack({ ...playing(), state: "ERROR" }, track), false);
});
