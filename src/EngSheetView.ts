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
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private _batchEntry: UndoEntry | null = null;

  // Cached cell DOM references
  private cellEls: HTMLTableCellElement[][] = [];

  // DOM refs
  private nameBox!: HTMLInputElement;
  private formulaInput!: HTMLInputElement;
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
    if ((window as Record<string, unknown>).HyperFormula) return;
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/hyperformula/dist/hyperformula.full.min.js";
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("HyperFormula CDN load failed"));
      document.head.appendChild(s);
    });
  }

  private rebuildHF(): void {
    const HF = (window as Record<string, unknown>).HyperFormula as {
      buildFromArray: (data: unknown[][], opts: unknown) => unknown;
    } | undefined;
    if (!HF) return;
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
      this.hf = HF.buildFromArray(data, { licenseKey: "gpl-v3" });
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
        const m = cell.f.match(/EXPORT\s*\(\s*[^,]+\s*,\s*["']([^"']+)["']\s*(?:,\s*["']([^"']*?)["']\s*)?\)/i);
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

    const ig = this.grp(panel, "CSV");
    this.rBtn(ig, "upload",   "Import CSV file into sheet at active cell", () => this.importCSV(),   "Import");
    this.rBtn(ig, "download", "Export sheet to CSV file",                  () => this.exportCSV(),   "Export");
  }

  private buildViewPanel(panel: HTMLElement): void {
    const fg = this.grp(panel, "Freeze Panes");
    this.rBtn(fg, "lock",   "Freeze top row",      () => this.freezeRows(1), "Top Row");
    this.rBtn(fg, "lock",   "Freeze first column", () => this.freezeCols(1), "First Col");
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
        const p = parseAddr(this.nameBox.value.toUpperCase().trim());
        if (p) { this.setSelection(p.row, p.col, p.row, p.col); this.gridScrollEl.focus(); }
      }
    };

    const fx = bar.createDiv({ cls: "eng-fx-label" });
    setIcon(fx, "function-square");

    this.formulaInput = bar.createEl("input", { cls: "eng-formula-input" }) as HTMLInputElement;
    this.formulaInput.type = "text";
    this.formulaInput.spellcheck = false;
    this.formulaInput.onkeydown = (e) => {
      if (e.key === "Enter")  { this.commitFormulaBar(); this.gridScrollEl.focus(); }
      if (e.key === "Escape") { this.refreshFormulaBar(); this.gridScrollEl.focus(); }
    };
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
        this.statusInfoEl.createSpan({
          cls: "eng-status-stats",
          text: `Sum: ${applyFormat(sum)} · Count: ${nums.length} · Avg: ${applyFormat(avg)}`,
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

    this.fileData.sheets.forEach((sheet, idx) => {
      const active = idx === this.activeSheet;
      const tab = this.sheetTabsEl.createDiv({ cls: "eng-sheet-tab" + (active ? " active" : "") });
      tab.createSpan({ text: sheet.name });
      tab.onclick       = () => { this.activeSheet = idx; this.switchSheet(); };
      tab.ondblclick    = () => this.renameSheet(idx);
      tab.oncontextmenu = (e) => { e.preventDefault(); this.showSheetContextMenu(e, idx); };
    });
  }

  private showSheetContextMenu(e: MouseEvent, idx: number): void {
    const menu = new Menu();
    menu.addItem(i => i.setTitle("Rename").onClick(()    => this.renameSheet(idx)));
    menu.addItem(i => i.setTitle("Duplicate").onClick(() => this.duplicateSheet(idx)));
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

    // TSV paste from external sources (Google Sheets, Excel).
    // Fires on Ctrl+V when no internal clipboard is set; internal clipboard
    // is handled by handleKey → pasteClipboard() and takes priority.
    this.tableEl.addEventListener("paste", (e: ClipboardEvent) => {
      if (this.editingCell) return;
      if (this.clipboard) return; // internal cut/copy takes priority
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

    // Border
    const border = cell?.style?.border;
    td.style.outline    = border === "all"   ? "1px solid var(--text-muted)" : "";
    td.style.boxShadow  = border === "outer" ? "inset 0 0 0 1px var(--text-muted)" : "";

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
    const onMove = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const td = el?.closest?.("td") as HTMLTableCellElement | null;
      if (!td || td.closest("table") !== this.tableEl) return;
      const tr = td.closest("tr") as HTMLTableRowElement;
      const allRows = [...this.tbodyEl.querySelectorAll("tr")] as HTMLTableRowElement[];
      const r = allRows.indexOf(tr);
      const c = [...tr.querySelectorAll("td")].indexOf(td) - 1;
      if (r >= 0 && c >= 0) this.extendSelection(r, c);
    };
    const onUp = () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
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
    if (hasFormulas) { this.rebuildHF(); this.refreshAllCells(); }
    else { affected.forEach(([r,c]) => this.refreshCell(r,c)); }
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
    input.value = initialChar !== null ? initialChar : current;
    input.focus();
    if (initialChar === null) input.select(); else input.setSelectionRange(1,1);

    this.formulaInput.value = input.value;
    input.oninput = () => { this.formulaInput.value = input.value; };

    // Restore cell to a clean state before refreshCell runs — otherwise the
    // <input> element remains in the <td> after commit, appearing as a box over the value.
    const restoreCell = () => {
      td.empty();
      td.style.padding  = origPad;
      td.style.overflow = "hidden";
    };

    // Guards against double-commit: onblur can fire after Enter/Tab already called commit
    let committed = false;

    const commit = (newR: number, newC: number) => {
      if (committed) return;
      committed = true;
      const val = input.value;
      this.editingCell = null;
      restoreCell();
      this.setCellRaw(r, c, val);
      this.setSelection(newR, newC, newR, newC);
      this.tableEl?.focus();
    };

    const cancel = () => {
      committed = true;
      this.editingCell = null;
      td.innerHTML      = origContent;
      td.style.padding  = origPad;
      td.style.overflow = "hidden";
      this.tableEl.focus();
    };

    input.onkeydown = (e) => {
      if (e.key==="Enter")  { e.preventDefault(); e.stopPropagation(); commit(r+1,c); }
      if (e.key==="Tab")    { e.preventDefault(); e.stopPropagation(); commit(r,c+(e.shiftKey?-1:1)); }
      if (e.key==="Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }
    };
    input.onblur = () => {
      if (committed) return;
      if (this.editingCell?.r===r && this.editingCell?.c===c) {
        committed = true;
        this.editingCell = null;
        restoreCell();
        this.setCellRaw(r, c, input.value);
      }
    };
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
      switch(e.key.toLowerCase()) {
        case "c": e.preventDefault(); this.copySelectionFull(); return;
        case "x": e.preventDefault(); this.cutSelection(); return;
        case "v": e.preventDefault(); this.pasteClipboard(); return;
        case "b": e.preventDefault(); this.toggleFormat("bold"); return;
        case "i": e.preventDefault(); this.toggleFormat("italic"); return;
        case "u": e.preventDefault(); this.toggleFormat("underline"); return;
        case "s": e.preventDefault(); this.saveFile(); return;
        case "a": e.preventDefault(); this.selectAll(); return;
        case "home": e.preventDefault(); this.setSelection(0,0,0,0); return;
        case "z":
          e.preventDefault();
          if (e.shiftKey) this.redo(); else this.undo();
          return;
        case "y": e.preventDefault(); this.redo(); return;
      }
    }
    switch(e.key) {
      case "ArrowUp":    e.preventDefault(); e.shiftKey?this.extendSelection(r1-1,c1):this.setSelection(r1-1,c1,r1-1,c1); break;
      case "ArrowDown":  e.preventDefault(); e.shiftKey?this.extendSelection(r1+1,c1):this.setSelection(r1+1,c1,r1+1,c1); break;
      case "ArrowLeft":  e.preventDefault(); e.shiftKey?this.extendSelection(r1,c1-1):this.setSelection(r1,c1-1,r1,c1-1); break;
      case "ArrowRight": e.preventDefault(); e.shiftKey?this.extendSelection(r1,c1+1):this.setSelection(r1,c1+1,r1,c1+1); break;
      case "Tab":   e.preventDefault(); e.shiftKey?this.setSelection(r1,c1-1,r1,c1-1):this.setSelection(r1,c1+1,r1,c1+1); break;
      case "Enter": e.preventDefault(); e.shiftKey?this.setSelection(r1-1,c1,r1-1,c1):this.setSelection(r1+1,c1,r1+1,c1); break;
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
    this.applyStyle(s => { s.border = border; });
    this.refreshSelectionCells();
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
    this.refreshAllCells();
    this.markDirty();
  }

  // ─── Freeze panes ────────────────────────────────────────────────────────────

  private freezeRows(count: number): void {
    const s = this.currentSheet();
    s.frozen = { rows:count, cols:s.frozen?.cols ?? 0 };
    this.switchSheet();
  }

  private freezeCols(count: number): void {
    const s = this.currentSheet();
    s.frozen = { rows:s.frozen?.rows ?? 0, cols:count };
    this.switchSheet();
  }

  private unfreeze(): void {
    this.currentSheet().frozen = { rows:0, cols:0 };
    this.switchSheet();
  }

  // ─── Column resize ────────────────────────────────────────────────────────────

  private startColResize(e: MouseEvent, colIdx: number): void {
    e.preventDefault(); e.stopPropagation();
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
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }

  // ─── Row / Column ops ─────────────────────────────────────────────────────────

  private shiftCells(sheet: SheetData, axis: "row"|"col", fromIdx: number, delta: 1|-1): Record<string,CellData> {
    const nc: Record<string,CellData> = {};
    for (const [addr,cell] of Object.entries(sheet.cells)) {
      const p = parseAddr(addr);
      if (!p) continue;
      const key = axis==="row" ? p.row : p.col;
      if (delta===1 && key>=fromIdx)      nc[axis==="row"?cellAddr(p.row+1,p.col):cellAddr(p.row,p.col+1)] = cell;
      else if (delta===-1 && key===fromIdx) { /* deleted */ }
      else if (delta===-1 && key>fromIdx)  nc[axis==="row"?cellAddr(p.row-1,p.col):cellAddr(p.row,p.col-1)] = cell;
      else nc[addr] = cell;
    }
    return nc;
  }

  private insertRow():      void { const r=Math.min(this.sel.r0,this.sel.r1);   const s=this.currentSheet(); s.cells=this.shiftCells(s,"row",r,1);  s.numRows++; this.switchSheet(); }
  private insertRowBelow(): void { const r=Math.max(this.sel.r0,this.sel.r1)+1; const s=this.currentSheet(); s.cells=this.shiftCells(s,"row",r,1);  s.numRows++; this.switchSheet(); }
  private deleteRow():      void { const r=Math.min(this.sel.r0,this.sel.r1);   const s=this.currentSheet(); s.cells=this.shiftCells(s,"row",r,-1); s.numRows=Math.max(1,s.numRows-1); this.switchSheet(); }
  private insertCol():      void { const c=Math.min(this.sel.c0,this.sel.c1);   const s=this.currentSheet(); s.cells=this.shiftCells(s,"col",c,1);  s.numCols++; this.switchSheet(); }
  private insertColRight(): void { const c=Math.max(this.sel.c0,this.sel.c1)+1; const s=this.currentSheet(); s.cells=this.shiftCells(s,"col",c,1);  s.numCols++; this.switchSheet(); }
  private deleteCol():      void { const c=Math.min(this.sel.c0,this.sel.c1);   const s=this.currentSheet(); s.cells=this.shiftCells(s,"col",c,-1); s.numCols=Math.max(1,s.numCols-1); this.switchSheet(); }

  // ─── Sheet ops ────────────────────────────────────────────────────────────────

  private switchSheet(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.sel = { r0:0, c0:0, r1:0, c1:0 };
    this.prevSel = { ...this.sel };
    this.rebuildHF();
    this.buildGrid();
    this.refreshAllCells();
    this.updateSelection();
    this.refreshFormulaBar();
    this.renderTabs();
    this.markDirty();
  }

  private addSheet(): void {
    this.fileData.sheets.push(emptySheet(`Sheet${this.fileData.sheets.length+1}`));
    this.activeSheet = this.fileData.sheets.length-1;
    this.switchSheet();
  }

  private deleteSheetAt(idx: number): void {
    if (this.fileData.sheets.length<=1) { new Notice("Cannot delete the only sheet."); return; }
    this.fileData.sheets.splice(idx,1);
    this.activeSheet = Math.min(this.activeSheet, this.fileData.sheets.length-1);
    this.switchSheet();
  }

  private renameSheet(idx: number): void {
    const name = prompt("Sheet name:", this.fileData.sheets[idx].name);
    if (name?.trim()) { this.fileData.sheets[idx].name=name.trim(); this.markDirty(); this.renderTabs(); }
  }

  private duplicateSheet(idx: number): void {
    const copy = JSON.parse(JSON.stringify(this.fileData.sheets[idx])) as SheetData;
    copy.name += " (2)";
    this.fileData.sheets.splice(idx+1,0,copy);
    this.activeSheet = idx+1;
    this.switchSheet();
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

    const onMove = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      const td = el?.closest?.("td") as HTMLTableCellElement | null;
      if (!td || td.closest("table") !== this.tableEl) return;
      const tr = td.closest("tr") as HTMLTableRowElement;
      const allRows = [...this.tbodyEl.querySelectorAll("tr")] as HTMLTableRowElement[];
      const r = allRows.indexOf(tr);
      const c = [...tr.querySelectorAll("td")].indexOf(td) - 1;
      if (r < 0 || c < 0) return;
      lastR = r; lastC = c;
      this.updateFillPreview(sR0, sC0, sR1, sC1, r, c);
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      this.clearFillPreview();
      this.doAutofill(sR0, sC0, sR1, sC1, lastR, lastC);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
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
        }
      }
    }

    this.commitUndoBatch();
    this.rebuildHF();
    this.refreshAllCells();
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
    this.startUndoBatch();
    const { r1,c1 } = this.sel;
    const sheet = this.currentSheet();
    let hasFormula = false;

    for (let dr = 0; dr < rows.length; dr++) {
      for (let dc = 0; dc < rows[dr].length; dc++) {
        const r = r1 + dr, c = c1 + dc;
        if (r >= sheet.numRows || c >= sheet.numCols) continue;
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
}
