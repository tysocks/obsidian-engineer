/**
 * EngSheetView — modern Excel-like spreadsheet for .engsheet files.
 *
 * FILE FORMAT (.engsheet — JSON)
 * {
 *   "version": 1,
 *   "sheets": [{
 *     "name": "Sheet1",
 *     "cells": {
 *       "A1": { "v": "Label", "f": null, "style": { "bold": true } },
 *       "B1": { "v": null, "f": "=STORE(\"E\")" },
 *       "C1": { "v": null, "f": "=EXPORT(B1*2, \"double_E\")" }
 *     },
 *     "colWidths": { "0": 120 },
 *     "rowHeights": {},
 *     "numRows": 20,
 *     "numCols": 10,
 *     "frozen": { "rows": 0, "cols": 0 }
 *   }],
 *   "meta": {}
 * }
 *
 * VARIABLE STORE INTEGRATION
 * Reading  →  =STORE("varname")
 * Writing  →  =EXPORT(expression, "varname")
 *             =EXPORT(expr, "varname", "scope")   scope: global (default), folder, folder:path, tag
 */

import { FileView, Menu, Notice, WorkspaceLeaf, TFile, setIcon } from "obsidian";
import { HyperFormula } from "hyperformula";
import { VariableStore, VariableVisibility } from "./VariableStore";

type TagResolver = (filePath: string) => string[];

export const ENGSHEET_VIEW_TYPE = "engsheet-view";
export const ENGSHEET_EXTENSION = "engsheet";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  wrap?: boolean;
  align?: "left" | "center" | "right";
  color?: string;
  bg?: string;
  format?: string;
  border?: "all" | "outer" | "none";
  borderTop?: boolean;
  borderRight?: boolean;
  borderBottom?: boolean;
  borderLeft?: boolean;
}

interface CellData {
  v: string | number | boolean | null;
  f: string | null;
  style?: CellStyle;
}

interface SheetData {
  name: string;
  cells: Record<string, CellData>;
  colWidths: Record<number, number>;
  rowHeights: Record<number, number>;
  numRows: number;
  numCols: number;
  frozen?: { rows: number; cols: number };
  tabColor?: string;
  hidden?: boolean;
}

interface EngSheetFile {
  version: number;
  sheets: SheetData[];
  meta: Record<string, unknown>;
}

interface Selection {
  r0: number; c0: number;
  r1: number; c1: number;
}

interface ClipboardData {
  cells: Record<string, CellData | null>;
  mode: "copy" | "cut";
  rows: number;
  cols: number;
  selR0?: number; selR1?: number;
  selC0?: number; selC1?: number;
}

interface UndoChange {
  r: number; c: number; sheetIdx: number;
  before: CellData | undefined;
  after: CellData | undefined;
}

interface UndoEntry {
  changes: UndoChange[];
}

interface NamedRangeDef {
  sheetIdx: number;
  range: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_COL_W = 120;
const DEFAULT_ROW_H = 24;
const ROW_HDR_W     = 44;
const COL_HDR_H     = 24;
const DEFAULT_ROWS  = 20;
const DEFAULT_COLS  = 10;

const NUMBER_FORMATS: [string, string][] = [
  ["General",    "General"],
  ["0",          "Integer"],
  ["0.0",        "1 decimal"],
  ["0.00",       "2 decimal"],
  ["0.000",      "3 decimal"],
  ["0.0000",     "4 decimal"],
  ["0.00000",    "5 decimal"],
  ["0.00E+00",   "Scientific (2dp)"],
  ["0.000E+00",  "Scientific (3dp)"],
  ["#,##0",      "Thousands"],
  ["#,##0.00",   "Thousands (2dp)"],
  ["0%",         "Percent"],
  ["0.00%",      "Percent (2dp)"],
];

const FORMULA_HINTS: Record<string, string> = {
  SUM: "SUM(number1, [number2], ...)",
  AVERAGE: "AVERAGE(number1, [number2], ...)",
  MIN: "MIN(number1, [number2], ...)",
  MAX: "MAX(number1, [number2], ...)",
  IF: "IF(condition, value_if_true, value_if_false)",
  ROUND: "ROUND(number, num_digits)",
  ABS: "ABS(number)",
  SQRT: "SQRT(number)",
  POWER: "POWER(number, power)",
  COUNT: "COUNT(value1, [value2], ...)",
  COUNTA: "COUNTA(value1, [value2], ...)",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function colLetter(idx: number): string {
  let s = "", i = idx + 1;
  while (i > 0) { const r = (i-1)%26; s = String.fromCharCode(65+r)+s; i = Math.floor((i-1)/26); }
  return s;
}

function parseAddr(addr: string): { row: number; col: number } | null {
  const m = addr.match(/^([A-Z]+)(\d+)$/i);
  if (!m) return null;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n*26 + ch.charCodeAt(0) - 64;
  return { col: n-1, row: parseInt(m[2])-1 };
}

function cellAddr(r: number, c: number): string {
  return colLetter(c) + (r+1);
}

function applyFormat(value: unknown, fmt?: string): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "number") return String(value);
  const f = fmt ?? "General";
  if (f === "General") {
    if (!isFinite(value)) return value > 0 ? "∞" : "-∞";
    const abs = Math.abs(value);
    if (abs === 0) return "0";
    if (Number.isInteger(value) && abs < 1e15) return value.toLocaleString();
    if (abs >= 1e6 || (abs < 1e-3 && abs > 0)) return value.toExponential(3);
    return parseFloat(value.toPrecision(6)).toString();
  }
  if (f === "0")         return Math.round(value).toString();
  if (f === "0.0")       return value.toFixed(1);
  if (f === "0.00")      return value.toFixed(2);
  if (f === "0.000")     return value.toFixed(3);
  if (f === "0.0000")    return value.toFixed(4);
  if (f === "0.00000")   return value.toFixed(5);
  if (f === "0.00E+00")  return value.toExponential(2);
  if (f === "0.000E+00") return value.toExponential(3);
  if (f === "#,##0")     return Math.round(value).toLocaleString();
  if (f === "#,##0.00")  return value.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
  if (f === "0%")        return (value*100).toFixed(0)+"%";
  if (f === "0.00%")     return (value*100).toFixed(2)+"%";
  return value.toString();
}

function emptySheet(name = "Sheet1"): SheetData {
  return { name, cells:{}, colWidths:{}, rowHeights:{}, numRows:DEFAULT_ROWS, numCols:DEFAULT_COLS, frozen:{rows:0,cols:0} };
}
function emptyFile(): EngSheetFile {
  return { version:1, sheets:[emptySheet()], meta:{} };
}

// ─── View ─────────────────────────────────────────────────────────────────────

export class EngSheetView extends FileView {
  private store: VariableStore;
  private fileData: EngSheetFile = emptyFile();
  private activeSheet = 0;
  private sel: Selection = { r0:0, c0:0, r1:0, c1:0 };
  private prevSel: Selection = { r0:0, c0:0, r1:0, c1:0 };
  private editingCell: { r:number; c:number } | null = null;
  private isDirty = false;
  private storeListener: (() => void) | null = null;
  private _suppressStoreListener = false;
  private clipboard: ClipboardData | null = null;
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;
  private colResizing = false;
  private hf: unknown = null;
  private activeRibbonTab: "home" | "data" | "view" = "home";
  private fillHandleEl: HTMLElement | null = null;
  private fillPreviewCells: HTMLTableCellElement[] = [];
  private renamingSheetIdx: number | null = null;
  private lastFindTerm = "";
  private lastReplaceTerm = "";
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private _batchEntry: UndoEntry | null = null;

  // Formula point mode — active while user types a formula and navigates cells
  private _formulaEditInput: HTMLInputElement | null = null;
  private _formulaPoint: { r0: number; c0: number; r1: number; c1: number } | null = null;
  private _formulaRefSpan: { start: number; end: number } | null = null;

  // Cached cell DOM references
  private cellEls: HTMLTableCellElement[][] = [];

  // DOM refs
  private nameBox!: HTMLInputElement;
  private formulaInput!: HTMLInputElement;
  private formulaHintEl!: HTMLElement;
  private findBarEl!: HTMLElement;
  private findInputEl!: HTMLInputElement;
  private replaceInputEl!: HTMLInputElement;
  private formulaSuggestId = `eng-formula-suggest-${Math.random().toString(36).slice(2)}`;
  private fmtSelect!: HTMLSelectElement;
  private gridScrollEl!: HTMLElement;
  private sheetTabsEl!: HTMLElement;
  private tableEl!: HTMLTableElement;
  private theadEl!: HTMLTableSectionElement;
  private tbodyEl!: HTMLTableSectionElement;
  private statusLeftEl!: HTMLElement;
  private statusInfoEl!: HTMLElement;
  private ribbonPanels: Partial<Record<string, HTMLElement>> = {};

  tagResolver?: TagResolver;

  constructor(leaf: WorkspaceLeaf, store: VariableStore, tagResolver?: TagResolver) {
    super(leaf);
    this.store = store;
    this.tagResolver = tagResolver;
  }

  getViewType() { return ENGSHEET_VIEW_TYPE; }
  getDisplayText() { return this.file?.basename ?? "Spreadsheet"; }
  getIcon() { return "table"; }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  async onLoadFile(file: TFile): Promise<void> {
    await this.loadHyperFormula();
    await this.readFileData(file);
    if (this.currentSheet()?.hidden) {
      const firstVisible = this.getVisibleSheetIndices()[0] ?? 0;
      this.activeSheet = firstVisible;
    }
    this.buildUI();
    this.rebuildHF();
    this.buildGrid();
    this.refreshAllCells();
    this.updateSelection();
    this.refreshFormulaBar();
    this.updateStatusBar();
    this.storeListener = () => {
      if (this._suppressStoreListener) return;
      this.rebuildHF();
      this.refreshAllFormulaCells();
    };
    this.store.on("change", this.storeListener);
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    if (this.storeListener) { this.store.off("change", this.storeListener); this.storeListener = null; }
    if (this.isDirty) await this.saveFile();
  }

  async onClose(): Promise<void> {
    if (this.storeListener) this.store.off("change", this.storeListener);
  }

  // ─── HyperFormula ────────────────────────────────────────────────────────────

  private async loadHyperFormula(): Promise<void> {
    // HyperFormula is bundled locally via npm/esbuild (no runtime CDN fetch).
    return Promise.resolve();
  }

  private rebuildHF(): void {
    const sheet = this.currentSheet();
    const data: (string | number | boolean | null)[][] =
      Array.from({ length: sheet.numRows }, () => Array(sheet.numCols).fill(null) as (string|number|boolean|null)[]);
    for (const [addr, cell] of Object.entries(sheet.cells)) {
      if (!cell) continue;
      const p = parseAddr(addr);
      if (!p || p.row >= sheet.numRows || p.col >= sheet.numCols) continue;
      data[p.row][p.col] = cell.f ? this.resolveCustomFuncs(cell.f) : (cell.v ?? null);
    }
    try {
      this.hf = HyperFormula.buildFromArray(data, { licenseKey: "gpl-v3" });
    } catch(e) { console.warn("[Engineer] HF error:", e); }
    this.processExports();
  }

  private updateHFCell(r: number, c: number): void {
    if (!this.hf) return;
    const cell = this.currentSheet().cells[cellAddr(r,c)];
    try {
      const hfInst = this.hf as { setCellContents: (addr: object, content: unknown) => void };
      const content = cell?.f ? this.resolveCustomFuncs(cell.f) : (cell?.v ?? null);
      hfInst.setCellContents({ sheet:0, row:r, col:c }, [[content]]);
    } catch { /* fall back to full rebuild */ }
    this.processExports();
  }

  private resolveCustomFuncs(formula: string): string {
    const filePath = this.file?.path;
    let f = formula.replace(/STORE\s*\(\s*["']([^"']+)["']\s*\)/gi, (_m, name) => {
      const val = this.store.get(name, filePath, this.tagResolver);
      if (val === undefined || val === null) return "0";
      if (typeof val === "number") return String(val);
      if (typeof val === "boolean") return val ? "TRUE" : "FALSE";
      return `"${String(val).replace(/"/g,'""')}"`;
    });
    f = f.replace(/EXPORT\s*\(\s*([^,]+?)\s*,\s*["'][^"']*["']\s*(?:,\s*["'][^"']*["']\s*)?\)/gi,
      (_m, expr) => expr.trim());
    return f;
  }

  private processExports(): void {
    const filePath = this.file?.path ?? "unknown";
    const sheet = this.currentSheet();
    const prevExported = new Set<string>(
      this.store.getAllEntries()
        .filter(e => e.entry.source === filePath && e.entry.block === "engsheet")
        .map(e => e.key)
    );
    const nowExported = new Set<string>();
    this._suppressStoreListener = true;
    try {
      for (const [addr, cell] of Object.entries(sheet.cells)) {
        if (!cell?.f) continue;
        const m = cell.f.match(/EXPORT\s*\(\s*[^,]+\s*,\s*["']([^"']+)["']\s*(?:,\s*["']([^"']*)["']\s*)?\)/i);
        if (!m) continue;
        nowExported.add(m[1]);
        const p = parseAddr(addr);
        if (!p) continue;
        const value = this.getComputedValue(p.row, p.col);
        if (value !== null && value !== undefined) {
          const rawScope = (m[2] ?? "global").trim();
          const lower = rawScope.toLowerCase();
          let vis: VariableVisibility = "global";
          let explicitFolder: string | undefined;
          if (lower.startsWith("folder:")) { vis = "folder"; explicitFolder = rawScope.slice(7).trim() || undefined; }
          else if (lower === "folder") { vis = "folder"; }
          else if (lower === "tag") { vis = "tag"; }
          this.store.set(m[1], value, undefined, filePath, "engsheet", "global", vis, undefined, explicitFolder);
        }
      }
      for (const name of prevExported) {
        if (!nowExported.has(name)) this.store.delete(name, filePath);
      }
    } finally {
      this._suppressStoreListener = false;
    }
  }

  private getComputedValue(r: number, c: number): string | number | boolean | null {
    const cell = this.currentSheet().cells[cellAddr(r,c)];
    if (this.hf && cell?.f) {
      try {
        const raw = (this.hf as { getCellValue: (a: object) => unknown })
          .getCellValue({ sheet:0, row:r, col:c });
        if (raw === null || raw === undefined) return null;
        if (typeof raw === "object") {
          if ("value" in (raw as object)) return (raw as { value: unknown }).value as string|number|boolean|null;
          return "#ERR";
        }
        return raw as string|number|boolean|null;
      } catch { return null; }
    }
    return cell?.v ?? null;
  }

  // ─── File I/O ────────────────────────────────────────────────────────────────

  private async readFileData(file: TFile): Promise<void> {
    try {
      const raw = await this.app.vault.read(file);
      if (!raw.trim()) { this.fileData = emptyFile(); return; }
      const parsed = JSON.parse(raw) as EngSheetFile;
      parsed.meta ??= {};
      for (const s of parsed.sheets) {
        s.cells ??= {}; s.colWidths ??= {}; s.rowHeights ??= {};
        s.numRows ??= DEFAULT_ROWS; s.numCols ??= DEFAULT_COLS;
        s.frozen ??= { rows: 0, cols: 0 };
        s.hidden ??= false;
      }
      this.fileData = parsed;
    } catch { this.fileData = emptyFile(); }
  }

