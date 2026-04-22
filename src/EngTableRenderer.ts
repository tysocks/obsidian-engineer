import { MarkdownPostProcessorContext, Plugin } from "obsidian";
import { VariableStore } from "./VariableStore";
import {
  formatCell,
  parseFenceConfig,
  parseRange,
  readCsvFile,
  readEngSheetRange,
  resolveVaultPath,
} from "./EngDataUtils";

type TagResolver = (filePath: string) => string[];

export class EngTableRenderer {
  private plugin: Plugin;
  private store: VariableStore;
  private tagResolver?: TagResolver;
  private showSourceByDefault: () => boolean;
  private rerenderTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    plugin: Plugin,
    store: VariableStore,
    tagResolver?: TagResolver,
    showSourceByDefault: () => boolean = () => true
  ) {
    this.plugin = plugin;
    this.store = store;
    this.tagResolver = tagResolver;
    this.showSourceByDefault = showSourceByDefault;
  }

  register(): void {
    this.plugin.registerMarkdownCodeBlockProcessor("engtable", (source, el, ctx) =>
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

  private async render(
    source: string,
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext
  ): Promise<void> {
    const cfg = parseFenceConfig(source);
    const sourcePath = String(cfg["source"] ?? "").trim();
    const rangeRaw = String(cfg["range"] ?? "").trim();
    if (!sourcePath || !rangeRaw) {
      this.renderError(el, "engtable requires `source:` and `range:`.");
      return;
    }
    const range = parseRange(rangeRaw);
    if (!range) {
      this.renderError(el, `Invalid range: ${rangeRaw}`);
      return;
    }

    const resolved = resolveVaultPath(sourcePath, ctx.sourcePath);
    const ext = resolved.split(".").pop()?.toLowerCase();
    const precision = typeof cfg["precision"] === "number" ? Number(cfg["precision"]) : undefined;
    const header = cfg["header"] === true;
    const showSource =
      typeof cfg["show-source"] === "boolean" ? cfg["show-source"] : this.showSourceByDefault();

    try {
      let rows: unknown[][] = [];
      if (ext === "engsheet") {
        const sheetName = typeof cfg["sheet"] === "string" ? String(cfg["sheet"]) : undefined;
        rows = await readEngSheetRange(
          this.plugin.app,
          this.store,
          resolved,
          sheetName,
          range,
          this.tagResolver
        );
      } else if (ext === "csv") {
        const csv = await readCsvFile(this.plugin.app, resolved);
        rows = csv.slice(range.r0, range.r1 + 1).map((r) => r.slice(range.c0, range.c1 + 1));
      } else {
        this.renderError(el, "engtable source must be .engsheet or .csv");
        return;
      }
      this.renderTable(el, rows, resolved, rangeRaw, header, precision, showSource);
    } catch (err) {
      this.renderError(el, String(err));
    }
  }

  private renderTable(
    el: HTMLElement,
    rows: unknown[][],
    sourcePath: string,
    range: string,
    header: boolean,
    precision?: number,
    showSource = true
  ): void {
    const wrap = el.createDiv({ cls: "eng-live-table-wrap" });
    if (showSource) wrap.createDiv({ cls: "eng-live-table-caption", text: `${sourcePath}  ${range}` });
    const table = wrap.createEl("table", { cls: "eng-live-table" });
    if (rows.length === 0) return;

    const startRow = header ? 1 : 0;
    if (header) {
      const thead = table.createEl("thead");
      const tr = thead.createEl("tr");
      for (const cell of rows[0]) tr.createEl("th", { text: formatCell(cell, precision) });
    }
    const tbody = table.createEl("tbody");
    for (let r = startRow; r < rows.length; r++) {
      const tr = tbody.createEl("tr");
      for (const cell of rows[r]) tr.createEl("td", { text: formatCell(cell, precision) });
    }
  }

  private renderError(el: HTMLElement, msg: string): void {
    el.createDiv({ cls: "eng-live-table-error", text: `engtable: ${msg}` });
  }
}
