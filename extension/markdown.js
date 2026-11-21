// Use Marked for tokenization. Build DOM nodes directly so model output cannot inject HTML.
function appendMarkdown(parent, tokens) {
  const inlineTags = { strong: "strong", em: "em", del: "del", codespan: "code", paragraph: "p", blockquote: "blockquote" };
  const textOf = (token) => token.text ?? token.raw ?? "";
  const create = (tag, text) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  for (const token of tokens) {
    const { type } = token;
    if (type === "space" || type === "def") continue;
    if (type === "link" || type === "image") {
      const url = URL.parse(token.href);
      if (!url || !["http:", "https:", "mailto:"].includes(url.protocol)) {
        if (type === "link" && token.tokens) appendMarkdown(parent, token.tokens);
        else parent.append(textOf(token));
        continue;
      }
      const link = create("a");
      link.href = url.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      if (type === "image") link.textContent = token.text || "查看图片";
      else appendMarkdown(link, token.tokens || [{ type: "text", text: token.text }]);
      parent.append(link);
    } else if (type === "table") {
      const wrap = create("div");
      wrap.className = "md-table";
      const table = create("table");
      const head = create("thead");
      const body = create("tbody");
      const row = (cells, heading) => {
        const tr = create("tr");
        for (const cell of cells) {
          const td = create(heading ? "th" : "td");
          if (heading) td.scope = "col";
          if (["left", "center", "right"].includes(cell.align)) td.style.textAlign = cell.align;
          appendMarkdown(td, cell.tokens);
          tr.append(td);
        }
        return tr;
      };
      head.append(row(token.header, true));
      for (const cells of token.rows) body.append(row(cells, false));
      table.append(head, body);
      wrap.append(table);
      parent.append(wrap);
    } else if (type === "list") {
      const list = create(token.ordered ? "ol" : "ul");
      if (token.ordered && Number.isSafeInteger(token.start)) list.start = token.start;
      for (const item of token.items) {
        const li = create("li");
        if (item.task) {
          const checkbox = create("input");
          checkbox.type = "checkbox";
          checkbox.checked = item.checked;
          checkbox.disabled = true;
          checkbox.setAttribute("aria-label", item.checked ? "已完成" : "待完成");
          li.append(checkbox, " ");
        }
        appendMarkdown(li, item.tokens);
        list.append(li);
      }
      parent.append(list);
    } else if (type === "code") {
      const pre = create("pre");
      pre.append(create("code", textOf(token)));
      parent.append(pre);
    } else if (type === "br" || type === "hr") {
      parent.append(create(type));
    } else if (type === "heading" || Object.hasOwn(inlineTags, type)) {
      const tag = type === "heading" ? "h" + Math.min(6, Math.max(1, token.depth)) : inlineTags[type];
      const el = create(tag);
      if (token.tokens) appendMarkdown(el, token.tokens);
      else el.textContent = textOf(token);
      parent.append(el);
    } else if (type === "text" && token.tokens) {
      appendMarkdown(parent, token.tokens);
    } else {
      parent.append(textOf(token));
    }
  }
}

function renderMarkdown(node, source) {
  try {
    const fragment = document.createDocumentFragment();
    appendMarkdown(fragment, marked.lexer(source, { gfm: true, breaks: true }));
    node.replaceChildren(fragment);
  } catch {
    node.textContent = source;
  }
}
