const $ = (id) => document.getElementById(id);
const pages = $("pages");
const frames = new Map();
const idleSessionMs = 2 * 60 * 60 * 1000;

function canRecycle(entry) {
  if (entry === shown) return false;
  try {
    if (!entry.frame) return true;
    const state = entry.frame.contentWindow?.codexSessionState?.();
    return state?.protected === false;
  } catch {
    return false;
  }
}

function canUnloadView(frame) {
  try {
    return frame.contentWindow?.canUnloadCodexView?.() === true;
  } catch {
    return false;
  }
}

function recycleSessions(manual = false) {
  let recycled = 0;
  const now = Date.now();
  for (const [key, entry] of frames) {
    if (entry !== shown && entry.frame && !manual && now - entry.lastUsed < idleSessionMs) {
      // The page/thread binding can outlive its expensive renderer document.
      if (canUnloadView(entry.frame)) {
        entry.frame.remove();
        entry.frame = null;
        entry.context = null;
        entry.group = null;
      }
      continue;
    }
    if (!manual && now - entry.lastUsed < idleSessionMs) continue;
    if (!canRecycle(entry)) continue;
    entry.frame?.remove();
    frames.delete(key);
    recycled++;
  }
  updateSessionSummary();
  return recycled;
}

function updateSessionSummary() {
  const count = [...frames.values()].filter(canRecycle).length;
  $("recycle-sessions").disabled = count === 0;
  $("session-count").textContent = frames.size + " 个会话，" + count + " 个可回收";
}

const permissions = { permissions: ["tabs"] };
let sequence = 0;
let shown;
let currentPage;
let currentGroup;
let menuView = "overview";
let managedGroupId;
let addCandidates = [];
let addSequence = 0;
const menuViews = {
  overview: ["workspace-overview", "网页工作区"],
  manage: ["active-workspace", "工作区成员"],
  rename: ["rename-web-workspace", "修改名称"],
  create: ["create-web-workspace", "新建工作区"],
  add: ["add-pages-form", "添加网页"],
};

$("enable-pages").onclick = async () => {
  if (await chrome.permissions.request(permissions).catch(() => false)) void switchWorkspace();
};

function workspaceTone(group) {
  if (!group) return "single";
  const tones = ["teal", "blue", "violet", "amber", "rose"];
  const hash = Array.from(group.id).reduce((value, char) => (31 * value + char.charCodeAt(0)) >>> 0, 0);
  return tones[hash % tones.length];
}

function updateFrame(entry, active) {
  entry.frame.contentWindow?.postMessage({
    type: "codex-page-context", context: entry.context, active,
    members: entry.group?.pages || [],
    workspace: {
      name: entry.group?.name || "单页会话",
      tone: workspaceTone(entry.group),
      open: active && $("web-workspaces").matches(":popover-open"),
    },
  }, location.origin);
}

function positionWorkspaceMenu() {
  const frame = shown?.frame;
  const trigger = frame?.contentDocument?.getElementById("web-workspaces-button");
  if (!trigger) return;
  const frameBox = frame.getBoundingClientRect();
  const buttonBox = trigger.getBoundingClientRect();
  const menu = $("web-workspaces");
  const width = Math.min(356, innerWidth - 20);
  const top = frameBox.top + buttonBox.top;
  menu.style.left = Math.max(10, Math.min(frameBox.left + buttonBox.left, innerWidth - width - 10)) + "px";
  menu.style.bottom = Math.max(10, innerHeight - top + 6) + "px";
  menu.style.maxHeight = Math.max(80, top - 16) + "px";
}

