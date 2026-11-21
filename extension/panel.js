const $ = (id) => document.getElementById(id);
const appearance = [
  { control: $("color-theme"), key: "panel-theme", fallback: "blue",
    apply: (value) => { document.documentElement.dataset.theme = value; } },
  { control: $("font-size"), key: "reading-size", fallback: "16",
    apply: (value) => document.documentElement.style.setProperty("--reading-size", value + "px") },
  { control: $("font-family"), key: "reading-font", fallback: "system",
    apply: (value) => { document.documentElement.dataset.typeface = value; } },
];
for (const { control, key, fallback, apply } of appearance) {
  const load = (saved) => {
    control.value = Array.from(control.options).some(({ value }) => value === saved) ? saved : fallback;
    apply(control.value);
  };
  load(localStorage.getItem(key));
  window.addEventListener("storage", (event) => {
    if (event.key === key) load(event.newValue);
  });
  control.onchange = () => {
    apply(control.value);
    localStorage.setItem(key, control.value);
  };
}

const effortControl = $("effort");
const effortMenu = $("effort-menu");
const effortOptions = Array.from(effortMenu.querySelectorAll("[data-effort]"));
const savedEffort = localStorage.getItem("reply-effort");
let selectedEffort = "medium";

function selectEffort(value) {
  const option = effortOptions.find((entry) => entry.dataset.effort === value);
  if (!option) return;
  selectedEffort = value;
  $("effort-value").textContent = option.textContent;
  effortControl.setAttribute("aria-label", "思考强度：" + option.textContent);
  for (const entry of effortOptions) entry.setAttribute("aria-checked", String(entry === option));
}

function setEffortMenu(open, returnFocus = false) {
  effortMenu.hidden = !open;
  effortControl.setAttribute("aria-expanded", String(open));
  if (open) effortOptions.find((entry) => entry.dataset.effort === selectedEffort).focus();
  else if (returnFocus) effortControl.focus();
}

selectEffort(savedEffort || "medium");
effortControl.onclick = () => setEffortMenu(effortMenu.hidden, true);
effortControl.onkeydown = (event) => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  setEffortMenu(true);
};
for (const option of effortOptions) {
  option.onclick = () => {
    selectEffort(option.dataset.effort);
    localStorage.setItem("reply-effort", selectedEffort);
    setEffortMenu(false, true);
  };
}
effortMenu.onkeydown = (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    setEffortMenu(false, true);
    return;
  }
  const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
  if (!step) return;
  event.preventDefault();
  const index = effortOptions.indexOf(document.activeElement);
  effortOptions[(index + step + effortOptions.length) % effortOptions.length].focus();
};
document.addEventListener("focusin", (event) => {
  if (!effortMenu.hidden && event.target !== effortControl && !effortMenu.contains(event.target)) setEffortMenu(false);
});
document.addEventListener("pointerdown", (event) => {
  if (!effortMenu.hidden && !effortControl.contains(event.target) && !effortMenu.contains(event.target)) setEffortMenu(false);
});

let port, threadId, turnId, reference, busy = false, connected = false, sequence = 0, activeRequest, answer;
let startupError, bridgeProtocol, silenceTimer;
let workspaceSupported = false, workspaceBusy = false, selectedWorkspace, defaultWorkspace;
let workspaceManagement = false;
let groupEditing = false;
let attachmentSupported = false;
let folderAttachmentsSupported = false;
let localReferencesSupported = false;
let attachmentPicking = false;
const attachments = [];
const attachmentLimit = 8 * 1024 * 1024;
const attachmentExtensions = /\.(png|jpe?g|webp|gif|pdf|docx|xlsx|pptx|csv|tsv|txt|md)$/i;
const imageExtensions = /\.(png|jpe?g|webp|gif)$/i;
let connectionEpoch = 0;
let feishuBridge, feishuCheck;
let requestUncertain = false;
let progressStart, progressTimer;
let historyLoading = false;
let threadArchiveSupported = false;
let archivedHistory = false;
let historyArchiveBusy = false;
let olderCursor;
let threadReady = false;
const params = new URLSearchParams(location.search);
const groupId = params.get("group");
let boundPage = pageContext(params.get("page") || "", params.get("title"));
let frameActive = window.parent === window;
let connectionStarted = false;
let connectionSleeping = false;
let focusedPageKey = null;
let groupMembers = [];
const pending = new Map();
const activeTools = new Map();
const toolLabels = {
  commandExecution: "正在执行本机命令",
  mcpToolCall: "正在调用工具",
  dynamicToolCall: "正在调用工具",
  webSearch: "正在搜索",
  fileChange: "正在处理文件",
};

function feishuRoute(target) {
  if (!target) return null;
  const kind = new URL(target).pathname.split("/")[1];
  if (kind === "docx" || kind === "wiki") return "document";
  if (kind === "base") return "base";
  return "spreadsheet";
}

function documentStatsIntent(text) {
  const query = text.replace(/^(?:请|帮我|请帮我)\s*/, "").replace(/[。？?！!]+$/, "").trim();
  const document = "(?:当前文档|这篇文档|这份文档|本文档|这篇)";
  if (new RegExp(`^(?:统计${document}(?:的)?(?:字数|图片数|字数和图片数)|${document}(?:有)?(?:多少字|多少张图片))$`).test(query)) {
    return "count";
  }
  if (new RegExp(`^(?:估算${document}(?:的)?(?:人工)?阅读时间|(?:读完|通读)${document}(?:要|需要)?多久)$`).test(query)) {
    return "reading";
  }
  return null;
}

function recordFeishuTiming(request) {
  const { route, timing } = request || {};
  if (!route || !timing) return;
  const sample = { ...timing, total: Math.round(performance.now() - progressStart) };
  const labels = { toolStart: "首个工具", toolEnd: "首个工具返回", reply: "首段输出", total: "整轮完成" };
  $("progress-time").title = Object.entries(labels)
    .filter(([key]) => sample[key] !== undefined)
    .map(([key, label]) => label + " " + (sample[key] / 1000).toFixed(2) + " 秒").join(" · ");
  try {
    const key = "feishu-timing:" + route;
    const history = JSON.parse(localStorage.getItem(key) || "[]");
    localStorage.setItem(key, JSON.stringify([...history.slice(-19), sample]));
  } catch {
    // A storage error should not interrupt the turn.
  }
}

function status(text, state = connected ? "ready" : "") {
  $("codex-status-area").dataset.state = state;
  $("codex-status-area").title = "Codex · " + text;
  $("status").textContent = text;
}

function readyStatus() {
  status("已连接");
}

function progress(text) {
  $("progress").hidden = false;
  $("progress-label").textContent = text;
}

const composerPet = $("composer-pet");
const petPoses = { idle: 0, working: 3, success: 5, concerned: 6 };
let petPoseTimer, petRivePose;

