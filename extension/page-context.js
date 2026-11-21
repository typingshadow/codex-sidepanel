const feishuHost = /(?:^|\.)(?:feishu\.cn|larksuite\.com|doubao\.com)$/;

function safeReference(raw) {
  const url = URL.parse(raw);
  if (!url || !["https:", "http:"].includes(url.protocol)) return null;
  url.username = "";
  url.password = "";
  const feishu = feishuHost.test(url.hostname);
  for (const key of new Set(url.searchParams.keys())) {
    const keep = feishu && ["table", "view", "record"].includes(key) &&
      url.searchParams.getAll(key).every((value) => /^[a-zA-Z0-9_-]{1,128}$/.test(value));
    if (!keep) url.searchParams.delete(key);
  }
  if (!feishu || !/^#[a-zA-Z0-9_-]{1,128}$/.test(url.hash)) url.hash = "";
  return url.href;
}

function pageContext(raw, title) {
  const safe = safeReference(raw);
  if (!safe) return null;
  const url = new URL(safe);
  const key = url.origin + (url.pathname.replace(/\/+$/, "") || "/");
  return { key, url: safe, title: title || url.hostname };
}