async function switchWorkspace() {
  const request = ++sequence;
  const granted = await chrome.permissions.contains(permissions).catch(() => false);
  if (request !== sequence) return;
  $("enable-pages").hidden = granted;
  pages.hidden = !granted;
  if (!granted) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (request !== sequence) return;
  currentPage = pageContext(tab?.url || "", tab?.title);
  currentGroup = workspaceFor(currentPage, readWebWorkspaces());
  const key = currentGroup ? "group:" + currentGroup.id : currentPage?.key || "unassigned";
  let entry = frames.get(key);
  if (!entry?.frame) {
    const frame = document.createElement("iframe");
    entry = { frame, context: currentPage, group: currentGroup, lastUsed: Date.now() };
    frames.set(key, entry);
    frame.title = "Codex 会话";
    frame.hidden = true;
    frame.addEventListener("load", () => updateFrame(entry, shown === entry));
    const params = new URLSearchParams();
    if (currentGroup) params.set("group", currentGroup.id);
    if (currentPage) {
      params.set("page", currentPage.url);
      params.set("title", currentPage.title);
    }
    frame.src = "panel.html?" + params;
    pages.append(frame);
  }
  if (shown && shown !== entry) {
    if (menuView === "overview") $("web-workspaces").hidePopover();
    shown.lastUsed = Date.now();
    shown.frame.hidden = true;
    updateFrame(shown, false);
  }
  shown = entry;
  entry.lastUsed = Date.now();
  entry.context = currentPage;
  entry.group = currentGroup;
  entry.frame.hidden = false;
  updateFrame(entry, true);
  recycleSessions();
  if ($("web-workspaces").matches(":popover-open")) {
    positionWorkspaceMenu();
    renderWorkspaceMenu();
  }
}

function chooseWorkspace(id, page) {
  if (!page) return;
  localStorage.setItem(pageWorkspaceKey(page), id);
  $("web-workspaces").hidePopover();
  void switchWorkspace();
}

function menuButton(label, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.onclick = handler;
  return button;
}

function removeMember(groupId, member) {
  writeWebWorkspaces(leaveWebWorkspace(readWebWorkspaces(), groupId, member));
  if (localStorage.getItem(pageWorkspaceKey(member)) === groupId ||
      (currentPage?.key === member.key && currentGroup?.id === groupId)) {
    localStorage.setItem(pageWorkspaceKey(member), "single");
  }
  void switchWorkspace();
}

function managedGroup() {
  return readWebWorkspaces().find(({ id }) => id === managedGroupId);
}

function openGroupManagement(id) {
  managedGroupId = id;
  menuView = "manage";
  renderWorkspaceMenu();
  $("web-workspaces-title").focus();
}

function renderActiveWorkspace(group) {
  const list = $("active-workspace-pages");
  list.replaceChildren();
  const groupId = group.id;
  $("active-workspace-label").textContent = group.name;
  $("active-workspace-count").textContent = group.pages.length + " 个成员页面";
  if (!group.pages.length) {
    const empty = document.createElement("p");
    empty.className = "menu-note";
    empty.textContent = "还没有成员网页";
    list.append(empty);
  }
  for (const member of group.pages) {
    const row = document.createElement("div");
    row.className = "member-row";
    const link = document.createElement("a");
    link.textContent = member.title || member.url;
    link.title = member.title || member.url;
    link.href = member.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.onclick = () => $("web-workspaces").hidePopover();
    if (member.key === currentPage?.key) {
      link.setAttribute("aria-current", "page");
      link.title += "（当前页）";
    }
    const remove = menuButton("移出", () => removeMember(groupId, member));
    remove.className = "secondary";
    remove.setAttribute("aria-label", "移出 " + link.textContent);
    row.append(link, remove);
    list.append(row);
  }
}

