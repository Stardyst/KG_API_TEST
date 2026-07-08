import { NVL } from "@neo4j-nvl/base";

let currentNvl = null;
let currentDisposers = [];
let currentContainer = null;
let currentPreview = null;

const COLLISION_PADDING = 12;
const COLLISION_STRENGTH = 0.72;
const COLLISION_MAX_AFFECTED = 40;

function render(container, graph, options = {}) {
  destroy();
  container.replaceChildren();

  const preview = buildPreviewGraph(graph, options.maxNodes || 320, options.maxLinks || 620);
  if (!preview.nodes.length) {
    container.innerHTML = '<div class="empty">没有可预览的图谱节点。</div>';
    return { nodes: [], links: [] };
  }

  const nvlNodes = preview.nodes.map((node) => ({
    id: node.id,
    caption: node.caption,
    captionSize: node.caption ? 12 : 0,
    size: node.size,
    color: colorForNode(node),
    raw: node.raw,
  }));

  const nvlRelationships = preview.links.map((link) => ({
    id: link.id,
    from: link.source,
    to: link.target,
    type: link.label,
    caption: "",
    color: "#ccd6e3",
    width: 1.25,
    raw: link.raw,
  }));

  currentNvl = new NVL(
    container,
    nvlNodes,
    nvlRelationships,
    {
      renderer: "canvas",
      layout: "forceDirected",
      initialZoom: 0.8,
      minZoom: 0.08,
      maxZoom: 4,
      allowDynamicMinZoom: true,
      layoutTimeLimit: 2400,
      disableTelemetry: true,
      disableWebWorkers: true,
      relationshipThreshold: 0.55,
      layoutOptions: {
        enableCytoscape: true,
      },
    },
    {
      onLayoutDone: () => {
        try {
          currentNvl?.fit(nvlNodes.map((node) => node.id), { animated: true, maxZoom: 1.15 });
        } catch {
          // Fit is visual sugar only; graph rendering already succeeded.
        }
      },
      onError: (error) => {
        console.error(error);
      },
    }
  );
  currentContainer = container;
  currentPreview = preview;

  bindInteractions(container, preview, options);

  return { nodes: preview.nodes, links: preview.links };
}

function destroy() {
  currentDisposers.forEach((dispose) => dispose());
  currentDisposers = [];
  if (currentNvl) {
    currentNvl.destroy();
    currentNvl = null;
  }
  currentContainer = null;
  currentPreview = null;
}

