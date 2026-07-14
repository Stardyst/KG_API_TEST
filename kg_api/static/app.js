const state = {
  eventTypes: [],
  fields: [],
  lastQuery: null,
  lastResult: null,
  lastResultKind: "query",
};

const $ = (id) => document.getElementById(id);

async function apiPost(path, body = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok || data["错误"]) {
    throw new Error(data["错误信息"] || "请求失败");
  }
  return data;
}

async function loadInitialData() {
  const health = await fetch("/api/健康检查").then((r) => r.json());
  $("statusText").textContent = `数据已加载：${health["事件类型数"]} 类事件，${health["节点数"]} 个节点，${health["关系数"]} 条关系`;

  const data = await apiPost("/api/事件类型列表");
  state.eventTypes = data["事件类型列表"];
  const select = $("eventTypeSelect");
  select.innerHTML = state.eventTypes.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
  select.addEventListener("change", onEventTypeChange);
  await onEventTypeChange();
}

async function onEventTypeChange() {
  const eventType = $("eventTypeSelect").value;
  const data = await apiPost("/api/可筛选字段", { "事件类型": eventType });
  state.fields = data["可筛选字段"];
  renderFieldList();
  $("filterRows").innerHTML = "";
  addFilterRow();
  await queryGraph();
}

function renderFieldList() {
  $("fieldList").innerHTML = state.fields.map((field) => `<span class="tag">${escapeHtml(field)}</span>`).join("");
}

function addFilterRow() {
  const container = $("filterRows");
  const row = document.createElement("div");
  row.className = "filter-row";
  row.innerHTML = `
    <select class="filter-field">
      ${state.fields.map((field) => `<option value="${escapeHtml(field)}">${escapeHtml(field)}</option>`).join("")}
    </select>
    <div class="filter-row-actions">
      <div class="filter-value-control">
        <input class="filter-value" autocomplete="off" placeholder="输入筛选值，支持包含匹配" />
        <div class="filter-candidate-menu" role="listbox" hidden></div>
      </div>
      <button type="button" class="remove-filter">删除</button>
    </div>
  `;
  const fieldSelect = row.querySelector(".filter-field");
  const valueInput = row.querySelector(".filter-value");
  fieldSelect.addEventListener("change", async () => {
    valueInput.value = "";
    await refreshCandidatesForRow(row);
  });
  valueInput.addEventListener("focus", () => showCandidateMenu(row));
  valueInput.addEventListener("input", () => showCandidateMenu(row));
  valueInput.addEventListener("keydown", (event) => handleCandidateKeydown(event, row));
  row.querySelector(".filter-candidate-menu").addEventListener("mousedown", (event) => {
    const option = event.target.closest(".filter-candidate-option");
    if (!option) return;
    event.preventDefault();
    valueInput.value = option.dataset.value || "";
    hideCandidateMenu(row);
  });
  row.querySelector(".remove-filter").addEventListener("click", () => {
    row.remove();
  });
  container.appendChild(row);
  if (state.fields[0]) {
    refreshCandidatesForRow(row);
  }
}

async function refreshCandidatesForRow(row, options = {}) {
  const field = row.querySelector(".filter-field")?.value;
  const valueInput = row.querySelector(".filter-value");
  if (!field) {
    renderCandidatesForRow(row, []);
    return;
  }
  if (!options.force && row.dataset.loadedCandidateField === field) {
    return;
  }
  const requestToken = `${Date.now()}-${Math.random()}`;
  row.dataset.candidateRequestToken = requestToken;
  row.dataset.loadingCandidateField = field;
  row.candidateValues = [];
  if (valueInput) {
    valueInput.placeholder = "正在加载候选值";
  }
  renderCandidatesForRow(row, []);
  await loadCandidates(field, row, requestToken);
}

async function loadCandidates(field, row, requestToken) {
  const eventType = $("eventTypeSelect").value;
  try {
    const data = await apiPost("/api/字段候选值", { "事件类型": eventType, "字段": field });
    if (!isLatestCandidateRequest(row, requestToken, eventType)) return;
    renderCandidatesForRow(row, data["候选值"].slice(0, 80));
    row.dataset.loadedCandidateField = field;
  } catch {
    if (!isLatestCandidateRequest(row, requestToken, eventType)) return;
    renderCandidatesForRow(row, []);
  } finally {
    if (row.dataset.candidateRequestToken === requestToken) {
      row.dataset.loadingCandidateField = "";
      const valueInput = row.querySelector(".filter-value");
      if (valueInput) valueInput.placeholder = "输入筛选值，支持包含匹配";
    }
  }
}

