"use strict";
const {
  modelOptionsFor,
  DEFAULT_MODEL_BY_KIND,
} = require("../core/model-options");
const { ALL_AI_KINDS, getKindLabel } = require("../core/ai-kinds");
const { formatBeijingDateTime } = require("../core/beijing-time");
function createMemoryPanel({
  document,
  ipcRenderer,
  escapeHtml: esc,
  getActiveSessionInfo,
  openSession,
}) {
  let page,
    tab = "context",
    data = null,
    rows = [],
    selected = new Set(),
    sid = null,
    file = null,
    preview = "",
    error = "",
    busy = false,
    epoch = 0,
    timer,
    query = "",
    scanned = [],
    scanNote = "",
    sourcePreview = "";
  let kind = "codex",
    model = DEFAULT_MODEL_BY_KIND.codex,
    effort = "medium";
  try {
    const s = JSON.parse(localStorage.getItem("hubDreamSelection") || "null");
    if (s && ALL_AI_KINDS.includes(s.kind)) {
      kind = s.kind;
      model = s.model;
      effort = s.effort;
    }
  } catch {}
  const fmt = (n) => (n ? formatBeijingDateTime(n, { seconds: false }) : "—");
  const badge = (s) => `<span class="mp-badge">${esc(s)}</span>`;
  const button = (text, action, cls = "") =>
    `<button class="mp-btn ${cls}" data-action-mp="${action}">${text}</button>`;
  async function call(name, args = {}) {
    const r = await ipcRenderer.invoke("memory:" + name, args);
    if (!r?.ok) throw new Error(r?.error || "读取失败");
    return r.data;
  }
  function position() {
    const r = document.getElementById("scene-rail")?.getBoundingClientRect();
    if (page && r) {
      page.style.left = r.right + "px";
      page.style.top = r.top + "px";
    }
  }
  function fail(e) {
    error = e.message || String(e);
    render();
  }
  function tuning() {
    return (
      window.WorkspaceController?.resolveSessionTuning(kind, model, {
        effort,
      }) || {
        model,
        modelOptions: modelOptionsFor(kind),
        showEffort: kind === "codex",
        effortOptions: [
          ["medium", "medium"],
          ["high", "high"],
          ["max", "max"],
        ],
      }
    );
  }
  async function catalog() {
    const before = kind;
    await window.WorkspaceController?.loadModelCatalog(kind);
    if (before === kind) render();
  }
  async function read(p, paint = true) {
    const version = epoch;
    file = p;
    preview = "读取中…";
    if (paint) render();
    const r = await ipcRenderer.invoke("read-file", p);
    if (file !== p || version !== epoch) return;
    preview = r?.error ? "读取失败：" + r.error : String(r?.content || "");
    if (paint) render();
  }
  async function refresh() {
    const version = ++epoch,
      s = getActiveSessionInfo();
    if (!s?.id) {
      sid = null;
      data = null;
      error = "";
      return render();
    }
    const changed = sid !== s.id;
    sid = s.id;
    if (changed) {
      selected.clear();
      file = null;
      preview = "";
      scanned = [];
      scanNote = "";
      sourcePreview = "";
      data = null;
    }
    error = "";
    const [a, b] = await Promise.allSettled([
      call("snapshot", { sessionId: s.id }),
      call("candidates", { sessionId: s.id }),
    ]);
    if (version !== epoch || page.hidden) return;
    if (a.status === "rejected") return fail(a.reason);
    data = a.value;
    if (b.status === "fulfilled") {
      rows = b.value;
      if (changed)
        rows
          .filter((x) => !x.processed)
          .slice(0, 3)
          .forEach((x) => selected.add(x.key));
    } else {
      rows = [];
      error = "历史素材读取失败：" + b.reason.message;
    }
    if (!file) {
      file = data.indexPath || data.files[0]?.path || null;
      if (file) await read(file, false);
    }
    render();
  }
  function fileRow(f) {
    return `<button class="mp-file ${file === f.path ? "active" : ""}" data-file="${esc(f.path)}"><span class="mp-file-name">${esc(f.label || f.path.split(/[\\/]/).pop())}</span><span class="mp-meta">${esc(f.owner || "")} ${badge(f.status || "可读取")}</span></button>`;
  }
  function previewPane() {
    return `<section class="mp-preview"><div class="mp-preview-head"><span>${esc(file ? file.split(/[\\/]/).pop() : "内容预览")}</span>${file ? button("打开所在位置", "folder") : ""}</div><pre class="mp-preview-content">${esc(preview || "选择文件查看内容")}</pre><div class="mp-path">${esc(file || "")}</div></section>`;
  }
  function context() {
    return `<div class="mp-pagehead"><div><h2>这次对话用了哪些记忆</h2><p>${esc(data.session.title || "当前 session")} · ${esc(data.session.kind)}</p></div>${button("返回当前会话", "close")}</div><div class="mp-two"><section class="mp-card"><div class="mp-section-title">当前 session 的文件与使用证据</div>${data.nativeFiles.map(fileRow).join("")}${data.receipts.map((r, i) => `<button class="mp-file" data-receipt="${i}"><span class="mp-file-name">DREAM_INDEX.md ${badge(r.status === "sent" ? "已发送" : r.status === "failed" ? "发送失败" : "待确认")}</span><span class="mp-meta">${esc(fmt(r.sentAt || r.createdAt))} · ${esc(r.version.slice(0, 8))}</span></button>`).join("")}${!data.nativeFiles.length && !data.receipts.length ? '<p class="mp-empty">暂未发现记忆文件或索引提交记录。</p>' : ""}</section>${previewPane()}</div>${data.pending ? '<div class="mp-note">文件库已有新版 DREAM_INDEX.md；当前 session 将在下一次正常任务提交时附带索引。已有提交快照不变。</div>' : ""}<div class="mp-note">${esc(data.nativeNote || "")}<br>只确认有证据的发送。原生文件标为预计加载或可读取；磁盘存在不代表已注入。梦境正文按需读取，Hub 暂不推测其读取状态。</div>`;
  }
  function library() {
    const all = [...data.files, ...scanned]
      .filter((f, i, a) => a.findIndex((x) => x.path === f.path) === i)
      .filter((f) =>
        (f.label + " " + f.path).toLowerCase().includes(query.toLowerCase()),
      );
    const groups = [...new Set(all.map((f) => f.group))];
    return `<div class="mp-pagehead"><div><h2>记忆文件库</h2><p>各处记忆统一浏览，原生文件保留原位。</p>${scanNote ? `<p class="mp-muted">${esc(scanNote)}</p>` : ""}</div><div class="mp-actions">${button("扫描项目文档", "scan")}${button("☾ 造梦", "dream", "primary")}</div></div><div class="mp-library"><section class="mp-tree"><input id="mp-search" placeholder="搜索文件名或路径" aria-label="搜索记忆文件" value="${esc(query)}">${groups
      .map(
        (g) =>
          `<div class="mp-section-title">${esc(g)}</div>${all
            .filter((f) => f.group === g)
            .map(fileRow)
            .join("")}`,
      )
      .join(
        "",
      )}${!all.length ? '<p class="mp-empty">没有匹配的文件</p>' : ""}</section>${previewPane()}</div><div class="mp-note">原生 MEMORY.md 由各家 AI 自己维护。Hub 使用独立 DREAM_INDEX.md 和主题文件；允许少量重复。</div>`;
  }
  function dream() {
    const t = tuning();
    return `<div class="mp-pagehead"><div><h2>把聊过的事，留给下一次</h2><p>选择昨日之我的对话，交给一个普通 AI session 整理。</p></div></div><div class="mp-dream-grid"><div><section class="mp-card"><div class="mp-section-title">素材 session <span>${rows.length} 个可用会话</span></div><div class="mp-sources">${rows.map((s) => `<div class="mp-source"><input type="checkbox" aria-label="选择 ${esc(s.title)}" data-source="${esc(s.key)}" ${selected.has(s.key) ? "checked" : ""}><span><strong>${esc(s.title)}</strong><small>${esc(s.provider)} · ${esc(fmt(s.updatedAt))} · ${s.records} 条记录</small><small>${s.processed ? "该版本已整理" : s.newRecords < s.records ? `约 ${s.newRecords} 条新增，已整理部分只作上文` : "有未整理记录"}${s.stale ? " · 请刷新后再整理" : ""}</small></span><button class="mp-link" data-source-preview="${esc(s.key)}">预览</button></div>`).join("") || '<p class="mp-empty">此项目暂无历史正文。点击右上角刷新，从昨日之我更新素材。</p>'}</div><div class="mp-selection">已选 ${selected.size} 个会话 · 完整导出这些会话的已保存正文</div></section><p class="mp-muted">默认勾选最近 3 个未整理会话，可自行修改。只读取历史，不打开素材 session。历史解析可能缺少工具结果或附件，不宣称无损归档。</p>${sourcePreview ? `<details open class="mp-card"><summary>素材预览（历史窗口，完整输入以导出文件为准）</summary><pre class="mp-source-preview">${esc(sourcePreview)}</pre></details>` : ""}</div><div><section class="mp-card mp-settings"><h3>造梦师</h3><label>AI<select id="mp-kind">${["codex", ...ALL_AI_KINDS.filter((v) => v !== "codex")].map((v) => `<option value="${v}" ${v === kind ? "selected" : ""}>${esc(getKindLabel(v))}</option>`).join("")}</select></label><label>模型<select id="mp-model">${!t.modelOptions.some((m) => m.id === model) ? `<option value="" selected>请选择模型（原选择不可用）</option>` : ""}${t.modelOptions.map((m) => `<option value="${esc(m.id)}" ${m.id === model ? "selected" : ""}>${esc(m.label)}</option>`).join("")}</select></label>${t.showEffort ? `<label>思考深度<select id="mp-effort">${!t.effortOptions.some(([v]) => v === effort) ? `<option value="" selected>请选择思考深度</option>` : ""}${t.effortOptions.map(([v, l]) => `<option value="${esc(v)}" ${v === effort ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>` : ""}<p class="mp-muted">复用新建 session 的模型与档位。账号跟随 Hub 当前设置。</p><button class="mp-btn primary mp-wide" data-action-mp="start" ${busy || !selected.size ? "disabled" : ""}>${busy ? "正在准备素材…" : "☾ 开始造梦"}</button></section>${data.jobs[0] ? job(data.jobs[0]) : ""}</div></div>`;
  }
  function job(j) {
    const labels = {
      preparing: "准备素材",
      running:
        {
          waiting: "等待你的回复或审批",
          unknown: "运行状态待核对",
          interrupted: "本轮已停止",
          failed: "本轮执行失败",
        }[j.runtimeState] || "造梦 session 正在处理",
      publishing: "保存结果",
      done: "造梦完成",
      attention: "需要在会话中处理",
      failed: "未完成",
    };
    return `<section class="mp-card mp-job"><h3>${esc(j.orphaned ? "任务中断，需核对" : labels[j.status] || j.status)}</h3><p>${esc(j.kind)} / ${esc(j.model)} / ${esc(j.effort || "默认配置")}</p><p>${j.sources.length} 个素材 session · ${esc(fmt(j.createdAt))}</p>${j.error ? `<div class="mp-error">${esc(j.error)}</div>` : ""}${j.summary ? `<p>${esc(j.summary)}</p>` : ""}<div class="mp-actions">${j.sessionId ? `<button class="mp-btn" data-job-session="${esc(j.sessionId)}">打开造梦 session ↗</button>` : ""}${j.status === "done" ? button("查看生成文件", "library") : j.sessionId ? `<button class="mp-btn" data-finalize="${j.id}">核对并保存结果</button><button class="mp-btn" data-abandon="${j.id}">结束本次</button>` : ""}</div><details><summary>输入文件与实际 prompt</summary><div class="mp-path">${esc(j.dir)}\input\manifest.json</div><pre>${esc(j.prompt || "素材准备中")}</pre></details></section>`;
  }
  function render() {
    if (!page || page.hidden) return;
    position();
    page.innerHTML = `<header class="mp-header"><div><span class="mp-eyebrow">AI HUB / MEMORY</span><h1>记忆</h1></div><div class="mp-actions"><span class="mp-muted">${esc(data?.project.label || "当前 session")}</span>${button("刷新", "refresh")}${button("关闭", "close")}</div></header><nav class="mp-tabs" role="tablist">${[
      ["context", "当前上下文"],
      ["library", "记忆文件库"],
      ["dream", "造梦"],
    ]
      .map(
        ([id, name]) =>
          `<button role="tab" aria-selected="${tab === id}" class="mp-tab ${tab === id ? "active" : ""}" data-tab="${id}">${name}</button>`,
      )
      .join(
        "",
      )}</nav><div class="mp-content" role="tabpanel">${error ? `<div class="mp-error" role="alert">${esc(error)}</div>` : ""}${data ? { context, library, dream }[tab]() : `<div class="mp-empty">${sid ? "正在读取当前 session…" : "请先打开一个 session。群聊可点击成员头像进入对应 session，再查看当前上下文。"}</div>`}</div>`;
  }
  async function action(b) {
    if (b.dataset.tab) {
      tab = b.dataset.tab;
      return render();
    }
    if (b.dataset.file) return read(b.dataset.file);
    if (b.dataset.receipt !== undefined) {
      const r = data.receipts[+b.dataset.receipt];
      file = r.path;
      preview = r.content;
      return render();
    }
    if (b.dataset.jobSession) {
      close();
      return openSession(b.dataset.jobSession);
    }
    if (b.dataset.sourcePreview) {
      const r = await ipcRenderer.invoke("get-session-search-preview", {
        sessionKey: b.dataset.sourcePreview,
      });
      sourcePreview =
        (r?.context || [])
          .map((x) => `${x.role || x.scope}\n${x.text || ""}`)
          .join("\n\n") ||
        r?.error ||
        "暂无预览";
      return render();
    }
    if (b.dataset.finalize) {
      await call("finalize-dream", { jobId: b.dataset.finalize });
      return refresh();
    }
    if (b.dataset.abandon) {
      await call("abandon-dream", { jobId: b.dataset.abandon });
      return refresh();
    }
    switch (b.dataset.actionMp) {
      case "close":
        return close();
      case "refresh":
        if (tab === "dream") {
          const status = await ipcRenderer.invoke("refresh-session-search", {
            immediate: true,
          });
          if (!status || status.phase === "error" || status.lastError)
            throw new Error(status?.lastError || "历史索引刷新失败");
        }
        return refresh();
      case "folder":
        if (file) await ipcRenderer.invoke("show-in-folder", file);
        return;
      case "scan":
        ({ files: scanned, note: scanNote } = await call("scan", { sessionId: sid }));
        return render();
      case "dream":
      case "library":
        tab = b.dataset.actionMp;
        return render();
      case "start":
        busy = true;
        error = "";
        render();
        try {
          model = page.querySelector("#mp-model").value;
          effort = page.querySelector("#mp-effort")?.value || "";
          if (!model || (tuning().showEffort && !effort))
            throw new Error("请选择可用的模型和思考深度");
          const opts = window.WorkspaceController?.buildSessionTuningOpts(
            kind,
            model,
            { effort },
          ) || { model, effort };
          if (opts.model !== model || (opts.effort && opts.effort !== effort))
            throw new Error("模型或思考档已变化，请重新选择");
          localStorage.setItem(
            "hubDreamSelection",
            JSON.stringify({ kind, model, effort }),
          );
          await call("start-dream", {
            sessionId: sid,
            keys: [...selected],
            kind,
            opts,
          });
          await refresh();
        } finally {
          busy = false;
          render();
        }
        return;
    }
  }
  function build() {
    if (page) return;
    page = document.createElement("section");
    page.id = "memory-page";
    page.className = "mp-overlay";
    page.hidden = true;
    page.setAttribute("aria-label", "记忆");
    document.body.appendChild(page);
    page.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (b) void action(b).catch(fail);
    });
    page.addEventListener("change", (e) => {
      const el = e.target;
      if (el.dataset.source) {
        el.checked
          ? selected.add(el.dataset.source)
          : selected.delete(el.dataset.source);
        render();
      }
      if (el.id === "mp-kind") {
        kind = el.value;
        model =
          DEFAULT_MODEL_BY_KIND[kind] || modelOptionsFor(kind)[0]?.id || "";
        render();
        void catalog().catch(fail);
      }
      if (el.id === "mp-model") {
        model = el.value;
        render();
      }
      if (el.id === "mp-effort") effort = el.value;
    });
    page.addEventListener("input", (e) => {
      if (e.target.id === "mp-search") {
        const n = e.target.selectionStart;
        query = e.target.value;
        render();
        const i = page.querySelector("#mp-search");
        i.focus();
        i.setSelectionRange(n, n);
      }
    });
  }
  async function open() {
    build();
    page.hidden = false;
    document.body.classList.add("memory-open");
    document
      .getElementById("btn-rail-memory")
      ?.setAttribute("aria-expanded", "true");
    tab = "context";
    render();
    clearInterval(timer);
    timer = setInterval(() => {
      if (getActiveSessionInfo()?.id !== sid) void refresh().catch(fail);
    }, 800);
    await Promise.all([refresh(), catalog()]);
  }
  function close() {
    if (!page) return;
    page.hidden = true;
    epoch++;
    clearInterval(timer);
    document.body.classList.remove("memory-open");
    document
      .getElementById("btn-rail-memory")
      ?.setAttribute("aria-expanded", "false");
  }
  document.addEventListener("click", (e) => {
    if (e.target.closest('[data-action="open-memory"]')) {
      if (page && !page.hidden) close();
      else void open().catch(fail);
    } else if (e.target.closest("#scene-rail button") && page && !page.hidden)
      close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  window.addEventListener("resize", position);
  ipcRenderer.on("memory:changed", () => {
    if (page && !page.hidden) void refresh().catch(fail);
  });
  ipcRenderer.on("session-updated", (_event, { session } = {}) => {
    if (!page || page.hidden || !session) return;
    const job = data?.jobs.find(
      (j) =>
        j.sessionId === session.id && !["done", "failed"].includes(j.status),
    );
    if (job && job.runtimeState !== (session.nativeRuntime?.state || null))
      void refresh().catch(fail);
  });
  return { open, close };
}
module.exports = { createMemoryPanel };