function renderWorkspaceMenu() {
  const group = managedGroup();
  if (!group && ["manage", "rename", "add"].includes(menuView)) menuView = "overview";
  for (const [view, [id]] of Object.entries(menuViews)) $(id).hidden = view !== menuView;
  $("workspace-back").hidden = menuView === "overview";
  $("web-workspaces-title").textContent = menuViews[menuView][1];
  if (menuView === "manage") {
    renderActiveWorkspace(group);
    return;
  }
  if (menuView !== "overview") return;

  updateSessionSummary();
  const list = $("web-workspace-list");
  list.replaceChildren();
  const page = currentPage;
  $("single-page").disabled = !page;
  $("single-page").setAttribute("aria-current", String(!currentGroup));
  const groups = readWebWorkspaces();
  if (currentGroup) groups.sort((a, b) => Number(b.id === currentGroup.id) - Number(a.id === currentGroup.id));
  const assigned = [], other = [];
  for (const group of groups) {
    const active = group.id === currentGroup?.id;
    const joined = page && group.pages.some((member) => member.key === page.key);
    const row = document.createElement("div");
    row.className = "web-workspace-row";
    const choose = menuButton("", () => {
      if (joined) chooseWorkspace(group.id, page);
      else openGroupManagement(group.id);
    });
    choose.className = "workspace-option";
    const icon = document.createElement("span");
    icon.className = "workspace-icon";
    icon.dataset.tone = workspaceTone(group);
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "▱";
    const name = document.createElement("span");
    name.className = "option-name";
    name.textContent = group.name;
    const count = document.createElement("span");
    count.className = "option-count";
    count.textContent = active ? "✓" : group.pages.length + " 页";
    if (active) choose.setAttribute("aria-current", "true");
    choose.append(icon, name, count);
    choose.title = group.name;
    row.append(choose);
    if (!joined && page) {
      const change = menuButton("加入此页", () => {
        writeWebWorkspaces(joinWebWorkspace(readWebWorkspaces(), group.id, page));
        chooseWorkspace(group.id, page);
      });
      change.className = "secondary";
      row.append(change);
    } else if (joined) {
      const manage = menuButton("管理", () => openGroupManagement(group.id));
      manage.className = "secondary";
      row.append(manage);
    }
    (joined ? assigned : other).push(row);
  }
  for (const [title, rows] of [["当前页已加入", assigned], ["其他工作区", other]]) {
    if (!rows.length) continue;
    const heading = document.createElement("div");
    heading.className = "workspace-list-heading";
    heading.textContent = title;
    list.append(heading, ...rows);
  }
}

function nameExists(name, id) {
  const normalized = name.trim().toLocaleLowerCase();
  return readWebWorkspaces().some((group) =>
    group.id !== id && group.name.trim().toLocaleLowerCase() === normalized);
}

function formError(id, text = "") {
  $(id).textContent = text;
  $(id).hidden = !text;
}

async function showAddPages() {
  const group = managedGroup();
  if (!group) return;
  const sequence = ++addSequence;
  menuView = "add";
  renderWorkspaceMenu();
  const list = $("add-page-options");
  list.textContent = "正在读取已打开的网页…";
  $("add-pages-submit").disabled = true;
  const tabs = await chrome.tabs.query({ windowType: "normal" }).catch(() => null);
  if (sequence !== addSequence || menuView !== "add" || managedGroupId !== group.id) return;
  const existing = new Set(group.pages.map(({ key }) => key));
  addCandidates = [];
  for (const tab of tabs || []) {
    const page = pageContext(tab.url || "", tab.title);
    if (page && !existing.has(page.key)) {
      existing.add(page.key);
      addCandidates.push(page);
    }
  }
  list.replaceChildren();
  if (!addCandidates.length) {
    list.textContent = tabs ? "已打开的网页都已加入，或没有可加入的网页。" : "暂时无法读取已打开的网页。";
    return;
  }
  for (const page of addCandidates) {
    const row = document.createElement("label");
    row.className = "add-page-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = page.key;
    const title = document.createElement("span");
    title.textContent = page.title;
    title.title = page.title;
    row.append(input, title);
    list.append(row);
  }
}