function isLatestCandidateRequest(row, requestToken, eventType) {
  return row.isConnected && row.dataset.candidateRequestToken === requestToken && $("eventTypeSelect").value === eventType;
}

function renderCandidatesForRow(row, values) {
  const menu = row.querySelector(".filter-candidate-menu");
  const input = row.querySelector(".filter-value");
  if (!menu || !input) return;
  row.candidateValues = values;
  const keyword = input.value.trim().toLowerCase();
  const visibleValues = values.filter((item) => String(item["值"]).toLowerCase().includes(keyword));
  menu.innerHTML = visibleValues
    .map(
      (item) => `
        <button type="button" class="filter-candidate-option" role="option" data-value="${escapeHtml(item["值"])}">
          <span>${escapeHtml(item["值"])}</span>
          <span class="filter-candidate-count">${escapeHtml(String(item["命中次数"]))}</span>
        </button>
      `
    )
    .join("");
  if (!visibleValues.length) menu.hidden = true;
}

function showCandidateMenu(row) {
  renderCandidatesForRow(row, row.candidateValues || []);
  const menu = row.querySelector(".filter-candidate-menu");
  if (menu?.children.length) menu.hidden = false;
}

function hideCandidateMenu(row) {
  const menu = row.querySelector(".filter-candidate-menu");
  if (menu) menu.hidden = true;
}

function handleCandidateKeydown(event, row) {
  const menu = row.querySelector(".filter-candidate-menu");
  const options = Array.from(menu?.querySelectorAll(".filter-candidate-option") || []);
  if (event.key === "Escape") {
    hideCandidateMenu(row);
    return;
  }
  if (event.key === "Enter" && !menu?.hidden && options.length) {
    event.preventDefault();
    row.querySelector(".filter-value").value = options[0].dataset.value || "";
    hideCandidateMenu(row);
  }
}

function collectFilters() {
  const filters = {};
  document.querySelectorAll(".filter-row").forEach((row) => {
    const field = row.querySelector(".filter-field").value;
    const value = row.querySelector(".filter-value").value.trim();
    if (!field || !value) {
      return;
    }
    if (filters[field]) {
      filters[field] = Array.isArray(filters[field]) ? filters[field].concat(value) : [filters[field], value];
    } else {
      filters[field] = value;
    }
  });
  return filters;
}

async function queryGraph() {
  const query = {
    "事件类型": $("eventTypeSelect").value,
    "筛选条件": collectFilters(),
  };
  state.lastQuery = query;
  setBusy(true);
  try {
    const result = await apiPost("/api/知识图谱查询", query);
    state.lastResult = result;
    state.lastResultKind = "query";
    renderResult(result);
  } catch (error) {
    alert(error.message);
  } finally {
    setBusy(false);
  }
}

function renderResult(result) {
  $("metricEvents").textContent = result["命中事件数"];
  $("metricNodes").textContent = result["节点数"];
  $("metricLinks").textContent = result["关系数"];
  $("metricType").textContent = result["事件类型"];
  $("jsonPreview").textContent = JSON.stringify(buildJsonPreview(result), null, 2);
  renderEvents(result["命中事件列表"] || []);
  renderGraph(result);
}

function buildJsonPreview(result) {
  const preview = { ...result };
  const maxNodes = 120;
  const maxLinks = 220;
  const maxEntries = 200;
  if (Array.isArray(result.staticNodes) && result.staticNodes.length > maxNodes) {
    preview.staticNodes = result.staticNodes.slice(0, maxNodes);
    preview["JSON预览说明"] = `页面仅预览前 ${maxNodes} 个节点、前 ${maxLinks} 条关系；下载 JSON 仍包含完整数据。`;
  }
  if (Array.isArray(result.staticLinks) && result.staticLinks.length > maxLinks) {
    preview.staticLinks = result.staticLinks.slice(0, maxLinks);
    preview["JSON预览说明"] = preview["JSON预览说明"] || `页面仅预览前 ${maxNodes} 个节点、前 ${maxLinks} 条关系；下载 JSON 仍包含完整数据。`;
  }
  if (Array.isArray(result["黑名单条目"]) && result["黑名单条目"].length > maxEntries) {
    preview["黑名单条目"] = result["黑名单条目"].slice(0, maxEntries);
    preview["黑名单预览说明"] = `页面仅预览前 ${maxEntries} 条黑名单；导出 JSON 仍包含完整条目。`;
  }
  return preview;
}