async function loadPet() {
  if (!globalThis.rive || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const canvas = $("composer-pet-canvas");
  rive.RuntimeLoader.setWasmUrl(chrome.runtime.getURL("vendor/rive/rive.wasm"));
  rive.RuntimeLoader.setWasmFallbackUrl(chrome.runtime.getURL("vendor/rive/rive_fallback.wasm"));

  const [runtime, response] = await Promise.all([
    rive.RuntimeLoader.awaitInstance(),
    fetch(chrome.runtime.getURL("voki.riv")),
  ]);
  if (!response.ok) throw new Error("宠物动画加载失败");
  const file = await runtime.load(new Uint8Array(await response.arrayBuffer()), undefined, false);
  const board = file.artboardByName("Voki");
  const machine = new runtime.StateMachineInstance(board.stateMachineByName("Voki poses"), board);
  const viewModel = file.defaultArtboardViewModel(board).defaultInstance();
  machine.bindViewModelInstance(viewModel);
  petRivePose = viewModel.number("pose");
  petRivePose.value = petPoses[composerPet.dataset.pose] ?? petPoses.idle;

  const renderer = runtime.makeRenderer(canvas);
  const bounds = { minX: 0, minY: 0, maxX: canvas.width, maxY: canvas.height };
  let frame = null;
  let previousTime;
  function draw(time) {
    const elapsed = previousTime === undefined ? 0 : Math.min((time - previousTime) / 1000, .05);
    previousTime = time;
    machine.advance(elapsed);
    board.advance(elapsed);
    renderer.clear();
    renderer.save();
    renderer.align(runtime.Fit.contain, runtime.Alignment.center, bounds, board.bounds);
    board.draw(renderer);
    renderer.restore();
    renderer.flush();
    composerPet.dataset.riveReady ??= "";
    frame = runtime.requestAnimationFrame(draw);
  }
  const observer = new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting && frame === null) frame = runtime.requestAnimationFrame(draw);
    if (!entry.isIntersecting && frame !== null) {
      runtime.cancelAnimationFrame(frame);
      frame = null;
      previousTime = undefined;
    }
  });
  observer.observe(canvas);
  window.addEventListener("pagehide", () => {
    observer.disconnect();
    if (frame !== null) runtime.cancelAnimationFrame(frame);
    petRivePose = undefined;
    machine.delete();
    viewModel.unref();
    board.delete();
    renderer.delete();
    file.unref();
  }, { once: true });
}

function setPetPose(pose, resetAfter = 0) {
  clearTimeout(petPoseTimer);
  if (resetAfter) petPoseTimer = setTimeout(() => setPetPose("idle"), resetAfter);
  if (composerPet.dataset.pose === pose) return;
  composerPet.dataset.pose = pose;
  if (petRivePose) petRivePose.value = petPoses[pose];
}

void loadPet().catch((error) => console.warn("侧栏宠物动画无法加载", error));

function updateProgressTime() {
  const seconds = Math.floor((performance.now() - progressStart) / 1000);
  const minutes = Math.floor(seconds / 60);
  $("progress-time").textContent = minutes ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}
function rpc(method, params) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!pending.delete(id)) return;
      const error = new Error("等待本机 Codex 确认超时。");
      error.code = "RPC_TIMEOUT";
      reject(error);
    }, ["workspace/pick", "attachments/pick"].includes(method) ? 125000 : method === "turn/start" ? 60000 : 30000);
    pending.set(id, {
      resolve: (result) => { clearTimeout(timeout); resolve(result); },
      reject: (error) => { clearTimeout(timeout); reject(error); },
    });
    try {
      port.postMessage({ id, method, params });
    } catch (error) {
      pending.delete(id);
      clearTimeout(timeout);
      reject(error);
    }
  });
}

function renderAssistantMessage(node, text) {
  renderMarkdown(node, text.replace(/:codex-file-citation\{path="[^"\n]*\/Codex Browser Connector\/Attachments\/[a-f\d-]{36}\/(?:\d+-|[a-f\d-]{36}\/)([^"\n]+)"[^}\n]*\}/gi,
    (_citation, name) => `（附件 ${name}）`));
}

function messageNode(text, kind) {
  const entry = document.createElement("article");
  entry.className = kind;
  if (kind === "assistant" && text) renderAssistantMessage(entry, text);
  else if (kind === "user" && text) renderMarkdown(entry, text);
  else entry.textContent = text;
  return entry;
}

function visibleQuestion(text) {
  const blocks = text.split("\n\n");
  while (blocks.length > 1 && /^(?:当前网页|聚焦页面|工作区页面|参考网页（只读）|工作区参考（只读）|引用链接)：\s*https?:\/\/\S+\s*$/.test(blocks.at(-1))) {
    blocks.pop();
  }
  return blocks.join("\n\n");
}

function message(text, kind) {
  const entry = messageNode(text, kind);
  $("messages").append(entry);
  if (frameActive) entry.scrollIntoView({ block: "end" });
  return entry;
}

function updateControls() {
  $("add-attachment").disabled = busy || attachmentPicking;
  $("add-attachment").title = attachmentSupported ? "添加附件" : "更新本机连接器后可添加附件";
  for (const entry of attachments) entry.removeButton.disabled = busy;
  $("send").disabled = historyArchiveBusy || feishuCheck?.pending || busy || requestUncertain || workspaceBusy || historyLoading || !connected;
  $("workspace-button").disabled = busy || workspaceBusy || historyLoading || !connected || !workspaceSupported;
  effortControl.disabled = busy;
  $("composer-target").disabled = busy;
  if (busy) setAttachmentOptions(false);
  if (busy) setFocusMenu(false);
  if (busy) setEffortMenu(false);
  $("new").disabled = busy || workspaceBusy || historyLoading;
  $("older-messages").disabled = busy || workspaceBusy || historyLoading || !connected;
  $("stop").hidden = !turnId;
}

function historyFeedback(text) {
  $("history-feedback").textContent = text;
  $("history-feedback").hidden = !text;
}

function closeArchivedThread(id) {
  for (const key of [pageThreadKey(), boundPage && "page-thread:" + boundPage.key]) {
    if (key && localStorage.getItem(key) === id) localStorage.removeItem(key);
  }
  if (threadId !== id) return;
  threadId = null;
  threadReady = false;
  olderCursor = null;
  $("older-messages").hidden = true;
  $("messages").replaceChildren();
  $("progress").hidden = true;
}

async function changeThreadArchive(id, restore, button) {
  if (!connected || busy || workspaceBusy || historyLoading || historyArchiveBusy) return;
  historyArchiveBusy = true;
  button.disabled = true;
  historyFeedback("");
  updateControls();
  try {
    await rpc(restore ? "thread/unarchive" : "thread/archive", { threadId: id });
    if (!restore) closeArchivedThread(id);
    await renderHistoryMenu();
    historyFeedback(restore ? "会话已移回历史列表。" : "会话已归档。");
  } catch (error) {
    historyFeedback(error.message);
  } finally {
    historyArchiveBusy = false;
    button.disabled = false;
    updateControls();
  }
}

$("history-archive-view").onclick = () => {
  if (historyArchiveBusy) return;
  archivedHistory = !archivedHistory;
  historyFeedback("");
  void renderHistoryMenu();
};

async function renderHistoryMenu(cursor = null) {
  const list = $("history-list");
  const archived = threadArchiveSupported && archivedHistory;
  $("history-title").textContent = archived ? "已归档会话" : "历史会话";
  $("history-archive-view").hidden = !threadArchiveSupported;
  $("history-archive-view").textContent = archived ? "返回历史" : "已归档";
  if (!connected || busy || workspaceBusy || historyLoading) {
    const unavailable = document.createElement("p");
    unavailable.textContent = connected ? "本轮结束后可切换会话" : "连接 Codex 后可查看";
    list.replaceChildren(unavailable);
    return;
  }
  const loading = document.createElement("p");
  loading.textContent = "正在加载…";
  if (cursor) list.append(loading);
  else list.replaceChildren(loading);
  try {
    let nextCursor = cursor;
    let entries;
    do {
      const page = await rpc("thread/list", {
        archived, cursor: nextCursor, limit: 40, sortKey: "updated_at",
      });
      if (!loading.isConnected) return;
      entries = page.data;
      nextCursor = page.nextCursor;
    } while (entries.length === 0 && nextCursor);
    for (const { id, name, preview, cwd } of entries) {
      const title = (name || preview || "").replace(/https?:\/\/\S+/g, "").trim().split(/\s*\n\s*/)[0];
      const button = document.createElement(archived ? "span" : "button");
      if (!archived) button.type = "button";
      button.className = "history-entry";
      button.textContent = title || "未命名会话";
      button.title = button.textContent;
      if (id === threadId) button.setAttribute("aria-current", "true");
      if (!archived) button.onclick = () => {
        if (!historyArchiveBusy) return openHistory(id, cwd);
      };
      const row = document.createElement("div");
      row.className = "history-row";
      row.append(button);
      if (threadArchiveSupported) {
        const action = document.createElement("button");
        action.type = "button";
        action.className = "history-thread-action";
        action.textContent = archived ? "恢复" : "归档";
        action.setAttribute("aria-label", action.textContent + " " + button.textContent);
        action.onclick = () => changeThreadArchive(id, archived, action);
        row.append(action);
      }
      list.insertBefore(row, loading);
    }
    if (nextCursor) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "history-entry";
      more.textContent = "更多会话";
      more.onclick = () => {
        more.remove();
        void renderHistoryMenu(nextCursor);
      };
      list.insertBefore(more, loading);
    }
    if (list.childElementCount === 1) loading.textContent = archived ? "暂无已归档会话" : "暂无侧栏会话";
    else loading.remove();
  } catch {
    loading.textContent = "无法加载历史会话，请重新打开菜单。";
  }
}

