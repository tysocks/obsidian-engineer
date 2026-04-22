import { MarkdownPostProcessorContext, Plugin } from "obsidian";
import * as math from "mathjs";
import { VariableStore } from "./VariableStore";
import {
  csvColumn,
  parseFenceConfig,
  parseRange,
  readCsvFile,
  readEngSheetRange,
  resolveVaultPath,
} from "./EngDataUtils";

type TagResolver = (filePath: string) => string[];

interface SeriesData {
  name: string;
  x: (number | string)[];
  y: number[];
  color?: string;
  yAxis: "left" | "right";
}

type PlotType = "line" | "scatter" | "bar" | "hbar" | "area" | "pie" | "donut";

const PALETTE = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#14b8a6"];

export class EngPlotRenderer {
  private plugin: Plugin;
  private store: VariableStore;
  private tagResolver?: TagResolver;
  private rerenderTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(plugin: Plugin, store: VariableStore, tagResolver?: TagResolver) {
    this.plugin = plugin;
    this.store = store;
    this.tagResolver = tagResolver;
  }

  register(): void {
    this.plugin.registerMarkdownCodeBlockProcessor("engplot", (source, el, ctx) =>
      this.render(source, el, ctx)
    );
    this.store.on("change", () => this.scheduleRerender());
  }

  scheduleRerender(): void {
    if (this.rerenderTimer) clearTimeout(this.rerenderTimer);
    this.rerenderTimer = setTimeout(() => {
      this.rerenderTimer = null;
      this.rerenderAll();
    }, 120);
  }