async function showBlacklistGraph() {
  setBusy(true);
  try {
    const result = await fetch("/api/黑名单图谱").then((response) => response.json());
    state.lastResult = result;
    state.lastResultKind = "blacklist";
    state.lastQuery = null;
    renderResult(result);
    activateTab("graph");
  } catch (error) {
    alert(error.message || "黑名单图谱加载失败");
  } finally {
    setBusy(false);
  }
}

function renderEvents(events) {
  const list = $("eventList");
  if (!events.length) {
    list.innerHTML = '<div class="empty">没有命中事件。</div>';
    return;
  }
  list.innerHTML = events
    .slice(0, 200)
    .map(
      (event) => `
        <article class="event-item">
          <div class="event-title">
            <span>${escapeHtml(event["本地任务ID"] || event["事件ID"])}</span>
            <span>${escapeHtml(event["原始文件"] || "")}</span>
          </div>
          <p>${escapeHtml(event["原文摘要"] || "")}</p>
        </article>
      `
    )
    .join("");
}

function renderGraph(result) {
  const canvas = $("graphCanvas");
  const detail = ensureGraphDetail();
  detail.hidden = true;

  if (!window.KgNvlPreview) {
    canvas.innerHTML = '<div class="empty">图谱预览库未加载。</div>';
    return;
  }

  const preview = window.KgNvlPreview.render(canvas, result, {
    maxNodes: canvas.clientWidth < 620 ? 160 : 240,
    maxLinks: canvas.clientWidth < 620 ? 260 : 420,
    onNodeSelect: (node, degree) => showGraphDetail(detail, { ...node, degree }),
  });
  const info = ensureGraphInfo();
  info.textContent = `NVL 图谱预览：${preview.nodes.length} 个节点、${preview.links.length} 条关系。滚轮缩放，拖动画布，点击节点查看详情。`;
}

function buildPreviewGraph(result, maxNodes, maxLinks) {
  const allNodes = result.staticNodes || [];
  const allLinks = result.staticLinks || [];
  const nodeById = new Map(allNodes.map((node) => [node.id, node]));
  const degree = new Map();
  allLinks.forEach((link) => {
    degree.set(link.source, (degree.get(link.source) || 0) + 1);
    degree.set(link.target, (degree.get(link.target) || 0) + 1);
  });

  const ranked = allNodes
    .map((node, index) => ({
      ...node,
      degree: degree.get(node.id) || 0,
      originalIndex: index,
      nodeClass: (node.labels || [])[0] || node.ontName || "Entity",
    }))
    .sort((a, b) => nodeRank(b) - nodeRank(a) || a.originalIndex - b.originalIndex)
    .slice(0, maxNodes);

  const selected = new Set(ranked.map((node) => node.id));
  const links = allLinks
    .filter((link) => selected.has(link.source) && selected.has(link.target))
    .sort((a, b) => linkRank(b, degree) - linkRank(a, degree))
    .slice(0, maxLinks);

  return {
    nodes: ranked.map((node) => ({
      ...node,
      r: radiusForNode(node),
    })),
    links,
    nodeById,
  };
}

function nodeRank(node) {
  const labels = node.labels || [];
  const base = labels.includes("EventType") ? 10000 : labels.includes("Event") ? 5000 : 0;
  return base + (node.degree || 0) * 20;
}

function linkRank(link, degree) {
  const relationWeight = link.type === "BELONGS_TO" ? 1000 : link.type === "HAS_ENTITY" ? 500 : 0;
  return relationWeight + (degree.get(link.source) || 0) + (degree.get(link.target) || 0);
}

function radiusForNode(node) {
  const labels = node.labels || [];
  if (labels.includes("EventType")) return 24;
  if (labels.includes("Event")) return 16;
  return Math.min(15, 8 + Math.sqrt(node.degree || 0) * 1.8);
}

