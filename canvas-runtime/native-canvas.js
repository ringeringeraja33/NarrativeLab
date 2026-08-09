const CANVAS_SIDES = new Set(["top", "right", "bottom", "left"]);
const NARRATIVE_CANVAS_PROJECTION_KIND = "narrative-lab-ncanvas-projection";
const NARRATIVE_CANVAS_PROJECTION_VERSION = 1;

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveNumber(value, fallback) {
  const number = finiteNumber(value, fallback);
  return number > 0 ? number : fallback;
}

function canvasSide(value, fallback) {
  return CANVAS_SIDES.has(String(value || "")) ? String(value) : fallback;
}

function nodeTypeMap(project) {
  return new Map((Array.isArray(project?.nodeTypes) ? project.nodeTypes : [])
    .filter((entry) => entry && typeof entry === "object" && entry.type)
    .map((entry) => [String(entry.type), entry]));
}

function isFrameNode(node, typeMap) {
  const definition = typeMap.get(String(node?.type || ""));
  return definition?.kind === "frame" || definition?.frame === true || /frame$/i.test(String(node?.type || ""));
}

function normalizeColor(value) {
  const color = String(value || "").trim();
  if (!color) return "";
  if (/^[1-6]$/.test(color) || /^#[0-9a-f]{3,8}$/i.test(color)) return color;
  return "";
}

function markdownText(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}

function stringifyFieldValue(value) {
  if (value == null || value === "") return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

function collectVaultReferences(node) {
  const refs = [];
  const add = (value) => {
    const path = String(value?.path || value?.file || value || "").trim();
    if (path && !refs.includes(path)) refs.push(path);
  };
  if (Array.isArray(node?.vaultFiles)) node.vaultFiles.forEach(add);
  if (Array.isArray(node?.files)) node.files.forEach(add);
  add(node?.vaultFile);
  add(node?.filePath);
  return refs;
}

function renderNodeMarkdown(node) {
  const title = markdownText(node?.title) || "Untitled";
  const type = markdownText(node?.type) || "Content";
  const sections = [`# ${title}`, `*NarrativeLab · ${type}*`];
  const body = markdownText(node?.body);
  if (body) sections.push(body);

  const turns = Array.isArray(node?.turns) ? node.turns : [];
  if (turns.length) {
    const lines = turns.map((turn) => {
      const speaker = markdownText(turn?.speaker || turn?.character || turn?.name);
      const text = markdownText(turn?.text || turn?.body || turn?.line);
      return speaker ? `- **${speaker}:** ${text}` : `- ${text}`;
    }).filter((line) => line !== "- ");
    if (lines.length) sections.push(`## Dialog\n${lines.join("\n")}`);
  }

  const choices = Array.isArray(node?.choiceOptions) && node.choiceOptions.length
    ? node.choiceOptions.map((choice) => choice?.label)
    : (Array.isArray(node?.choices) ? node.choices : []);
  const choiceLines = choices.map(markdownText).filter(Boolean).map((choice) => `- ${choice}`);
  if (choiceLines.length) sections.push(`## Choices\n${choiceLines.join("\n")}`);

  const references = collectVaultReferences(node);
  if (references.length) sections.push(`## Files\n${references.map((path) => `- [[${path}]]`).join("\n")}`);

  const customFields = node?.customFields && typeof node.customFields === "object" ? node.customFields : {};
  const customLines = Object.entries(customFields)
    .map(([key, value]) => [markdownText(key), stringifyFieldValue(value)])
    .filter(([key, value]) => key && value)
    .map(([key, value]) => `- **${key}:** ${value}`);
  if (customLines.length) sections.push(`## Fields\n${customLines.join("\n")}`);
  return sections.join("\n\n");
}

function projectToObsidianCanvas(projectInput, options = {}) {
  const project = projectInput && typeof projectInput === "object" ? projectInput : {};
  const typeMap = nodeTypeMap(project);
  const sourceNodes = Array.isArray(project.nodes) ? project.nodes : [];
  const knownNodeIds = new Set(sourceNodes.map((node) => String(node?.id || "")).filter(Boolean));
  let groupCount = 0;

  const nodes = sourceNodes.filter((node) => node?.id).map((node) => {
    const frame = isFrameNode(node, typeMap);
    const definition = typeMap.get(String(node.type || "")) || {};
    const color = normalizeColor(node.color || definition.color);
    const base = {
      id: String(node.id),
      type: frame ? "group" : "text",
      x: finiteNumber(node.x, 0),
      y: finiteNumber(node.y, 0),
      width: positiveNumber(node.width, frame ? positiveNumber(definition.width, 520) : positiveNumber(definition.width, 300)),
      height: positiveNumber(node.height, frame ? positiveNumber(definition.height, 320) : positiveNumber(definition.height, 180))
    };
    if (color) base.color = color;
    if (frame) {
      groupCount += 1;
      base.label = markdownText(node.title) || markdownText(node.type) || "Group";
    } else {
      base.text = renderNodeMarkdown(node);
    }
    return base;
  });

  const sourceLinks = Array.isArray(project.links) ? project.links : [];
  let skippedLinks = 0;
  let semanticLinks = 0;
  const usedEdgeIds = new Set();
  const edges = [];
  sourceLinks.forEach((link, index) => {
    const from = String(link?.from || "");
    const to = String(link?.to || "");
    if (!knownNodeIds.has(from) || !knownNodeIds.has(to)) {
      skippedLinks += 1;
      return;
    }
    let id = String(link?.id || `edge-${index + 1}`);
    while (usedEdgeIds.has(id)) id = `${id}-${index + 1}`;
    usedEdgeIds.add(id);
    const sourceNode = sourceNodes.find((node) => String(node?.id || "") === from);
    const targetNode = sourceNodes.find((node) => String(node?.id || "") === to);
    const edge = {
      id,
      fromNode: from,
      fromSide: canvasSide(sourceNode?.ports?.output?.side, "bottom"),
      fromEnd: "none",
      toNode: to,
      toSide: canvasSide(targetNode?.ports?.input?.side, "top"),
      toEnd: "arrow"
    };
    const label = markdownText(link?.label);
    if (label) edge.label = label;
    if (link?.choiceOptionId || Number.isInteger(link?.choiceIndex)) semanticLinks += 1;
    edges.push(edge);
  });

  const sourcePath = String(options.sourcePath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  return {
    canvas: {
      nodes,
      edges,
      narrativeLab: {
        kind: NARRATIVE_CANVAS_PROJECTION_KIND,
        version: NARRATIVE_CANVAS_PROJECTION_VERSION,
        sourcePath
      }
    },
    report: {
      nodeCount: nodes.length,
      groupCount,
      edgeCount: edges.length,
      semanticEdgeCount: semanticLinks,
      skippedLinkCount: skippedLinks
    }
  };
}

function nodeBounds(node) {
  const x = finiteNumber(node?.x, 0);
  const y = finiteNumber(node?.y, 0);
  const width = positiveNumber(node?.width, 1);
  const height = positiveNumber(node?.height, 1);
  return { x, y, width, height, right: x + width, bottom: y + height, area: width * height };
}

function containingGroupId(node, groups) {
  const bounds = nodeBounds(node);
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  return groups
    .filter((group) => String(group.id) !== String(node.id))
    .map((group) => ({ group, bounds: nodeBounds(group) }))
    .filter(({ bounds: groupBounds }) => centerX >= groupBounds.x && centerX <= groupBounds.right && centerY >= groupBounds.y && centerY <= groupBounds.bottom)
    .sort((left, right) => left.bounds.area - right.bounds.area)[0]?.group?.id || "";
}

function isSemanticLink(link, sourceNode) {
  return Boolean(link?.choiceOptionId)
    || Number.isInteger(link?.choiceIndex)
    || String(sourceNode?.type || "") === "Choice";
}

function uniqueLinkId(preferred, usedIds) {
  let id = String(preferred || "").trim() || "l0";
  if (!usedIds.has(id)) return id;
  let index = 0;
  while (usedIds.has(`l${index}`)) index += 1;
  return `l${index}`;
}

function applyObsidianCanvasLayout(projectInput, canvasInput) {
  const project = cloneJson(projectInput && typeof projectInput === "object" ? projectInput : {});
  const canvas = canvasInput && typeof canvasInput === "object" ? canvasInput : {};
  const nativeNodes = Array.isArray(canvas.nodes) ? canvas.nodes : [];
  const nativeEdges = Array.isArray(canvas.edges) ? canvas.edges : [];
  const projectNodes = Array.isArray(project.nodes) ? project.nodes : [];
  const projectLinks = Array.isArray(project.links) ? project.links : [];
  const typeMap = nodeTypeMap(project);
  const projectNodeMap = new Map(projectNodes.map((node) => [String(node?.id || ""), node]).filter(([id]) => id));
  const nativeNodeMap = new Map(nativeNodes.map((node) => [String(node?.id || ""), node]).filter(([id]) => id));
  const matchingNativeGroups = nativeNodes.filter((node) => node?.type === "group" && projectNodeMap.has(String(node.id)));

  let updatedNodeCount = 0;
  let updatedGroupCount = 0;
  projectNodes.forEach((node) => {
    const nativeNode = nativeNodeMap.get(String(node?.id || ""));
    if (!nativeNode) return;
    const before = [node.x, node.y, node.width, node.height, node.frameId].join("|");
    node.x = finiteNumber(nativeNode.x, finiteNumber(node.x, 0));
    node.y = finiteNumber(nativeNode.y, finiteNumber(node.y, 0));
    node.width = positiveNumber(nativeNode.width, positiveNumber(node.width, isFrameNode(node, typeMap) ? 520 : 300));
    node.height = positiveNumber(nativeNode.height, positiveNumber(node.height, isFrameNode(node, typeMap) ? 320 : 180));
    node.frameId = String(containingGroupId(nativeNode, matchingNativeGroups));
    const after = [node.x, node.y, node.width, node.height, node.frameId].join("|");
    if (before !== after) updatedNodeCount += 1;
    if (isFrameNode(node, typeMap)) updatedGroupCount += 1;
  });

  const knownIds = new Set(projectNodeMap.keys());
  const usableNativeEdges = nativeEdges.filter((edge) => knownIds.has(String(edge?.fromNode || "")) && knownIds.has(String(edge?.toNode || "")));
  const nativeById = new Map(usableNativeEdges.map((edge) => [String(edge?.id || ""), edge]).filter(([id]) => id));
  const consumedNativeEdges = new Set();
  const nextLinks = [];
  let preservedSemanticEdgeCount = 0;
  let removedOrdinaryEdgeCount = 0;
  let updatedEdgeCount = 0;

  const matchNativeEdge = (link) => {
    const byId = nativeById.get(String(link?.id || ""));
    if (byId && !consumedNativeEdges.has(byId)) return byId;
    return usableNativeEdges.find((edge) => !consumedNativeEdges.has(edge)
      && String(edge.fromNode || "") === String(link?.from || "")
      && String(edge.toNode || "") === String(link?.to || ""));
  };

  projectLinks.forEach((link) => {
    const sourceNode = projectNodeMap.get(String(link?.from || ""));
    const semantic = isSemanticLink(link, sourceNode);
    const nativeEdge = matchNativeEdge(link);
    if (!nativeEdge) {
      if (semantic) {
        preservedSemanticEdgeCount += 1;
        nextLinks.push(link);
      } else {
        removedOrdinaryEdgeCount += 1;
      }
      return;
    }
    consumedNativeEdges.add(nativeEdge);
    const next = { ...link, from: String(nativeEdge.fromNode), to: String(nativeEdge.toNode) };
    if (Object.prototype.hasOwnProperty.call(nativeEdge, "label") && !semantic) next.label = String(nativeEdge.label || "");
    const fromNode = projectNodeMap.get(next.from);
    const toNode = projectNodeMap.get(next.to);
    if (fromNode) {
      fromNode.ports = { ...(fromNode.ports || {}), output: { ...(fromNode.ports?.output || {}), side: canvasSide(nativeEdge.fromSide, fromNode.ports?.output?.side || "bottom") } };
    }
    if (toNode) {
      toNode.ports = { ...(toNode.ports || {}), input: { ...(toNode.ports?.input || {}), side: canvasSide(nativeEdge.toSide, toNode.ports?.input?.side || "top") } };
    }
    updatedEdgeCount += 1;
    nextLinks.push(next);
  });

  const usedLinkIds = new Set(nextLinks.map((link) => String(link?.id || "")).filter(Boolean));
  let addedOrdinaryEdgeCount = 0;
  usableNativeEdges.forEach((edge) => {
    if (consumedNativeEdges.has(edge)) return;
    const id = uniqueLinkId(edge.id, usedLinkIds);
    usedLinkIds.add(id);
    const link = { id, from: String(edge.fromNode), to: String(edge.toNode) };
    const label = markdownText(edge.label);
    if (label) link.label = label;
    nextLinks.push(link);
    addedOrdinaryEdgeCount += 1;
  });
  project.links = nextLinks;

  return {
    project,
    report: {
      updatedNodeCount,
      updatedGroupCount,
      updatedEdgeCount,
      addedOrdinaryEdgeCount,
      removedOrdinaryEdgeCount,
      preservedSemanticEdgeCount,
      ignoredNativeNodeCount: nativeNodes.filter((node) => !projectNodeMap.has(String(node?.id || ""))).length,
      missingNarrativeNodeCount: projectNodes.filter((node) => !nativeNodeMap.has(String(node?.id || ""))).length,
      ignoredNativeEdgeCount: nativeEdges.length - usableNativeEdges.length
    }
  };
}

function validateObsidianCanvas(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Native Canvas must be a JSON object.");
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) throw new Error("Native Canvas must contain nodes and edges arrays.");
  return value;
}

function getNarrativeCanvasProjectionPath(projectPath) {
  const path = String(projectPath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!path) return "";
  const stem = path.replace(/\.(ncanvas|narrativecanvas|json)$/i, "");
  return `${stem}.narrative.canvas`;
}

/**
 * Reject an unrelated native Canvas before reverse sync can remove ordinary
 * narrative links. Obsidian may discard unknown top-level metadata while
 * editing, so a strong node-id match remains a compatible fallback.
 */
function validateNarrativeCanvasProjection(canvasInput, projectInput, sourcePath = "") {
  const canvas = validateObsidianCanvas(canvasInput);
  const source = String(sourcePath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const marker = canvas.narrativeLab;
  if (marker && typeof marker === "object") {
    if (marker.kind !== NARRATIVE_CANVAS_PROJECTION_KIND) {
      throw new Error("This Canvas is not a NarrativeLab narrative projection.");
    }
    const markedSource = String(marker.sourcePath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (source && markedSource && source !== markedSource) {
      throw new Error("This Canvas belongs to a different .ncanvas project.");
    }
  }

  const projectIds = new Set((Array.isArray(projectInput?.nodes) ? projectInput.nodes : [])
    .map((node) => String(node?.id || ""))
    .filter(Boolean));
  if (projectIds.size === 0) return canvas;
  const matching = (Array.isArray(canvas.nodes) ? canvas.nodes : [])
    .filter((node) => projectIds.has(String(node?.id || ""))).length;
  if (matching === 0) {
    throw new Error("This Canvas has no nodes matching the open .ncanvas project.");
  }
  if (!marker && matching / projectIds.size < 0.5) {
    throw new Error("This Canvas does not match enough nodes from the open .ncanvas project.");
  }
  return canvas;
}

module.exports = {
  applyObsidianCanvasLayout,
  getNarrativeCanvasProjectionPath,
  projectToObsidianCanvas,
  validateNarrativeCanvasProjection,
  validateObsidianCanvas
};
