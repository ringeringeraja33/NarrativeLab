import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  applyObsidianCanvasLayout,
  getNarrativeCanvasProjectionPath,
  projectToObsidianCanvas,
  validateNarrativeCanvasProjection,
  validateObsidianCanvas
} = require("../canvas-runtime/native-canvas.js");

function sampleProject() {
  return {
    title: "Projection test",
    variables: { trust: 2 },
    nodeTypes: [
      { type: "Event", kind: "frame", width: 800, height: 500 },
      { type: "Choice", kind: "node", width: 320 },
      { type: "Content", kind: "node", width: 300 }
    ],
    nodes: [
      { id: "f0", type: "Event", title: "Act I", body: "Protected frame data", x: 0, y: 0, width: 800, height: 500, frameId: "" },
      { id: "n0", type: "Choice", title: "Choose", body: "A choice", x: 80, y: 80, frameId: "f0", choices: ["Go"], choiceOptions: [{ id: "opt_1", label: "Go" }] },
      { id: "n1", type: "Content", title: "One", body: "Keep this text", x: 420, y: 80, frameId: "f0" },
      { id: "n2", type: "Content", title: "Two", body: "Also keep", x: 900, y: 80, frameId: "" }
    ],
    links: [
      { id: "l0", from: "n0", to: "n1", label: "Go", choiceOptionId: "opt_1", choiceIndex: 0 },
      { id: "l1", from: "n1", to: "n2", label: "ordinary" }
    ]
  };
}

test("projects are projected to JSON Canvas nodes, groups, and edges", () => {
  const result = projectToObsidianCanvas(sampleProject(), { sourcePath: "Projects/Book/Canvas/Book.ncanvas" });
  assert.deepEqual(Object.keys(result.canvas).sort(), ["edges", "narrativeLab", "nodes"]);
  assert.equal(result.canvas.narrativeLab.sourcePath, "Projects/Book/Canvas/Book.ncanvas");
  assert.equal(result.canvas.nodes.find((node) => node.id === "f0")?.type, "group");
  assert.match(result.canvas.nodes.find((node) => node.id === "n0")?.text || "", /## Choices\n- Go/);
  assert.equal(result.canvas.edges.find((edge) => edge.id === "l0")?.toNode, "n1");
  assert.deepEqual(result.report, {
    nodeCount: 4,
    groupCount: 1,
    edgeCount: 2,
    semanticEdgeCount: 1,
    skippedLinkCount: 0
  });
});

test("native Canvas reverse sync changes layout and ordinary links without deleting narrative data", () => {
  const project = sampleProject();
  const native = {
    nodes: [
      { id: "f0", type: "group", label: "Act I", x: 10, y: 20, width: 1000, height: 600 },
      { id: "n0", type: "text", text: "edited projection text", x: 100, y: 120, width: 360, height: 200 },
      { id: "n1", type: "text", text: "ignored text", x: 500, y: 120, width: 320, height: 180 },
      { id: "n2", type: "text", text: "ignored text", x: 1100, y: 120, width: 320, height: 180 },
      { id: "native-only", type: "text", text: "not imported", x: 0, y: 800, width: 300, height: 180 }
    ],
    edges: [
      { id: "new-edge", fromNode: "n2", fromSide: "right", toNode: "n1", toSide: "left", label: "new ordinary link" }
    ]
  };
  const result = applyObsidianCanvasLayout(project, native);
  const choice = result.project.nodes.find((node) => node.id === "n0");
  assert.equal(choice.body, "A choice");
  assert.deepEqual(choice.choiceOptions, [{ id: "opt_1", label: "Go" }]);
  assert.equal(choice.frameId, "f0");
  assert.equal(result.project.nodes.find((node) => node.id === "n2")?.frameId, "");
  assert.ok(result.project.links.some((link) => link.id === "l0" && link.choiceOptionId === "opt_1"));
  assert.ok(!result.project.links.some((link) => link.id === "l1"));
  assert.ok(result.project.links.some((link) => link.id === "new-edge" && link.from === "n2" && link.to === "n1"));
  assert.equal(result.report.preservedSemanticEdgeCount, 1);
  assert.equal(result.report.removedOrdinaryEdgeCount, 1);
  assert.equal(result.report.addedOrdinaryEdgeCount, 1);
  assert.equal(result.report.ignoredNativeNodeCount, 1);
});

test("invalid native Canvas payloads are rejected", () => {
  assert.throws(() => validateObsidianCanvas({ nodes: [] }), /nodes and edges arrays/);
  assert.equal(validateObsidianCanvas({ nodes: [], edges: [] }).nodes.length, 0);
});

test("narrative projections use an isolated native Canvas filename", () => {
  assert.equal(
    getNarrativeCanvasProjectionPath("Projects/Book/Canvas/Book.ncanvas"),
    "Projects/Book/Canvas/Book.narrative.canvas"
  );
});

test("reverse sync rejects unrelated native Canvas files", () => {
  const project = sampleProject();
  assert.throws(
    () => validateNarrativeCanvasProjection({ nodes: [{ id: "other" }], edges: [] }, project, "Book.ncanvas"),
    /no nodes matching/
  );
  const marked = projectToObsidianCanvas(project, { sourcePath: "Other.ncanvas" }).canvas;
  assert.throws(
    () => validateNarrativeCanvasProjection(marked, project, "Book.ncanvas"),
    /different \.ncanvas project/
  );
});