function renderHistoryPage(data, prepend = false) {
  const items = document.createDocumentFragment();
  for (const turn of [...data].reverse()) {
    for (const item of turn.items || []) {
      if (item.type === "userMessage") {
        const text = item.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        if (text) {
          const entry = messageNode(visibleQuestion(text), "user");
          const names = item.content.find((part) => part.type === "attachments")?.text;
          if (names) {
            const label = document.createElement("p");
            label.textContent = "附件 · " + names;
            entry.append(label);
          }
          items.append(entry);
        }
      } else if (item.type === "agentMessage" && item.text) {
        items.append(messageNode(item.text, "assistant"));
      }
    }
  }
  const messages = $("messages");
  const dialogue = messages.parentElement;
  if (prepend) {
    const height = dialogue.scrollHeight;
    const top = dialogue.scrollTop;
    messages.prepend(items);
    dialogue.scrollTop = top + dialogue.scrollHeight - height;
  } else {
    messages.replaceChildren(items);
    dialogue.scrollTop = dialogue.scrollHeight;
  }
}

async function loadHistory(id, prepend = false, directory = selectedWorkspace) {
  if (!connected || busy || historyLoading) return;
  historyLoading = true;
  const epoch = connectionEpoch;
  updateControls();
  status("正在读取历史会话…");
  try {
    const { data, nextCursor } = await rpc("thread/turns/list", {
      threadId: id, cursor: prepend ? olderCursor : null, limit: 8, sortDirection: "desc", itemsView: "summary",
    });
    if (epoch !== connectionEpoch) return;
    if (!prepend) {
      threadId = id;
      threadReady = false;
      requestUncertain = false;
      if (directory) setSelectedWorkspace(directory);
      attach(null);
      $("progress").hidden = true;
    }
    olderCursor = nextCursor;
    $("older-messages").hidden = !olderCursor;
    renderHistoryPage(data, prepend);
    if (!prepend && boundPage) localStorage.setItem(pageThreadKey(), id);
    if (!prepend && frameActive) $("question").focus();
  } catch (error) {
    if (epoch !== connectionEpoch) return;
    message("无法读取历史会话：" + error.message, "error");
  } finally {
    if (epoch === connectionEpoch) {
      historyLoading = false;
      if (connected) readyStatus();
      updateControls();
    }
  }
}

function openHistory(id, directory) {
  $("history").hidePopover();
  if (id !== threadId) void loadHistory(id, false, directory);
}

$("history").addEventListener("beforetoggle", (event) => {
  if (event.newState === "open") {
    archivedHistory = false;
    historyFeedback("");
    void renderHistoryMenu();
  }
});
for (const [entry, popover] of [["workspace-button", "workspace-menu"], ["appearance-button", "appearance"]]) {
  $(entry).onclick = () => {
    $("history").hidePopover();
    $(popover).showPopover();
  };
}
$("older-messages").onclick = () => loadHistory(threadId, true);

function finish(outcome, petPose = "idle") {
  if (busy) {
    clearInterval(progressTimer);
    clearTimeout(silenceTimer);
    updateProgressTime();
    $("progress").dataset.running = "false";
    progress(outcome);
    setPetPose(petPose, petPose === "idle" ? 0 : 1200);
  }
  busy = false;
  activeTools.clear();
  turnId = null;
  activeRequest = null;
  renderComposerTarget();
  finishAnswer();
  updateControls();
  maybeSuspendConnection();
}

function finishAnswer(text) {
  if (!answer) return;
  if (answer.frame !== null) cancelAnimationFrame(answer.frame);
  renderAssistantMessage(answer.node, text ?? answer.source);
  answer = null;
}

function onPacket(packet) {
  if (packet.bridgeStatus) {
    status(packet.bridgeStatus);
    return;
  }
  if (packet.bridgeInfo) {
    bridgeProtocol = packet.bridgeInfo.protocol;
    workspaceSupported = packet.bridgeInfo.workspaces === true;
    workspaceManagement = packet.bridgeInfo.workspaceManagement === true;
    groupEditing = packet.bridgeInfo.groupEditing === true;
    attachmentSupported = packet.bridgeInfo.attachments === true;
    folderAttachmentsSupported = packet.bridgeInfo.folderAttachments === true;
    localReferencesSupported = packet.bridgeInfo.localReferences === true;
    threadArchiveSupported = packet.bridgeInfo.threadArchive === true;
    feishuBridge = packet.bridgeInfo;
    void checkFeishuConnection();
    return;
  }
  if (packet.bridgeError) {
    if (connected) {
      message(packet.bridgeError, "error");
      $("reconnect").hidden = false;
    }
    else startupError = packet.bridgeError;
    return;
  }
  if ("id" in packet) {
    const callback = pending.get(packet.id);
    if (!callback) return;
    pending.delete(packet.id);
    if (packet.error) callback.reject(new Error(packet.error.message));
    else callback.resolve(packet.result);
    queueMicrotask(maybeSuspendConnection);
    return;
  }
  const params = packet.params || {};
  if (packet.method === "thread/archived") {
    closeArchivedThread(params.threadId);
    return;
  }
  if (params.threadId !== threadId || !busy) return;
  if (turnId && (params.turnId || params.turn?.id) !== turnId) return;
  watchForSilence();
  const toolLabel = toolLabels[params.item?.type];
  const timing = activeRequest?.timing;
  if (packet.method === "item/started" && toolLabel) {
    if (timing && timing.toolStart === undefined) {
      timing.toolStart = Math.round(performance.now() - progressStart);
      activeRequest.firstToolId = params.item.id;
    }
    activeTools.set(params.item.id, toolLabel);
    progress(toolLabel);
  }
  if (packet.method === "item/completed" && toolLabel) {
    if (timing && activeRequest.firstToolId === params.item.id) {
      timing.toolEnd = Math.round(performance.now() - progressStart);
    }
    activeTools.delete(params.item.id);
    progress(activeTools.values().next().value || "工具已返回，等待 Codex 继续");
  }
  if (packet.method === "item/agentMessage/delta" && params.delta) {
    if (timing) timing.reply ??= Math.round(performance.now() - progressStart);
    if (!answer) {
      progress("正在输出回复");
      answer = { node: message("", "assistant"), source: "", frame: null };
    }
    const current = answer;
    current.source += params.delta;
    if (frameActive && current.frame === null) {
      current.frame = requestAnimationFrame(() => {
        current.frame = null;
        renderAssistantMessage(current.node, current.source);
        if (frameActive) current.node.scrollIntoView({ block: "end" });
      });
    }
  } else if (packet.method === "item/completed" && params.item?.type === "agentMessage") {
    if (timing) timing.reply ??= Math.round(performance.now() - progressStart);
    if (!answer) message(params.item.text, "assistant");
    else finishAnswer(params.item.text);
    progress("已收到回复，等待本轮结束");
  } else if (packet.method === "turn/completed") {
    if (params.turn.status === "failed") message(params.turn.error?.message || "Codex 执行失败。", "error");
    else if (params.turn.status === "interrupted") message("已停止。", "error");
    const outcomes = { failed: "执行失败", interrupted: "已停止" };
    if (params.turn.status === "completed") recordFeishuTiming(activeRequest);
    const petPose = { completed: "success", failed: "concerned" }[params.turn.status];
    finish(outcomes[params.turn.status] || "本轮已完成", petPose);
    readyStatus();
  }
}