function bindInteractions(container, preview, options) {
  let interaction = null;
  let lastPointer = null;

  const onWheel = (event) => {
    if (!currentNvl) return;
    event.preventDefault();
    const rect = container.getBoundingClientRect();
    const oldZoom = currentNvl.getScale();
    const pan = currentNvl.getPan();
    const delta = event.deltaY > 0 ? 0.88 : 1.14;
    const newZoom = clamp(oldZoom * delta, 0.08, 4);
    const pointerGraphX = pan.x + (event.clientX - rect.left - rect.width / 2) / oldZoom;
    const pointerGraphY = pan.y + (event.clientY - rect.top - rect.height / 2) / oldZoom;
    const nextPanX = pointerGraphX - (event.clientX - rect.left - rect.width / 2) / newZoom;
    const nextPanY = pointerGraphY - (event.clientY - rect.top - rect.height / 2) / newZoom;
    currentNvl.setZoomAndPan(newZoom, nextPanX, nextPanY);
  };

  const onPointerDown = (event) => {
    if (!currentNvl || event.button !== 0) return;
    const nodeHit = getNodeHit(event);
    lastPointer = { x: event.clientX, y: event.clientY };
    if (nodeHit) {
      const nodeId = nodeHit.data?.id;
      const nodePosition = currentNvl.getNodePositions().find((node) => node.id === nodeId);
      if (!nodeId || !nodePosition) return;
      currentNvl.pinNode(nodeId);
      interaction = {
        type: "node",
        nodeId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startX: nodePosition.x,
        startY: nodePosition.y,
        moved: false,
      };
    } else {
      const pan = currentNvl.getPan();
      interaction = {
        type: "canvas",
        startClientX: event.clientX,
        startClientY: event.clientY,
        startPanX: pan.x,
        startPanY: pan.y,
      };
    }
    container.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event) => {
    if (!currentNvl || !interaction || !lastPointer) return;
    event.preventDefault();
    const zoom = currentNvl.getScale();
    const dx = event.clientX - interaction.startClientX;
    const dy = event.clientY - interaction.startClientY;
    if (interaction.type === "node") {
      interaction.moved = interaction.moved || Math.hypot(dx, dy) > 3;
      const targetPosition = {
        id: interaction.nodeId,
        x: interaction.startX + dx / zoom,
        y: interaction.startY + dy / zoom,
        pinned: true,
      };
      currentNvl.setNodePositions(
        [targetPosition, ...resolveDraggedNodeCollisions(interaction.nodeId, targetPosition, preview)],
        false
      );
    } else {
      currentNvl.setPan(interaction.startPanX - dx / zoom, interaction.startPanY - dy / zoom);
    }
    lastPointer = { x: event.clientX, y: event.clientY };
  };

  const onPointerUp = (event) => {
    if (!currentNvl || !interaction) return;
    if (interaction.type === "node" && !interaction.moved) {
      selectNodeByEvent(event, preview, options);
    }
    interaction = null;
    lastPointer = null;
    container.releasePointerCapture?.(event.pointerId);
  };

  const onClick = (event) => {
    if (!interaction) selectNodeByEvent(event, preview, options);
  };

  container.addEventListener("wheel", onWheel, { passive: false });
  container.addEventListener("pointerdown", onPointerDown);
  container.addEventListener("pointermove", onPointerMove);
  container.addEventListener("pointerup", onPointerUp);
  container.addEventListener("pointercancel", onPointerUp);
  container.addEventListener("click", onClick);
  currentDisposers.push(() => {
    container.removeEventListener("wheel", onWheel);
    container.removeEventListener("pointerdown", onPointerDown);
    container.removeEventListener("pointermove", onPointerMove);
    container.removeEventListener("pointerup", onPointerUp);
    container.removeEventListener("pointercancel", onPointerUp);
    container.removeEventListener("click", onClick);
  });
}

function selectNodeByEvent(event, preview, options) {
  const nodeHit = getNodeHit(event);
  const nodeId = nodeHit?.data?.id;
  if (!nodeId) return;
  const node = preview.nodeById.get(nodeId);
  if (node && options.onNodeSelect) options.onNodeSelect(node.raw, node.degree);
}

function getNodeHit(event) {
  if (!currentNvl) return null;
  const hitEvent = currentNvl.getHits(event, ["node"], { hitNodeMarginWidth: 14 });
  return hitEvent?.nvlTargets?.nodes?.[0] || null;
}