  private async saveFile(): Promise<void> {
    if (!this.file) return;
    try {
      await this.app.vault.modify(this.file, JSON.stringify(this.fileData, null, 2));
      this.isDirty = false;
      this.setStatusLeft("Autosaved");
    } catch(e) { console.error("[Engineer] Save failed:", e); }
  }

  private markDirty(): void {
    this.isDirty = true;
    this.setStatusLeft("Saving…");
    clearTimeout(this._saveTimer!);
    this._saveTimer = setTimeout(() => this.saveFile(), 1500);
  }

  // ─── UI Shell ────────────────────────────────────────────────────────────────

  private buildUI(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("eng-sheet-container");
    container.oncontextmenu = (e) => e.preventDefault();
    this.buildToolbar(container);
    this.buildFormulaBar(container);
    this.buildFindReplaceBar(container);
    this.gridScrollEl = container.createDiv({ cls: "eng-sheet-grid" });
    this.buildStatusBar(container);
    this.buildSheetTabs(container);
  }

  // ─── Toolbar ─────────────────────────────────────────────────────────────────

  private buildToolbar(parent: HTMLElement): void {
    const toolbar = parent.createDiv({ cls: "eng-sheet-toolbar" });
    const tabBar  = toolbar.createDiv({ cls: "eng-ribbon-tab-bar" });
    const ribbonArea = toolbar.createDiv({ cls: "eng-ribbon-area" });

    const tabs: Array<{ id: "home"|"data"|"view"; label: string }> = [
      { id:"home",  label:"Home"  },
      { id:"data",  label:"Data"  },
      { id:"view",  label:"View"  },
    ];

    for (const t of tabs) {
      const panel = ribbonArea.createDiv({ cls: "eng-ribbon-panel" });
      panel.style.display = t.id === this.activeRibbonTab ? "flex" : "none";
      this.ribbonPanels[t.id] = panel;

      const tabBtn = tabBar.createEl("button", { text: t.label, cls: "eng-ribbon-tab" });
      if (t.id === this.activeRibbonTab) tabBtn.addClass("active");
      tabBtn.onclick = () => {
        tabBar.querySelectorAll<HTMLElement>(".eng-ribbon-tab").forEach(b => b.removeClass("active"));
        tabBtn.addClass("active");
        Object.values(this.ribbonPanels).forEach(p => p && (p.style.display = "none"));
        panel.style.display = "flex";
        this.activeRibbonTab = t.id;
      };
    }

    this.buildHomePanel(this.ribbonPanels.home!);
    this.buildDataPanel(this.ribbonPanels.data!);
    this.buildViewPanel(this.ribbonPanels.view!);
  }

  // ─── Ribbon groups ────────────────────────────────────────────────────────────

  private grp(panel: HTMLElement, label: string): HTMLElement {
    const g    = panel.createDiv({ cls: "eng-ribbon-group" });
    const body = g.createDiv({ cls: "eng-ribbon-group-body" });
    g.createDiv({ cls: "eng-ribbon-group-label", text: label });
    return body;
  }

  private rBtn(
    parent: HTMLElement,
    icon: string,
    title: string,
    action: () => void,
    label?: string,
    dataAttr?: string
  ): HTMLElement {
    const b = parent.createDiv({ cls: "eng-rbn-btn", title });
    if (dataAttr) b.dataset.fmtBtn = dataAttr;
    const iconEl = b.createDiv({ cls: "eng-rbn-icon" });
    setIcon(iconEl, icon);
    if (label) b.createDiv({ cls: "eng-rbn-label", text: label });
    b.onclick = action;
    return b;
  }

  private rSep(parent: HTMLElement): void {
    parent.createDiv({ cls: "eng-rbn-sep" });
  }

  private buildHomePanel(panel: HTMLElement): void {
    // Undo / Redo
    const ug = this.grp(panel, "History");
    this.rBtn(ug, "undo",  "Undo (Ctrl+Z)",       () => this.undo(),  "Undo");
    this.rBtn(ug, "redo",  "Redo (Ctrl+Y / ⇧Z)", () => this.redo(),  "Redo");

    // Clipboard
    const cg = this.grp(panel, "Clipboard");
    this.rBtn(cg, "clipboard",  "Paste (Ctrl+V)",    () => this.pasteClipboard(),      "Paste");
    this.rSep(cg);
    this.rBtn(cg, "scissors",   "Cut (Ctrl+X)",      () => this.cutSelection(),        "Cut");
    this.rBtn(cg, "copy",       "Copy (Ctrl+C)",     () => this.copySelectionFull(),   "Copy");

    // Font
    const fg = this.grp(panel, "Font");
    this.rBtn(fg, "bold",      "Bold (Ctrl+B)",      () => this.toggleFormat("bold"),      undefined, "bold");
    this.rBtn(fg, "italic",    "Italic (Ctrl+I)",    () => this.toggleFormat("italic"),    undefined, "italic");
    this.rBtn(fg, "underline", "Underline (Ctrl+U)", () => this.toggleFormat("underline"), undefined, "underline");
    this.rSep(fg);
    this.buildColorBtn(fg, "type",    "Font color", "color",  "#333333");
    this.buildColorBtn(fg, "droplet", "Fill color", "bg",     "#ffff00");

    // Alignment
    const ag = this.grp(panel, "Alignment");
    this.rBtn(ag, "align-left",   "Align left",    () => this.applyStyle(s => { s.align = "left";   }));
    this.rBtn(ag, "align-center", "Align center",  () => this.applyStyle(s => { s.align = "center"; }));
    this.rBtn(ag, "align-right",  "Align right",   () => this.applyStyle(s => { s.align = "right";  }));
    this.rSep(ag);
    this.rBtn(ag, "wrap-text",    "Wrap text",     () => this.toggleWrap(), undefined, "wrap");

    // Borders
    const bg = this.grp(panel, "Borders");
    this.rBtn(bg, "grid-3x3",  "All borders",   () => this.applyBorder("all"));
    this.rBtn(bg, "square",    "Outer border",  () => this.applyBorder("outer"));
    this.rBtn(bg, "minus",     "No borders",    () => this.applyBorder("none"));

    // Number
    const ng = this.grp(panel, "Number");
    this.fmtSelect = ng.createEl("select", { cls: "eng-fmt-select" });
    for (const [val, label] of NUMBER_FORMATS) {
      const opt = this.fmtSelect.createEl("option", { text: label });
      opt.value = val;
    }
    this.fmtSelect.onchange = () => {
      this.applyStyle(s => { s.format = this.fmtSelect.value; });
      this.refreshSelectionCells();
    };

    // Cells
    const cellG = this.grp(panel, "Cells");
    this.rBtn(cellG, "arrow-up-to-line",   "Insert row above",    () => this.insertRow());
    this.rBtn(cellG, "arrow-down-to-line", "Insert row below",    () => this.insertRowBelow());
    this.rBtn(cellG, "row-spacing",        "Delete row(s)",       () => this.deleteRow());
    this.rSep(cellG);
    this.rBtn(cellG, "arrow-left-to-line", "Insert column left",  () => this.insertCol());
    this.rBtn(cellG, "arrow-right-to-line","Insert column right", () => this.insertColRight());
    this.rBtn(cellG, "columns",            "Delete column(s)",    () => this.deleteCol());

    // Clear
    const clrG = this.grp(panel, "Clear");
    this.rBtn(clrG, "eraser",       "Clear contents (Delete)", () => this.clearSelection());
    this.rBtn(clrG, "paintbrush",   "Clear formatting",        () => this.clearFormatting());
  }

  private buildDataPanel(panel: HTMLElement): void {
    const sg = this.grp(panel, "Sort");
    this.rBtn(sg, "arrow-up-a-z",   "Sort A → Z (ascending)",  () => this.sortColumn(true),  "A → Z");
    this.rBtn(sg, "arrow-down-z-a", "Sort Z → A (descending)", () => this.sortColumn(false), "Z → A");

    const fg = this.grp(panel, "Find");
    this.rBtn(fg, "search", "Find in sheet (Ctrl+F)", () => this.openFindReplaceBar("find"), "Find");
    this.rBtn(fg, "replace", "Replace in sheet (Ctrl+H)", () => this.openFindReplaceBar("replace"), "Replace");

    const ng = this.grp(panel, "Names");
    this.rBtn(ng, "bookmark-plus", "Define named range from current selection", () => this.defineNamedRange(), "Define");
    this.rBtn(ng, "navigation", "Go to named range", () => this.goToNamedRange(), "Go To");
    this.rBtn(ng, "list", "Manage named ranges", () => this.manageNamedRanges(), "Manage");

    const ig = this.grp(panel, "CSV");
    this.rBtn(ig, "upload",   "Import CSV file into sheet at active cell", () => this.importCSV(),   "Import");
    this.rBtn(ig, "download", "Export sheet to CSV file",                  () => this.exportCSV(),   "Export");
  }

  private buildViewPanel(panel: HTMLElement): void {
    const fg = this.grp(panel, "Freeze Panes");
    this.rBtn(fg, "lock",   "Freeze top row",      () => this.freezeRows(1), "Top Row");
    this.rBtn(fg, "lock",   "Freeze first column", () => this.freezeCols(1), "First Col");
    this.rBtn(fg, "lock",   "Freeze panes at active cell", () => this.freezeAtSelection(), "At Cell");
    this.rBtn(fg, "unlock", "Unfreeze all",        () => this.unfreeze(),    "Unfreeze");
  }

  private buildColorBtn(
    parent: HTMLElement,
    icon: string,
    title: string,
    prop: "color" | "bg",
    defaultColor: string
  ): void {
    const wrap = parent.createDiv({ cls: "eng-rbn-color-btn", title });
    const iconEl = wrap.createDiv({ cls: "eng-rbn-icon" });
    setIcon(iconEl, icon);
    const bar = wrap.createDiv({ cls: "eng-rbn-color-bar" });
    bar.style.background = defaultColor;
    const input = wrap.createEl("input") as HTMLInputElement;
    input.type = "color"; input.value = defaultColor;
    input.className = "eng-rbn-color-input";
    input.oninput = () => {
      bar.style.background = input.value;
      this.applyStyle(s => { s[prop] = input.value; });
      this.refreshSelectionCells();
    };
  }

  // ─── Formula bar ─────────────────────────────────────────────────────────────

  private buildFormulaBar(parent: HTMLElement): void {
    const bar = parent.createDiv({ cls: "eng-formula-bar" });

    this.nameBox = bar.createEl("input", { cls: "eng-name-box" }) as HTMLInputElement;
    this.nameBox.type = "text";
    this.nameBox.spellcheck = false;
    this.nameBox.onkeydown = (e) => {
      if (e.key === "Enter") {
        const raw = this.nameBox.value.toUpperCase().trim();
        const p = parseAddr(raw);
        if (p) { this.setSelection(p.row, p.col, p.row, p.col); this.gridScrollEl.focus(); return; }
        const named = this.getNamedRanges()[raw];
        if (named) {
          const [a, b] = named.range.split(":");
          const p1 = parseAddr(a);
          const p2 = parseAddr(b ?? a);
          if (p1 && p2) {
            if (named.sheetIdx !== this.activeSheet) {
              this.activeSheet = named.sheetIdx;
              this.switchSheet();
            }
            this.setSelection(p1.row, p1.col, p2.row, p2.col);
            this.gridScrollEl.focus();
          }
        }
      }
    };

    const fx = bar.createDiv({ cls: "eng-fx-label" });
    setIcon(fx, "function-square");

    this.formulaInput = bar.createEl("input", { cls: "eng-formula-input" }) as HTMLInputElement;
    this.formulaInput.type = "text";
    this.formulaInput.spellcheck = false;
    this.formulaInput.setAttribute("list", this.formulaSuggestId);
    bar.createEl("datalist", { attr: { id: this.formulaSuggestId } });
    this.formulaInput.onkeydown = (e) => {
      if (e.key === "Enter")  { this.commitFormulaBar(); this.gridScrollEl.focus(); }
      if (e.key === "Escape") { this.refreshFormulaBar(); this.updateFillHandle(); this.gridScrollEl.focus(); }
    };
    this.formulaInput.oninput = () => this.updateFormulaAssist(this.formulaInput);
    this.formulaHintEl = parent.createDiv({ cls: "eng-formula-hint" });
    this.formulaHintEl.style.display = "none";
  }

  // ─── Status bar ──────────────────────────────────────────────────────────────

  private buildStatusBar(parent: HTMLElement): void {
    const bar = parent.createDiv({ cls: "eng-status-bar" });
    this.statusLeftEl  = bar.createDiv({ cls: "eng-status-left", text: "Autosaved" });
    this.statusInfoEl  = bar.createDiv({ cls: "eng-status-right" });
  }

  private setStatusLeft(text: string): void {
    if (this.statusLeftEl) this.statusLeftEl.textContent = text;
  }

  private updateStatusBar(): void {
    if (!this.statusInfoEl) return;
    this.statusInfoEl.empty();

    const { r0,c0,r1,c1 } = this.sel;
    const sR0=Math.min(r0,r1), sR1=Math.max(r0,r1);
    const sC0=Math.min(c0,c1), sC1=Math.max(c0,c1);
    const isRange = sR0!==sR1 || sC0!==sC1;

    const label = isRange
      ? `${cellAddr(sR0,sC0)}:${cellAddr(sR1,sC1)}`
      : cellAddr(sR0,sC0);
    this.statusInfoEl.createSpan({ cls:"eng-status-addr", text: label });

    if (isRange) {
      const nums: number[] = [];
      for (let r=sR0; r<=sR1; r++)
        for (let c=sC0; c<=sC1; c++) {
          const v = this.getComputedValue(r,c);
          if (typeof v === "number" && isFinite(v)) nums.push(v);
        }
      if (nums.length > 0) {
        const sum = nums.reduce((a,b)=>a+b,0);
        const avg = sum/nums.length;
        const min = Math.min(...nums);
        const max = Math.max(...nums);
        this.statusInfoEl.createSpan({
          cls: "eng-status-stats",
          text: `Sum: ${applyFormat(sum)} · Count: ${nums.length} · Avg: ${applyFormat(avg)} · Min: ${applyFormat(min)} · Max: ${applyFormat(max)}`,
        });
      } else {
        const total = (sR1-sR0+1)*(sC1-sC0+1);
        this.statusInfoEl.createSpan({ cls:"eng-status-stats", text:`Count: ${total}` });
      }
    }
  }

  // ─── Sheet tabs ───────────────────────────────────────────────────────────────

  private buildSheetTabs(parent: HTMLElement): void {
    this.sheetTabsEl = parent.createDiv({ cls: "eng-sheet-tabs" });
    this.renderTabs();
  }