function writeTarget(url) {
  const target = url && URL.parse(url);
  if (!target || target.protocol !== "https:" || target.port ||
      !/(?:^|\.)(?:feishu\.cn|larksuite\.com|doubao\.com)$/.test(target.hostname) ||
      !/^\/(?:wiki|docx|base|sheets|sheet)\/[a-zA-Z0-9]+\/?$/.test(target.pathname)) return null;
  return target.origin + target.pathname;
}

function feishuStatus(text, state = "") {
  $("feishu-status-area").hidden = !text;
  $("feishu-status-area").dataset.state = state;
  $("feishu-status-area").title = text;
  $("tool-status").textContent = text;
  $("feishu-details-button").hidden = state !== "error";
  if (state !== "error") $("feishu-details").hidePopover();
}

function feishuFailure(detail) {
  const version = chrome.runtime.getManifest?.().version || "未知";
  const connector = feishuBridge?.connectorVersion || "未报告版本";
  $("feishu-diagnostic").value = [
    "请排查并修复我这台 Mac 上的 Codex 飞书侧栏读取问题。",
    "扩展版本：" + version + "；连接器版本：" + connector,
    "检查项目：连接器以 --as user 只读请求当前飞书文档的一级大纲。",
    "报错信息：" + detail,
    "",
    "1. 若提示连接器不支持检查，请先更新连接器。用源码安装的用户请更新源码并重新运行 python3 install.py；用安装包的用户请安装配套的新版 Mac 连接器。然后关闭并重新打开侧栏。",
    "2. 运行 lark-cli auth status --json --verify，确认 CLI 使用的是我的现有飞书账号。需要复现时，用当前文档链接替换下面的占位符：",
    '   lark-cli docs +fetch --as user --doc "<当前飞书文档链接>" --doc-format markdown --scope outline --max-depth 1',
    "3. 根据报错处理：钥匙串访问失败时检查 Mac 是否已解锁，以及是否有授权弹窗。若终端能读、侧栏失败，请对比两个执行环境。授权失效时，用原飞书账号重新授权。文档权限不足时，确认该账号有阅读权限。若找不到 CLI，先查现有安装和连接器的 PATH，再决定是否需要安装。",
    "4. 连接器优先使用 codex-lark-cli，再查找 lark-cli。用步骤 2 中的命令复测时，请换成实际使用的 CLI。修复后确认顶部飞书图标前显示绿点。",
    "保留现有账号和配置，别重置钥匙串、删除凭据或修改文档。反馈原始错误时请隐去令牌、密钥和文档内容。"
  ].join("\n");
  $("feishu-copy-status").textContent = "";
  feishuStatus("飞书读取失败", "error");
  $("feishu-details").showPopover();
}

function currentFeishuDocument() {
  const target = writeTarget(boundPage?.url);
  return target && /^\/(?:docx|wiki)\//.test(new URL(target).pathname) ? target : null;
}

async function checkFeishuConnection() {
  if (!frameActive) return;
  const target = currentFeishuDocument();
  if (!target) {
    feishuCheck = undefined;
    feishuStatus("请打开飞书文档");
    return;
  }
  if (!feishuBridge) {
    if ($("feishu-status-area").dataset.state !== "error") feishuStatus("等待飞书连接");
    return;
  }
  if (feishuCheck?.target === target) return;
  const check = { target, epoch: connectionEpoch };
  feishuCheck = check;
  if (!feishuBridge.larkCheck) {
    feishuFailure("本机连接器不支持飞书读取检查。");
    return;
  }
  if (!feishuBridge.larkCli) {
    feishuFailure("本机连接器找不到飞书 CLI。");
    return;
  }
  feishuStatus("正在检查飞书…");
  check.pending = true;
  updateControls();
  try {
    const result = await rpc("feishu/check", { document: target });
    if (check !== feishuCheck || check.epoch !== connectionEpoch || !frameActive) return;
    if (!result?.readable) throw new Error("本机连接器未确认文档可读取。");
    feishuStatus("已连接", "ready");
    $("feishu-status-area").title = "飞书已连接 · 检查时间 " + new Date().toLocaleTimeString();
  } catch (error) {
    if (check !== feishuCheck || check.epoch !== connectionEpoch || !frameActive) return;
    feishuFailure(error.code === "RPC_TIMEOUT" ?
      "连接器未在 30 秒内返回读取结果。请检查网络，并查看 Mac 是否在等待钥匙串授权。" : error.message);
  } finally {
    check.pending = false;
    updateControls();
  }
}

$("copy-feishu-diagnostic").onclick = async () => {
  const field = $("feishu-diagnostic");
  try {
    await navigator.clipboard.writeText(field.value);
    $("feishu-copy-status").textContent = "已复制";
  } catch {
    field.focus();
    field.select();
    $("feishu-copy-status").textContent = "已选中，请按 ⌘C 复制";
  }
};

function attach(url) {
  reference = url;
  $("reference").hidden = !url;
  $("url").textContent = url || "";
  $("url").href = url || "#";
  $("url").title = url || "";
}

async function readCurrentPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return pageContext(tab?.url || "", tab?.title);
}

function groupReferences(current) {
  return groupMembers.filter((member) => member.key !== current?.key);
}

function focusPage() {
  return groupMembers.find((page) => page.key === focusedPageKey) || boundPage;
}

function focusStorageKey() {
  return "web-workspace-focus:" + groupId;
}

function restoreGroupFocus() {
  if (!groupId || !groupMembers.length) {
    focusedPageKey = null;
    return;
  }
  const saved = localStorage.getItem(focusStorageKey());
  const selected = groupMembers.find(({ key }) => key === saved) ||
    groupMembers.find(({ key }) => key === boundPage?.key) || groupMembers[0];
  focusedPageKey = selected.key;
  if (saved !== selected.key) localStorage.setItem(focusStorageKey(), selected.key);
}

function selectFocusPage(key) {
  if (!groupId || !groupMembers.some((page) => page.key === key)) return;
  focusedPageKey = key;
  localStorage.setItem(focusStorageKey(), key);
  renderComposerTarget();
}

function renderComposerTarget() {
  const target = activeRequest?.targetPage || focusPage();
  const tag = activeRequest?.targetPage ? "本轮目标" : "聚焦页";
  const title = target?.title || "";
  const label = target ? tag + "：" + title : "";
  $("focus-control").hidden = !target;
  $("composer-target-name").textContent = title.replace(/(?:\s*[-–—|｜·]\s*|\s+)飞书云文档\s*$/, "") || title;
  $("composer-target").title = label;
  $("composer-target").setAttribute("aria-label", label);
  if ($("connection-help").hidden) {
    $("welcome-title").textContent = $("composer-target-name").textContent || "当前聚焦页";
  }
  void checkFeishuConnection();
}

function setFocusMenu(open, restoreFocus = false) {
  $("focus-menu").hidden = !open;
  $("composer-target").setAttribute("aria-expanded", String(open));
  if (open) {
    const anchor = $("composer-target").getBoundingClientRect();
    const menu = $("focus-menu");
    const width = menu.getBoundingClientRect().width;
    menu.style.left = Math.max(8, Math.min(anchor.left, innerWidth - width - 8)) + "px";
    menu.style.bottom = Math.max(8, innerHeight - anchor.top + 8) + "px";
    menu.style.maxHeight = Math.max(40, Math.min(270, anchor.top - 16)) + "px";
  }
  if (restoreFocus) $("composer-target").focus();
}

function renderFocusMenu() {
  const menu = $("focus-menu");
  menu.replaceChildren();
  const candidates = groupId ? groupMembers : boundPage ? [boundPage] : [];
  for (const page of candidates) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", String(page.key === focusPage()?.key));
    button.textContent = page.title || page.url;
    button.title = page.url;
    button.onclick = () => {
      selectFocusPage(page.key);
      setFocusMenu(false, true);
    };
    menu.append(button);
  }
}