function resolveDraggedNodeCollisions(draggedNodeId, draggedPosition, preview) {
  if (!currentNvl) return [];
  const positions = currentNvl.getNodePositions();
  const draggedNode = preview.nodeById.get(draggedNodeId);
  const draggedRadius = collisionRadiusForNode(draggedNode);
  return positions
    .filter((position) => position.id !== draggedNodeId)
    .map((position) => {
      const node = preview.nodeById.get(position.id);
      const radius = collisionRadiusForNode(node);
      const dx = position.x - draggedPosition.x;
      const dy = position.y - draggedPosition.y;
      const distance = Math.hypot(dx, dy);
      const minDistance = draggedRadius + radius + COLLISION_PADDING;
      if (distance >= minDistance) return null;
      const direction = distance > 0.001 ? { x: dx / distance, y: dy / distance } : fallbackDirection(position.id);
      const push = (minDistance - distance) * COLLISION_STRENGTH;
      return {
        id: position.id,
        x: position.x + direction.x * push,
        y: position.y + direction.y * push,
        pinned: true,
        distance,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, COLLISION_MAX_AFFECTED)
    .map(({ distance, ...position }) => position);
}

function collisionRadiusForNode(node) {
  return Math.max(12, (node?.size || 18) * 0.62);
}

function fallbackDirection(id) {
  let hash = 0;
  for (const char of String(id || "")) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  const angle = (hash / 0xffffffff) * Math.PI * 2;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

function debug() {
  if (!currentNvl || !currentContainer || !currentPreview) return null;
  const rect = currentContainer.getBoundingClientRect();
  const positions = currentNvl.getNodePositions().map((position) => {
    const node = currentPreview.nodeById.get(position.id);
    return {
      id: position.id,
      x: position.x,
      y: position.y,
      size: node?.size || 18,
      radius: collisionRadiusForNode(node),
    };
  });
  return {
    zoom: currentNvl.getScale(),
    pan: currentNvl.getPan(),
    rect: {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    },
    positions,
  };
}

function buildPreviewGraph(result, maxNodes, maxLinks) {
  const allNodes = result.staticNodes || [];
  const allLinks = result.staticLinks || [];
  const degree = new Map();
  allLinks.forEach((link) => {
    degree.set(link.source, (degree.get(link.source) || 0) + 1);
    degree.set(link.target, (degree.get(link.target) || 0) + 1);
  });

  const ranked = allNodes
    .map((node, index) => ({
      id: node.id,
      raw: node,
      degree: degree.get(node.id) || 0,
      originalIndex: index,
      labels: node.labels || [],
      ontName: node.ontName || "",
      name: node.name || "",
    }))
    .sort((a, b) => nodeRank(b) - nodeRank(a) || a.originalIndex - b.originalIndex)
    .slice(0, maxNodes);

  const selected = new Set(ranked.map((node) => node.id));
  const visibleLinks = allLinks
    .filter((link) => selected.has(link.source) && selected.has(link.target))
    .sort((a, b) => linkRank(b, degree) - linkRank(a, degree))
    .slice(0, maxLinks);

  const linkDegree = new Map();
  visibleLinks.forEach((link) => {
    linkDegree.set(link.source, (linkDegree.get(link.source) || 0) + 1);
    linkDegree.set(link.target, (linkDegree.get(link.target) || 0) + 1);
  });

  const labelLimit = window.innerWidth < 620 ? 8 : ranked.length > 220 ? 34 : 70;
  const labeledIds = new Set(
    ranked
      .filter((node) => isEventType(node) || isEvent(node) || (linkDegree.get(node.id) || 0) >= 3)
      .sort((a, b) => nodeRank(b) - nodeRank(a))
      .slice(0, labelLimit)
      .map((node) => node.id)
  );

  const nodes = ranked.map((node) => ({
    ...node,
    degree: linkDegree.get(node.id) || node.degree,
    size: sizeForNode(node, linkDegree.get(node.id) || node.degree),
    caption: labeledIds.has(node.id) ? shortCaption(node.name || node.ontName || "节点") : "",
  }));

  return {
    nodes,
    links: visibleLinks.map((link) => ({ ...link, raw: link })),
    nodeById: new Map(nodes.map((node) => [node.id, node])),
  };
}

function nodeRank(node) {
  const base = isEventType(node) ? 10000 : isEvent(node) ? 5200 : 0;
  return base + (node.degree || 0) * 25;
}

function linkRank(link, degree) {
  const relationWeight = link.type === "BELONGS_TO" ? 1000 : link.type === "HAS_ENTITY" ? 500 : 0;
  return relationWeight + (degree.get(link.source) || 0) + (degree.get(link.target) || 0);
}

function isEventType(node) {
  return (node.labels || []).includes("EventType") || node.ontName === "EventType";
}

function isEvent(node) {
  return (node.labels || []).includes("Event") || node.ontName === "Event";
}

function sizeForNode(node, degree) {
  if (isEventType(node)) return 46;
  if (isEvent(node)) return Math.min(34, 22 + Math.sqrt(degree || 0) * 2.2);
  return Math.min(27, 15 + Math.sqrt(degree || 0) * 2.4);
}

function colorForNode(node) {
  const name = node.ontName || "";
  if (isEventType(node)) return "#2f80ed";
  if (isEvent(node)) return "#0ea5c6";
  if (name.includes("位置")) return "#13aa52";
  if (name.includes("时间")) return "#dd7900";
  if (name.includes("人员") || name.includes("主体")) return "#7c3aed";
  if (name.includes("船")) return "#0b8fc5";
  if (name.includes("机构")) return "#4b5563";
  if (name.includes("物品") || name.includes("货物")) return "#e17a00";
  if (name.includes("法律")) return "#2563eb";
  return "#465568";
}

function shortCaption(value) {
  const text = String(value || "");
  return text.length > 14 ? `${text.slice(0, 14)}...` : text;
}

window.KgNvlPreview = {
  render,
  destroy,
  debug,
};

export { render, destroy, debug };