  private renderTabs(): void {
    this.sheetTabsEl.empty();
    const addBtn = this.sheetTabsEl.createDiv({ cls: "eng-tab-add-btn", title: "New sheet" });
    setIcon(addBtn, "plus");
    addBtn.onclick = () => this.addSheet();
    const unhideBtn = this.sheetTabsEl.createDiv({ cls: "eng-tab-add-btn", title: "Unhide sheet" });
    setIcon(unhideBtn, "eye");
    unhideBtn.onclick = () => this.unhideSheetPrompt();

    const visible = this.getVisibleSheetIndices();
    visible.forEach((idx) => {
      const sheet = this.fileData.sheets[idx];
      const active = idx === this.activeSheet;
      const tab = this.sheetTabsEl.createDiv({ cls: "eng-sheet-tab" + (active ? " active" : "") });
      tab.dataset.sheetIdx = String(idx);
      tab.draggable = true;
      if (sheet.tabColor) {
        tab.style.background = sheet.tabColor;
        tab.style.color = "#fff";
      }
      let clickTimer: ReturnType<typeof setTimeout> | null = null;
      if (this.renamingSheetIdx === idx) {
        const input = tab.createEl("input", { cls: "eng-sheet-tab-rename-input" }) as HTMLInputElement;
        input.type = "text";
        input.value = sheet.name;
        let renameCommitted = false;
        const cancel = () => {
          renameCommitted = true;
          this.renamingSheetIdx = null;
          this.renderTabs();
        };
        const commit = () => {
          if (renameCommitted) return;
          renameCommitted = true;
          this.commitRenameSheet(idx, input.value);
        };
        input.onkeydown = (e) => {
          if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); commit(); }
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }
        };
        input.onblur = () => commit();
        requestAnimationFrame(() => {
          input.focus();
          input.select();
        });
      } else {
        tab.createSpan({ text: sheet.name });
      }
      tab.onclick       = () => {
        if (this.renamingSheetIdx !== null) return;
        if (clickTimer) clearTimeout(clickTimer);
        clickTimer = setTimeout(() => {
          clickTimer = null;
          this.activeSheet = idx;
          this.switchSheet();
        }, 160);
      };
      tab.ondblclick    = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (clickTimer) {
          clearTimeout(clickTimer);
          clickTimer = null;
        }
        this.renameSheet(idx);
      };
      tab.oncontextmenu = (e) => { e.preventDefault(); this.showSheetContextMenu(e, idx); };
      tab.ondragstart = (e) => {
        e.dataTransfer?.setData("text/plain", String(idx));
      };
      tab.ondragover = (e) => e.preventDefault();
      tab.ondrop = (e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer?.getData("text/plain"));
        if (Number.isFinite(from)) this.reorderSheet(from, idx);
      };
    });
  }

  private showSheetContextMenu(e: MouseEvent, idx: number): void {
    const menu = new Menu();
    menu.addItem(i => i.setTitle("Rename").onClick(()    => this.renameSheet(idx)));
    menu.addItem(i => i.setTitle("Duplicate").onClick(() => this.duplicateSheet(idx)));
    menu.addSeparator();
    menu.addItem(i => i.setTitle("Set tab color…").onClick(() => this.setSheetTabColor(idx)));
    menu.addItem(i => i.setTitle("Clear tab color").onClick(() => this.clearSheetTabColor(idx)));
    menu.addItem(i => i.setTitle("Hide").onClick(() => this.hideSheet(idx)));
    menu.addSeparator();
    menu.addItem(i => i.setTitle("Delete").onClick(() => this.deleteSheetAt(idx)));
    menu.showAtMouseEvent(e);
  }

  // ─── Grid — built once, updated in-place ─────────────────────────────────────

  private buildGrid(): void {
    this.fillHandleEl = null;
    this.fillPreviewCells = [];
    this.gridScrollEl.empty();
    this.cellEls = [];
    const sheet  = this.currentSheet();
    const frozen = sheet.frozen ?? { rows:0, cols:0 };

    this.tableEl = this.gridScrollEl.createEl("table") as HTMLTableElement;
    this.tableEl.addClass("eng-grid-table");
    this.tableEl.tabIndex = 0;

    // Column headers
    this.theadEl = this.tableEl.createEl("thead") as HTMLTableSectionElement;
    const hrow   = this.theadEl.createEl("tr");

    const corner = hrow.createEl("th", { cls: "eng-corner" });
    corner.style.width = corner.style.minWidth = ROW_HDR_W + "px";
    corner.style.height = COL_HDR_H + "px";
    corner.title = "Select all (Ctrl+A)";
    corner.onclick = () => this.selectAll();

    for (let c = 0; c < sheet.numCols; c++) {
      const w  = sheet.colWidths[c] ?? DEFAULT_COL_W;
      const th = hrow.createEl("th", { cls: "eng-col-hdr" + (c < frozen.cols ? " eng-frozen-col" : "") });
      th.style.width = th.style.minWidth = th.style.maxWidth = w + "px";
      th.style.height = COL_HDR_H + "px";
      if (c < frozen.cols) th.style.left = (ROW_HDR_W + this.frozenColOffset(sheet, c)) + "px";
      th.createEl("span", { text: colLetter(c) });
      const rh = th.createEl("div", { cls: "eng-col-resize" });
      rh.onmousedown = (e) => this.startColResize(e, c);
      rh.ondblclick = (e) => this.autoFitColumn(e, c);
      th.onclick = (e) => { if (!this.colResizing) this.selectCol(c, e.shiftKey); };
    }

    // Data rows
    this.tbodyEl = this.tableEl.createEl("tbody") as HTMLTableSectionElement;
    for (let r = 0; r < sheet.numRows; r++) {
      this.cellEls.push([]);
      const h  = sheet.rowHeights[r] ?? DEFAULT_ROW_H;
      const tr = this.tbodyEl.createEl("tr");
      tr.style.height = h + "px";

      const rh = tr.createEl("td", { cls: "eng-row-hdr" + (r < frozen.rows ? " eng-frozen-row" : "") });
      rh.style.width = rh.style.minWidth = ROW_HDR_W + "px";
      if (r < frozen.rows) rh.style.top = (COL_HDR_H + this.frozenRowOffset(sheet, r)) + "px";
      rh.setText(String(r+1));
      rh.onclick = (ev) => this.selectRow(r, ev.shiftKey);

      for (let c = 0; c < sheet.numCols; c++) {
        const w  = sheet.colWidths[c] ?? DEFAULT_COL_W;
        const td = tr.createEl("td", { cls: "eng-cell" }) as HTMLTableCellElement;
        td.dataset.r = String(r);
        td.dataset.c = String(c);
        td.style.width = td.style.minWidth = td.style.maxWidth = w + "px";
        td.style.height = h + "px";
        if (r < frozen.rows && c < frozen.cols) {
          td.addClass("eng-frozen-corner-cell");
          td.style.top  = (COL_HDR_H + this.frozenRowOffset(sheet, r)) + "px";
          td.style.left = (ROW_HDR_W + this.frozenColOffset(sheet, c)) + "px";
        } else if (r < frozen.rows) {
          td.addClass("eng-frozen-row-cell");
          td.style.top = (COL_HDR_H + this.frozenRowOffset(sheet, r)) + "px";
        } else if (c < frozen.cols) {
          td.addClass("eng-frozen-col-cell");
          td.style.left = (ROW_HDR_W + this.frozenColOffset(sheet, c)) + "px";
        }
        this.cellEls[r].push(td);

        td.onmousedown = (ev: MouseEvent) => {
          if (ev.button !== 0) return;
          // Formula point mode: clicking (or drag-selecting) a cell inserts its address
          if (this._formulaEditInput && this._formulaEditInput.value.startsWith("=")) {
            ev.preventDefault();
            ev.stopPropagation();
            this.startFormulaRefDrag(r, c);
            return;
          }
          ev.preventDefault();
          if (ev.shiftKey) this.extendSelection(r, c);
          else { this.setSelection(r, c, r, c); this.startMouseSelect(r, c); }
          this.tableEl.focus();
        };
        td.ondblclick    = () => this.startEdit(r, c, td);
        td.oncontextmenu = (ev: MouseEvent) => {
          ev.preventDefault();
          const { r0,c0,r1,c1 } = this.sel;
          const sR0=Math.min(r0,r1),sR1=Math.max(r0,r1),sC0=Math.min(c0,c1),sC1=Math.max(c0,c1);
          if (!(r>=sR0&&r<=sR1&&c>=sC0&&c<=sC1)) this.setSelection(r,c,r,c);
          this.showContextMenu(ev);
        };
      }
    }

    this.tableEl.onkeydown = (e) => this.handleKey(e);
    this.tableEl.addEventListener("keypress", (e) => {
      if (this.editingCell) return;
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
        const td = this.cellEls[this.sel.r1]?.[this.sel.c1];
        if (td) {
          delete this.currentSheet().cells[cellAddr(this.sel.r1, this.sel.c1)];
          this.startEdit(this.sel.r1, this.sel.c1, td, e.key);
          e.preventDefault();
        }
      }
    });

    // TSV paste fallback — handles drag-and-drop paste or browser-initiated paste events.
    // Ctrl+V is handled directly in handleKey via navigator.clipboard.readText().
    this.tableEl.addEventListener("paste", (e: ClipboardEvent) => {
      if (this.editingCell) return;
      if (this.clipboard) return;
      e.preventDefault();
      const text = e.clipboardData?.getData("text/plain") ?? "";
      if (!text) return;
      const delimiter = text.includes("\t") ? "\t" : ",";
      this.pasteExternalData(this.parseDelimited(text, delimiter as "\t" | ","));
    });
  }

  private frozenRowOffset(sheet: SheetData, upToRow: number): number {
    let offset = 0;
    for (let r = 0; r < upToRow; r++) offset += sheet.rowHeights[r] ?? DEFAULT_ROW_H;
    return offset;
  }

  private frozenColOffset(sheet: SheetData, upToCol: number): number {
    let offset = 0;
    for (let c = 0; c < upToCol; c++) offset += sheet.colWidths[c] ?? DEFAULT_COL_W;
    return offset;
  }

  // ─── Cell rendering ───────────────────────────────────────────────────────────

  private refreshCell(r: number, c: number): void {
    const td = this.cellEls[r]?.[c];
    if (!td) return;
    const sheet = this.currentSheet();
    const addr  = cellAddr(r, c);
    const cell  = sheet.cells[addr];
    const value = this.getComputedValue(r, c);
    const fmt   = cell?.style?.format;
    const isNum = typeof value === "number";
    const w     = sheet.colWidths[c] ?? DEFAULT_COL_W;
    const h     = sheet.rowHeights[r] ?? DEFAULT_ROW_H;

    td.style.width = td.style.minWidth = td.style.maxWidth = w + "px";
    td.style.height = h + "px";
    td.style.fontWeight     = cell?.style?.bold      ? "600"        : "";
    td.style.fontStyle      = cell?.style?.italic    ? "italic"     : "";
    td.style.textDecoration = cell?.style?.underline ? "underline"  : "";
    td.style.color          = cell?.style?.color     ?? "";
    td.style.backgroundColor= cell?.style?.bg        ?? "";
    td.style.textAlign      = cell?.style?.align     ?? (isNum ? "right" : "left");
    td.style.whiteSpace     = cell?.style?.wrap      ? "pre-wrap"   : "nowrap";

    // Border styling (supports legacy `border` and per-edge borders)
    const style = cell?.style;
    let top = !!style?.borderTop;
    let right = !!style?.borderRight;
    let bottom = !!style?.borderBottom;
    let left = !!style?.borderLeft;
    if (!top && !right && !bottom && !left) {
      if (style?.border === "all" || style?.border === "outer") {
        top = right = bottom = left = true;
      }
    }
    const borderCss = "1px solid var(--text-muted)";
    td.style.outline = "";
    td.style.boxShadow = "";
    td.style.borderTop = top ? borderCss : "";
    td.style.borderRight = right ? borderCss : "";
    td.style.borderBottom = bottom ? borderCss : "";
    td.style.borderLeft = left ? borderCss : "";

    // Formula dot indicator (top-right corner)
    const existing = td.querySelector(".eng-formula-dot");
    if (cell?.f) {
      if (!existing) {
        const dot = td.createEl("span", { cls: "eng-formula-dot" });
        dot.title = cell.f;
      } else {
        (existing as HTMLElement).title = cell.f;
      }
    } else {
      existing?.remove();
    }

    // Error styling
    const errStr = typeof value === "string" && value.startsWith("#");
    if (errStr) td.addClass("eng-cell-hf-error");
    else td.removeClass("eng-cell-hf-error");

    td.childNodes.forEach(n => { if (n.nodeType === Node.TEXT_NODE) n.remove(); });
    td.prepend(document.createTextNode(applyFormat(value, fmt)));
  }

  private refreshAllCells(): void {
    const sheet = this.currentSheet();
    for (let r = 0; r < sheet.numRows; r++)
      for (let c = 0; c < sheet.numCols; c++)
        this.refreshCell(r, c);
  }

  private refreshSelectionCells(): void {
    const { r0,c0,r1,c1 } = this.sel;
    for (let r=Math.min(r0,r1); r<=Math.max(r0,r1); r++)
      for (let c=Math.min(c0,c1); c<=Math.max(c0,c1); c++)
        this.refreshCell(r,c);
    this.markDirty();
  }

  private refreshAllFormulaCells(): void {
    const sheet = this.currentSheet();
    for (const [addr, cell] of Object.entries(sheet.cells)) {
      if (!cell?.f) continue;
      const p = parseAddr(addr);
      if (p) this.refreshCell(p.row, p.col);
    }
    this.refreshCell(this.sel.r1, this.sel.c1);
  }

  // ─── Selection ────────────────────────────────────────────────────────────────

  private updateSelection(): void {
    const { r0,c0,r1,c1 } = this.sel;
    const { r0:pr0,c0:pc0,r1:pr1,c1:pc1 } = this.prevSel;
    const sR0=Math.min(r0,r1),sR1=Math.max(r0,r1),sC0=Math.min(c0,c1),sC1=Math.max(c0,c1);
    const pR0=Math.min(pr0,pr1),pR1=Math.max(pr0,pr1),pC0=Math.min(pc0,pc1),pC1=Math.max(pc0,pc1);

    const wasIn = (r: number, c: number) => r>=pR0&&r<=pR1&&c>=pC0&&c<=pC1;
    const nowIn = (r: number, c: number) => r>=sR0&&r<=sR1&&c>=sC0&&c<=sC1;

    const rows = new Set<number>(), cols = new Set<number>();
    for (let r=Math.min(pR0,sR0); r<=Math.max(pR1,sR1); r++) rows.add(r);
    for (let c=Math.min(pC0,sC0); c<=Math.max(pC1,sC1); c++) cols.add(c);

    for (const r of rows) {
      for (const c of cols) {
        const was = wasIn(r,c), now = nowIn(r,c);
        const isAct = r===r1&&c===c1, wasPrevAct = r===pr1&&c===pc1;
        if (was!==now||isAct||wasPrevAct) {
          const td = this.cellEls[r]?.[c];
          if (!td) continue;
          const cell = this.currentSheet().cells[cellAddr(r,c)];
          const inClip = this.isInClipboard(r,c);
          td.style.backgroundColor = cell?.style?.bg ?? "";
          td.classList.toggle("eng-cell-selected", now && !isAct);
          td.classList.toggle("eng-cell-active",   isAct);
          td.style.opacity = (inClip && this.clipboard?.mode === "cut") ? "0.4" : "1";
          td.classList.toggle("eng-cell-cut", inClip && this.clipboard?.mode === "cut");
        }
      }
    }

    // Row headers
    const allTrs = this.tbodyEl?.querySelectorAll("tr");
    for (const r of rows) {
      const rh = allTrs?.[r]?.querySelector("td") as HTMLElement | null;
      if (!rh) continue;
      rh.classList.toggle("eng-hdr-sel", nowIn(r, sC0));
    }
    // Col headers
    const allThs = this.theadEl?.querySelectorAll("th");
    for (const c of cols) {
      const th = allThs?.[c+1] as HTMLElement | null;
      if (!th) continue;
      th.classList.toggle("eng-hdr-sel", nowIn(sR0, c));
    }

    this.prevSel = { ...this.sel };
    this.updateStatusBar();
    this.updateFillHandle();
  }

  private setSelection(r0: number, c0: number, r1: number, c1: number): void {
    const s = this.currentSheet();
    this.prevSel = { ...this.sel };
    this.sel = {
      r0: Math.max(0, Math.min(r0, s.numRows-1)),
      c0: Math.max(0, Math.min(c0, s.numCols-1)),
      r1: Math.max(0, Math.min(r1, s.numRows-1)),
      c1: Math.max(0, Math.min(c1, s.numCols-1)),
    };
    this.editingCell = null;
    this.updateSelection();
    this.refreshFormulaBar();
    this.syncFormatControls();
    this.cellEls[this.sel.r1]?.[this.sel.c1]?.scrollIntoView({ block:"nearest", inline:"nearest" });
  }

  private extendSelection(r: number, c: number): void {
    const s = this.currentSheet();
    this.prevSel = { ...this.sel };
    this.sel.r1 = Math.max(0, Math.min(r, s.numRows-1));
    this.sel.c1 = Math.max(0, Math.min(c, s.numCols-1));
    this.updateSelection();
    this.refreshFormulaBar();
    this.updateStatusBar();
  }

  private selectAll(): void {
    const s = this.currentSheet();
    this.setSelection(0, 0, s.numRows-1, s.numCols-1);
  }

  private selectRow(r: number, shift: boolean): void {
    const s = this.currentSheet();
    if (shift) { this.prevSel={...this.sel}; this.sel.r1=r; this.sel.c0=0; this.sel.c1=s.numCols-1; this.updateSelection(); }
    else this.setSelection(r, 0, r, s.numCols-1);
  }

  private selectCol(c: number, shift: boolean): void {
    const s = this.currentSheet();
    if (shift) { this.prevSel={...this.sel}; this.sel.c1=c; this.sel.r0=0; this.sel.r1=s.numRows-1; this.updateSelection(); }
    else this.setSelection(0, c, s.numRows-1, c);
  }

  private startMouseSelect(_startR: number, _startC: number): void {
    const doc = this.tableEl.ownerDocument;
    let frame = 0;
    let pendingR: number | null = null;
    let pendingC: number | null = null;
    const flush = () => {
      frame = 0;
      if (pendingR === null || pendingC === null) return;
      this.extendSelection(pendingR, pendingC);
      pendingR = null;
      pendingC = null;
    };
    const onMove = (e: MouseEvent) => {
      const el = doc.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const td = el?.closest?.("td") as HTMLTableCellElement | null;
      if (!td || td.closest("table") !== this.tableEl) return;
      const r = Number(td.dataset.r);
      const c = Number(td.dataset.c);
      if (!Number.isFinite(r) || !Number.isFinite(c)) return;
      pendingR = r;
      pendingC = c;
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const onUp = () => {
      if (frame) cancelAnimationFrame(frame);
      flush();
      doc.removeEventListener("mousemove", onMove);
      doc.removeEventListener("mouseup", onUp);
    };
    doc.addEventListener("mousemove", onMove);
    doc.addEventListener("mouseup", onUp);
  }

  // ─── Context menu ─────────────────────────────────────────────────────────────

  private showContextMenu(e: MouseEvent): void {
    const menu = new Menu();
    menu.addItem(i => i.setTitle("Cut").setIcon("scissors").onClick(()     => this.cutSelection()));
    menu.addItem(i => i.setTitle("Copy").setIcon("copy").onClick(()        => this.copySelectionFull()));
    menu.addItem(i => i.setTitle("Paste").setIcon("clipboard").onClick(()  => this.pasteClipboard()));
    menu.addSeparator();
    menu.addItem(i => i.setTitle("Insert row above").onClick(()   => this.insertRow()));
    menu.addItem(i => i.setTitle("Insert row below").onClick(()   => this.insertRowBelow()));
    menu.addItem(i => i.setTitle("Delete row(s)").onClick(()      => this.deleteRow()));
    menu.addSeparator();
    menu.addItem(i => i.setTitle("Insert column left").onClick(()  => this.insertCol()));
    menu.addItem(i => i.setTitle("Insert column right").onClick(() => this.insertColRight()));
    menu.addItem(i => i.setTitle("Delete column(s)").onClick(()    => this.deleteCol()));
    menu.addSeparator();
    menu.addItem(i => i.setTitle("Sort A → Z").setIcon("arrow-up-a-z").onClick(()   => this.sortColumn(true)));
    menu.addItem(i => i.setTitle("Sort Z → A").setIcon("arrow-down-z-a").onClick(() => this.sortColumn(false)));
    menu.addSeparator();
    menu.addItem(i => i.setTitle("Clear contents").setIcon("eraser").onClick(()      => this.clearSelection()));
    menu.addItem(i => i.setTitle("Clear formatting").setIcon("paintbrush").onClick(() => this.clearFormatting()));
    menu.addSeparator();
    menu.addItem(i => i.setTitle("Copy engtable reference").setIcon("copy").onClick(() => this.copyEngTableReferenceToClipboard()));
    menu.addSeparator();
    menu.addItem(i => i.setTitle("Export to Variable Store…").setIcon("upload").onClick(() => this.promptExportCell()));
    menu.showAtMouseEvent(e);
  }

  // ─── Clipboard ────────────────────────────────────────────────────────────────

  private copySelectionFull(): void {
    const { r0,c0,r1,c1 } = this.sel;
    const sR0=Math.min(r0,r1),sR1=Math.max(r0,r1),sC0=Math.min(c0,c1),sC1=Math.max(c0,c1);
    const cells: Record<string, CellData|null> = {};
    const sheet = this.currentSheet();
    const lines: string[] = [];
    for (let r=sR0; r<=sR1; r++) {
      const row: string[] = [];
      for (let c=sC0; c<=sC1; c++) {
        const addr = cellAddr(r,c);
        cells[cellAddr(r-sR0,c-sC0)] = sheet.cells[addr] ? {...sheet.cells[addr]} : null;
        row.push(String(this.getComputedValue(r,c) ?? ""));
      }
      lines.push(row.join("\t"));
    }
    this.clipboard = { cells, mode:"copy", rows:sR1-sR0+1, cols:sC1-sC0+1, selR0:sR0,selR1:sR1,selC0:sC0,selC1:sC1 };
    navigator.clipboard?.writeText(lines.join("\n")).catch(()=>{});
    const nCells = (sR1-sR0+1) * (sC1-sC0+1);
    this.flashStatus(`Copied ${nCells} cell${nCells !== 1 ? "s" : ""} as TSV`);
  }

  private cutSelection(): void {
    this.copySelectionFull();
    if (this.clipboard) this.clipboard.mode = "cut";
  }

  private pasteClipboard(): void {
    if (!this.clipboard) return;
    this.startUndoBatch();
    const { r1,c1 } = this.sel;
    const { cells,rows,cols,mode } = this.clipboard;
    const sheet = this.currentSheet();
    const affected: Array<[number,number]> = [];
    for (let dr=0; dr<rows; dr++) {
      for (let dc=0; dc<cols; dc++) {
        const destR = r1+dr, destC = c1+dc;
        const dest = cellAddr(destR, destC);
        const before = sheet.cells[dest] ? JSON.parse(JSON.stringify(sheet.cells[dest])) as CellData : undefined;
        const src  = cells[cellAddr(dr,dc)];
        if (src) sheet.cells[dest] = {...src};
        else delete sheet.cells[dest];
        this.recordCellChange(destR, destC, before);
        affected.push([destR, destC]);
      }
    }
    if (mode==="cut" && this.clipboard.selR0 !== undefined) {
      for (let r=this.clipboard.selR0; r<=this.clipboard.selR1!; r++)
        for (let c=this.clipboard.selC0!; c<=this.clipboard.selC1!; c++) {
          const addr = cellAddr(r,c);
          const before = sheet.cells[addr] ? JSON.parse(JSON.stringify(sheet.cells[addr])) as CellData : undefined;
          delete sheet.cells[addr];
          this.recordCellChange(r, c, before);
          affected.push([r,c]);
        }
      this.clipboard = null;
    }
    this.commitUndoBatch();
    const hasFormulas = affected.some(([r,c]) => sheet.cells[cellAddr(r,c)]?.f);
    if (hasFormulas) {
      this.rebuildHF();
      this.refreshAllFormulaCells();
      affected.forEach(([r,c]) => this.refreshCell(r,c));
    } else {
      affected.forEach(([r,c]) => this.refreshCell(r,c));
    }
    this.markDirty();
  }

  private isInClipboard(r: number, c: number): boolean {
    if (!this.clipboard || this.clipboard.selR0 === undefined) return false;
    return r>=this.clipboard.selR0!&&r<=this.clipboard.selR1!&&c>=this.clipboard.selC0!&&c<=this.clipboard.selC1!;
  }

  private clearSelection(): void {
    this.startUndoBatch();
    const { r0,c0,r1,c1 } = this.sel;
    const sheet = this.currentSheet();
    for (let r=Math.min(r0,r1); r<=Math.max(r0,r1); r++)
      for (let c=Math.min(c0,c1); c<=Math.max(c0,c1); c++) {
        const addr = cellAddr(r,c);
        const before = sheet.cells[addr] ? JSON.parse(JSON.stringify(sheet.cells[addr])) as CellData : undefined;
        const cell = sheet.cells[addr];
        if (cell?.style && Object.keys(cell.style).length > 0)
          sheet.cells[addr] = { v:null, f:null, style:cell.style };
        else delete sheet.cells[addr];
        this.recordCellChange(r, c, before);
        this.refreshCell(r,c);
      }
    this.commitUndoBatch();
    this.markDirty();
  }

  private clearFormatting(): void {
    this.startUndoBatch();
    const { r0,c0,r1,c1 } = this.sel;
    const sheet = this.currentSheet();
    for (let r=Math.min(r0,r1); r<=Math.max(r0,r1); r++)
      for (let c=Math.min(c0,c1); c<=Math.max(c0,c1); c++) {
        const addr = cellAddr(r,c);
        const before = sheet.cells[addr] ? JSON.parse(JSON.stringify(sheet.cells[addr])) as CellData : undefined;
        if (sheet.cells[addr])
          sheet.cells[addr] = { v:sheet.cells[addr].v, f:sheet.cells[addr].f };
        this.recordCellChange(r, c, before);
        this.refreshCell(r,c);
      }
    this.commitUndoBatch();
    this.markDirty();
  }

  // ─── Editing ─────────────────────────────────────────────────────────────────

  private refreshFormulaBar(): void {
    const { r1,c1 } = this.sel;
    this.nameBox.value = cellAddr(r1,c1);
    const cell = this.currentSheet().cells[cellAddr(r1,c1)];
    this.formulaInput.value = cell?.f ?? (cell?.v !== null && cell?.v !== undefined ? String(cell.v) : "");
    this.updateFormulaAssist(this.formulaInput);
  }

  private commitFormulaBar(): void {
    this.setCellRaw(this.sel.r1, this.sel.c1, this.formulaInput.value);
  }

  private startEdit(r: number, c: number, td: HTMLElement, initialChar: string | null = null): void {
    this.editingCell = { r, c };
    const addr = cellAddr(r,c);
    const cell = this.currentSheet().cells[addr];
    const current = cell?.f ?? (cell?.v !== null && cell?.v !== undefined ? String(cell.v) : "");

    const origContent = td.innerHTML;
    const origPad     = td.style.padding;
    td.style.padding  = "0";
    td.style.overflow = "visible";
    td.innerHTML      = "";

    const input = td.createEl("input", { cls: "eng-cell-edit-input" }) as HTMLInputElement;
    input.type  = "text";
    input.spellcheck = false;
    input.setAttribute("list", this.formulaSuggestId);
    input.value = initialChar !== null ? initialChar : current;
    input.focus();
    if (initialChar === null) input.select(); else input.setSelectionRange(1,1);

    this.formulaInput.value = input.value;
    this._formulaEditInput = input;
    this.updateFormulaAssist(input);

    input.oninput = () => {
      // Any typed character exits formula point mode
      if (this._formulaPoint) {
        this._formulaPoint = null;
        this._formulaRefSpan = null;
        this.clearFormulaPointHighlight();
      }
      this.formulaInput.value = input.value;
      this.updateFormulaAssist(input);
    };

    // Restore cell to a clean state before refreshCell runs — otherwise the
    // <input> element remains in the <td> after commit, appearing as a box over the value.
    const restoreCell = () => {
      td.empty();
      td.style.padding  = origPad;
      td.style.overflow = "hidden";
    };

    const exitFormulaPoint = () => {
      this._formulaEditInput = null;
      this._formulaPoint = null;
      this._formulaRefSpan = null;
      this.clearFormulaPointHighlight();
    };

    // Guards against double-commit: onblur can fire after Enter/Tab already called commit
    let committed = false;

    const commit = (newR: number, newC: number) => {
      if (committed) return;
      committed = true;
      const val = input.value;
      this.editingCell = null;
      exitFormulaPoint();
      restoreCell();
      this.setCellRaw(r, c, val);
      this.setSelection(newR, newC, newR, newC);
      this.tableEl?.focus();
    };

    const cancel = () => {
      committed = true;
      this.editingCell = null;
      exitFormulaPoint();
      td.innerHTML      = origContent;
      td.style.padding  = origPad;
      td.style.overflow = "hidden";
      // origContent may have re-inserted a fill-handle element from HTML without its
      // event listeners. Re-run updateFillHandle to replace it with a wired one.
      this.updateFillHandle();
      this.tableEl.focus();
    };

    input.onkeydown = (e) => {
      if (e.key==="Enter")  { e.preventDefault(); e.stopPropagation(); commit(r+1,c); return; }
      if (e.key==="Tab")    { e.preventDefault(); e.stopPropagation(); commit(r,c+(e.shiftKey?-1:1)); return; }
      if (e.key==="Escape") { e.preventDefault(); e.stopPropagation(); cancel(); return; }
      // Formula point mode: arrow keys navigate cells and insert cell references
      if (["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(e.key) && input.value.startsWith("=")) {
        const pos = input.selectionStart ?? input.value.length;
        const before = input.value.slice(0, pos);
        const inRefContext = /[(,=+\-*/^&:\s]$/.test(before) || this._formulaPoint !== null;
        if (inRefContext) {
          e.preventDefault();
          e.stopPropagation();
          this.handleFormulaArrow(e.key, e.shiftKey, input);
          return;
        }
      }
    };
    // Fix: removed the extra editingCell check — setSelection() clears editingCell before
    // blur fires, so the old check prevented commit when clicking away from the cell.
    input.onblur = () => {
      if (committed) return;
      committed = true;
      this.editingCell = null;
      exitFormulaPoint();
      restoreCell();
      this.setCellRaw(r, c, input.value);
    };
  }

  // ─── Formula point mode (arrow / click to insert cell refs during formula entry) ─

  private handleFormulaArrow(key: string, shift: boolean, input: HTMLInputElement): void {
    const sheet = this.currentSheet();
    if (!this._formulaPoint) {
      // Enter point mode: initialize reference at the active cell
      const pos = input.selectionStart ?? input.value.length;
      const addr = cellAddr(this.sel.r1, this.sel.c1);
      const before = input.value.slice(0, pos);
      const after  = input.value.slice(pos);
      input.value = before + addr + after;
      this._formulaRefSpan = { start: pos, end: pos + addr.length };
      this._formulaPoint   = { r0: this.sel.r1, c0: this.sel.c1, r1: this.sel.r1, c1: this.sel.c1 };
      input.setSelectionRange(this._formulaRefSpan.end, this._formulaRefSpan.end);
      this.formulaInput.value = input.value;
      this.highlightFormulaPoint();
      return;
    }

    const { r0, c0, r1, c1 } = this._formulaPoint;
    let nr1 = r1, nc1 = c1;
    if (key === "ArrowUp")    nr1 = Math.max(0, r1 - 1);
    if (key === "ArrowDown")  nr1 = Math.min(sheet.numRows - 1, r1 + 1);
    if (key === "ArrowLeft")  nc1 = Math.max(0, c1 - 1);
    if (key === "ArrowRight") nc1 = Math.min(sheet.numCols - 1, c1 + 1);

    if (shift) {
      this._formulaPoint = { r0, c0, r1: nr1, c1: nc1 };
    } else {
      this._formulaPoint = { r0: nr1, c0: nc1, r1: nr1, c1: nc1 };
    }

    const { r0: pr0, c0: pc0, r1: pr1, c1: pc1 } = this._formulaPoint;
    const addr = (pr0 !== pr1 || pc0 !== pc1)
      ? `${cellAddr(Math.min(pr0,pr1), Math.min(pc0,pc1))}:${cellAddr(Math.max(pr0,pr1), Math.max(pc0,pc1))}`
      : cellAddr(pr0, pc0);

    if (this._formulaRefSpan) {
      const { start } = this._formulaRefSpan;
      input.value = input.value.slice(0, start) + addr + input.value.slice(this._formulaRefSpan.end);
      this._formulaRefSpan = { start, end: start + addr.length };
      input.setSelectionRange(this._formulaRefSpan.end, this._formulaRefSpan.end);
    }
    this.formulaInput.value = input.value;
    this.highlightFormulaPoint();
    // Scroll the referenced cell into view
    this.cellEls[pr1]?.[pc1]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  private startFormulaRefDrag(startR: number, startC: number): void {
    // Insert the initial single-cell reference, then track drag to extend to a range.
    this.insertFormulaRefClick(startR, startC);
    const doc = this.tableEl.ownerDocument;

    const onMove = (e: MouseEvent) => {
      const el = doc.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const tdEl = el?.closest?.("td") as HTMLTableCellElement | null;
      if (!tdEl || tdEl.closest("table") !== this.tableEl) return;
      const r = Number(tdEl.dataset.r);
      const c = Number(tdEl.dataset.c);
      if (r < 0 || c < 0 || !this._formulaPoint || !this._formulaRefSpan) return;

      this._formulaPoint = { r0: startR, c0: startC, r1: r, c1: c };
      const { r0, c0, r1, c1 } = this._formulaPoint;
      const addr = (r0 !== r1 || c0 !== c1)
        ? `${cellAddr(Math.min(r0,r1), Math.min(c0,c1))}:${cellAddr(Math.max(r0,r1), Math.max(c0,c1))}`
        : cellAddr(r0, c0);
      const input = this._formulaEditInput!;
      const { start } = this._formulaRefSpan;
      input.value = input.value.slice(0, start) + addr + input.value.slice(this._formulaRefSpan.end);
      this._formulaRefSpan = { start, end: start + addr.length };
      input.setSelectionRange(this._formulaRefSpan.end, this._formulaRefSpan.end);
      this.formulaInput.value = input.value;
      this.highlightFormulaPoint();
    };

    const onUp = () => {
      doc.removeEventListener("mousemove", onMove);
      doc.removeEventListener("mouseup", onUp);
      this._formulaEditInput?.focus();
    };

    doc.addEventListener("mousemove", onMove);
    doc.addEventListener("mouseup", onUp);
  }

  private insertFormulaRefClick(r: number, c: number): void {
    const input = this._formulaEditInput;
    if (!input) return;
    const addr = cellAddr(r, c);
    if (this._formulaRefSpan) {
      const { start } = this._formulaRefSpan;
      input.value = input.value.slice(0, start) + addr + input.value.slice(this._formulaRefSpan.end);
      this._formulaRefSpan = { start, end: start + addr.length };
      input.setSelectionRange(this._formulaRefSpan.end, this._formulaRefSpan.end);
    } else {
      const pos = input.selectionStart ?? input.value.length;
      const before = input.value.slice(0, pos);
      const after  = input.value.slice(pos);
      input.value = before + addr + after;
      this._formulaRefSpan = { start: pos, end: pos + addr.length };
      input.setSelectionRange(this._formulaRefSpan.end, this._formulaRefSpan.end);
    }
    this._formulaPoint = { r0: r, c0: c, r1: r, c1: c };
    this.formulaInput.value = input.value;
    this.highlightFormulaPoint();
    input.focus();
  }

  private highlightFormulaPoint(): void {
    this.clearFormulaPointHighlight();
    if (!this._formulaPoint) return;
    const { r0, c0, r1, c1 } = this._formulaPoint;
    for (let rr = Math.min(r0,r1); rr <= Math.max(r0,r1); rr++)
      for (let cc = Math.min(c0,c1); cc <= Math.max(c0,c1); cc++)
        this.cellEls[rr]?.[cc]?.classList.add("eng-formula-ref");
  }

  private clearFormulaPointHighlight(): void {
    this.containerEl.querySelectorAll(".eng-formula-ref")
      .forEach(el => el.classList.remove("eng-formula-ref"));
  }

  private setCellRaw(r: number, c: number, raw: string): void {
    const addr     = cellAddr(r,c);
    const sheet    = this.currentSheet();
    const existing = sheet.cells[addr];
    const before   = existing ? JSON.parse(JSON.stringify(existing)) as CellData : undefined;
    const wasFormula = !!existing?.f;

    if (!raw.trim()) {
      if (existing?.style && Object.keys(existing.style).length > 0)
        sheet.cells[addr] = { v:null, f:null, style:existing.style };
      else delete sheet.cells[addr];
    } else if (raw.startsWith("=")) {
      sheet.cells[addr] = { v:null, f:raw, style:existing?.style };
    } else {
      const n = Number(raw);
      sheet.cells[addr] = { v: isNaN(n) ? raw : n, f:null, style:existing?.style };
    }

    this.recordCellChange(r, c, before);

    const isFormula = !!sheet.cells[addr]?.f;
    if (isFormula || wasFormula) {
      this.updateHFCell(r, c);
      this.refreshAllFormulaCells();
    } else {
      this.refreshCell(r, c);
    }
    this.markDirty();
    this.refreshFormulaBar();
  }

  // ─── Keyboard ─────────────────────────────────────────────────────────────────

  private handleKey(e: KeyboardEvent): void {
    if (this.editingCell) return;
    const { r1,c1 } = this.sel;
    if (e.ctrlKey || e.metaKey) {
      if (e.key === " ") { e.preventDefault(); this.selectCol(c1, e.shiftKey); return; }
      if (e.key === "ArrowUp")    { e.preventDefault(); this.ctrlNavigate("up", e.shiftKey); return; }
      if (e.key === "ArrowDown")  { e.preventDefault(); this.ctrlNavigate("down", e.shiftKey); return; }
      if (e.key === "ArrowLeft")  { e.preventDefault(); this.ctrlNavigate("left", e.shiftKey); return; }
      if (e.key === "ArrowRight") { e.preventDefault(); this.ctrlNavigate("right", e.shiftKey); return; }
      switch(e.key.toLowerCase()) {
        case "f": e.preventDefault(); this.openFindReplaceBar("find"); return;
        case "h": e.preventDefault(); this.openFindReplaceBar("replace"); return;
        case "c": e.preventDefault(); this.copySelectionFull(); return;
        case "x": e.preventDefault(); this.cutSelection(); return;
        case "v":
          e.preventDefault();
          if (this.clipboard) {
            this.pasteClipboard();
          } else {
            // Read system clipboard directly so TSV from Google Sheets / Excel works.
            // (e.preventDefault() on keydown suppresses the paste event, so we must
            // read the clipboard explicitly here rather than relying on that event.)
            navigator.clipboard.readText().then(text => {
              if (!text) return;
              const delim = text.includes("\t") ? "\t" : ",";
              this.pasteExternalData(this.parseDelimited(text, delim as "\t" | ","));
            }).catch(() => {});
          }
          return;
        case "b": e.preventDefault(); this.toggleFormat("bold"); return;
        case "i": e.preventDefault(); this.toggleFormat("italic"); return;
        case "u": e.preventDefault(); this.toggleFormat("underline"); return;
        case "s": e.preventDefault(); this.saveFile(); return;
        case "a": e.preventDefault(); this.selectAll(); return;
        case "home": e.preventDefault(); this.setSelection(0,0,0,0); return;
        case "end": {
          e.preventDefault();
          const last = this.findLastUsedCell();
          this.setSelection(last.r, last.c, last.r, last.c);
          return;
        }
        case "z":
          e.preventDefault();
          if (e.shiftKey) this.redo(); else this.undo();
          return;
        case "y": e.preventDefault(); this.redo(); return;
      }
    }
    switch(e.key) {
      case " ":
        if (e.shiftKey) {
          e.preventDefault();
          this.selectRow(r1, true);
        }
        break;
      case "ArrowUp":    e.preventDefault(); e.shiftKey?this.extendSelection(r1-1,c1):this.setSelection(r1-1,c1,r1-1,c1); break;
      case "ArrowDown":  e.preventDefault(); e.shiftKey?this.extendSelection(r1+1,c1):this.setSelection(r1+1,c1,r1+1,c1); break;
      case "ArrowLeft":  e.preventDefault(); e.shiftKey?this.extendSelection(r1,c1-1):this.setSelection(r1,c1-1,r1,c1-1); break;
      case "ArrowRight": e.preventDefault(); e.shiftKey?this.extendSelection(r1,c1+1):this.setSelection(r1,c1+1,r1,c1+1); break;
      case "Tab":   e.preventDefault(); e.shiftKey?this.setSelection(r1,c1-1,r1,c1-1):this.setSelection(r1,c1+1,r1,c1+1); break;
      case "Enter": e.preventDefault(); e.shiftKey?this.setSelection(r1-1,c1,r1-1,c1):this.setSelection(r1+1,c1,r1+1,c1); break;
      case "Home": e.preventDefault(); e.shiftKey ? this.extendSelection(r1, 0) : this.setSelection(r1, 0, r1, 0); break;
      case "End": {
        e.preventDefault();
        const targetC = this.findRowEndCell(r1);
        e.shiftKey ? this.extendSelection(r1, targetC) : this.setSelection(r1, targetC, r1, targetC);
        break;
      }
      case "Delete": case "Backspace": e.preventDefault(); this.clearSelection(); break;
      case "F2": { e.preventDefault(); const td=this.cellEls[r1]?.[c1]; if(td) this.startEdit(r1,c1,td); break; }
      case "Escape": this.clipboard=null; break;
    }
  }

  // ─── Formatting ───────────────────────────────────────────────────────────────

  private applyStyle(updater: (style: CellStyle) => void): void {
    this.startUndoBatch();
    const { r0,c0,r1,c1 } = this.sel;
    const sheet = this.currentSheet();
    for (let r=Math.min(r0,r1); r<=Math.max(r0,r1); r++)
      for (let c=Math.min(c0,c1); c<=Math.max(c0,c1); c++) {
        const addr = cellAddr(r,c);
        const before = sheet.cells[addr] ? JSON.parse(JSON.stringify(sheet.cells[addr])) as CellData : undefined;
        if (!sheet.cells[addr]) sheet.cells[addr] = { v:null, f:null };
        sheet.cells[addr].style ??= {};
        updater(sheet.cells[addr].style!);
        this.refreshCell(r,c);
        this.recordCellChange(r, c, before);
      }
    this.commitUndoBatch();
    this.markDirty();
    this.syncFormatControls();
  }

  private toggleFormat(prop: "bold"|"italic"|"underline"): void {
    const { r1,c1 } = this.sel;
    const current = this.currentSheet().cells[cellAddr(r1,c1)]?.style?.[prop] ?? false;
    this.applyStyle(s => { s[prop] = !current; });
  }

  private toggleWrap(): void {
    const { r1,c1 } = this.sel;
    const current = this.currentSheet().cells[cellAddr(r1,c1)]?.style?.wrap ?? false;
    this.applyStyle(s => { s.wrap = !current; });
  }

  private applyBorder(border: "all"|"outer"|"none"): void {
    const { r0,c0,r1,c1 } = this.sel;
    const sR0=Math.min(r0,r1), sR1=Math.max(r0,r1), sC0=Math.min(c0,c1), sC1=Math.max(c0,c1);
    const sheet = this.currentSheet();
    this.startUndoBatch();
    for (let r=sR0; r<=sR1; r++) {
      for (let c=sC0; c<=sC1; c++) {
        const addr = cellAddr(r,c);
        const before = sheet.cells[addr] ? JSON.parse(JSON.stringify(sheet.cells[addr])) as CellData : undefined;
        if (!sheet.cells[addr]) sheet.cells[addr] = { v:null, f:null };
        sheet.cells[addr].style ??= {};
        const style = sheet.cells[addr].style!;
        if (border === "all") {
          style.borderTop = true;
          style.borderRight = true;
          style.borderBottom = true;
          style.borderLeft = true;
          style.border = "all";
        } else if (border === "outer") {
          style.borderTop = r === sR0;
          style.borderRight = c === sC1;
          style.borderBottom = r === sR1;
          style.borderLeft = c === sC0;
          style.border = undefined;
        } else {
          style.borderTop = false;
          style.borderRight = false;
          style.borderBottom = false;
          style.borderLeft = false;
          style.border = "none";
        }
        this.refreshCell(r,c);
        this.recordCellChange(r, c, before);
      }
    }
    this.commitUndoBatch();
    this.markDirty();
  }

  private syncFormatControls(): void {
    if (!this.fmtSelect) return;
    const cell = this.currentSheet().cells[cellAddr(this.sel.r1,this.sel.c1)];
    this.fmtSelect.value = cell?.style?.format ?? "General";
    // Toggle active state on format buttons
    const panel = this.ribbonPanels.home;
    if (!panel) return;
    panel.querySelectorAll<HTMLElement>("[data-fmt-btn]").forEach(el => {
      const prop = el.dataset.fmtBtn as "bold"|"italic"|"underline"|"wrap";
      el.classList.toggle("eng-rbn-btn-active", !!(cell?.style?.[prop]));
    });
  }

  // ─── Sort ─────────────────────────────────────────────────────────────────────

  private sortColumn(ascending: boolean): void {
    this.startUndoBatch();
    const { r0,c0,r1,c1 } = this.sel;
    const sR0=Math.min(r0,r1), sR1=Math.max(r0,r1);
    const minC=Math.min(c0,c1), maxC=Math.max(c0,c1);
    const sortC = minC;
    const sheet = this.currentSheet();
    const affected: Array<[number, number]> = [];

    // Snapshot affected cells before sort
    for (let r=sR0; r<=sR1; r++)
      for (let c=minC; c<=maxC; c++) {
        const addr = cellAddr(r,c);
        const before = sheet.cells[addr] ? JSON.parse(JSON.stringify(sheet.cells[addr])) as CellData : undefined;
        // record before; we'll call recordCellChange after the sort applies
        if (this._batchEntry) this._batchEntry.changes.push({ r, c, sheetIdx: this.activeSheet, before, after: undefined });
      }

    const rows: Array<Record<number, CellData|undefined>> = [];
    for (let r=sR0; r<=sR1; r++) {
      const row: Record<number, CellData|undefined> = {};
      for (let c=minC; c<=maxC; c++)
        row[c] = sheet.cells[cellAddr(r,c)] ? {...sheet.cells[cellAddr(r,c)]} : undefined;
      rows.push(row);
    }

    rows.sort((a, b) => {
      const av = a[sortC]?.v ?? "";
      const bv = b[sortC]?.v ?? "";
      const an=Number(av), bn=Number(bv);
      if (!isNaN(an)&&!isNaN(bn)) return ascending ? an-bn : bn-an;
      return ascending
        ? String(av).localeCompare(String(bv))
        : String(bv).localeCompare(String(av));
    });

    for (let i=0; i<rows.length; i++) {
      const r = sR0+i;
      for (let c=minC; c<=maxC; c++) {
        const cell = rows[i][c];
        if (cell) sheet.cells[cellAddr(r,c)] = cell;
        else delete sheet.cells[cellAddr(r,c)];
        affected.push([r, c]);
      }
    }

    // Fill in the "after" snapshots now that sort has been applied
    if (this._batchEntry) {
      for (const ch of this._batchEntry.changes) {
        if (ch.after === undefined) ch.after = sheet.cells[cellAddr(ch.r,ch.c)] ? JSON.parse(JSON.stringify(sheet.cells[cellAddr(ch.r,ch.c)])) : undefined;
      }
    }
    this.commitUndoBatch();

    this.rebuildHF();
    this.refreshAllFormulaCells();
    for (const [r, c] of affected) this.refreshCell(r, c);
    this.markDirty();
  }

  // ─── Freeze panes ────────────────────────────────────────────────────────────

  private freezeRows(count: number): void {
    const s = this.currentSheet();
    s.frozen = { rows:count, cols:s.frozen?.cols ?? 0 };
    this.switchSheet(true, true);
  }

  private freezeCols(count: number): void {
    const s = this.currentSheet();
    s.frozen = { rows:s.frozen?.rows ?? 0, cols:count };
    this.switchSheet(true, true);
  }

  private unfreeze(): void {
    this.currentSheet().frozen = { rows:0, cols:0 };
    this.switchSheet(true, true);
  }

  private freezeAtSelection(): void {
    const rows = Math.max(0, this.sel.r1);
    const cols = Math.max(0, this.sel.c1);
    const s = this.currentSheet();
    s.frozen = { rows, cols };
    this.switchSheet(true, true);
  }

  // ─── Column resize ────────────────────────────────────────────────────────────

  private startColResize(e: MouseEvent, colIdx: number): void {
    e.preventDefault(); e.stopPropagation();
    const doc = this.tableEl.ownerDocument;
    const startX = e.clientX;
    const sheet  = this.currentSheet();
    const startW = sheet.colWidths[colIdx] ?? DEFAULT_COL_W;
    this.colResizing = true;
    const onMove = (e2: MouseEvent) => {
      const newW = Math.max(20, startW + e2.clientX - startX);
      sheet.colWidths[colIdx] = newW;
      const th = this.theadEl?.querySelectorAll("th")[colIdx+1] as HTMLElement|null;
      if (th) th.style.width = th.style.minWidth = th.style.maxWidth = newW+"px";
      for (let r=0; r<sheet.numRows; r++) {
        const td = this.cellEls[r]?.[colIdx];
        if (td) td.style.width = td.style.minWidth = td.style.maxWidth = newW+"px";
      }
    };
    const onUp = () => {
      this.colResizing = false; this.markDirty();
      doc.removeEventListener("mousemove", onMove);
      doc.removeEventListener("mouseup", onUp);
    };
    doc.addEventListener("mousemove", onMove);
    doc.addEventListener("mouseup", onUp);
  }

  private autoFitColumn(e: MouseEvent, colIdx: number): void {
    e.preventDefault();
    e.stopPropagation();
    const sheet = this.currentSheet();
    let maxChars = 6;
    for (let r = 0; r < sheet.numRows; r++) {
      const formatted = applyFormat(this.getComputedValue(r, colIdx), sheet.cells[cellAddr(r, colIdx)]?.style?.format);
      maxChars = Math.max(maxChars, formatted.length);
    }
    // Approximate text width: ~8px per char + cell padding
    const newW = Math.min(420, Math.max(60, Math.round(maxChars * 8 + 24)));
    sheet.colWidths[colIdx] = newW;
    const th = this.theadEl?.querySelectorAll("th")[colIdx+1] as HTMLElement|null;
    if (th) th.style.width = th.style.minWidth = th.style.maxWidth = newW + "px";
    for (let r = 0; r < sheet.numRows; r++) {
      const td = this.cellEls[r]?.[colIdx];
      if (td) td.style.width = td.style.minWidth = td.style.maxWidth = newW + "px";
    }
    this.markDirty();
  }

  private buildFindReplaceBar(parent: HTMLElement): void {
    const bar = parent.createDiv({ cls: "eng-find-bar" });
    bar.style.display = "none";
    this.findBarEl = bar;

    this.findInputEl = bar.createEl("input", {
      cls: "eng-find-input",
      attr: { type: "text", placeholder: "Find in sheet..." },
    }) as HTMLInputElement;
    this.replaceInputEl = bar.createEl("input", {
      cls: "eng-find-input",
      attr: { type: "text", placeholder: "Replace with..." },
    }) as HTMLInputElement;

    const findNextBtn = bar.createEl("button", { cls: "eng-find-btn", text: "Next" });
    const replaceBtn = bar.createEl("button", { cls: "eng-find-btn", text: "Replace all" });
    const closeBtn = bar.createEl("button", { cls: "eng-find-btn", text: "Close" });

    this.findInputEl.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.findNext(this.findInputEl.value.trim(), true);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        this.closeFindReplaceBar();
      }
    };
    this.replaceInputEl.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.replaceAll(this.findInputEl.value.trim(), this.replaceInputEl.value);
      }
      if (e.key === "Escape") {
        e.preventDefault();
        this.closeFindReplaceBar();
      }
    };
    findNextBtn.onclick = () => this.findNext(this.findInputEl.value.trim(), true);
    replaceBtn.onclick = () => this.replaceAll(this.findInputEl.value.trim(), this.replaceInputEl.value);
    closeBtn.onclick = () => this.closeFindReplaceBar();
  }

  private openFindReplaceBar(mode: "find" | "replace"): void {
    if (!this.findBarEl) return;
    this.findBarEl.style.display = "";
    const seed = this.lastFindTerm || this.getCellDisplay(this.sel.r1, this.sel.c1);
    this.findInputEl.value = seed;
    if (mode === "replace") {
      this.replaceInputEl.value = this.lastReplaceTerm;
      this.replaceInputEl.focus();
      this.replaceInputEl.select();
    } else {
      this.findInputEl.focus();
      this.findInputEl.select();
    }
  }

  private closeFindReplaceBar(): void {
    if (!this.findBarEl) return;
    this.findBarEl.style.display = "none";
    this.gridScrollEl?.focus();
  }

  private findNext(term: string, wrap = false): void {
    if (!term) return;
    this.lastFindTerm = term;
    const s = this.currentSheet();
    const total = s.numRows * s.numCols;
    const start = this.sel.r1 * s.numCols + this.sel.c1 + 1;
    for (let i = 0; i < total; i++) {
      const idx = wrap ? (start + i) % total : start + i;
      if (idx >= total) break;
      const r = Math.floor(idx / s.numCols);
      const c = idx % s.numCols;
      if (this.getCellDisplay(r, c).toLowerCase().includes(term.toLowerCase())) {
        this.setSelection(r, c, r, c);
        return;
      }
    }
    new Notice(`No match found for "${term}".`);
  }

  private replaceAll(find: string, replace: string): void {
    if (!find) return;
    this.lastFindTerm = find;
    this.lastReplaceTerm = replace;
    const s = this.currentSheet();
    let changed = 0;
    this.startUndoBatch();
    const target = find.toLowerCase();
    for (let r = 0; r < s.numRows; r++) {
      for (let c = 0; c < s.numCols; c++) {
        const addr = cellAddr(r, c);
        const cell = s.cells[addr];
        if (!cell) continue;
        if (cell.f) {
          if (cell.f.toLowerCase().includes(target)) {
            const before = JSON.parse(JSON.stringify(cell)) as CellData;
            cell.f = this.replaceInsensitive(cell.f, find, replace);
            this.recordCellChange(r, c, before);
            changed++;
          }
          continue;
        }
        if (typeof cell.v === "string" && cell.v.toLowerCase().includes(target)) {
          const before = JSON.parse(JSON.stringify(cell)) as CellData;
          cell.v = this.replaceInsensitive(cell.v, find, replace);
          this.recordCellChange(r, c, before);
          changed++;
        }
      }
    }
    this.commitUndoBatch();
    if (changed > 0) {
      this.rebuildHF();
      this.refreshAllFormulaCells();
      this.refreshAllCells();
      this.markDirty();
      this.flashStatus(`Replaced ${changed} match${changed === 1 ? "" : "es"}.`);
    } else {
      this.flashStatus("No matches to replace.");
    }
  }

  private getCellDisplay(r: number, c: number): string {
    const cell = this.currentSheet().cells[cellAddr(r, c)];
    if (!cell) return "";
    if (cell.f) return cell.f;
    return String(cell.v ?? "");
  }

  private replaceInsensitive(input: string, find: string, replace: string): string {
    const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return input.replace(new RegExp(escaped, "gi"), replace);
  }

  private getNamedRanges(): Record<string, NamedRangeDef> {
    const raw = this.fileData.meta["namedRanges"];
    if (!raw || typeof raw !== "object") return {};
    return raw as Record<string, NamedRangeDef>;
  }

  private setNamedRanges(next: Record<string, NamedRangeDef>): void {
    this.fileData.meta["namedRanges"] = next;
    this.markDirty();
  }

  private defineNamedRange(): void {
    const key = `${cellAddr(Math.min(this.sel.r0, this.sel.r1), Math.min(this.sel.c0, this.sel.c1))}:${cellAddr(Math.max(this.sel.r0, this.sel.r1), Math.max(this.sel.c0, this.sel.c1))}`;
    const seed = this.nameBox.value.trim() || `Range_${cellAddr(this.sel.r1, this.sel.c1)}`;
    const name = (this.containerEl.ownerDocument.defaultView ?? window).prompt("Named range name:", seed)?.trim().toUpperCase();
    if (!name) return;
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      new Notice("Invalid name. Use letters, numbers, underscore; start with letter/underscore.");
      return;
    }
    const ranges = this.getNamedRanges();
    ranges[name] = { sheetIdx: this.activeSheet, range: key };
    this.setNamedRanges(ranges);
    this.flashStatus(`Named range "${name}" saved.`);
  }

  private goToNamedRange(): void {
    const ranges = this.getNamedRanges();
    const names = Object.keys(ranges).sort();
    if (names.length === 0) {
      new Notice("No named ranges defined.");
      return;
    }
    const choice = (this.containerEl.ownerDocument.defaultView ?? window).prompt(`Go to named range:\n${names.join(", ")}`, names[0])?.trim().toUpperCase();
    if (!choice || !ranges[choice]) return;
    const def = ranges[choice];
    const [a, b] = def.range.split(":");
    const p1 = parseAddr(a);
    const p2 = parseAddr(b ?? a);
    if (!p1 || !p2) return;
    if (def.sheetIdx !== this.activeSheet) {
      this.activeSheet = def.sheetIdx;
      this.switchSheet();
    }
    this.setSelection(p1.row, p1.col, p2.row, p2.col);
  }

  private manageNamedRanges(): void {
    const ranges = this.getNamedRanges();
    const names = Object.keys(ranges).sort();
    if (names.length === 0) {
      new Notice("No named ranges defined.");
      return;
    }
    const lines = names.map((n) => `${n} -> ${this.fileData.sheets[ranges[n].sheetIdx]?.name ?? "?"}!${ranges[n].range}`).join("\n");
    const remove = (this.containerEl.ownerDocument.defaultView ?? window)
      .prompt(`Named ranges:\n${lines}\n\nType one name to delete:`, "")
      ?.trim()
      .toUpperCase();
    if (!remove) return;
    if (!ranges[remove]) {
      new Notice(`Named range "${remove}" not found.`);
      return;
    }
    delete ranges[remove];
    this.setNamedRanges(ranges);
    this.flashStatus(`Deleted named range "${remove}".`);
  }

  private updateFormulaAssist(input: HTMLInputElement): void {
    const list = this.containerEl.querySelector(`#${this.formulaSuggestId}`) as HTMLDataListElement | null;
    if (!list) return;
    list.empty();

    const value = input.value;
    if (!value.startsWith("=")) {
      if (this.formulaHintEl) this.formulaHintEl.style.display = "none";
      return;
    }
    const pos = input.selectionStart ?? value.length;
    const before = value.slice(1, pos).toUpperCase();
    const token = (before.match(/([A-Z_][A-Z0-9_]*)$/)?.[1] ?? "").toUpperCase();

    const pool = new Set<string>([
      ...Object.keys(FORMULA_HINTS),
      ...Object.keys(this.getNamedRanges()),
      ...this.store.getAllEntries().map((e) => e.key.toUpperCase()),
    ]);
    const picks = [...pool].filter((k) => (token ? k.startsWith(token) : true)).slice(0, 20);
    for (const p of picks) {
      const opt = list.createEl("option");
      opt.value = p;
    }

    const fn = before.match(/([A-Z_][A-Z0-9_]*)\($/)?.[1];
    if (!this.formulaHintEl) return;
    if (fn && FORMULA_HINTS[fn]) {
      this.formulaHintEl.setText(FORMULA_HINTS[fn]);
      this.formulaHintEl.style.display = "";
    } else {
      this.formulaHintEl.style.display = "none";
    }
  }

  private isCellEmpty(r: number, c: number): boolean {
    const cell = this.currentSheet().cells[cellAddr(r, c)];
    if (!cell) return true;
    if (cell.f && cell.f.trim() !== "") return false;
    if (cell.v === null || cell.v === undefined) return true;
    return String(cell.v).trim() === "";
  }

  private ctrlNavigate(dir: "up" | "down" | "left" | "right", shift: boolean): void {
    const s = this.currentSheet();
    let r = this.sel.r1;
    let c = this.sel.c1;
    const dR = dir === "up" ? -1 : dir === "down" ? 1 : 0;
    const dC = dir === "left" ? -1 : dir === "right" ? 1 : 0;
    const inBounds = (rr: number, cc: number) => rr >= 0 && rr < s.numRows && cc >= 0 && cc < s.numCols;
    const startEmpty = this.isCellEmpty(r, c);

    if (startEmpty) {
      while (inBounds(r + dR, c + dC) && this.isCellEmpty(r + dR, c + dC)) {
        r += dR;
        c += dC;
      }
      if (inBounds(r + dR, c + dC)) {
        r += dR;
        c += dC;
      }
    } else {
      while (inBounds(r + dR, c + dC) && !this.isCellEmpty(r + dR, c + dC)) {
        r += dR;
        c += dC;
      }
    }

    if (shift) this.extendSelection(r, c);
    else this.setSelection(r, c, r, c);
  }

  private findLastUsedCell(): { r: number; c: number } {
    let maxR = 0;
    let maxC = 0;
    for (const addr of Object.keys(this.currentSheet().cells)) {
      const p = parseAddr(addr);
      if (!p) continue;
      maxR = Math.max(maxR, p.row);
      maxC = Math.max(maxC, p.col);
    }
    return { r: maxR, c: maxC };
  }

  private findRowEndCell(row: number): number {
    const s = this.currentSheet();
    for (let c = s.numCols - 1; c >= 0; c--) {
      if (!this.isCellEmpty(row, c)) return c;
    }
    return s.numCols - 1;
  }

  // ─── Row / Column ops ─────────────────────────────────────────────────────────

  private shiftCells(sheet: SheetData, axis: "row"|"col", fromIdx: number, delta: number): Record<string,CellData> {
    const nc: Record<string,CellData> = {};
    if (delta === 0) return { ...sheet.cells };
    const deleting = delta < 0;
    const amount = Math.abs(delta);
    for (const [addr,cell] of Object.entries(sheet.cells)) {
      const p = parseAddr(addr);
      if (!p) continue;
      const key = axis==="row" ? p.row : p.col;
      if (!deleting) {
        if (key >= fromIdx) nc[axis==="row" ? cellAddr(p.row + amount, p.col) : cellAddr(p.row, p.col + amount)] = cell;
        else nc[addr] = cell;
        continue;
      }
      const endIdx = fromIdx + amount - 1;
      if (key >= fromIdx && key <= endIdx) continue;
      if (key > endIdx) nc[axis==="row" ? cellAddr(p.row - amount, p.col) : cellAddr(p.row, p.col - amount)] = cell;
      else nc[addr] = cell;
    }
    return nc;
  }

  private shiftIndexMap(map: Record<number, number>, fromIdx: number, delta: number): Record<number, number> {
    const next: Record<number, number> = {};
    if (delta === 0) return { ...map };
    const deleting = delta < 0;
    const amount = Math.abs(delta);
    for (const [k, val] of Object.entries(map)) {
      const idx = Number(k);
      if (!Number.isFinite(idx)) continue;
      if (!deleting) {
        next[idx >= fromIdx ? idx + amount : idx] = val;
        continue;
      }
      const endIdx = fromIdx + amount - 1;
      if (idx >= fromIdx && idx <= endIdx) continue;
      next[idx > endIdx ? idx - amount : idx] = val;
    }
    return next;
  }

  private refreshAfterSheetStructureChange(nextSel: Selection): void {
    this.rebuildHF();
    this.buildGrid();
    this.refreshAllCells();
    this.setSelection(nextSel.r0, nextSel.c0, nextSel.r1, nextSel.c1);
    this.updateStatusBar();
    this.markDirty();
  }

  private insertRow(): void {
    const s = this.currentSheet();
    const rStart = Math.min(this.sel.r0, this.sel.r1);
    const count = Math.max(1, Math.abs(this.sel.r1 - this.sel.r0) + 1);
    s.cells = this.shiftCells(s, "row", rStart, count);
    s.rowHeights = this.shiftIndexMap(s.rowHeights, rStart, count);
    s.numRows += count;
    const c = Math.min(this.sel.c1, s.numCols - 1);
    this.refreshAfterSheetStructureChange({ r0: rStart, c0: c, r1: rStart, c1: c });
  }

  private insertRowBelow(): void {
    const s = this.currentSheet();
    const rStart = Math.max(this.sel.r0, this.sel.r1) + 1;
    const count = Math.max(1, Math.abs(this.sel.r1 - this.sel.r0) + 1);
    s.cells = this.shiftCells(s, "row", rStart, count);
    s.rowHeights = this.shiftIndexMap(s.rowHeights, rStart, count);
    s.numRows += count;
    const row = Math.min(rStart, s.numRows - 1);
    const c = Math.min(this.sel.c1, s.numCols - 1);
    this.refreshAfterSheetStructureChange({ r0: row, c0: c, r1: row, c1: c });
  }

  private deleteRow(): void {
    const s = this.currentSheet();
    const rStart = Math.min(this.sel.r0, this.sel.r1);
    const requested = Math.max(1, Math.abs(this.sel.r1 - this.sel.r0) + 1);
    const count = Math.min(requested, Math.max(0, s.numRows - 1));
    if (count <= 0) return;
    s.cells = this.shiftCells(s, "row", rStart, -count);
    s.rowHeights = this.shiftIndexMap(s.rowHeights, rStart, -count);
    s.numRows = Math.max(1, s.numRows - count);
    const row = Math.min(rStart, s.numRows - 1);
    const c = Math.min(this.sel.c1, s.numCols - 1);
    this.refreshAfterSheetStructureChange({ r0: row, c0: c, r1: row, c1: c });
  }

  private insertCol(): void {
    const s = this.currentSheet();
    const cStart = Math.min(this.sel.c0, this.sel.c1);
    const count = Math.max(1, Math.abs(this.sel.c1 - this.sel.c0) + 1);
    s.cells = this.shiftCells(s, "col", cStart, count);
    s.colWidths = this.shiftIndexMap(s.colWidths, cStart, count);
    s.numCols += count;
    const r = Math.min(this.sel.r1, s.numRows - 1);
    this.refreshAfterSheetStructureChange({ r0: r, c0: cStart, r1: r, c1: cStart });
  }

  private insertColRight(): void {
    const s = this.currentSheet();
    const cStart = Math.max(this.sel.c0, this.sel.c1) + 1;
    const count = Math.max(1, Math.abs(this.sel.c1 - this.sel.c0) + 1);
    s.cells = this.shiftCells(s, "col", cStart, count);
    s.colWidths = this.shiftIndexMap(s.colWidths, cStart, count);
    s.numCols += count;
    const col = Math.min(cStart, s.numCols - 1);
    const r = Math.min(this.sel.r1, s.numRows - 1);
    this.refreshAfterSheetStructureChange({ r0: r, c0: col, r1: r, c1: col });
  }

  private deleteCol(): void {
    const s = this.currentSheet();
    const cStart = Math.min(this.sel.c0, this.sel.c1);
    const requested = Math.max(1, Math.abs(this.sel.c1 - this.sel.c0) + 1);
    const count = Math.min(requested, Math.max(0, s.numCols - 1));
    if (count <= 0) return;
    s.cells = this.shiftCells(s, "col", cStart, -count);
    s.colWidths = this.shiftIndexMap(s.colWidths, cStart, -count);
    s.numCols = Math.max(1, s.numCols - count);
    const col = Math.min(cStart, s.numCols - 1);
    const r = Math.min(this.sel.r1, s.numRows - 1);
    this.refreshAfterSheetStructureChange({ r0: r, c0: col, r1: r, c1: col });
  }

  // ─── Sheet ops ────────────────────────────────────────────────────────────────

  private switchSheet(markDirty = false, preserveUndo = false): void {
    if (!preserveUndo) {
      this.undoStack = [];
      this.redoStack = [];
    }
    this.renamingSheetIdx = null;
    this.sel = { r0:0, c0:0, r1:0, c1:0 };
    this.prevSel = { ...this.sel };
    this.rebuildHF();
    this.buildGrid();
    this.refreshAllCells();
    this.updateSelection();
    this.refreshFormulaBar();
    this.renderTabs();
    if (markDirty) this.markDirty();
  }

  private getVisibleSheetIndices(): number[] {
    const out: number[] = [];
    this.fileData.sheets.forEach((s, i) => { if (!s.hidden) out.push(i); });
    return out.length > 0 ? out : [0];
  }

  private addSheet(): void {
    this.fileData.sheets.push(emptySheet(`Sheet${this.fileData.sheets.length+1}`));
    this.activeSheet = this.fileData.sheets.length-1;
    this.switchSheet(true);
  }

  private deleteSheetAt(idx: number): void {
    if (this.fileData.sheets.length<=1) { new Notice("Cannot delete the only sheet."); return; }
    this.fileData.sheets.splice(idx,1);
    this.activeSheet = Math.min(this.activeSheet, this.fileData.sheets.length-1);
    this.switchSheet(true);
  }

  private hideSheet(idx: number): void {
    const visible = this.getVisibleSheetIndices();
    if (visible.length <= 1) {
      new Notice("Cannot hide the only visible sheet.");
      return;
    }
    const sheet = this.fileData.sheets[idx];
    if (!sheet) return;
    sheet.hidden = true;
    if (this.activeSheet === idx) {
      const next = this.getVisibleSheetIndices().find((i) => i !== idx);
      if (next !== undefined) this.activeSheet = next;
    }
    this.switchSheet(true);
  }

  private unhideSheetPrompt(): void {
    const hidden = this.fileData.sheets
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => !!s.hidden);
    if (hidden.length === 0) {
      new Notice("No hidden sheets.");
      return;
    }
    const choice = (this.containerEl.ownerDocument.defaultView ?? window)
      .prompt(`Unhide sheet:\n${hidden.map((h) => h.s.name).join(", ")}`, hidden[0].s.name)
      ?.trim();
    if (!choice) return;
    const match = hidden.find((h) => h.s.name.toLowerCase() === choice.toLowerCase());
    if (!match) {
      new Notice(`Hidden sheet "${choice}" not found.`);
      return;
    }
    match.s.hidden = false;
    this.activeSheet = match.i;
    this.switchSheet(true);
  }

  private setSheetTabColor(idx: number): void {
    const sheet = this.fileData.sheets[idx];
    if (!sheet) return;
    const next = (this.containerEl.ownerDocument.defaultView ?? window)
      .prompt("Tab color (hex, e.g. #2563eb):", sheet.tabColor ?? "#2563eb")
      ?.trim();
    if (!next) return;
    if (!/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(next)) {
      new Notice("Invalid color. Use #RGB or #RRGGBB.");
      return;
    }
    sheet.tabColor = next;
    this.markDirty();
    this.renderTabs();
  }

  private clearSheetTabColor(idx: number): void {
    const sheet = this.fileData.sheets[idx];
    if (!sheet) return;
    delete sheet.tabColor;
    this.markDirty();
    this.renderTabs();
  }

  private reorderSheet(fromIdx: number, toIdx: number): void {
    if (fromIdx === toIdx) return;
    const from = this.fileData.sheets[fromIdx];
    if (!from || !this.fileData.sheets[toIdx]) return;
    this.fileData.sheets.splice(fromIdx, 1);
    this.fileData.sheets.splice(toIdx, 0, from);

    if (this.activeSheet === fromIdx) this.activeSheet = toIdx;
    else if (fromIdx < this.activeSheet && toIdx >= this.activeSheet) this.activeSheet--;
    else if (fromIdx > this.activeSheet && toIdx <= this.activeSheet) this.activeSheet++;

    const named = this.getNamedRanges();
    const remap = (idx: number): number => {
      if (idx === fromIdx) return toIdx;
      if (fromIdx < toIdx && idx > fromIdx && idx <= toIdx) return idx - 1;
      if (fromIdx > toIdx && idx >= toIdx && idx < fromIdx) return idx + 1;
      return idx;
    };
    for (const def of Object.values(named)) def.sheetIdx = remap(def.sheetIdx);
    this.fileData.meta["namedRanges"] = named;

    this.markDirty();
    this.renderTabs();
  }

  private renameSheet(idx: number): void {
    if (!this.fileData.sheets[idx]) return;
    this.renamingSheetIdx = idx;
    this.renderTabs();
  }

  private commitRenameSheet(idx: number, rawName: string): void {
    const sheet = this.fileData.sheets[idx];
    this.renamingSheetIdx = null;
    if (!sheet) {
      this.renderTabs();
      return;
    }
    const name = rawName.trim();
    if (!name) {
      this.renderTabs();
      return;
    }
    if (name === sheet.name) {
      this.renderTabs();
      return;
    }
    const duplicate = this.fileData.sheets.some((s, i) => i !== idx && s.name.toLowerCase() === name.toLowerCase());
    if (duplicate) {
      new Notice(`Sheet "${name}" already exists.`);
      this.renderTabs();
      return;
    }
    sheet.name = name;
    this.markDirty();
    this.renderTabs();
  }

  private duplicateSheet(idx: number): void {
    const copy = JSON.parse(JSON.stringify(this.fileData.sheets[idx])) as SheetData;
    copy.name += " (2)";
    this.fileData.sheets.splice(idx+1,0,copy);
    this.activeSheet = idx+1;
    this.switchSheet(true);
  }

  // ─── EXPORT() ────────────────────────────────────────────────────────────────

  private promptExportCell(): void {
    const { r1,c1 } = this.sel;
    const addr = cellAddr(r1,c1);
    const cell = this.currentSheet().cells[addr];
    const existing = cell?.f?.match(/EXPORT\s*\(\s*[^,]+\s*,\s*["']([^"']+)["']/i)?.[1] ?? "";
    const varName = prompt(`Export cell ${addr} to Variable Store.\nVariable name (empty to remove):`, existing);
    if (varName === null) return;
    if (!varName.trim()) {
      const inner = cell?.f?.match(/EXPORT\s*\(\s*([^,]+)\s*,/i)?.[1]?.trim();
      if (inner) this.setCellRaw(r1, c1, `=${inner}`);
      return;
    }
    const innerExpr = cell?.f
      ? (cell.f.match(/EXPORT\s*\(\s*([^,]+)\s*,/i)?.[1]?.trim() ?? cell.f.replace(/^=/,""))
      : String(cell?.v ?? "0");
    this.setCellRaw(r1, c1, `=EXPORT(${innerExpr},"${varName.trim()}")`);
    new Notice(`${addr} → Variable Store as "${varName.trim()}"`);
  }

  // ─── Autofill ────────────────────────────────────────────────────────────────

  private updateFillHandle(): void {
    this.tableEl?.querySelectorAll(".eng-fill-handle").forEach((el) => el.remove());
    this.fillHandleEl?.remove();
    this.fillHandleEl = null;
    const { r0,c0,r1,c1 } = this.sel;
    const maxR = Math.max(r0,r1), maxC = Math.max(c0,c1);
    const td = this.cellEls[maxR]?.[maxC];
    if (!td) return;
    const handle = document.createElement("div");
    handle.className = "eng-fill-handle";
    td.appendChild(handle);
    this.fillHandleEl = handle;
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.startAutofill();
    });
  }

  private startAutofill(): void {
    const { r0,c0,r1,c1 } = this.sel;
    const sR0=Math.min(r0,r1), sR1=Math.max(r0,r1);
    const sC0=Math.min(c0,c1), sC1=Math.max(c0,c1);
    let lastR = sR1, lastC = sC1;
    const doc = this.tableEl.ownerDocument;
    let frame = 0;
    let pendingR: number | null = null;
    let pendingC: number | null = null;
    const flush = () => {
      frame = 0;
      if (pendingR === null || pendingC === null) return;
      lastR = pendingR;
      lastC = pendingC;
      this.updateFillPreview(sR0, sC0, sR1, sC1, lastR, lastC);
      pendingR = null;
      pendingC = null;
    };

    const onMove = (e: MouseEvent) => {
      const el = doc.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const td = el?.closest?.("td") as HTMLTableCellElement | null;
      if (!td || td.closest("table") !== this.tableEl) return;
      const r = Number(td.dataset.r);
      const c = Number(td.dataset.c);
      if (r < 0 || c < 0 || !Number.isFinite(r) || !Number.isFinite(c)) return;
      pendingR = r;
      pendingC = c;
      if (!frame) frame = requestAnimationFrame(flush);
    };

    const onUp = () => {
      if (frame) cancelAnimationFrame(frame);
      flush();
      doc.removeEventListener("mousemove", onMove);
      doc.removeEventListener("mouseup", onUp);
      this.clearFillPreview();
      this.doAutofill(sR0, sC0, sR1, sC1, lastR, lastC);
    };

    doc.addEventListener("mousemove", onMove);
    doc.addEventListener("mouseup", onUp);
  }

  private updateFillPreview(sR0: number, sC0: number, sR1: number, sC1: number, targetR: number, targetC: number): void {
    this.clearFillPreview();
    const drDown  = targetR - sR1;
    const drRight = targetC - sC1;
    if (drDown > 0) {
      for (let r=sR1+1; r<=targetR; r++)
        for (let c=sC0; c<=sC1; c++) {
          const td = this.cellEls[r]?.[c];
          if (td) { td.classList.add("eng-fill-preview"); this.fillPreviewCells.push(td); }
        }
    } else if (drRight > 0) {
      for (let c=sC1+1; c<=targetC; c++)
        for (let r=sR0; r<=sR1; r++) {
          const td = this.cellEls[r]?.[c];
          if (td) { td.classList.add("eng-fill-preview"); this.fillPreviewCells.push(td); }
        }
    }
  }

  private clearFillPreview(): void {
    for (const td of this.fillPreviewCells) td.classList.remove("eng-fill-preview");
    this.fillPreviewCells = [];
  }

  private doAutofill(sR0: number, sC0: number, sR1: number, sC1: number, targetR: number, targetC: number): void {
    const sheet = this.currentSheet();
    const fillDown  = targetR > sR1;
    const fillRight = targetC > sC1;
    if (!fillDown && !fillRight) return;
    this.startUndoBatch();
    const affected: Array<[number, number]> = [];

    if (fillDown) {
      const srcRows = sR1 - sR0 + 1;
      for (let r = sR1+1; r <= targetR; r++) {
        const srcR = sR0 + ((r - sR1 - 1) % srcRows);
        const dr   = r - srcR;
        for (let c = sC0; c <= sC1; c++) {
          const dest = cellAddr(r, c);
          const before = sheet.cells[dest] ? JSON.parse(JSON.stringify(sheet.cells[dest])) as CellData : undefined;
          const src  = sheet.cells[cellAddr(srcR, c)];
          if (!src) { delete sheet.cells[dest]; }
          else if (src.f) { sheet.cells[dest] = { ...src, f: this.adjustFormula(src.f, dr, 0) }; }
          else if (typeof src.v === "number") { const step = this.detectStep(sR0, sR1, c, "row", sheet); sheet.cells[dest] = { ...src, v: src.v + step * (r - srcR) }; }
          else { sheet.cells[dest] = { ...src }; }
          this.recordCellChange(r, c, before);
          affected.push([r, c]);
        }
      }
    } else {
      const srcCols = sC1 - sC0 + 1;
      for (let c = sC1+1; c <= targetC; c++) {
        const srcC = sC0 + ((c - sC1 - 1) % srcCols);
        const dc   = c - srcC;
        for (let r = sR0; r <= sR1; r++) {
          const dest = cellAddr(r, c);
          const before = sheet.cells[dest] ? JSON.parse(JSON.stringify(sheet.cells[dest])) as CellData : undefined;
          const src  = sheet.cells[cellAddr(r, srcC)];
          if (!src) { delete sheet.cells[dest]; }
          else if (src.f) { sheet.cells[dest] = { ...src, f: this.adjustFormula(src.f, 0, dc) }; }
          else if (typeof src.v === "number") { const step = this.detectStep(sC0, sC1, r, "col", sheet); sheet.cells[dest] = { ...src, v: src.v + step * (c - srcC) }; }
          else { sheet.cells[dest] = { ...src }; }
          this.recordCellChange(r, c, before);
          affected.push([r, c]);
        }
      }
    }

    this.commitUndoBatch();
    this.rebuildHF();
    this.refreshAllFormulaCells();
    for (const [r, c] of affected) this.refreshCell(r, c);
    this.updateFillHandle();
    this.markDirty();
  }

  private detectStep(from: number, to: number, fixedIdx: number, axis: "row"|"col", sheet: SheetData): number {
    if (from >= to) return 0;
    const vals: number[] = [];
    for (let i = from; i <= to; i++) {
      const addr = axis === "row" ? cellAddr(i, fixedIdx) : cellAddr(fixedIdx, i);
      const v = sheet.cells[addr]?.v;
      if (typeof v !== "number") return 0;
      vals.push(v);
    }
    if (vals.length < 2) return 0;
    const step = vals[1] - vals[0];
    for (let i = 2; i < vals.length; i++) {
      if (Math.abs((vals[i] - vals[i-1]) - step) > 1e-10) return 0;
    }
    return step;
  }

  private adjustFormula(formula: string, deltaRow: number, deltaCol: number): string {
    if (!formula.startsWith("=") || (deltaRow === 0 && deltaCol === 0)) return formula;
    return "=" + formula.slice(1).replace(
      /(\$?)([A-Z]+)(\$?)(\d+)/gi,
      (full, absCol, colStr, absRow, rowStr) => {
        if (absCol && absRow) return full; // fully absolute — unchanged
        let colIdx = 0;
        for (const ch of colStr.toUpperCase()) colIdx = colIdx * 26 + ch.charCodeAt(0) - 64;
        colIdx--; // 0-based
        const newCol = absCol ? colStr.toUpperCase() : colLetter(Math.max(0, colIdx + deltaCol));
        const newRow = absRow ? rowStr : String(Math.max(1, parseInt(rowStr) + deltaRow));
        return `${absCol}${newCol}${absRow}${newRow}`;
      }
    );
  }

  // ─── CSV import / export ─────────────────────────────────────────────────────

  private importCSV(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,text/csv";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = reader.result as string;
        const rows = this.parseDelimited(text, ",");
        if (rows.length === 0) { new Notice("CSV file appears to be empty."); return; }
        this.setSelection(this.sel.r1, this.sel.c1, this.sel.r1, this.sel.c1);
        this.pasteExternalData(rows);
        new Notice(`Imported ${rows.length} row${rows.length !== 1 ? "s" : ""} from ${file.name}`);
      };
      reader.readAsText(file);
    };
    input.click();
  }

  private exportCSV(): void {
    const sheet = this.currentSheet();
    const { r0,c0,r1,c1 } = this.sel;
    const sR0=Math.min(r0,r1), sR1=Math.max(r0,r1);
    const sC0=Math.min(c0,c1), sC1=Math.max(c0,c1);
    const isRange = sR0 !== sR1 || sC0 !== sC1;

    let minR: number, maxR: number, minC: number, maxC: number;
    if (isRange) {
      minR = sR0; maxR = sR1; minC = sC0; maxC = sC1;
    } else {
      const addrs = Object.keys(sheet.cells);
      if (addrs.length === 0) { new Notice("No data to export."); return; }
      minR = Infinity; maxR = 0; minC = Infinity; maxC = 0;
      for (const addr of addrs) {
        const p = parseAddr(addr);
        if (!p) continue;
        if (p.row < minR) minR = p.row; if (p.row > maxR) maxR = p.row;
        if (p.col < minC) minC = p.col; if (p.col > maxC) maxC = p.col;
      }
    }

    const data: string[][] = [];
    for (let r = minR; r <= maxR; r++) {
      const row: string[] = [];
      for (let c = minC; c <= maxC; c++) {
        const val = this.getComputedValue(r, c);
        row.push(val !== null && val !== undefined ? String(val) : "");
      }
      data.push(row);
    }

    const csv  = this.serializeDelimited(data, ",");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const a    = document.createElement("a");
    a.href     = URL.createObjectURL(blob);
    a.download = `${this.file?.basename ?? "sheet"}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ─── External paste (TSV / CSV from clipboard or file) ───────────────────────

  private pasteExternalData(rows: string[][]): void {
    if (rows.length === 0) return;
    const { r1,c1 } = this.sel;
    const sheet = this.currentSheet();

    // Expand sheet dimensions if the pasted data exceeds them, then rebuild the grid.
    const neededRows = r1 + rows.length;
    const neededCols = c1 + Math.max(...rows.map(row => row.length));
    let needRebuild = false;
    if (neededRows > sheet.numRows) { sheet.numRows = neededRows; needRebuild = true; }
    if (neededCols > sheet.numCols) { sheet.numCols = neededCols; needRebuild = true; }
    if (needRebuild) { this.buildGrid(); this.refreshAllCells(); this.updateSelection(); }

    this.startUndoBatch();
    let hasFormula = false;

    for (let dr = 0; dr < rows.length; dr++) {
      for (let dc = 0; dc < rows[dr].length; dc++) {
        const r = r1 + dr, c = c1 + dc;
        const addr = cellAddr(r, c);
        const before = sheet.cells[addr] ? JSON.parse(JSON.stringify(sheet.cells[addr])) as CellData : undefined;
        const raw = rows[dr][dc];
        if (!raw.trim()) {
          delete sheet.cells[addr];
        } else if (raw.startsWith("=")) {
          sheet.cells[addr] = { v: null, f: raw };
          hasFormula = true;
        } else {
          const n = Number(raw);
          sheet.cells[addr] = { v: isNaN(n) ? raw : n, f: null };
        }
        this.recordCellChange(r, c, before);
      }
    }

    this.commitUndoBatch();
    if (hasFormula) { this.rebuildHF(); this.refreshAllCells(); }
    else {
      for (let dr = 0; dr < rows.length; dr++)
        for (let dc = 0; dc < rows[dr].length; dc++) {
          const r = r1+dr, c = c1+dc;
          if (r < sheet.numRows && c < sheet.numCols) this.refreshCell(r, c);
        }
    }
    this.markDirty();
  }

  // ─── Delimited text parsing / serialization ───────────────────────────────────

  /** RFC 4180-compliant parser. Handles quoted fields, escaped quotes, \r\n and \n. */
  private parseDelimited(text: string, delimiter: "," | "\t"): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    let i = 0;
    const n = text.length;

    while (i < n) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < n && text[i + 1] === '"') { field += '"'; i += 2; }
          else { inQuotes = false; i++; }
        } else { field += ch; i++; }
      } else {
        if (ch === '"') { inQuotes = true; i++; }
        else if (ch === delimiter) { row.push(field); field = ""; i++; }
        else if (ch === "\r" && i + 1 < n && text[i + 1] === "\n") {
          row.push(field); rows.push(row); row = []; field = ""; i += 2;
        } else if (ch === "\n") {
          row.push(field); rows.push(row); row = []; field = ""; i++;
        } else { field += ch; i++; }
      }
    }

    if (field || row.length > 0) { row.push(field); rows.push(row); }

    // Drop trailing all-empty row (common artifact of trailing newline)
    if (rows.length > 0 && rows[rows.length - 1].every(c => c === "")) rows.pop();

    return rows;
  }

  /** Serialize a 2D string array to delimited text (RFC 4180). */
  private serializeDelimited(data: string[][], delimiter: "," | "\t"): string {
    return data.map(row =>
      row.map(field => {
        const needs = field.includes(delimiter) || field.includes('"') ||
                      field.includes("\n") || field.includes("\r");
        return needs ? '"' + field.replace(/"/g, '""') + '"' : field;
      }).join(delimiter)
    ).join("\r\n");
  }

  // ─── Status flash ─────────────────────────────────────────────────────────────

  private _flashTimer: ReturnType<typeof setTimeout> | null = null;

  private flashStatus(text: string, ms = 1800): void {
    if (this._flashTimer) clearTimeout(this._flashTimer);
    this.setStatusLeft(text);
    this._flashTimer = setTimeout(() => {
      this._flashTimer = null;
      this.setStatusLeft(this.isDirty ? "Saving…" : "Autosaved");
    }, ms);
  }

  // ─── Undo / Redo ─────────────────────────────────────────────────────────────

  private startUndoBatch(): void {
    this._batchEntry = { changes: [] };
  }

  private commitUndoBatch(): void {
    if (!this._batchEntry) return;
    if (this._batchEntry.changes.length > 0) this.pushUndo(this._batchEntry);
    this._batchEntry = null;
  }

  private recordCellChange(r: number, c: number, before: CellData | undefined): void {
    const after = this.currentSheet().cells[cellAddr(r, c)];
    const change: UndoChange = {
      r, c, sheetIdx: this.activeSheet,
      before: before ? JSON.parse(JSON.stringify(before)) : undefined,
      after:  after  ? JSON.parse(JSON.stringify(after))  : undefined,
    };
    if (this._batchEntry) this._batchEntry.changes.push(change);
    else this.pushUndo({ changes: [change] });
  }

  private pushUndo(entry: UndoEntry): void {
    if (entry.changes.length === 0) return;
    this.undoStack.push(entry);
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
  }

  private applyUndoEntry(entry: UndoEntry, reverse: boolean): void {
    const changes = reverse ? [...entry.changes].reverse() : entry.changes;
    for (const ch of changes) {
      const sheet = this.fileData.sheets[ch.sheetIdx];
      if (!sheet) continue;
      const addr = cellAddr(ch.r, ch.c);
      const data = reverse ? ch.before : ch.after;
      if (data) sheet.cells[addr] = JSON.parse(JSON.stringify(data));
      else delete sheet.cells[addr];
    }
  }

  undo(): void {
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.applyUndoEntry(entry, true);
    this.redoStack.push(entry);
    this.afterUndoRedo();
  }

  redo(): void {
    const entry = this.redoStack.pop();
    if (!entry) return;
    this.applyUndoEntry(entry, false);
    this.undoStack.push(entry);
    this.afterUndoRedo();
  }

  private afterUndoRedo(): void {
    this.rebuildHF();
    this.refreshAllCells();
    this.refreshFormulaBar();
    this.updateStatusBar();
    this.markDirty();
  }

  // ─── Helper ───────────────────────────────────────────────────────────────────

  private currentSheet(): SheetData {
    return this.fileData.sheets[this.activeSheet] ?? this.fileData.sheets[0];
  }

  getSelectedRangeA1(): string {
    const { r0, c0, r1, c1 } = this.sel;
    const sR0 = Math.min(r0, r1);
    const sR1 = Math.max(r0, r1);
    const sC0 = Math.min(c0, c1);
    const sC1 = Math.max(c0, c1);
    return `${cellAddr(sR0, sC0)}:${cellAddr(sR1, sC1)}`;
  }

  getActiveSheetName(): string {
    return this.currentSheet().name;
  }

  buildEngTableFence(): string {
    const source = this.file?.path ?? "path/to/file.engsheet";
    const sheet = this.getActiveSheetName();
    const range = this.getSelectedRangeA1();
    return [
      "```engtable",
      `source: ${source}`,
      `sheet: ${sheet}`,
      `range: ${range}`,
      "header: false",
      "```",
    ].join("\n");
  }

  private copyEngTableReferenceToClipboard(): void {
    const text = this.buildEngTableFence();
    navigator.clipboard.writeText(text).then(
      () => new Notice("Copied engtable reference."),
      () => new Notice("Failed to copy engtable reference.")
    );
  }

  getActiveCellAddr(): string {
    return cellAddr(this.sel.r1, this.sel.c1);
  }

  getActiveCellFormula(): string | null {
    return this.currentSheet().cells[this.getActiveCellAddr()]?.f ?? null;
  }

  getActiveCellValue(): unknown {
    return this.getComputedValue(this.sel.r1, this.sel.c1);
  }
}