$("composer-target").onclick = () => {
  if (busy) return;
  if (!$("focus-menu").hidden) return setFocusMenu(false, true);
  setEffortMenu(false);
  renderFocusMenu();
  setFocusMenu(true);
  $("focus-menu").querySelector('[aria-checked="true"]')?.focus();
};
$("focus-menu").onkeydown = (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    setFocusMenu(false, true);
  }
  const direction = { ArrowDown: 1, ArrowUp: -1 }[event.key];
  if (!direction) return;
  event.preventDefault();
  const options = Array.from($("focus-menu").querySelectorAll("button"));
  const index = options.indexOf(document.activeElement);
  options[(index + direction + options.length) % options.length].focus();
};
document.addEventListener("pointerdown", (event) => {
  if (!$("focus-control").contains(event.target)) setFocusMenu(false);
});
document.addEventListener("focusin", (event) => {
  if (!$("focus-control").contains(event.target)) setFocusMenu(false);
});
window.addEventListener("resize", () => setFocusMenu(false));
window.addEventListener("storage", (event) => {
  if (!groupId || event.key !== focusStorageKey()) return;
  restoreGroupFocus();
  renderComposerTarget();
  if (!$("focus-menu").hidden) renderFocusMenu();
});

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.source !== window.parent ||
      event.data?.type !== "codex-page-context") return;
  boundPage = event.data.context;
  frameActive = event.data.active === true;
  if (frameActive) {
    if (connectionSleeping) reconnect(true);
    else if (!connectionStarted && connectionConsentGranted()) startConnection();
  } else {
    feishuCheck = undefined;
    maybeSuspendConnection();
  }
  groupMembers = Array.isArray(event.data.members) ? event.data.members : [];
  if (frameActive && answer) {
    if (answer.frame !== null) cancelAnimationFrame(answer.frame);
    answer.frame = null;
    renderAssistantMessage(answer.node, answer.source);
  }
  restoreGroupFocus();
  if (!$("focus-menu").hidden) renderFocusMenu();
  renderComposerTarget();
  const workspace = event.data.workspace;
  if (workspace) {
    $("web-workspaces-button").dataset.scopeTone = workspace.tone;
    $("web-workspaces-button").setAttribute("aria-expanded", String(workspace.open));
    $("web-workspaces-button").title = workspace.name;
    $("web-workspaces-button").setAttribute("aria-label", "网页工作区：" + workspace.name);
    $("current-scope").textContent = workspace.name;
  }
});
renderComposerTarget();

let workspaceWasOpen;
$("web-workspaces-button").onpointerdown = (event) => {
  workspaceWasOpen = event.currentTarget.getAttribute("aria-expanded") === "true";
};
$("web-workspaces-button").onclick = (event) => {
  const wasOpen = event.detail && workspaceWasOpen !== undefined
    ? workspaceWasOpen : event.currentTarget.getAttribute("aria-expanded") === "true";
  window.parent.postMessage({ type: "codex-toggle-workspaces", open: !wasOpen }, location.origin);
  workspaceWasOpen = undefined;
};

function composeContext(text, current, chosen, members, focus = current) {
  const parts = [text];
  if (current?.url) parts.push("当前网页：" + current.url);
  if (focus?.url && focus.key !== current?.key) parts.push("聚焦页面：" + focus.url);
  if (chosen && chosen !== current?.url &&
      !members.some((member) => pageContext(chosen)?.key === member.key)) {
    parts.push("参考网页（只读）：" + chosen);
  }
  for (const member of members) {
    parts.push("工作区页面：" + member.url);
  }
  return {
    input: parts.join("\n\n"),
    target: writeTarget(focus?.url) || null,
    targets: [...new Set([current, focus, ...members].map((page) => writeTarget(page?.url)).filter(Boolean))],
  };
}

function watchForSilence() {
  clearTimeout(silenceTimer);
  $("reconnect").hidden = true;
  silenceTimer = setTimeout(() => {
    if (busy) {
      progress("暂未收到新进度，可以继续等待或停止");
      $("reconnect").hidden = false;
    }
  }, 45000);
}

function attachmentStatus(text) {
  const status = $("attachment-status");
  status.textContent = text;
  status.hidden = !text;
}

function removeAttachment(entry) {
  const index = attachments.indexOf(entry);
  if (index < 0) return;
  attachments.splice(index, 1);
  if (entry.token && entry.epoch === connectionEpoch && connected) {
    void rpc("attachments/release", { tokens: [entry.token] }).catch(() => {});
  }
  if (entry.preview?.startsWith("blob:")) URL.revokeObjectURL(entry.preview);
  entry.element.remove();
  $("attachments").hidden = attachments.length === 0;
}

function addAttachments(files, folder = false) {
  if (busy || !frameActive) return;
  if (!attachmentSupported || (folder && !folderAttachmentsSupported)) {
    attachmentStatus("请更新本机连接器并重新连接后添加附件。");
    return;
  }
  const supported = Array.from(files).filter((file) => attachmentExtensions.test(file.name) && file.size > 0);
  if (!supported.length) {
    attachmentStatus("没有找到支持的非空文件。");
    return;
  }
  const skipped = files.length - supported.length;
  const groups = folder ? [supported] : supported.map((file) => [file]);
  const errors = [];
  if (skipped) errors.push(`已跳过 ${skipped} 个格式不支持或为空的文件`);
  for (const group of groups) {
    const size = group.reduce((total, file) => total + file.size, 0);
    const queuedSize = attachments.reduce((total, entry) => total + entry.size, 0);
    const queuedFiles = attachments.reduce((total, entry) => total + entry.files.length, 0);
    if (attachments.length >= 5 || queuedFiles + group.length > 30 || queuedSize + size > attachmentLimit) {
      errors.push("每条消息最多添加 5 项、30 个文件，合计 8 MB。");
      break;
    }
    const file = group[0];
    const name = folder ? file.webkitRelativePath.split("/")[0] : file.name;
    const count = folder ? ` · ${group.length} 个文件` : "";
    addAttachmentChip({
      files: group, name, size, folder: folder ? crypto.randomUUID() : null,
      preview: !folder && imageExtensions.test(file.name) ? URL.createObjectURL(file) : null,
    }, `${name}${count} · ${Math.max(1, Math.ceil(size / 1024))} KB`);
  }
  attachmentStatus(errors.join("；"));
}

function addAttachmentChip(entry, text) {
  const element = document.createElement("div");
  element.className = "attachment-chip";
  if (entry.preview) {
    const thumbnail = document.createElement("img");
    thumbnail.src = entry.preview;
    thumbnail.alt = "";
    element.append(thumbnail);
  }
  const label = document.createElement("span");
  label.textContent = text;
  label.title = entry.name;
  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.textContent = "×";
  removeButton.setAttribute("aria-label", "移除 " + entry.name);
  removeButton.onclick = () => {
    if (!busy) removeAttachment(entry);
  };
  Object.assign(entry, { element, removeButton });
  attachments.push(entry);
  element.append(label, removeButton);
  $("attachments").append(element);
  $("attachments").hidden = false;
}

async function pickLocalAttachments(folder) {
  if (!frameActive || busy || attachmentPicking) return;
  const epoch = connectionEpoch;
  const pageKey = boundPage?.key;
  attachmentPicking = true;
  updateControls();
  attachmentStatus("");
  try {
    const { entries } = await rpc("attachments/pick", { mode: folder ? "folders" : "files" });
    if (epoch !== connectionEpoch) return;
    if (!frameActive || pageKey !== boundPage?.key || busy || attachments.length + entries.length > 5) {
      if (entries.length) void rpc("attachments/release", { tokens: entries.map(({ token }) => token) }).catch(() => {});
      attachmentStatus(!frameActive || pageKey !== boundPage?.key || busy
        ? "页面或任务状态已改变，请返回当前会话后重新选择附件。"
        : "每条消息最多添加 5 项附件。");
      return;
    }
    for (const entry of entries) {
      addAttachmentChip({ ...entry, epoch, files: [], size: 0 }, entry.name + (entry.directory ? " · 文件夹" : ""));
    }
  } catch (error) {
    if (epoch === connectionEpoch) attachmentStatus(error.message);
  } finally {
    attachmentPicking = false;
    updateControls();
  }
}

