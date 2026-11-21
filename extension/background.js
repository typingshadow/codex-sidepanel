importScripts("release.js");

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

const panels = new Set();
const pending = new Map();
const activeTurns = new Map();
const handshake = new Map();
let native, bridgeInfo, idleTimer;
let sequence = 0;
let initialized = false;

function post(panel, packet) {
  if (!panels.has(panel)) return;
  try { panel.postMessage(packet); } catch { /* The panel closed. */ }
}

function releaseIdleConnection() {
  clearTimeout(idleTimer);
  if (panels.size || !native) return;
  // With all panels closed, allow in-flight work to finish. Native activity
  // renews this grace period; a silent, ownerless service cannot live forever.
  const delay = pending.size || activeTurns.size ? 5 * 60 * 1000 : 5000;
  const connection = native;
  idleTimer = setTimeout(() => {
    if (panels.size || native !== connection) return;
    reset();
    connection.disconnect();
  }, delay);
}

function reset() {
  native = null;
  bridgeInfo = null;
  initialized = false;
  handshake.clear();
  for (const request of pending.values()) clearTimeout(request.timer);
  pending.clear();
  activeTurns.clear();
}

function connectNative() {
  const connection = chrome.runtime.connectNative(release.hostName);
  native = connection;
  connection.onMessage.addListener((packet) => {
    if (native !== connection) return;
    if (packet.bridgeInfo) bridgeInfo = packet;
    if (packet.bridgeError?.includes("账号")) handshake.delete("account/read");
    if ("id" in packet) {
      const request = pending.get(packet.id);
      if (!request) {
        if (packet.error) {
          for (const [threadId, turn] of activeTurns) {
            if (turn.wireId === packet.id) activeTurns.delete(threadId);
          }
          releaseIdleConnection();
        }
        return;
      }
      pending.delete(packet.id);
      clearTimeout(request.timer);
      if (request.shared) {
        if ("result" in packet && (request.method === "initialize" ||
            packet.result?.authenticated || packet.result?.requiresOpenaiAuth === false)) {
          handshake.set(request.method, packet);
        }
        for (const { panel, id } of request.clients) post(panel, { ...packet, id });
      } else {
        if (request.method === "turn/start" && packet.result?.turn?.id) {
          request.turnId = packet.result.turn.id;
        }
        if (packet.error && activeTurns.get(request.threadId) === request) activeTurns.delete(request.threadId);
        post(request.panel, { ...packet, id: request.id });
        if ("result" in packet && request.method === "thread/archive") {
          for (const panel of panels) post(panel, { method: "thread/archived", params: { threadId: request.threadId } });
        }
      }
    } else if (packet.params?.threadId) {
      const threadId = packet.params.threadId;
      const request = activeTurns.get(threadId);
      const eventTurn = packet.params.turnId || packet.params.turn?.id;
      if (request && !(request.turnId && eventTurn && request.turnId !== eventTurn)) {
        post(request.panel, packet);
        if (packet.method === "turn/completed") activeTurns.delete(threadId);
      }
    } else {
      for (const panel of panels) post(panel, packet);
    }
    releaseIdleConnection();
  });
  connection.onDisconnect.addListener(() => {
    const detail = chrome.runtime.lastError?.message;
    if (native !== connection) return;
    reset();
    for (const panel of panels) {
      if (detail) post(panel, { nativeDisconnect: detail });
      panel.disconnect();
    }
    panels.clear();
  });
}

chrome.runtime.onConnect.addListener((panel) => {
  const panelUrl = chrome.runtime.getURL("panel.html");
  if (panel.name !== "codex-sidepanel" || panel.sender?.id !== chrome.runtime.id ||
      panel.sender.url?.split("?")[0] !== panelUrl) return;
  clearTimeout(idleTimer);
  panels.add(panel);
  panel.onDisconnect.addListener(() => {
    panels.delete(panel);
    releaseIdleConnection();
  });
  panel.onMessage.addListener((packet) => {
    if (!panels.has(panel)) return;
    const { id, method, params } = packet;
    if (method === "initialized" && initialized) return;
    if (handshake.has(method)) {
      post(panel, { ...handshake.get(method), id });
      return;
    }
    const shared = method === "initialize" || method === "account/read";
    if (shared) {
      const existing = [...pending.values()].find(request => request.shared && request.method === method);
      if (existing) {
        existing.clients.push({ panel, id });
        return;
      }
    }
    const threadId = params?.threadId;
    const running = activeTurns.get(threadId);
    const archiving = [...pending.values()].some(request => request.threadId === threadId && request.method === "thread/archive");
    if ((["turn/start", "thread/archive"].includes(method) && (running || archiving)) ||
        (method === "turn/interrupt" && running?.panel !== panel)) {
      post(panel, { id, error: { message: "此会话正在另一个侧栏执行，或任务已经结束。" } });
      return;
    }
    const wireId = ++sequence;
    const request = { panel, id, method, threadId, shared, wireId, clients: [{ panel, id }] };
    try {
      if (!native) connectNative();
      if (id !== undefined) {
        const deadline = ["workspace/pick", "attachments/pick"].includes(method) ? 126000 : method === "turn/start" ? 61000 : 31000;
        request.timer = setTimeout(() => {
          if (!pending.delete(wireId)) return;
          // A submitted turn can have side effects even without acknowledgement.
          // Keep its ownership until completion or native disconnect.
          releaseIdleConnection();
        }, deadline);
        pending.set(wireId, request);
      }
      if (method === "turn/start") activeTurns.set(threadId, request);
      native.postMessage(id === undefined ? packet : { ...packet, id: wireId });
      if (method === "initialized") initialized = true;
    } catch (error) {
      pending.delete(wireId);
      clearTimeout(request.timer);
      if (activeTurns.get(threadId) === request) activeTurns.delete(threadId);
      post(panel, { id, error: { message: error.message } });
      releaseIdleConnection();
    }
  });
  if (bridgeInfo) post(panel, bridgeInfo);
});
