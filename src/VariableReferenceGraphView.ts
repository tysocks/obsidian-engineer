import { App, ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";

export const VARIABLE_REFERENCE_GRAPH_VIEW_TYPE = "engineer-variable-reference-graph";

export interface VariableReferenceGraph {
  sourcePath: string;
  variables: string[];
  references: Map<string, Map<string, number>>;
  variableScopes: Record<string, string>;
}

interface NodePos {
  x: number;
  y: number;
}

interface GraphNode {
  id: string;
  label: string;
  cls: string;
  pos: NodePos;
  clickablePath?: string;
}

interface GraphEdge {
  from: string;
  to: string;
  count: number;
  self: boolean;
  cls: string;
}

interface RenderGraphOptions {
  app: App;
  stageEl: HTMLElement;
  graph: VariableReferenceGraph;
  interactionMultiplier?: number;
}

function normalizeScope(scopeRaw: string | undefined): string {
  const base = (scopeRaw ?? "global").toLowerCase().split(":")[0];
  if (base === "folder" || base === "tag" || base === "file" || base === "block") return base;
  return "global";
}

function spread(index: number, total: number, min: number, max: number): number {
  if (total <= 1) return (min + max) / 2;
  return min + (index / (total - 1)) * (max - min);
}

function collectReferencedFiles(graph: VariableReferenceGraph): string[] {
  const set = new Set<string>();
  for (const refs of graph.references.values()) {
    for (const p of refs.keys()) set.add(p);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function drawNode(viewport: SVGElement, label: string, cls: string): SVGElement {
  const g = viewport.createSvg("g", { attr: { class: `eng-ref-node ${cls}` } }) as unknown as SVGElement;
  g.createSvg("rect", {
    attr: {
      x: "-66",
      y: "-16",
      rx: "8",
      ry: "8",
      width: "132",
      height: "32",
    },
  });
  const t = g.createSvg("text", {
    attr: { x: "0", y: "4", "text-anchor": "middle" },
  });
  t.textContent = label.length > 26 ? label.slice(0, 25) + "…" : label;
  return g;
}

function openPath(app: App, path: string): void {
  const file = app.vault.getAbstractFileByPath(path);
  if (file instanceof TFile) {
    app.workspace.openLinkText(path, "", false);
    return;
  }
  new Notice(`File not found: ${path}`);
}

export function renderVariableReferenceGraph({
  app,
  stageEl,
  graph,
  interactionMultiplier = 2,
}: RenderGraphOptions): () => void {
  stageEl.empty();
  const width = Math.max(stageEl.clientWidth || 900, 900);
  const height = Math.max(stageEl.clientHeight || 560, 560);
  const svg = stageEl.createSvg("svg", {
    attr: { viewBox: `0 0 ${width} ${height}`, class: "eng-ref-graph-svg" },
  }) as unknown as SVGElement;

  const bg = svg.createSvg("rect", {
    attr: {
      x: "0",
      y: "0",
      width: String(width),
      height: String(height),
      fill: "transparent",
    },
  }) as unknown as SVGElement;
  const viewport = svg.createSvg("g", { attr: { class: "eng-ref-graph-viewport" } }) as unknown as SVGElement;

  const sourcePath = graph.sourcePath;
  const sourceLabel = sourcePath.split("/").pop() ?? sourcePath;
  const sourceNode: GraphNode = {
    id: "source",
    label: `📝 ${sourceLabel}`,
    cls: "eng-ref-node-source",
    pos: { x: 160, y: height / 2 },
    clickablePath: sourcePath,
  };

  const varNodes: GraphNode[] = graph.variables.map((name, i) => {
    const scope = normalizeScope(graph.variableScopes?.[name]);
    return {
      id: `var:${name}`,
      label: name,
      cls: `eng-ref-node-var eng-ref-node-var-${scope}`,
      pos: { x: width * 0.42, y: spread(i, graph.variables.length, 90, height - 90) },
    };
  });

  const filePaths = collectReferencedFiles(graph).filter((p) => p !== sourcePath);
  const fileNodes: GraphNode[] = filePaths.map((path, i) => ({
    id: `file:${path}`,
    label: path.split("/").pop() ?? path,
    cls: "eng-ref-node-file",
    pos: { x: width * 0.78, y: spread(i, filePaths.length, 70, height - 70) },
    clickablePath: path,
  }));

  const nodes = new Map<string, GraphNode>();
  nodes.set(sourceNode.id, sourceNode);
  for (const n of varNodes) nodes.set(n.id, n);
  for (const n of fileNodes) nodes.set(n.id, n);

  const edges: GraphEdge[] = [];
  for (const vn of varNodes) {
    edges.push({ from: sourceNode.id, to: vn.id, count: 1, self: false, cls: "eng-ref-edge" });
    const name = vn.id.slice(4);
    const refMap = graph.references.get(name);
    if (!refMap) continue;
    const selfCount = refMap.get(sourcePath) ?? 0;
    if (selfCount > 0) {
      edges.push({ from: sourceNode.id, to: vn.id, count: selfCount, self: true, cls: "eng-ref-edge eng-ref-edge-self" });
    }
    for (const [path, count] of refMap.entries()) {
      if (path === sourcePath) continue;
      edges.push({ from: vn.id, to: `file:${path}`, count, self: false, cls: "eng-ref-edge eng-ref-edge-ref" });
    }
  }

  const edgeEls: Array<{ edge: GraphEdge; el: SVGElement }> = [];
  for (const edge of edges) {
    const el = edge.self
      ? viewport.createSvg("path", { attr: { class: edge.cls } })
      : viewport.createSvg("line", { attr: { class: edge.cls } });
    edgeEls.push({ edge, el: el as unknown as SVGElement });
  }

  const nodeEls = new Map<string, SVGElement>();
  const nodeMoved = new Set<string>();
  for (const node of nodes.values()) {
    const g = drawNode(viewport, node.label, node.cls);
    if (node.clickablePath) {
      g.style.cursor = "pointer";
      g.addEventListener("click", () => {
        if (nodeMoved.has(node.id)) {
          nodeMoved.delete(node.id);
          return;
        }
        openPath(app, node.clickablePath!);
      });
    }
    nodeEls.set(node.id, g);
  }

  let tx = 0;
  let ty = 0;
  let scale = 1;
  const applyTransform = () => {
    viewport.setAttribute("transform", `translate(${tx} ${ty}) scale(${scale})`);
  };

  const updateGeometry = () => {
    for (const { edge, el } of edgeEls) {
      const from = nodes.get(edge.from);
      const to = nodes.get(edge.to);
      if (!from || !to) continue;
      if (!edge.self) {
        el.setAttribute("x1", String(from.pos.x + 66));
        el.setAttribute("y1", String(from.pos.y));
        el.setAttribute("x2", String(to.pos.x - 66));
        el.setAttribute("y2", String(to.pos.y));
        el.setAttribute("stroke-width", String(Math.min(6, 1 + Math.log2(edge.count + 1))));
      } else {
        const cx = (from.pos.x + to.pos.x) / 2;
        const cy = Math.min(from.pos.y, to.pos.y) - 30;
        const d = `M ${from.pos.x + 66} ${from.pos.y} Q ${cx} ${cy} ${to.pos.x - 66} ${to.pos.y}`;
        el.setAttribute("d", d);
        el.setAttribute("stroke-width", String(Math.min(6, 1 + Math.log2(edge.count + 1))));
      }
    }

    for (const [id, g] of nodeEls.entries()) {
      const node = nodes.get(id);
      if (!node) continue;
      const rect = g.querySelector("rect");
      const text = g.querySelector("text");
      if (rect) {
        rect.setAttribute("x", String(node.pos.x - 66));
        rect.setAttribute("y", String(node.pos.y - 16));
      }
      if (text) {
        text.setAttribute("x", String(node.pos.x));
        text.setAttribute("y", String(node.pos.y + 4));
      }
    }
  };

  let panning = false;
  let panPointerId: number | null = null;
  let panLastX = 0;
  let panLastY = 0;
  const onBgPointerDown = (e: PointerEvent) => {
    panning = true;
    panPointerId = e.pointerId;
    panLastX = e.clientX;
    panLastY = e.clientY;
    bg.setPointerCapture(e.pointerId);
    bg.style.cursor = "grabbing";
  };
  const onBgPointerMove = (e: PointerEvent) => {
    if (!panning || e.pointerId !== panPointerId) return;
    const dx = e.clientX - panLastX;
    const dy = e.clientY - panLastY;
    panLastX = e.clientX;
    panLastY = e.clientY;
    tx += dx * interactionMultiplier;
    ty += dy * interactionMultiplier;
    applyTransform();
  };
  const onBgPointerUp = (e: PointerEvent) => {
    if (e.pointerId !== panPointerId) return;
    panning = false;
    panPointerId = null;
    bg.releasePointerCapture(e.pointerId);
    bg.style.cursor = "grab";
  };
  bg.addEventListener("pointerdown", onBgPointerDown);
  bg.addEventListener("pointermove", onBgPointerMove);
  bg.addEventListener("pointerup", onBgPointerUp);
  bg.addEventListener("pointercancel", onBgPointerUp);
  bg.style.cursor = "grab";

  for (const [id, g] of nodeEls.entries()) {
    let nodePointerId: number | null = null;
    let lastX = 0;
    let lastY = 0;
    let moved = false;
    const onNodeDown = (e: PointerEvent) => {
      e.stopPropagation();
      nodePointerId = e.pointerId;
      lastX = e.clientX;
      lastY = e.clientY;
      moved = false;
      g.setPointerCapture(e.pointerId);
    };
    const onNodeMove = (e: PointerEvent) => {
      if (nodePointerId === null || e.pointerId !== nodePointerId) return;
      const node = nodes.get(id);
      if (!node) return;
      const dx = (e.clientX - lastX) / scale;
      const dy = (e.clientY - lastY) / scale;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) moved = true;
      lastX = e.clientX;
      lastY = e.clientY;
      node.pos.x += dx * interactionMultiplier;
      node.pos.y += dy * interactionMultiplier;
      updateGeometry();
    };
    const onNodeUp = (e: PointerEvent) => {
      if (nodePointerId === null || e.pointerId !== nodePointerId) return;
      if (moved) nodeMoved.add(id);
      g.releasePointerCapture(e.pointerId);
      nodePointerId = null;
    };
    g.addEventListener("pointerdown", onNodeDown);
    g.addEventListener("pointermove", onNodeMove);
    g.addEventListener("pointerup", onNodeUp);
    g.addEventListener("pointercancel", onNodeUp);
  }

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const old = scale;
    const zoomIn = 1 + (0.08 * interactionMultiplier);
    const zoomOut = 1 - (0.08 * interactionMultiplier);
    const delta = e.deltaY < 0 ? zoomIn : zoomOut;
    scale = Math.max(0.35, Math.min(2.8, scale * delta));
    tx = px - ((px - tx) / old) * scale;
    ty = py - ((py - ty) / old) * scale;
    applyTransform();
  };
  svg.addEventListener("wheel", onWheel, { passive: false });

  updateGeometry();
  applyTransform();
  return () => {
    svg.removeEventListener("wheel", onWheel);
    bg.removeEventListener("pointerdown", onBgPointerDown);
    bg.removeEventListener("pointermove", onBgPointerMove);
    bg.removeEventListener("pointerup", onBgPointerUp);
    bg.removeEventListener("pointercancel", onBgPointerUp);
  };
}

export class VariableReferenceGraphView extends ItemView {
  private graph: VariableReferenceGraph | null = null;
  private cleanup: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return VARIABLE_REFERENCE_GRAPH_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Variable Dependency Graph";
  }

  getIcon(): string {
    return "git-branch";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  setGraph(graph: VariableReferenceGraph): void {
    this.graph = graph;
    this.render();
  }

  private render(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("eng-ref-graph-view");
    this.cleanup?.();
    this.cleanup = null;
    if (!this.graph) {
      root.createDiv({
        cls: "eng-ref-graph-empty",
        text: "No graph loaded yet. Open Variable Store and click the graph button.",
      });
      return;
    }

    const header = root.createDiv({ cls: "eng-ref-graph-view-header" });
    const sourceName = this.graph.sourcePath.split("/").pop() ?? this.graph.sourcePath;
    header.createSpan({ text: `Source: ${sourceName}`, cls: "eng-ref-graph-view-title" });
    const subtitle = header.createSpan({ cls: "eng-ref-graph-view-subtitle" });
    subtitle.textContent = this.graph.sourcePath;

    const stage = root.createDiv({ cls: "eng-ref-graph-stage" });
    this.cleanup = renderVariableReferenceGraph({
      app: this.app,
      stageEl: stage,
      graph: this.graph,
      interactionMultiplier: 2,
    });
  }

  async onClose(): Promise<void> {
    this.cleanup?.();
    this.cleanup = null;
  }
}