async function transferAttachments(entries, threadId, batch, check) {
  const files = entries.flatMap((entry) => entry.files.map((file) => ({
    file, folder: entry.folder,
  })));
  await rpc("attachments/begin", { threadId, batch, files: files.map(({ file, folder }) => ({
    name: file.name, size: file.size,
    ...(folder ? { folder, relativePath: file.webkitRelativePath } : {}),
  })) });
  for (const [index, { file }] of files.entries()) {
    for (let offset = 0; offset < file.size; offset += 128 * 1024) {
      check();
      const data = new Uint8Array(await file.slice(offset, offset + 128 * 1024).arrayBuffer());
      check();
      await rpc("attachments/chunk", { batch, index, offset, data: typeof data.toBase64 === "function" ? data.toBase64() : btoa(Array.from(data, (byte) => String.fromCharCode(byte)).join("")) });
    }
  }
}

function setAttachmentOptions(open) {
  $("attachment-options").hidden = !open;
  $("add-attachment").setAttribute("aria-expanded", String(open));
}

$("add-attachment").onclick = () => {
  setAttachmentOptions($("attachment-options").hidden);
  if (!$("attachment-options").hidden) $("choose-file").focus();
};
for (const [button, picker, folder] of [
  ["choose-file", "attachment-picker", false],
  ["choose-folder", "folder-picker", true],
]) {
  $(button).onclick = () => {
    setAttachmentOptions(false);
    $("add-attachment").focus();
    if (localReferencesSupported) void pickLocalAttachments(folder);
    else if (attachmentSupported && (!folder || folderAttachmentsSupported)) $(picker).click();
    else attachmentStatus("请更新本机连接器并重新连接后添加附件。");
  };
  $(picker).onchange = (event) => {
    addAttachments(event.target.files, folder);
    event.target.value = "";
  };
}
document.addEventListener("pointerdown", (event) => {
  if (!$("attachment-control").contains(event.target)) setAttachmentOptions(false);
});
document.addEventListener("focusin", (event) => {
  if (!$("attachment-control").contains(event.target)) setAttachmentOptions(false);
});
$("attachment-control").onkeydown = (event) => {
  if (event.key !== "Escape" || $("attachment-options").hidden) return;
  event.preventDefault();
  setAttachmentOptions(false);
  $("add-attachment").focus();
};

$("remove").onclick = () => attach(null);
$("question").addEventListener("paste", (event) => {
  const files = Array.from(event.clipboardData?.files || []);
  if (files.length) {
    event.preventDefault();
    addAttachments(files);
    return;
  }
  const pasted = event.clipboardData?.getData("text/plain").trim();
  if (!pasted || /\s/.test(pasted)) return;
  const url = safeReference(pasted);
  if (!writeTarget(url)) return;
  event.preventDefault();
  attach(url);
});
$("new").onclick = () => {
  requestUncertain = false;
  if (boundPage) {
    localStorage.removeItem(pageThreadKey());
    if (!groupId && selectedWorkspace === defaultWorkspace) localStorage.removeItem("page-thread:" + boundPage.key);
  }
  threadId = null;
  threadReady = false;
  olderCursor = null;
  $("older-messages").hidden = true;
  $("messages").replaceChildren();
  $("progress").hidden = true;
  attach(null);
  updateControls();
  $("question").focus();
};
$("stop").onclick = async () => {
  const request = activeRequest;
  try { await rpc("turn/interrupt", { threadId, turnId }); }
  catch (error) {
    if (request !== activeRequest) return;
    message(error.message, "error");
    $("reconnect").hidden = false;
  }
};
$("composer").onsubmit = async (event) => {
  event.preventDefault();
  const draft = $("question").value.trim();
  const entries = [...attachments];
  const local = entries.filter(({ token }) => token);
  const copied = entries.filter(({ token }) => !token);
  const text = draft || (entries.length ? "请查看这些附件。" : "");
  if (!text || historyArchiveBusy || feishuCheck?.pending || busy || requestUncertain || workspaceBusy || historyLoading || !connected || !frameActive) return;
  if (local.some(({ epoch }) => epoch !== connectionEpoch) || (local.length && !localReferencesSupported)) {
    attachmentStatus("本地附件引用已失效，请移除后重新选择。");
    return;
  }
  if (copied.length && (!attachmentSupported || (!folderAttachmentsSupported && copied.some(({ folder }) => folder)))) {
    attachmentStatus("请更新本机连接器，或移除附件后发送文字。");
    return;
  }
  const pageKey = boundPage?.key;
  const epoch = connectionEpoch;
  const checkAttachmentContext = () => {
    if (activeRequest !== request || connectionEpoch !== epoch || !frameActive || boundPage?.key !== pageKey) {
      throw new Error("页面或连接已切换，请确认后重新发送附件。");
    }
  };
  const chosen = reference;
  const effort = selectedEffort;
  const requestedFocus = focusedPageKey;
  const request = { draft };
  let target;
  let batch;
  let sentEntry;
  activeRequest = request;
  busy = true;
  setPetPose("working");
  progressStart = performance.now();
  $("progress-time").title = "";
  $("progress").dataset.running = "true";
  progress(threadId ? "正在发送请求" : "正在启动会话");
  updateProgressTime();
  progressTimer = setInterval(updateProgressTime, 1000);
  updateControls();
  $("question").value = "";
  attachmentStatus("");
  try {
    const current = await readCurrentPage().catch(() => null);
    if (!frameActive || current?.key !== boundPage?.key) {
      throw new Error("页面刚切换，请在对应网页的会话里重新发送。");
    }
    if (activeRequest !== request) {
      if (!$("question").value) $("question").value = draft;
      return;
    }
    if (!groupEditing) throw new Error("请更新本机连接器，再使用工作区读写和聚焦页面功能。");
    const focus = requestedFocus === null ? current : groupMembers.find(({ key }) => key === requestedFocus);
    if (!focus && requestedFocus !== null) throw new Error("所选页面已移出工作区，请重新选择聚焦页面。");
    const context = composeContext(text, current, chosen, groupReferences(current), focus);
    request.targetPage = focus;
    renderComposerTarget();
    target = context.target;
    request.writeTarget = target;
    request.route = feishuRoute(target);
    if (request.route) request.timing = {};
    sentEntry = message(text, "user");
    if (entries.length) {
      const names = document.createElement("p");
      names.textContent = "附件 · " + entries.map(({ name }) => name).join("、");
      sentEntry.append(names);
    }
    const statsIntent = !chosen && !entries.length && request.route === "document" &&
      feishuBridge?.documentStats && documentStatsIntent(text);
    if (statsIntent) {
      progress("正在直接读取飞书文档");
      request.timing.toolStart = Math.round(performance.now() - progressStart);
      const { han, images } = await rpc("feishu/documentStats", { document: target });
      if (activeRequest !== request) return;
      request.timing.toolEnd = Math.round(performance.now() - progressStart);
      const summary = `当前文档约有 **${han.toLocaleString("zh-CN")} 个汉字**，包含 **${images} 处图片引用**。`;
      const minutes = Math.max(1, Math.ceil(han / 400));
      const reading = han ? `\n\n按每分钟约 400 个汉字估算，通读中文正文约 **${minutes} 分钟**。浏览图片的时间另计。` : "";
      message(summary + (statsIntent === "reading" ? reading : ""), "assistant");
      request.timing.reply = Math.round(performance.now() - progressStart);
      recordFeishuTiming(request);
      finish("本轮已完成", "success");
      return;
    }
    if (!threadId) {
      const result = await rpc("thread/start", { workspace: selectedWorkspace });
      if (activeRequest !== request) return;
      threadId = result.thread.id;
      threadReady = true;
    } else if (!threadReady) {
      await rpc("thread/resume", { threadId });
      if (activeRequest !== request) return;
      threadReady = true;
    }
    progress("正在发送请求");
    const id = threadId;
    if (entries.length) {
      checkAttachmentContext();
      if (copied.length) {
        batch = crypto.randomUUID();
        progress("正在传送附件");
        await transferAttachments(copied, id, batch, checkAttachmentContext);
      }
      const latest = await readCurrentPage();
      checkAttachmentContext();
      if (latest?.key !== pageKey) throw new Error("页面已切换，请确认后重新发送附件。");
    }
    request.sent = true;
    if (boundPage) localStorage.setItem(pageThreadKey(), id);
    const result = await rpc("turn/start", {
      threadId: id, effort, text: context.input, writeTarget: target, writeTargets: context.targets,
      ...(batch ? { attachmentBatch: batch } : {}),
      ...(local.length ? { localAttachments: local.map(({ token }) => token) } : {}),
    });
    for (const entry of entries) removeAttachment(entry);
    if (activeRequest === request) {
      turnId = result.turn.id;
      watchForSilence();
      if ($("progress-label").textContent === "正在发送请求") progress("Codex 已接收，等待首条输出");
      updateControls();
    }
  } catch (error) {
    if (batch && connected && connectionEpoch === epoch) {
      void rpc("attachments/discard", { batch }).catch(() => {});
    }
    if (activeRequest !== request) return;
    const writerBusy = /already has an active writer/.test(error.message);
    requestUncertain = request.sent && (!connected || error.code === "RPC_TIMEOUT");
    if (entries.length && !requestUncertain) sentEntry?.remove();
    if (requestUncertain) message("请求可能已开始执行。请先重新连接并查看这段历史，核对执行结果后再发送。", "error");
    message(writerBusy ? "此会话正在另一个窗口中使用。关闭那边的会话后，可以在这里继续。" : error.message, "error");
    if (!$("question").value) $("question").value = draft;
    finish(requestUncertain ? "请求结果待确认" : "请求失败", "concerned");
    if (error.code === "RPC_TIMEOUT" || !connected) $("reconnect").hidden = false;
    if (connected) readyStatus();
  }
};
$("question").onkeydown = (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (connected && !busy && !requestUncertain && !historyLoading && !event.repeat && ($("question").value.trim() || attachments.length)) $("composer").requestSubmit();
};

