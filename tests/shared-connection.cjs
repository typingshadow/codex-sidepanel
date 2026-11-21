const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");

function event() {
  const listeners = [];
  return {
    addListener(fn) { listeners.push(fn); },
    emit(value) { for (const fn of listeners) fn(value); },
  };
}

function port() {
  return {
    sent: [], onMessage: event(), onDisconnect: event(),
    postMessage(packet) { this.sent.push(packet); },
    disconnect() { this.onDisconnect.emit(); },
  };
}

test("panels share one service and receive only their own replies and turn events", () => {
  const onConnect = event();
  const connection = port();
  let launches = 0;
  const timers = new Map();
  const idle = () => [...timers.values()].find(timer => timer.ms === 5000);
  vm.runInNewContext(fs.readFileSync(require.resolve("../extension/background.js"), "utf8"), {
    importScripts() {}, release: { hostName: "local.codex_sidepanel" }, console,
    setTimeout(fn, ms) {
      const id = Symbol();
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    chrome: {
      sidePanel: { setPanelBehavior: async () => {} },
      runtime: { id: "test", getURL: path => "chrome-extension://test/" + path, onConnect,
        connectNative() { launches++; return connection; } },
    },
  });
  const openPanel = () => {
    const panel = Object.assign(port(), { name: "codex-sidepanel",
      sender: { id: "test", url: "chrome-extension://test/panel.html?page=sample" } });
    onConnect.emit(panel);
    return panel;
  };
  const a = openPanel(), b = openPanel();
  a.onMessage.emit({ id: 1, method: "initialize" });
  b.onMessage.emit({ id: 2, method: "initialize" });
  assert.equal(launches, 1);
  assert.equal(connection.sent.length, 1);
  connection.onMessage.emit({ id: connection.sent[0].id, result: {} });
  assert.equal(a.sent.at(-1).id, 1);
  assert.equal(b.sent.at(-1).id, 2);

  a.onMessage.emit({ id: 3, method: "turn/start", params: { threadId: "A" } });
  b.onMessage.emit({ id: 3, method: "turn/start", params: { threadId: "B" } });
  assert.notEqual(connection.sent.at(-1).id, connection.sent.at(-2).id);
  b.onMessage.emit({ id: 4, method: "turn/start", params: { threadId: "A" } });
  assert.ok(b.sent.at(-1).error);
  const sentBeforeArchive = connection.sent.length;
  b.onMessage.emit({ id: 9, method: "thread/archive", params: { threadId: "A" } });
  assert.equal(b.sent.at(-1).id, 9);
  assert.ok(b.sent.at(-1).error);
  assert.equal(connection.sent.length, sentBeforeArchive);
  for (const request of connection.sent.slice(1)) {
    const threadId = request.params.threadId;
    connection.onMessage.emit({ id: request.id, result: { turn: { id: threadId } } });
    connection.onMessage.emit({ method: "item/agentMessage/delta", params: { threadId } });
  }
  assert.deepEqual(a.sent.filter(p => p.params).map(p => p.params.threadId), ["A"]);
  assert.deepEqual(b.sent.filter(p => p.params).map(p => p.params.threadId), ["B"]);
  connection.onMessage.emit({ method: "turn/completed", params: { threadId: "A", turn: { id: "older" } } });
  assert.equal(a.sent.at(-1).method, "item/agentMessage/delta");
  b.onMessage.emit({ id: 6, method: "turn/start", params: { threadId: "A" } });
  assert.ok(b.sent.at(-1).error);
  a.disconnect();
  b.disconnect();
  assert.equal(idle(), undefined);
  for (const threadId of ["A", "B"]) {
    connection.onMessage.emit({ method: "turn/completed", params: { threadId } });
  }
  assert.equal(typeof idle()?.fn, "function");

  const c = openPanel();
  c.onMessage.emit({ id: 5, method: "thread/list" });
  c.disconnect();
  assert.equal(idle(), undefined);
  const deadline = [...timers].find(([, timer]) => timer.ms === 31000);
  timers.delete(deadline[0]);
  deadline[1].fn();
  assert.equal(typeof idle()?.fn, "function");

  const d = openPanel();
  d.onMessage.emit({ id: 8, method: "turn/start", params: { threadId: "orphan" } });
  connection.onMessage.emit({ id: connection.sent.at(-1).id, result: { turn: { id: "orphan-turn" } } });
  d.disconnect();
  let disconnected = false;
  connection.onDisconnect.addListener(() => { disconnected = true; });
  const grace = [...timers.values()].find(timer => timer.ms === 300000);
  assert.ok(grace);
  grace.fn();
  assert.equal(disconnected, true);
});