  rerenderAll(): void {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as { previewMode?: { rerender: (full?: boolean) => void } };
      if (view?.previewMode) view.previewMode.rerender(false);
    }
  }

  private async render(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    const cfg = parseFenceConfig(source);
    const type = String(cfg["type"] ?? "line").toLowerCase() as PlotType;
    const title = String(cfg["title"] ?? "");
    const xLabel = String(cfg["x-label"] ?? "");
    const yLabel = String(cfg["y-label"] ?? "");
    const y2Label = String(cfg["y2-label"] ?? cfg["y-right-label"] ?? "");
    const options = (cfg["options"] as Record<string, unknown> | undefined) ?? {};
    const showLegend = options["legend"] !== false;
    const showGrid = options["grid"] !== false;
    const references = this.parseReferences(cfg["reference"], ctx.sourcePath);

    try {
      const series = await this.loadSeries(cfg, ctx.sourcePath);
      if (series.length === 0) {
        this.renderError(el, "No data found for engplot.");
        return;
      }
      this.renderSvgPlot(el, { type, title, xLabel, yLabel, y2Label, series, showLegend, showGrid, references });
    } catch (err) {
      this.renderError(el, String(err));
    }
  }

  private async loadSeries(cfg: Record<string, unknown>, notePath: string): Promise<SeriesData[]> {
    const arr = Array.isArray(cfg["series"]) ? (cfg["series"] as Array<Record<string, unknown>>) : null;
    const specs = arr && arr.length > 0 ? arr : [cfg];
    const out: SeriesData[] = [];
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i] ?? {};
      const series = await this.loadOneSeries(spec, notePath);
      if (series.y.length === 0) continue;
      series.color = series.color ?? PALETTE[i % PALETTE.length];
      out.push(series);
    }
    return out;
  }

  private async loadOneSeries(spec: Record<string, unknown>, notePath: string): Promise<SeriesData> {
    const name = String(spec["name"] ?? "Series");
    const sourcePath = String(spec["source"] ?? "").trim();
    const xSpec = spec["x"];
    const ySpec = spec["y"];
    const color = typeof spec["color"] === "string" ? spec["color"] : undefined;
    const yAxis = this.normalizeAxis(spec["axis"] ?? spec["y-axis"]);

    if (!sourcePath) {
      // Inline arrays
      const x = Array.isArray(xSpec) ? xSpec.map((v) => this.toNumOrString(v)) : [];
      const yRaw = Array.isArray(ySpec) ? ySpec : [];
      const y = yRaw.map((v) => Number(v)).filter((n) => Number.isFinite(n));
      if (x.length === 0) {
        return { name, x: y.map((_v, idx) => idx + 1), y, color, yAxis };
      }
      return { name, x, y: y.slice(0, x.length), color, yAxis };
    }

    const resolved = resolveVaultPath(sourcePath, notePath);
    const ext = resolved.split(".").pop()?.toLowerCase();
    if (ext === "csv") {
      const rows = await readCsvFile(this.plugin.app, resolved);
      const yCol = String(ySpec ?? "");
      const xCol = String(xSpec ?? "");
      const y = csvColumn(rows, yCol).map((v) => Number(v)).filter((n) => Number.isFinite(n));
      const xRaw = xCol ? csvColumn(rows, xCol) : [];
      const x = xRaw.length > 0 ? xRaw.map((v) => this.toNumOrString(v)) : y.map((_v, idx) => idx + 1);
      return { name, x: x.slice(0, y.length), y, color, yAxis };
    }
    if (ext === "engsheet") {
      const sheet = typeof spec["sheet"] === "string" ? String(spec["sheet"]) : undefined;
      const yRange = parseRange(String(ySpec ?? ""));
      if (!yRange) return { name, x: [], y: [], color, yAxis };
      const yRows = await readEngSheetRange(
        this.plugin.app,
        this.store,
        resolved,
        sheet,
        yRange,
        this.tagResolver
      );
      const yFlat = yRows.flat().map((v) => Number(v)).filter((n) => Number.isFinite(n));
      let xFlat: (number | string)[] = [];
      const xRange = parseRange(String(xSpec ?? ""));
      if (xRange) {
        const xRows = await readEngSheetRange(
          this.plugin.app,
          this.store,
          resolved,
          sheet,
          xRange,
          this.tagResolver
        );
        xFlat = xRows.flat().map((v) => this.toNumOrString(v));
      }
      if (xFlat.length === 0) xFlat = yFlat.map((_v, idx) => idx + 1);
      return { name, x: xFlat.slice(0, yFlat.length), y: yFlat, color, yAxis };
    }

    return { name, x: [], y: [], color, yAxis };
  }

  private renderSvgPlot(
    el: HTMLElement,
    params: {
      type: PlotType;
      title: string;
      xLabel: string;
      yLabel: string;
      y2Label: string;
      series: SeriesData[];
      showLegend: boolean;
      showGrid: boolean;
      references: number[];
    }
  ): void {
    const { type, title, xLabel, yLabel, y2Label, series, showLegend, showGrid, references } = params;
    const wrap = el.createDiv({ cls: "eng-plot-wrap" });
    if (title) wrap.createDiv({ cls: "eng-plot-title", text: title });
    const width = 720;
    const height = 420;
    const svg = wrap.createSvg("svg", {
      attr: { viewBox: `0 0 ${width} ${height}`, class: "eng-plot-svg" },
    });

    if (type === "pie" || type === "donut") {
      this.drawPie(svg, width, height, series[0], type === "donut");
      this.renderLegend(wrap, series);
      return;
    }

    const hasRightAxis = series.some((s) => s.yAxis === "right");
    const margin = { left: 62, right: hasRightAxis ? 62 : 18, top: 20, bottom: 48 };
    const w = width - margin.left - margin.right;
    const h = height - margin.top - margin.bottom;
    const leftY = series.filter((s) => s.yAxis === "left").flatMap((s) => s.y);
    const rightY = series.filter((s) => s.yAxis === "right").flatMap((s) => s.y);
    const leftMin = Math.min(0, ...(leftY.length > 0 ? leftY : [0]));
    const leftMax = Math.max(1, ...(leftY.length > 0 ? leftY : [1]));
    const rightMin = Math.min(0, ...(rightY.length > 0 ? rightY : [leftMin]));
    const rightMax = Math.max(1, ...(rightY.length > 0 ? rightY : [leftMax]));

    const catCount = Math.max(...series.map((s) => s.y.length));
    const sx = (i: number) => margin.left + (catCount <= 1 ? w / 2 : (i / (catCount - 1)) * w);
    const syLeft = (v: number) => margin.top + h - ((v - leftMin) / (leftMax - leftMin || 1)) * h;
    const syRight = (v: number) => margin.top + h - ((v - rightMin) / (rightMax - rightMin || 1)) * h;
    const syForSeries = (s: SeriesData, v: number) => (s.yAxis === "right" ? syRight(v) : syLeft(v));

    if (showGrid) {
      for (let i = 0; i <= 5; i++) {
        const y = margin.top + (i / 5) * h;
        svg.createSvg("line", {
          attr: { x1: String(margin.left), y1: String(y), x2: String(margin.left + w), y2: String(y), class: "eng-plot-grid" },
        });
      }
    }
    svg.createSvg("line", {
      attr: {
        x1: String(margin.left),
        y1: String(margin.top + h),
        x2: String(margin.left + w),
        y2: String(margin.top + h),
        class: "eng-plot-axis",
      },
    });
    svg.createSvg("line", {
      attr: {
        x1: String(margin.left),
        y1: String(margin.top),
        x2: String(margin.left),
        y2: String(margin.top + h),
        class: "eng-plot-axis",
      },
    });
    if (hasRightAxis) {
      svg.createSvg("line", {
        attr: {
          x1: String(margin.left + w),
          y1: String(margin.top),
          x2: String(margin.left + w),
          y2: String(margin.top + h),
          class: "eng-plot-axis",
        },
      });
    }

    for (const ref of references) {
      const y = syLeft(ref);
      svg.createSvg("line", {
        attr: { x1: String(margin.left), y1: String(y), x2: String(margin.left + w), y2: String(y), class: "eng-plot-reference" },
      });
    }

    if (type === "bar" || type === "hbar") {
      this.drawBars(svg, series, type, margin.left, margin.top, w, h, leftMin, leftMax, rightMin, rightMax);
    } else {
      for (const s of series) {
        const pts = s.y.map((v, i) => `${sx(i)},${syForSeries(s, v)}`).join(" ");
        if (type === "area") {
          const base = s.yAxis === "right" ? rightMin : leftMin;
          const areaPts = `${sx(0)},${syForSeries(s, base)} ${pts} ${sx(s.y.length - 1)},${syForSeries(s, base)}`;
          svg.createSvg("polygon", { attr: { points: areaPts, fill: s.color ?? PALETTE[0], "fill-opacity": "0.22" } });
        }
        if (type === "line" || type === "area") {
          svg.createSvg("polyline", {
            attr: { points: pts, fill: "none", stroke: s.color ?? PALETTE[0], "stroke-width": "2" },
          });
        }
        if (type === "scatter" || type === "line" || type === "area") {
          for (let i = 0; i < s.y.length; i++) {
            svg.createSvg("circle", {
              attr: { cx: String(sx(i)), cy: String(syForSeries(s, s.y[i])), r: "3.2", fill: s.color ?? PALETTE[0] },
            });
          }
        }
      }
    }

    if (xLabel) {
      const tx = svg.createSvg("text", { attr: { x: String(margin.left + w / 2), y: String(height - 8), class: "eng-plot-label" } });
      tx.textContent = xLabel;
    }
    if (yLabel) {
      const ty = svg.createSvg("text", {
        attr: {
          x: "14",
          y: String(margin.top + h / 2),
          transform: `rotate(-90 14 ${margin.top + h / 2})`,
          class: "eng-plot-label",
        },
      });
      ty.textContent = yLabel;
    }
    if (hasRightAxis && y2Label) {
      const ty2 = svg.createSvg("text", {
        attr: {
          x: String(width - 14),
          y: String(margin.top + h / 2),
          transform: `rotate(90 ${width - 14} ${margin.top + h / 2})`,
          class: "eng-plot-label",
        },
      });
      ty2.textContent = y2Label;
    }
    if (showLegend) this.renderLegend(wrap, series);
  }

  private drawBars(
    svg: SVGElement,
    series: SeriesData[],
    type: "bar" | "hbar",
    x0: number,
    y0: number,
    w: number,
    h: number,
    minLeft: number,
    maxLeft: number,
    minRight: number,
    maxRight: number
  ): void {
    const nSeries = Math.max(1, series.length);
    const cats = Math.max(...series.map((s) => s.y.length));
    const catBand = type === "bar" ? w / Math.max(1, cats) : h / Math.max(1, cats);
    const itemBand = catBand / nSeries;
    const sy = (axis: "left" | "right", v: number) => {
      const min = axis === "right" ? minRight : minLeft;
      const max = axis === "right" ? maxRight : maxLeft;
      return y0 + h - ((v - min) / (max - min || 1)) * h;
    };
    const sx = (axis: "left" | "right", v: number) => {
      const min = axis === "right" ? minRight : minLeft;
      const max = axis === "right" ? maxRight : maxLeft;
      return x0 + ((v - min) / (max - min || 1)) * w;
    };

    for (let sIdx = 0; sIdx < series.length; sIdx++) {
      const s = series[sIdx];
      for (let i = 0; i < s.y.length; i++) {
        const v = s.y[i];
        if (type === "bar") {
          const x = x0 + i * catBand + sIdx * itemBand + itemBand * 0.1;
          const y = sy(s.yAxis, v);
          const bw = itemBand * 0.8;
          const bh = y0 + h - y;
          svg.createSvg("rect", { attr: { x: String(x), y: String(y), width: String(bw), height: String(Math.max(1, bh)), fill: s.color ?? PALETTE[sIdx % PALETTE.length] } });
        } else {
          const y = y0 + i * catBand + sIdx * itemBand + itemBand * 0.1;
          const x = x0;
          const bw = sx(s.yAxis, v) - x0;
          const bh = itemBand * 0.8;
          svg.createSvg("rect", { attr: { x: String(x), y: String(y), width: String(Math.max(1, bw)), height: String(bh), fill: s.color ?? PALETTE[sIdx % PALETTE.length] } });
        }
      }
    }
  }

  private drawPie(svg: SVGElement, width: number, height: number, series: SeriesData, donut: boolean): void {
    const cx = width / 2;
    const cy = height / 2;
    const r = Math.min(width, height) * 0.31;
    const values = series.y.filter((v) => Number.isFinite(v) && v > 0);
    const total = values.reduce((a, b) => a + b, 0);
    if (total <= 0) return;
    let angle = -Math.PI / 2;
    for (let i = 0; i < values.length; i++) {
      const frac = values[i] / total;
      const next = angle + frac * Math.PI * 2;
      const p1 = `${cx + Math.cos(angle) * r},${cy + Math.sin(angle) * r}`;
      const p2 = `${cx + Math.cos(next) * r},${cy + Math.sin(next) * r}`;
      const large = frac > 0.5 ? 1 : 0;
      const d = `M ${cx} ${cy} L ${p1} A ${r} ${r} 0 ${large} 1 ${p2} Z`;
      svg.createSvg("path", { attr: { d, fill: PALETTE[i % PALETTE.length], "fill-opacity": "0.95" } });
      angle = next;
    }
    if (donut) {
      svg.createSvg("circle", { attr: { cx: String(cx), cy: String(cy), r: String(r * 0.52), fill: "var(--background-primary)" } });
    }
  }

  private renderLegend(parent: HTMLElement, series: SeriesData[]): void {
    const legend = parent.createDiv({ cls: "eng-plot-legend" });
    for (let i = 0; i < series.length; i++) {
      const s = series[i];
      const item = legend.createDiv({ cls: "eng-plot-legend-item" });
      const swatch = item.createSpan({ cls: "eng-plot-legend-swatch" });
      swatch.style.background = s.color ?? PALETTE[i % PALETTE.length];
      const axisLabel = s.yAxis === "right" ? " (R)" : " (L)";
      item.createSpan({ cls: "eng-plot-legend-text", text: `${s.name}${axisLabel}` });
    }
  }

  private parseReferences(input: unknown, sourcePath: string): number[] {
    const values: unknown[] = Array.isArray(input) ? input : input ? [input] : [];
    const refs: number[] = [];
    for (const item of values) {
      const val = item && typeof item === "object" ? (item as Record<string, unknown>)["value"] : item;
      const n = this.resolveDynamicNumber(val, sourcePath);
      if (n !== null && Number.isFinite(n)) refs.push(n);
    }
    return refs;
  }

  private resolveDynamicNumber(raw: unknown, sourcePath: string): number | null {
    if (typeof raw === "number") return raw;
    if (typeof raw !== "string") return null;
    const t = raw.trim();
    const m = t.match(/^<<(.+?)>>$/);
    if (!m) {
      const n = Number(t);
      return Number.isFinite(n) ? n : null;
    }
    const expr = m[1].trim();
    const scope = this.store.getAll(sourcePath, this.tagResolver) as Record<string, unknown>;
    try {
      const out = math.evaluate(expr, scope as math.MathJsInstance);
      const n = Number(out);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  private toNumOrString(v: unknown): number | string {
    const n = Number(v);
    return Number.isFinite(n) ? n : String(v ?? "");
  }

  private normalizeAxis(raw: unknown): "left" | "right" {
    const s = String(raw ?? "left").trim().toLowerCase();
    return s === "right" || s === "r" || s === "y2" ? "right" : "left";
  }

  private renderError(el: HTMLElement, msg: string): void {
    el.createDiv({ cls: "eng-plot-error", text: `engplot: ${msg}` });
  }
}