function selectionKey() {
  return "page-workspace:" + conversationScope();
}

function conversationScope() {
  return groupId ? "group:" + groupId : boundPage?.key || "unassigned";
}

function pageThreadKey() {
  return "page-thread-v2:" + JSON.stringify([conversationScope(), selectedWorkspace || ""]);
}

function setSelectedWorkspace(directory) {
  selectedWorkspace = directory;
  const label = "工作目录：" + workspaceName(directory);
  $("workspace-button").textContent = label;
  $("workspace-button").title = directory;
  $("workspace-button").setAttribute("aria-label", label);
  localStorage.setItem(selectionKey(), directory);
}

function workspaceName(directory) {
  return localStorage.getItem("workspace-name:" + directory) ||
    directory.split("/").filter(Boolean).at(-1) || "/";
}

function workspaceAction(label, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "workspace-action";
  button.textContent = label;
  button.onclick = handler;
  return button;
}

function editWorkspaceName(row, path) {
  const form = document.createElement("form");
  form.className = "workspace-rename";
  const name = document.createElement("input");
  name.type = "text";
  name.value = workspaceName(path);
  name.maxLength = 40;
  name.setAttribute("aria-label", "工作目录显示名称");
  const save = workspaceAction("保存");
  save.type = "submit";
  form.append(name, save, workspaceAction("取消", () => void showWorkspaceMenu()));
  form.onsubmit = (event) => {
    event.preventDefault();
    const value = name.value.trim();
    if (value) localStorage.setItem("workspace-name:" + path, value);
    else localStorage.removeItem("workspace-name:" + path);
    if (path === selectedWorkspace) setSelectedWorkspace(path);
    void showWorkspaceMenu();
  };
  row.replaceWith(form);
  name.focus();
  name.select();
}

async function removeWorkspace(path) {
  if (workspaceBusy || busy) return;
  workspaceBusy = true;
  updateControls();
  try {
    const result = await rpc("workspace/remove", { path });
    if (path === selectedWorkspace) await switchDirectory(result.default);
    await showWorkspaceMenu();
  } catch (error) {
    $("workspace-error").textContent = error.message;
    $("workspace-error").hidden = false;
  } finally {
    workspaceBusy = false;
    updateControls();
  }
}

async function initializeWorkspace() {
  const epoch = connectionEpoch;
  workspaceBusy = true;
  updateControls();
  try {
    const result = await rpc("workspace/list", {});
    if (epoch !== connectionEpoch) return;
    defaultWorkspace = result.default;
    const saved = localStorage.getItem(selectionKey());
    setSelectedWorkspace(result.paths.includes(saved) ? saved : defaultWorkspace);
  } catch (error) {
    if (epoch !== connectionEpoch) return;
    workspaceSupported = false;
    message("无法加载工作目录：" + error.message, "error");
  } finally {
    if (epoch === connectionEpoch) {
      workspaceBusy = false;
      updateControls();
    }
  }
}

async function switchDirectory(directory) {
  if (!directory || directory === selectedWorkspace) return;
  setSelectedWorkspace(directory);
  threadId = null;
  threadReady = false;
  olderCursor = null;
  requestUncertain = false;
  $("messages").replaceChildren();
  $("older-messages").hidden = true;
  $("progress").hidden = true;
  await restorePageThread();
}

async function showWorkspaceMenu() {
  const list = $("workspace-list");
  list.textContent = "正在读取…";
  $("workspace-error").hidden = true;
  try {
    const result = await rpc("workspace/list", {});
    list.replaceChildren();
    for (const path of result.paths) {
      const row = document.createElement("div");
      row.className = "workspace-row";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "history-entry workspace-item";
      const name = document.createElement("span");
      const directory = document.createElement("small");
      name.textContent = workspaceName(path);
      directory.textContent = path;
      button.append(name, directory);
      button.title = path;
      if (path === selectedWorkspace) button.setAttribute("aria-current", "true");
      button.onclick = () => {
        $("workspace-menu").hidePopover();
        void switchDirectory(path);
      };
      row.append(button, workspaceAction("改名", () => editWorkspaceName(row, path)));
      if (workspaceManagement && path !== result.default) {
        const remove = workspaceAction("移除", () => void removeWorkspace(path));
        remove.title = "从侧栏移除此目录";
        row.append(remove);
      }
      list.append(row);
    }
  } catch (error) {
    list.textContent = "无法读取工作目录：" + error.message;
  }
}

$("workspace-menu").addEventListener("beforetoggle", (event) => {
  if (event.newState === "open") void showWorkspaceMenu();
});
$("workspace-pick").onclick = async () => {
  workspaceBusy = true;
  $("workspace-pick").disabled = true;
  updateControls();
  try {
    const { selected } = await rpc("workspace/pick", {});
    if (selected) {
      $("workspace-menu").hidePopover();
      await switchDirectory(selected);
    }
  } catch (error) {
    $("workspace-error").textContent = error.message;
    $("workspace-error").hidden = false;
  } finally {
    workspaceBusy = false;
    $("workspace-pick").disabled = false;
    updateControls();
  }
};

async function restorePageThread() {
  const savedId = boundPage && (localStorage.getItem(pageThreadKey()) ||
    (!groupId && selectedWorkspace === defaultWorkspace && localStorage.getItem("page-thread:" + boundPage.key)));
  if (!savedId) return;
  const epoch = connectionEpoch;
  historyLoading = true;
  status("正在恢复此页的会话…");
  updateControls();
  let found = false;
  try {
    let cursor = null;
    const visited = new Set();
    do {
      const page = await rpc("thread/list", { cursor });
      if (epoch !== connectionEpoch) return;
      if (visited.has(cursor)) throw new Error("历史分页未能继续，请从历史菜单选择会话。");
      visited.add(cursor);
      found = page.data.some(({ id }) => id === savedId);
      cursor = page.nextCursor;
    } while (!found && cursor);
  } catch (error) {
    if (epoch !== connectionEpoch) return;
    message("暂时无法恢复此页会话：" + error.message, "error");
  } finally {
    if (epoch === connectionEpoch) {
      historyLoading = false;
      if (connected) readyStatus();
      updateControls();
    }
  }
  if (found && epoch === connectionEpoch) await loadHistory(savedId);
}

