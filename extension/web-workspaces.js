const webWorkspacesKey = "codex-web-workspaces-v1";

function readWebWorkspaces() {
  try {
    const list = JSON.parse(localStorage.getItem(webWorkspacesKey) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeWebWorkspaces(list) {
  localStorage.setItem(webWorkspacesKey, JSON.stringify(list));
}

function pageWorkspaceKey(page) {
  return "web-workspace-for:" + page.key;
}

function workspaceFor(page, groups) {
  if (!page) return null;
  const preference = localStorage.getItem(pageWorkspaceKey(page));
  if (preference === "single") return null;
  const memberships = groups.filter((group) => group.pages.some((member) => member.key === page.key));
  return memberships.find(({ id }) => id === preference) || memberships[0] || null;
}

function joinWebWorkspace(groups, id, page) {
  return joinWebWorkspacePages(groups, id, [page]);
}

function joinWebWorkspacePages(groups, id, incoming) {
  return groups.map((group) => {
    if (group.id !== id) return group;
    const pages = new Map(group.pages.map((page) => [page.key, page]));
    for (const page of incoming) pages.set(page.key, page);
    return { ...group, pages: [...pages.values()] };
  });
}

function leaveWebWorkspace(groups, id, page) {
  return groups.map((group) => group.id === id
    ? { ...group, pages: group.pages.filter((member) => member.key !== page.key) }
    : group);
}