function runForceLayout(nodes, links, width, height) {
  const centerX = width / 2;
  const centerY = height / 2;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const spread = Math.min(width, height) * 0.34;

  nodes.forEach((node, index) => {
    const angle = (index / nodes.length) * Math.PI * 2;
    const isEvent = (node.labels || []).includes("Event") || (node.labels || []).includes("EventType");
    const baseRadius = isEvent ? spread * 0.25 : spread * (0.55 + ((index % 7) / 16));
    node.x = centerX + Math.cos(angle) * baseRadius;
    node.y = centerY + Math.sin(angle) * baseRadius;
    node.vx = 0;
    node.vy = 0;
  });

  for (let tick = 0; tick < 260; tick += 1) {
    const alpha = 1 - tick / 260;
    for (let i = 0; i < nodes.length; i += 1) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j += 1) {
        const b = nodes[j];
        const dx = a.x - b.x || 0.01;
        const dy = a.y - b.y || 0.01;
        const distanceSq = dx * dx + dy * dy;
        const force = Math.min(6.5, 780 / distanceSq) * alpha;
        const distance = Math.sqrt(distanceSq);
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }

    links.forEach((link) => {
      const source = nodeById.get(link.source);
      const target = nodeById.get(link.target);
      if (!source || !target) return;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.sqrt(dx * dx + dy * dy) || 1;
      const ideal = link.type === "BELONGS_TO" ? 90 : link.type === "HAS_ENTITY" ? 120 : 160;
      const force = (distance - ideal) * 0.018 * alpha;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      source.vx += fx;
      source.vy += fy;
      target.vx -= fx;
      target.vy -= fy;
    });

    nodes.forEach((node) => {
      const isEventType = (node.labels || []).includes("EventType");
      const targetX = centerX;
      const targetY = centerY;
      const gravity = isEventType ? 0.06 : 0.012;
      node.vx += (targetX - node.x) * gravity * alpha;
      node.vy += (targetY - node.y) * gravity * alpha;
      node.vx *= 0.78;
      node.vy *= 0.78;
      node.x = clamp(node.x + node.vx, 48, width - 48);
      node.y = clamp(node.y + node.vy, 66, height - 48);
    });
  }
}

function importantLabels(nodes, width) {
  const limit = width < 600 ? 8 : nodes.length > 180 ? 26 : 48;
  return nodes
    .filter((node) => (node.labels || []).includes("EventType") || (node.labels || []).includes("Event") || node.degree >= 4)
    .sort((a, b) => nodeRank(b) - nodeRank(a))
    .slice(0, limit);
}

function ensureGraphDetail() {
  let detail = $("graphDetail");
  if (!detail) {
    detail = document.createElement("aside");
    detail.id = "graphDetail";
    detail.className = "graph-detail";
    $("graphView").appendChild(detail);
  }
  return detail;
}

function ensureGraphInfo() {
  let info = $("graphInfo");
  if (!info) {
    info = document.createElement("div");
    info.id = "graphInfo";
    info.className = "graph-info";
    $("graphView").appendChild(info);
  }
  return info;
}

function showGraphDetail(detail, node) {
  detail.hidden = false;
  detail.innerHTML = `
    <div class="graph-detail-title">${escapeHtml(node.name || "节点")}</div>
    <dl>
      <dt>类型</dt><dd>${escapeHtml(node.ontName || "-")}</dd>
      <dt>连接数</dt><dd>${escapeHtml(String(node.degree || 0))}</dd>
      <dt>ID</dt><dd>${escapeHtml(node.id || "-")}</dd>
    </dl>
  `;
}

function enableGraphPanZoom(svg, root) {
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  let dragStart = null;
  const apply = () => root.setAttribute("transform", `translate(${offsetX},${offsetY}) scale(${scale})`);

  svg.addEventListener("wheel", (event) => {
    event.preventDefault();
    const delta = event.deltaY > 0 ? 0.9 : 1.1;
    scale = clamp(scale * delta, 0.45, 2.8);
    apply();
  });

  svg.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".graph-node")) return;
    dragStart = { x: event.clientX, y: event.clientY, offsetX, offsetY };
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener("pointermove", (event) => {
    if (!dragStart) return;
    offsetX = dragStart.offsetX + event.clientX - dragStart.x;
    offsetY = dragStart.offsetY + event.clientY - dragStart.y;
    apply();
  });
  svg.addEventListener("pointerup", () => {
    dragStart = null;
  });
}