async function connect() {
  const epoch = ++connectionEpoch;
  startupError = null;
  feishuBridge = feishuCheck = undefined;
  feishuStatus("");
  void checkFeishuConnection();
  bridgeProtocol = null;
  workspaceSupported = false;
  workspaceManagement = false;
  groupEditing = false;
  attachmentSupported = folderAttachmentsSupported = localReferencesSupported = false;
  threadArchiveSupported = false;
  const connection = chrome.runtime.connect({ name: "codex-sidepanel" });
  port = connection;
  let nativeDisconnect;
  connection.onMessage.addListener((packet) => {
    if (port !== connection) return;
    if (packet.nativeDisconnect) nativeDisconnect = packet.nativeDisconnect;
    else onPacket(packet);
  });
  connection.onDisconnect.addListener(() => {
    if (port !== connection) return;
    ++connectionEpoch;
    port = null;
    historyLoading = false;
    workspaceBusy = false;
    const detail = nativeDisconnect || chrome.runtime.lastError?.message;
    for (const callback of pending.values()) callback.reject(new Error(detail || "与本机 Codex 的连接已关闭。"));
    pending.clear();
    connected = false;
    feishuBridge = feishuCheck = undefined;
    if (frameActive && currentFeishuDocument()) {
      feishuFailure("本机连接器连接中断，无法完成自动读取检查。");
    } else feishuStatus("请打开飞书文档");
    const uncertainWrite = busy && activeRequest?.sent;
    if (busy && activeRequest?.draft && !$("question").value) $("question").value = activeRequest.draft;
    attachmentSupported = folderAttachmentsSupported = localReferencesSupported = false;
    requestUncertain ||= Boolean(uncertainWrite);
    finish(uncertainWrite ? "请求结果待确认" : "连接已中断", "concerned");
    const missingHost = detail && /native messaging host.*not found|not find.*native messaging host/i.test(detail);
    const help = startupError || (missingHost
      ? (release.packageInstall ? "打开 Mac 连接器安装包。安装完成后，回到这里重新检查。" : "请先运行本机连接器安装脚本，再重新检查。")
      : "请检查本机连接器和 Codex 是否正常启动，再重新检查。");
    showConnectionHelp(missingHost ? "未安装本机连接器" : "本机 Codex 未连接", help);
    if (missingHost && release.installerUrl) {
      $("install-connector").href = release.installerUrl;
      $("install-connector").hidden = false;
    }
    $("install-codex").hidden = !startupError?.startsWith("找不到本机 Codex");
    if ($("messages").childElementCount) message(help, "error");
    if (uncertainWrite) message("如果刚才要求修改，请先核对飞书原文再重试。", "error");
  });
  await rpc("initialize", {});
  if (epoch !== connectionEpoch) return;
  if (bridgeProtocol !== 3) throw new Error("连接器版本过旧，请更新配套的 Mac 连接器后重连。");
  port.postMessage({ method: "initialized" });
  const { authenticated, requiresOpenaiAuth } = await rpc("account/read", {});
  if (epoch !== connectionEpoch) return;
  connected = authenticated || !requiresOpenaiAuth;
  $("reconnect").hidden = connected;
  if (connected) {
    readyStatus();
    if (workspaceSupported) await initializeWorkspace();
    if (epoch !== connectionEpoch) return;
    await restorePageThread();
  } else showConnectionHelp("本机 Codex 未登录", "在已安装的 Codex 中完成登录，然后返回侧栏重新检查。");
  updateControls();
}

function showConnectionHelp(title, help, state = "error") {
  status(title, state);
  $("welcome-title").textContent = title;
  $("connection-help").textContent = help;
  $("connection-help").hidden = false;
  $("retry").hidden = false;
  $("reconnect").hidden = !($("messages").childElementCount > 0);
}

function connectionConsentGranted() {
  return !release.installerUrl || localStorage.getItem("connection-consent") === "1";
}

function maybeSuspendConnection() {
  if (frameActive || !connected || busy || historyLoading || workspaceBusy ||
      requestUncertain || pending.size) return;
  // Keep the page, draft, reference and saved thread; release only the native
  // process. A running or uncertain request must never be disconnected here.
  connectionSleeping = true;
  ++connectionEpoch;
  const previous = port;
  port = null;
  connected = false;
  threadReady = false;
  previous?.disconnect();
  status("后台连接已休眠");
  updateControls();
}

function startConnection(savedReference = null) {
  connectionStarted = true;
  connectionSleeping = false;
  const epoch = connectionEpoch + 1;
  connect().then(() => {
    if (epoch !== connectionEpoch) return;
    if (connected && savedReference && !reference) attach(savedReference);
    maybeSuspendConnection();
  }).catch((error) => {
    if (epoch !== connectionEpoch) return;
    const failed = port;
    port = null;
    failed?.disconnect();
    connected = false;
    for (const callback of pending.values()) callback.reject(error);
    pending.clear();
    updateControls();
    if (frameActive && currentFeishuDocument() && !feishuCheck?.pending) {
      feishuFailure("本机连接器启动或握手失败。请检查 Codex 和 Mac 连接器是否已安装并正常启动。");
    }
    if ($("retry").hidden) showConnectionHelp("本机 Codex 未连接", error.message);
  });
}

function reconnect(preserveReference = false) {
  const savedReference = preserveReference === true ? reference : null;
  if (busy && activeRequest?.writeTarget &&
      !confirm("如果刚才要求修改，重连后请先核对飞书原文。现在重新连接？")) return;
  requestUncertain ||= Boolean(busy && activeRequest?.sent);
  ++connectionEpoch;
  const previous = port;
  port = null;
  previous?.disconnect();
  for (const callback of pending.values()) callback.reject(new Error("连接已重置。若刚才请求写入，请先核对飞书原文。"));
  pending.clear();
  connected = false;
  historyLoading = false;
  workspaceBusy = false;
  // Reopening the connector refreshes its current-account boundary.
  threadId = null;
  threadReady = false;
  olderCursor = null;
  $("older-messages").hidden = true;
  $("messages").replaceChildren();
  $("history-list").replaceChildren();
  attach(savedReference);
  $("connection-help").hidden = true;
  finish("已断开旧连接");
  $("progress").hidden = true;
  $("reconnect").hidden = true;
  $("retry").hidden = true;
  $("install-connector").hidden = true;
  $("install-codex").hidden = true;
  status("正在连接本机…");
  startConnection(savedReference);
}

$("retry").onclick = reconnect;
$("reconnect").onclick = reconnect;
if (release.installerUrl && localStorage.getItem("connection-consent") !== "1") {
  showConnectionHelp("连接本机 Codex", "发送时，问题、当前网页地址、所选参考链接和附件会交给本机 Codex，相关内容由你配置的模型服务处理。飞书文档通过本机已有的飞书工具访问。", "");
  $("retry").textContent = "同意并连接";
  $("retry").onclick = () => {
    localStorage.setItem("connection-consent", "1");
    location.reload();
  };
} else if (frameActive) {
  startConnection();
}

// The parent checks synchronously before removing an idle panel. Unknown or
// loading panels remain resident, and drafts never disappear during recycling.
window.codexSessionState = () => ({
  protected: busy || historyLoading || workspaceBusy || requestUncertain ||
    attachmentPicking || pending.size > 0 || Boolean($("question").value.trim()) || Boolean(reference) || attachments.length > 0,
});


// Only unload a hidden view whose visible conversation can be restored.
window.canUnloadCodexView = () => !frameActive && !window.codexSessionState().protected &&
  (!$("messages").childElementCount || Boolean(boundPage && threadId &&
    localStorage.getItem(pageThreadKey()) === threadId));