$("web-workspaces").addEventListener("beforetoggle", (event) => {
  if (event.newState === "open") {
    menuView = "overview";
    renderWorkspaceMenu();
  }
});
$("web-workspaces").addEventListener("toggle", () => {
  if (shown) updateFrame(shown, true);
});
window.addEventListener("message", (event) => {
  if (event.origin !== location.origin || event.source !== shown?.frame.contentWindow ||
      event.data?.type !== "codex-toggle-workspaces") return;
  if (event.data.open) {
    positionWorkspaceMenu();
    $("web-workspaces").showPopover();
  }
  else $("web-workspaces").hidePopover();
});
$("single-page").onclick = () => chooseWorkspace("single", currentPage);
$("workspace-back").onclick = () => {
  menuView = ["rename", "add"].includes(menuView) ? "manage" : "overview";
  renderWorkspaceMenu();
  $("web-workspaces-title").focus();
};
$("rename-workspace").onclick = () => {
  const group = managedGroup();
  if (!group) return;
  menuView = "rename";
  formError("rename-workspace-error");
  renderWorkspaceMenu();
  $("active-workspace-name").value = group.name;
  $("active-workspace-name").focus();
  $("active-workspace-name").select();
};
$("new-workspace").onclick = () => {
  menuView = "create";
  formError("create-workspace-error");
  $("create-include-current").hidden = !currentPage;
  $("include-current-page").checked = Boolean(currentPage);
  renderWorkspaceMenu();
  $("web-workspace-name").focus();
};
$("rename-web-workspace").onsubmit = (event) => {
  event.preventDefault();
  const name = $("active-workspace-name").value.trim();
  const id = managedGroupId;
  if (!name || !managedGroup()) return;
  if (nameExists(name, id)) return formError("rename-workspace-error", "已有同名工作区。");
  writeWebWorkspaces(readWebWorkspaces().map((group) => group.id === id ? { ...group, name } : group));
  menuView = "manage";
  void switchWorkspace();
};
$("create-web-workspace").onsubmit = (event) => {
  event.preventDefault();
  const input = $("web-workspace-name");
  const name = input.value.trim();
  if (!name) return;
  if (nameExists(name)) return formError("create-workspace-error", "已有同名工作区。");
  const id = crypto.randomUUID();
  const included = currentPage && $("include-current-page").checked;
  writeWebWorkspaces([...readWebWorkspaces(), { id, name, pages: included ? [currentPage] : [] }]);
  input.value = "";
  if (included) chooseWorkspace(id, currentPage);
  else openGroupManagement(id);
};
$("add-workspace-pages").onclick = () => void showAddPages();
$("delete-workspace").onclick = () => {
  const group = managedGroup();
  if (!group || !confirm("删除网页工作区「" + group.name + "」？只移除分组，网页和历史对话会保留。")) return;
  writeWebWorkspaces(readWebWorkspaces().filter(({ id }) => id !== group.id));
  for (const member of group.pages) {
    if (localStorage.getItem(pageWorkspaceKey(member)) === group.id ||
        (currentPage?.key === member.key && currentGroup?.id === group.id)) {
      localStorage.setItem(pageWorkspaceKey(member), "single");
    }
  }
  managedGroupId = null;
  menuView = "overview";
  renderWorkspaceMenu();
  void switchWorkspace();
};
$("add-page-options").onchange = () => {
  $("add-pages-submit").disabled = !$("add-page-options").querySelector(":checked");
};
$("add-pages-form").onsubmit = (event) => {
  event.preventDefault();
  const group = managedGroup();
  if (!group) return;
  const selected = new Set(Array.from($("add-page-options").querySelectorAll(":checked"), ({ value }) => value));
  const added = addCandidates.filter(({ key }) => selected.has(key));
  if (!added.length) return;
  if (currentPage && added.some(({ key }) => key === currentPage.key)) {
    localStorage.setItem(pageWorkspaceKey(currentPage), currentGroup?.id || "single");
  }
  writeWebWorkspaces(joinWebWorkspacePages(readWebWorkspaces(), group.id, added));
  openGroupManagement(group.id);
  void switchWorkspace();
};

chrome.tabs.onActivated.addListener(() => void switchWorkspace());
chrome.tabs.onUpdated.addListener((_id, changes, tab) => {
  if (tab.active && (changes.url || changes.title)) void switchWorkspace();
});
chrome.permissions.onAdded.addListener(() => void switchWorkspace());
chrome.permissions.onRemoved.addListener(() => void switchWorkspace());
window.addEventListener("storage", (event) => {
  if (event.key === webWorkspacesKey || (currentPage && event.key === pageWorkspaceKey(currentPage))) {
    void switchWorkspace();
  }
});
window.addEventListener("resize", () => {
  if ($("web-workspaces").matches(":popover-open")) positionWorkspaceMenu();
});
void switchWorkspace();

$("recycle-sessions").onclick = () => {
  const count = recycleSessions(true);
  $("session-recycle-result").textContent = count
    ? "已回收 " + count + " 个后台会话，历史记录保留。"
    : "暂无可回收会话。任务、草稿和结果待确认的会话会保留。";
};
setInterval(() => recycleSessions(), 60000);