function startNodeDrag(event, node, group, linkLayer, nodeById) {
  event.preventDefault();
  event.stopPropagation();
  const start = { x: event.clientX, y: event.clientY, nodeX: node.x, nodeY: node.y };
  group.setPointerCapture(event.pointerId);
  const move = (moveEvent) => {
    node.x = start.nodeX + moveEvent.clientX - start.x;
    node.y = start.nodeY + moveEvent.clientY - start.y;
    group.setAttribute("transform", `translate(${node.x},${node.y})`);
    Array.from(linkLayer.children).forEach((line) => {
      const source = nodeById.get(line.__dataSource);
      const target = nodeById.get(line.__dataTarget);
      if (!source || !target) return;
      line.setAttribute("x1", source.x);
      line.setAttribute("y1", source.y);
      line.setAttribute("x2", target.x);
      line.setAttribute("y2", target.y);
    });
  };
  const up = () => {
    group.removeEventListener("pointermove", move);
    group.removeEventListener("pointerup", up);
  };
  group.addEventListener("pointermove", move);
  group.addEventListener("pointerup", up);
}

function svgEl(tag, attrs = {}, text = "") {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
  if (text) el.textContent = text;
  return el;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function colorForOntName(name) {
  if (name === "Event") return "#2563eb";
  if (name === "EventType") return "#0e7490";
  if (name && name.includes("位置")) return "#16a34a";
  if (name && name.includes("时间")) return "#d97706";
  if (name && name.includes("人员")) return "#7c3aed";
  if (name && name.includes("船")) return "#0284c7";
  return "#475569";
}

async function downloadJson() {
  if (state.lastResultKind === "blacklist" && state.lastResult) {
    saveJsonBlob(state.lastResult, "违法船舶黑名单.json");
    return;
  }
  if (!state.lastQuery) {
    await queryGraph();
  }
  const response = await fetch("/api/知识图谱下载", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state.lastQuery),
  });
  const blob = await response.blob();
  saveBlob(blob, `${state.lastQuery["事件类型"]}_查询结果.json`);
}

async function downloadFullGraph() {
  await downloadWithProgress("/api/全量知识图谱下载", "完整知识图谱.json");
}

async function downloadBlacklist() {
  await downloadWithProgress("/api/黑名单下载", "违法船舶黑名单.json");
}

async function downloadWithProgress(url, filename) {
  setExportProgress(0, "准备导出");
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("导出失败");
  }
  const total = Number(response.headers.get("Content-Length") || 0);
  if (!response.body) {
    const blob = await response.blob();
    saveBlob(blob, filename);
    setExportProgress(100, "导出完成");
    return;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) {
      setExportProgress((received / total) * 100, `${formatBytes(received)} / ${formatBytes(total)}`);
    } else {
      setExportProgress(0, `已接收 ${formatBytes(received)}`);
    }
  }
  saveBlob(new Blob(chunks, { type: "application/json;charset=utf-8" }), filename);
  setExportProgress(100, "导出完成");
}

function setExportProgress(percent, text) {
  const progress = $("exportProgress");
  const bar = $("exportProgressBar");
  const label = $("exportProgressText");
  progress.hidden = false;
  bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  label.textContent = text;
}

function saveJsonBlob(data, filename) {
  saveBlob(new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }), filename);
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function setBusy(isBusy) {
  $("queryButton").disabled = isBusy;
  $("downloadButton").disabled = isBusy;
  $("fullExportButton").disabled = isBusy;
  $("blacklistButton").disabled = isBusy;
  $("blacklistDownloadButton").disabled = isBusy;
  $("queryButton").textContent = isBusy ? "查询中" : "查询图谱";
}

function truncate(value, length) {
  return value.length > length ? `${value.slice(0, length)}...` : value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeSvg(value) {
  return escapeHtml(value).replaceAll("'", "&apos;");
}

function activateTab(tabName) {
  document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item.dataset.tab === tabName));
  document.querySelectorAll(".tab-view").forEach((item) => item.classList.remove("active"));
  $(`${tabName}View`).classList.add("active");
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
});

$("addFilterButton").addEventListener("click", addFilterRow);
$("queryButton").addEventListener("click", queryGraph);
$("downloadButton").addEventListener("click", downloadJson);
$("fullExportButton").addEventListener("click", () => {
  downloadFullGraph().catch((error) => alert(error.message));
});
$("blacklistButton").addEventListener("click", showBlacklistGraph);
$("blacklistDownloadButton").addEventListener("click", () => {
  downloadBlacklist().catch((error) => alert(error.message));
});
$("resetButton").addEventListener("click", async () => {
  $("filterRows").innerHTML = "";
  addFilterRow();
  await queryGraph();
});
document.addEventListener("click", (event) => {
  document.querySelectorAll(".filter-row").forEach((row) => {
    if (!row.contains(event.target)) hideCandidateMenu(row);
  });
});

loadInitialData().catch((error) => {
  $("statusText").textContent = error.message;
});
