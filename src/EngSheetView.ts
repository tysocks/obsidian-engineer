/**
 * EngSheetView — interactive Excel-like spreadsheet for .engsheet files.
 *
 * PERFORMANCE DESIGN
 * ──────────────────
 * The grid is built ONCE on load (or sheet switch). On every cell edit, only
 * the affected cells are updated in-place — no full DOM rebuild. HyperFormula
 * is only re-instantiated when a formula cell changes; plain value edits just
 * update the cell display directly. Selection changes update only the cells
 * whose highlight state changes (previous selection → new selection diff).
 *
 * FILE FORMAT (.engsheet — JSON)
 * ─────────────────────────────
 * {
 *   "version": 1,
 *   "sheets": [{
 *     "name": "Sheet1",
 *     "cells": {
 *       "A1": { "v": "Label",  "f": null, "style": { "bold": true } },
 *       "B1": { "v": null,     "f": "=STORE(\"E\")" },
 *       "C1": { "v": null,     "f": "=EXPORT(B1*2, \"double_E\")" }
 *     },
 *     "colWidths": { "0": 120 },
 *     "rowHeights": {},
 *     "numRows": 50,
 *     "numCols": 26
 *   }],
 *   "meta": {}
 * }
 *
 * VARIABLE STORE INTEGRATION
 * ──────────────────────────
 * Reading  →  =STORE("varname")
 *             Resolved to its current value before HyperFormula sees the formula.
 *
 * Writing  →  =EXPORT(expression, "varname")
 *             =EXPORT(expr, "varname", "scope")   scope: global (default), file, folder, tag
 *             The EXPORT wrapper is stripped before HF evaluation; after each
 *             recalculation the computed value is written to the Variable Store.
 *             Right-click → "Export cell…" wraps an existing formula automatically.
 */

import { FileView, Menu, Notice, WorkspaceLeaf, TFile } from "obsidian";
import { VariableStore, VariableVisibility } from "./VariableStore";

type TagResolver = (filePath: string) => string[];

export const ENGSHEET_VIEW_TYPE = "engsheet-view";
export const ENGSHEET_EXTENSION = "engsheet";

// ─── Types ────────────────────────────────────────────────────────────────────

interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: "left" | "center" | "right";
  color?: string;
  bg?: string;
  format?: string;
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
}

interface EngSheetFile {
  version: number;
  sheets: SheetData[];
  meta: Record<string, unknown>;
}

interface Selection {
  r0: number; c0: number;  // anchor
  r1: number; c1: number;  // active
}

interface ClipboardData {
  cells: Record<string, CellData | null>;
  mode: "copy" | "cut";
  rows: number;
  cols: number;
  selR0?: number; selR1?: number;
  selC0?: number; selC1?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_COL_W = 150;
const DEFAULT_ROW_H = 22;
const ROW_HDR_W     = 40;
const COL_HDR_H     = 22;
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
  if (f === "0")          return Math.round(value).toString();
  if (f === "0.0")        return value.toFixed(1);
  if (f === "0.00")       return value.toFixed(2);
  if (f === "0.000")      return value.toFixed(3);
  if (f === "0.0000")     return value.toFixed(4);
  if (f === "0.00000")    return value.toFixed(5);
  if (f === "0.00E+00")   return value.toExponential(2);
  if (f === "0.000E+00")  return value.toExponential(3);
  if (f === "#,##0")      return Math.round(value).toLocaleString();
  if (f === "#,##0.00")   return value.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
  if (f === "0%")         return (value*100).toFixed(0)+"%";
  if (f === "0.00%")      return (value*100).toFixed(2)+"%";
  return value.toString();
}

function emptySheet(name = "Sheet1"): SheetData {
  return { name, cells:{}, colWidths:{}, rowHeights:{}, numRows: DEFAULT_ROWS, numCols: DEFAULT_COLS };
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

  // Cached cell references — avoids re-querying DOM on every update
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
    this.buildGrid();     // builds DOM once
    this.refreshAllCells(); // populates values
    this.updateSelection(); // applies highlight
    this.refreshFormulaBar();
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

  // ─── HyperFormula ───────────────────────────────────────────────────────────

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
    // Pre-fill with nulls then patch only populated cells — avoids O(numRows×numCols) addr lookups
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

  /**
   * Lightweight HF update for a single cell — avoids full rebuild when only
   * one cell changes and it contains a formula. For plain values, no HF
   * update is needed at all since HF is only used to evaluate formulas.
   */
  private updateHFCell(r: number, c: number): void {
    if (!this.hf) return;
    const cell = this.currentSheet().cells[cellAddr(r,c)];
    try {
      const hfInst = this.hf as { setCellContents: (addr: object, content: unknown) => void };
      const content = cell?.f ? this.resolveCustomFuncs(cell.f) : (cell?.v ?? null);
      hfInst.setCellContents({ sheet:0, row:r, col:c }, [[content]]);
    } catch { /* fall back to full rebuild on next opportunity */ }
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
        // Mark alive before value check — cell still has EXPORT even if value is currently null
        nowExported.add(m[1]);
        const p = parseAddr(addr);
        if (!p) continue;
        const value = this.getComputedValue(p.row, p.col);
        if (value !== null && value !== undefined) {
          const rawScope = (m[2] ?? "global").trim();
          const lower = rawScope.toLowerCase();
          let vis: VariableVisibility = "global";
          let explicitFolder: string | undefined;
          if (lower.startsWith("folder:")) {
            vis = "folder";
            explicitFolder = rawScope.slice(7).trim() || undefined;
          } else if (lower === "folder") {
            vis = "folder";
          } else if (lower === "tag") {
            vis = "tag";
          }
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
      }
      this.fileData = parsed;
    } catch { this.fileData = emptyFile(); }
  }

  private async saveFile(): Promise<void> {
    if (!this.file) return;
    try {
      await this.app.vault.modify(this.file, JSON.stringify(this.fileData, null, 2));
      this.isDirty = false;
    } catch(e) { console.error("[Engineer] Save failed:", e); }
  }

  private markDirty(): void {
    this.isDirty = true;
    clearTimeout(this._saveTimer!);
    this._saveTimer = setTimeout(() => this.saveFile(), 1500);
  }

  // ─── UI shell ────────────────────────────────────────────────────────────────

  private buildUI(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.style.cssText = "display:flex;flex-direction:column;height:100%;overflow:hidden;user-select:none";
    container.oncontextmenu = (e) => e.preventDefault();
    this.buildRibbon(container);
    this.buildFormulaBar(container);
    this.gridScrollEl = container.createEl("div");
    this.gridScrollEl.style.cssText = "flex:1;overflow:auto;position:relative;background:var(--background-primary)";
    this.buildSheetTabs(container);
  }

  // ─── Ribbon ──────────────────────────────────────────────────────────────────

  private buildRibbon(parent: HTMLElement): void {
    const ribbon = parent.createEl("div");
    ribbon.style.cssText = "display:flex;align-items:center;gap:1px;padding:3px 6px;" +
      "border-bottom:1px solid var(--background-modifier-border);" +
      "background:var(--background-secondary);flex-shrink:0;flex-wrap:wrap";

    const grp = () => {
      const g = ribbon.createEl("div");
      g.style.cssText = "display:flex;align-items:center;gap:1px;padding-right:6px;" +
        "border-right:1px solid var(--background-modifier-border);margin-right:4px";
      return g;
    };

    // Minimal SVG icons — theme-coloured via currentColor
    const ICONS: Record<string, string> = {
      cut:    `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="4" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><line x1="4" y1="1" x2="12" y2="9"/><line x1="12" y1="1" x2="4" y2="9"/></svg>`,
      copy:   `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="5" width="9" height="9" rx="1"/><path d="M11 5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h2"/></svg>`,
      paste:  `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="4" width="10" height="11" rx="1"/><path d="M6 4V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1"/></svg>`,
      bold:   `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M4 3h5a3 3 0 0 1 0 6H4zm0 6h5.5a3.5 3.5 0 0 1 0 7H4z" opacity=".9"/></svg>`,
      italic: `<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M7 3h4l-4 10H3l4-10z" opacity=".9"/></svg>`,
      under:  `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 3v5a4 4 0 0 0 8 0V3"/><line x1="2" y1="14" x2="14" y2="14"/></svg>`,
      alL:    `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="2" y1="4" x2="14" y2="4"/><line x1="2" y1="8" x2="10" y2="8"/><line x1="2" y1="12" x2="14" y2="12"/></svg>`,
      alC:    `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="2" y1="4" x2="14" y2="4"/><line x1="4" y1="8" x2="12" y2="8"/><line x1="2" y1="12" x2="14" y2="12"/></svg>`,
      alR:    `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="2" y1="4" x2="14" y2="4"/><line x1="6" y1="8" x2="14" y2="8"/><line x1="2" y1="12" x2="14" y2="12"/></svg>`,
      insR:   `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="12" height="5" rx="1"/><rect x="2" y="9" width="12" height="5" rx="1"/><line x1="8" y1="6" x2="8" y2="9"/><line x1="6" y1="7.5" x2="10" y2="7.5"/></svg>`,
      delR:   `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="12" height="5" rx="1"/><rect x="2" y="9" width="12" height="5" rx="1"/><line x1="6" y1="7.5" x2="10" y2="7.5"/></svg>`,
      insC:   `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="5" height="12" rx="1"/><rect x="9" y="2" width="5" height="12" rx="1"/><line x1="6" y1="8" x2="9" y2="8"/><line x1="7.5" y1="6" x2="7.5" y2="10"/></svg>`,
      delC:   `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="5" height="12" rx="1"/><rect x="9" y="2" width="5" height="12" rx="1"/><line x1="6" y1="8" x2="10" y2="8"/></svg>`,
      save:   `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 2h8l3 3v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><rect x="5" y="9" width="6" height="5"/><rect x="5" y="2" width="4" height="4"/></svg>`,
    };

    const btn = (parent: HTMLElement, iconKey: string, title: string, action: () => void) => {
      const b = parent.createEl("button");
      b.innerHTML = ICONS[iconKey] ?? iconKey;
      b.title = title;
      b.style.cssText = "width:26px;height:26px;border-radius:3px;cursor:pointer;" +
        "display:flex;align-items:center;justify-content:center;" +
        "border:none;background:transparent;color:var(--text-normal);padding:0";
      b.onmouseenter = () => b.style.background = "var(--background-modifier-hover)";
      b.onmouseleave = () => b.style.background = "transparent";
      b.onclick = action;
      return b;
    };

    const sep = (g: HTMLElement) => {
      const s = g.createEl("div");
      s.style.cssText = "width:1px;height:18px;background:var(--background-modifier-border);margin:0 2px";
    };

    // Clipboard
    const cg = grp();
    btn(cg, "cut",   "Cut (Ctrl+X)",   () => this.cutSelection());
    btn(cg, "copy",  "Copy (Ctrl+C)",  () => this.copySelectionFull());
    btn(cg, "paste", "Paste (Ctrl+V)", () => this.pasteClipboard());

    // Font
    const fg = grp();
    btn(fg, "bold",  "Bold (Ctrl+B)",      () => this.toggleFormat("bold"));
    btn(fg, "italic","Italic (Ctrl+I)",     () => this.toggleFormat("italic"));
    btn(fg, "under", "Underline (Ctrl+U)",  () => this.toggleFormat("underline"));
    sep(fg);
    this.buildColorPicker(fg, "A", "Font color",  "color",  "#000000");
    this.buildColorPicker(fg, "▧", "Fill color",  "bg",     "#ffff00");

    // Alignment
    const ag = grp();
    btn(ag, "alL", "Align left",   () => this.applyStyle(s => { s.align = "left"; }));
    btn(ag, "alC", "Align center", () => this.applyStyle(s => { s.align = "center"; }));
    btn(ag, "alR", "Align right",  () => this.applyStyle(s => { s.align = "right"; }));

    // Number format
    const ng = grp();
    this.fmtSelect = ng.createEl("select");
    this.fmtSelect.style.cssText = "font-size:11px;height:24px;border-radius:3px;" +
      "border:1px solid var(--background-modifier-border);" +
      "background:var(--background-primary);color:var(--text-normal);padding:0 4px;cursor:pointer;max-width:140px";
    for (const [val, label] of NUMBER_FORMATS) {
      const opt = this.fmtSelect.createEl("option", { text: label });
      opt.value = val;
    }
    this.fmtSelect.onchange = () => this.applyStyle(s => {
      s.format = this.fmtSelect.value;
      // Refresh affected cells
      this.refreshSelectionCells();
    });

    // Cells
    const cellG = grp();
    btn(cellG, "insR", "Insert row above",   () => this.insertRow());
    btn(cellG, "delR", "Delete row",         () => this.deleteRow());
    btn(cellG, "insC", "Insert column left", () => this.insertCol());
    btn(cellG, "delC", "Delete column",      () => this.deleteCol());

    // Save (flush right)
    const sg = ribbon.createEl("div");
    sg.style.cssText = "margin-left:auto";
    btn(sg, "save", "Save (Ctrl+S)", () => this.saveFile());
  }

  private buildColorPicker(parent: HTMLElement, icon: string, title: string, prop: "color" | "bg", defaultColor: string): void {
    const wrap = parent.createEl("div");
    wrap.style.cssText = "position:relative;width:26px;height:26px;display:flex;flex-direction:column;" +
      "align-items:center;justify-content:center;border-radius:3px;cursor:pointer";
    wrap.title = title;
    const label = wrap.createEl("span", { text: icon });
    label.style.cssText = "font-size:11px;line-height:1;pointer-events:none;color:var(--text-normal);font-weight:500";
    const bar = wrap.createEl("div");
    bar.style.cssText = `height:3px;width:16px;background:${defaultColor};border-radius:1px;pointer-events:none`;
    const input = wrap.createEl("input") as HTMLInputElement;
    input.type = "color"; input.value = defaultColor;
    input.style.cssText = "position:absolute;opacity:0;width:26px;height:26px;cursor:pointer;top:0;left:0;padding:0;border:none";
    input.oninput = () => {
      bar.style.background = input.value;
      this.applyStyle(s => { s[prop] = input.value; });
      this.refreshSelectionCells();
    };
    wrap.onmouseenter = () => wrap.style.background = "var(--background-modifier-hover)";
    wrap.onmouseleave = () => wrap.style.background = "transparent";
  }

  // ─── Formula bar ─────────────────────────────────────────────────────────────

  private buildFormulaBar(parent: HTMLElement): void {
    const bar = parent.createEl("div");
    bar.style.cssText = "display:flex;align-items:center;" +
      "border-bottom:1px solid var(--background-modifier-border);flex-shrink:0;background:var(--background-primary)";

    this.nameBox = bar.createEl("input") as HTMLInputElement;
    this.nameBox.type = "text";
    this.nameBox.style.cssText = "width:64px;flex-shrink:0;font-size:12px;font-family:var(--font-monospace);" +
      "border:none;border-right:1px solid var(--background-modifier-border);" +
      "padding:0 6px;height:26px;background:var(--background-primary);color:var(--text-normal);outline:none;font-weight:500";
    this.nameBox.onkeydown = (e) => {
      if (e.key === "Enter") {
        const p = parseAddr(this.nameBox.value.toUpperCase().trim());
        if (p) { this.setSelection(p.row, p.col, p.row, p.col); this.gridScrollEl.focus(); }
      }
    };

    const fx = bar.createEl("span", { text: "fx" });
    fx.style.cssText = "padding:0 8px;font-size:11px;color:var(--text-muted);font-style:italic;" +
      "border-right:1px solid var(--background-modifier-border);height:26px;display:flex;align-items:center;flex-shrink:0";

    this.formulaInput = bar.createEl("input") as HTMLInputElement;
    this.formulaInput.type = "text";
    // No placeholder text — keep it clean
    this.formulaInput.style.cssText = "flex:1;font-size:12px;font-family:var(--font-monospace);" +
      "border:none;padding:0 8px;height:26px;background:var(--background-primary);color:var(--text-normal);outline:none";
    this.formulaInput.onkeydown = (e) => {
      if (e.key === "Enter")  { this.commitFormulaBar(); this.gridScrollEl.focus(); }
      if (e.key === "Escape") { this.refreshFormulaBar(); this.gridScrollEl.focus(); }
    };
  }

  // ─── Sheet tabs ───────────────────────────────────────────────────────────────

  private buildSheetTabs(parent: HTMLElement): void {
    this.sheetTabsEl = parent.createEl("div");
    this.sheetTabsEl.style.cssText = "display:flex;align-items:stretch;" +
      "border-top:1px solid var(--background-modifier-border);" +
      "background:var(--background-secondary);flex-shrink:0;overflow-x:auto;height:26px";
    this.renderTabs();
  }

  private renderTabs(): void {
    this.sheetTabsEl.empty();
    const addBtn = this.sheetTabsEl.createEl("div", { text: "+" });
    addBtn.style.cssText = "padding:0 10px;cursor:pointer;display:flex;align-items:center;" +
      "color:var(--text-muted);font-size:16px;border-right:1px solid var(--background-modifier-border)";
    addBtn.title = "Add sheet";
    addBtn.onclick = () => this.addSheet();
    this.fileData.sheets.forEach((sheet, idx) => {
      const tab = this.sheetTabsEl.createEl("div", { text: sheet.name });
      const active = idx === this.activeSheet;
      tab.style.cssText = "padding:0 14px;cursor:pointer;display:flex;align-items:center;font-size:12px;white-space:nowrap;" +
        "border-right:1px solid var(--background-modifier-border);" +
        (active ? "background:var(--background-primary);color:var(--text-normal);border-bottom:2px solid var(--interactive-accent);"
                : "background:transparent;color:var(--text-muted)");
      tab.onclick      = () => { this.activeSheet = idx; this.switchSheet(); };
      tab.ondblclick   = () => this.renameSheet(idx);
      tab.oncontextmenu = (e) => { e.preventDefault(); this.showSheetContextMenu(e, idx); };
    });
  }

  private showSheetContextMenu(e: MouseEvent, idx: number): void {
    const menu = new Menu();
    menu.addItem(i => i.setTitle("Rename").onClick(()    => this.renameSheet(idx)));
    menu.addItem(i => i.setTitle("Duplicate").onClick(() => this.duplicateSheet(idx)));
    menu.addSeparator();
    menu.addItem(i => i.setTitle("Delete").onClick(()    => this.deleteSheetAt(idx)));
    menu.showAtMouseEvent(e);
  }

  // ─── Grid — built once, updated in-place ──────────────────────────────────────

  /**
   * Builds the full table DOM structure once. After this, cell content and
   * highlight changes are done by updating individual <td> elements in-place
   * via cellEls[r][c] references — no innerHTML clearing.
   */
  private buildGrid(): void {
    this.gridScrollEl.empty();
    this.cellEls = [];
    const sheet = this.currentSheet();

    this.tableEl = this.gridScrollEl.createEl("table") as HTMLTableElement;
    this.tableEl.style.cssText = "border-collapse:collapse;table-layout:fixed;font-size:12px;font-family:var(--font-text)";
    this.tableEl.tabIndex = 0;

    // ── Column headers ────────────────────────────────────────────────────────
    this.theadEl = this.tableEl.createEl("thead") as HTMLTableSectionElement;
    const hrow = this.theadEl.createEl("tr");

    const corner = hrow.createEl("th");
    corner.style.cssText = `width:${ROW_HDR_W}px;min-width:${ROW_HDR_W}px;height:${COL_HDR_H}px;` +
      "background:var(--background-secondary);border-right:1px solid var(--background-modifier-border);" +
      "border-bottom:2px solid var(--background-modifier-border);position:sticky;top:0;left:0;z-index:4;cursor:pointer";
    corner.title = "Select all (Ctrl+A)";
    corner.onclick = () => this.selectAll();

    for (let c = 0; c < sheet.numCols; c++) {
      const w = sheet.colWidths[c] ?? DEFAULT_COL_W;
      const th = hrow.createEl("th");
      th.style.cssText = `width:${w}px;min-width:${w}px;max-width:${w}px;height:${COL_HDR_H}px;` +
        "text-align:center;font-size:11px;user-select:none;overflow:hidden;position:sticky;top:0;z-index:2;" +
        "border-right:1px solid var(--background-modifier-border);" +
        "border-bottom:2px solid var(--background-modifier-border);" +
        "background:var(--background-secondary);color:var(--text-muted);font-weight:400";
      th.createEl("span", { text: colLetter(c) });
      const rh = th.createEl("div");
      rh.style.cssText = "position:absolute;right:0;top:0;width:4px;height:100%;cursor:col-resize;z-index:3";
      rh.onmousedown = (e) => this.startColResize(e, c);
      th.onclick = (e) => { if (!this.colResizing) this.selectCol(c, e.shiftKey); };
    }

    // ── Data rows ─────────────────────────────────────────────────────────────
    this.tbodyEl = this.tableEl.createEl("tbody") as HTMLTableSectionElement;

    for (let r = 0; r < sheet.numRows; r++) {
      this.cellEls.push([]);
      const h = sheet.rowHeights[r] ?? DEFAULT_ROW_H;
      const tr = this.tbodyEl.createEl("tr");
      tr.style.height = h + "px";

      const rowHdr = tr.createEl("td");
      rowHdr.style.cssText = `width:${ROW_HDR_W}px;min-width:${ROW_HDR_W}px;text-align:center;font-size:11px;` +
        "position:sticky;left:0;z-index:1;user-select:none;cursor:pointer;" +
        "border-right:1px solid var(--background-modifier-border);" +
        "border-bottom:1px solid var(--background-modifier-border);" +
        "background:var(--background-secondary);color:var(--text-muted);font-weight:400";
      rowHdr.setText(String(r+1));
      rowHdr.onclick = (e) => this.selectRow(r, e.shiftKey);

      for (let c = 0; c < sheet.numCols; c++) {
        const w = sheet.colWidths[c] ?? DEFAULT_COL_W;
        const td = tr.createEl("td") as HTMLTableCellElement;
        td.style.cssText = `width:${w}px;min-width:${w}px;max-width:${w}px;height:${h}px;` +
          "padding:0 3px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;box-sizing:border-box;" +
          "border-right:1px solid var(--background-modifier-border);" +
          "border-bottom:1px solid var(--background-modifier-border);cursor:cell;" +
          "background:var(--background-primary);color:var(--text-normal);text-align:left";
        this.cellEls[r].push(td);

        td.onmousedown = (e: MouseEvent) => {
          if (e.button !== 0) return;
          e.preventDefault();
          if (e.shiftKey) this.extendSelection(r, c);
          else { this.setSelection(r, c, r, c); this.startMouseSelect(r, c); }
          this.tableEl.focus();
        };
        td.ondblclick    = () => this.startEdit(r, c, td);
        td.oncontextmenu = (e: MouseEvent) => {
          e.preventDefault();
          const { r0,c0,r1,c1 } = this.sel;
          const sR0=Math.min(r0,r1),sR1=Math.max(r0,r1),sC0=Math.min(c0,c1),sC1=Math.max(c0,c1);
          if (!(r >= sR0 && r <= sR1 && c >= sC0 && c <= sC1)) this.setSelection(r,c,r,c);
          this.showContextMenu(e);
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
  }

  /**
   * Update the content and style of a single cell's <td> in-place.
   * Called instead of full re-render whenever possible.
   */
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

    td.style.width = td.style.minWidth = td.style.maxWidth = w + "px";
    td.style.fontWeight      = cell?.style?.bold      ? "bold"      : "normal";
    td.style.fontStyle       = cell?.style?.italic    ? "italic"    : "normal";
    td.style.textDecoration  = cell?.style?.underline ? "underline" : "none";
    td.style.color           = cell?.style?.color     ?? "var(--text-normal)";
    td.style.backgroundColor = cell?.style?.bg        ?? "var(--background-primary)";
    td.style.textAlign       = cell?.style?.align     ?? (isNum ? "right" : "left");

    // Formula indicator (tiny superscript f)
    if (cell?.f) {
      td.style.position = "relative";
      // Only add if not already there
      if (!td.querySelector(".eng-fi")) {
        const fi = td.createEl("span");
        fi.className = "eng-fi";
        fi.style.cssText = "position:absolute;top:1px;right:2px;font-size:7px;color:#999;font-style:italic;pointer-events:none;font-family:serif";
        fi.textContent = "f";
      }
    } else {
      td.querySelector(".eng-fi")?.remove();
    }

    td.childNodes.forEach(n => { if (n.nodeType === Node.TEXT_NODE) n.remove(); });
    td.prepend(document.createTextNode(applyFormat(value, fmt)));
  }

  /** Refresh all cells — used after sheet switch or store change. */
  private refreshAllCells(): void {
    const sheet = this.currentSheet();
    for (let r = 0; r < sheet.numRows; r++)
      for (let c = 0; c < sheet.numCols; c++)
        this.refreshCell(r, c);
  }

  /** Refresh only the cells in the current selection — used after formatting. */
  private refreshSelectionCells(): void {
    const { r0,c0,r1,c1 } = this.sel;
    for (let r = Math.min(r0,r1); r <= Math.max(r0,r1); r++)
      for (let c = Math.min(c0,c1); c <= Math.max(c0,c1); c++)
        this.refreshCell(r, c);
    this.markDirty();
  }

  /**
   * Apply the selection highlight by updating only the <td> and header cells
   * that changed between prevSel and sel. Avoids touching all 1,300 cells.
   */
  private updateSelection(): void {
    const { r0,c0,r1,c1 } = this.sel;
    const { r0:pr0,c0:pc0,r1:pr1,c1:pc1 } = this.prevSel;
    const selR0=Math.min(r0,r1),selR1=Math.max(r0,r1),selC0=Math.min(c0,c1),selC1=Math.max(c0,c1);
    const pR0=Math.min(pr0,pr1),pR1=Math.max(pr0,pr1),pC0=Math.min(pc0,pc1),pC1=Math.max(pc0,pc1);

    const wasInSel = (r: number, c: number) => r>=pR0&&r<=pR1&&c>=pC0&&c<=pC1;
    const nowInSel = (r: number, c: number) => r>=selR0&&r<=selR1&&c>=selC0&&c<=selC1;

    // Update cells that changed selection state
    const rowsToCheck = new Set<number>();
    const colsToCheck = new Set<number>();
    for (let r = Math.min(pR0,selR0); r <= Math.max(pR1,selR1); r++) rowsToCheck.add(r);
    for (let c = Math.min(pC0,selC0); c <= Math.max(pC1,selC1); c++) colsToCheck.add(c);

    for (const r of rowsToCheck) {
      for (const c of colsToCheck) {
        const was = wasInSel(r,c), now = nowInSel(r,c);
        const isActive = r === r1 && c === c1;
        const isPrevActive = r === pr1 && c === pc1;
        if (was !== now || isActive || isPrevActive) {
          const td = this.cellEls[r]?.[c];
          if (!td) continue;
          const cell = this.currentSheet().cells[cellAddr(r,c)];
          const inClip = this.isInClipboard(r,c);
          td.style.backgroundColor = now
            ? (isActive ? "transparent" : "#d9e8f8")
            : (cell?.style?.bg ?? "var(--background-primary)");
          td.style.outline      = isActive ? "2px solid #1f78d1" : "none";
          td.style.outlineOffset = isActive ? "-1px" : "0";
          td.style.opacity      = (inClip && this.clipboard?.mode === "cut") ? "0.5" : "1";
          td.style.borderColor  = inClip ? "#1f78d1" : "var(--background-modifier-border)";
          td.style.borderStyle  = inClip ? "dashed" : "solid";
        }
      }
    }

    // Update row headers
    const allTrs = this.tbodyEl?.querySelectorAll("tr");
    for (const r of rowsToCheck) {
      const tr = allTrs?.[r];
      const rh = tr?.querySelector("td") as HTMLElement | null;
      if (!rh) continue;
      const inSel = nowInSel(r, selC0); // any col in range
      const wasIn = wasInSel(r, pC0);
      if (inSel !== wasIn) {
        rh.style.background = inSel ? "#bdd7ee" : "var(--background-secondary)";
        rh.style.color      = inSel ? "#1f497d" : "var(--text-muted)";
        rh.style.fontWeight = inSel ? "600"     : "400";
      }
    }

    // Update column headers
    const allThs = this.theadEl?.querySelectorAll("th");
    for (const c of colsToCheck) {
      const th = allThs?.[c+1] as HTMLElement | null; // +1 for corner
      if (!th) continue;
      const inSel = nowInSel(selR0, c);
      const wasIn = wasInSel(pR0, c);
      if (inSel !== wasIn) {
        th.style.background = inSel ? "#bdd7ee" : "var(--background-secondary)";
        th.style.color      = inSel ? "#1f497d" : "var(--text-muted)";
        th.style.fontWeight = inSel ? "600"     : "400";
      }
    }

    this.prevSel = { ...this.sel };
  }

  // ─── Selection ────────────────────────────────────────────────────────────────

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
    // Scroll active cell into view
    this.cellEls[this.sel.r1]?.[this.sel.c1]?.scrollIntoView({ block:"nearest", inline:"nearest" });
  }

  private extendSelection(r: number, c: number): void {
    const s = this.currentSheet();
    this.prevSel = { ...this.sel };
    this.sel.r1 = Math.max(0, Math.min(r, s.numRows-1));
    this.sel.c1 = Math.max(0, Math.min(c, s.numCols-1));
    this.updateSelection();
    this.refreshFormulaBar();
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

  private startMouseSelect(startR: number, startC: number): void {
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
    menu.addItem(i => i.setTitle("Cut (Ctrl+X)").onClick(()   => this.cutSelection()));
    menu.addItem(i => i.setTitle("Copy (Ctrl+C)").onClick(()  => this.copySelectionFull()));
    menu.addItem(i => i.setTitle("Paste (Ctrl+V)").onClick(() => this.pasteClipboard()));
    menu.addSeparator();
    menu.addItem(i => i.setTitle("Insert row above").onClick(()  => this.insertRow()));
    menu.addItem(i => i.setTitle("Insert row below").onClick(()  => this.insertRowBelow()));
    menu.addItem(i => i.setTitle("Delete row(s)").onClick(()     => this.deleteRow()));
    menu.addSeparator();
    menu.addItem(i => i.setTitle("Insert column left").onClick(()  => this.insertCol()));
    menu.addItem(i => i.setTitle("Insert column right").onClick(() => this.insertColRight()));
    menu.addItem(i => i.setTitle("Delete column(s)").onClick(()    => this.deleteCol()));
    menu.addSeparator();
    menu.addItem(i => i.setTitle("Clear contents (Delete)").onClick(() => this.clearSelection()));
    menu.addSeparator();
    menu.addItem(i => i.setTitle("Export cell to Variable Store…").onClick(() => this.promptExportCell()));
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
  }

  private cutSelection(): void {
    this.copySelectionFull();
    if (this.clipboard) this.clipboard.mode = "cut";
  }

  private pasteClipboard(): void {
    if (!this.clipboard) return;
    const { r1,c1 } = this.sel;
    const { cells,rows,cols,mode } = this.clipboard;
    const sheet = this.currentSheet();
    const affected: Array<[number,number]> = [];
    for (let dr=0; dr<rows; dr++) {
      for (let dc=0; dc<cols; dc++) {
        const src  = cells[cellAddr(dr,dc)];
        const dest = cellAddr(r1+dr,c1+dc);
        if (src) sheet.cells[dest] = {...src};
        else delete sheet.cells[dest];
        affected.push([r1+dr, c1+dc]);
      }
    }
    if (mode === "cut" && this.clipboard.selR0 !== undefined) {
      for (let r=this.clipboard.selR0; r<=this.clipboard.selR1!; r++)
        for (let c=this.clipboard.selC0!; c<=this.clipboard.selC1!; c++) {
          delete sheet.cells[cellAddr(r,c)];
          affected.push([r,c]);
        }
      this.clipboard = null;
    }
    const hasFormulas = affected.some(([r,c]) => sheet.cells[cellAddr(r,c)]?.f);
    if (hasFormulas) { this.rebuildHF(); this.refreshAllCells(); }
    else { affected.forEach(([r,c]) => this.refreshCell(r,c)); }
    this.markDirty();
  }

  private isInClipboard(r: number, c: number): boolean {
    if (!this.clipboard || this.clipboard.selR0 === undefined) return false;
    return r>=this.clipboard.selR0! && r<=this.clipboard.selR1! && c>=this.clipboard.selC0! && c<=this.clipboard.selC1!;
  }

  private clearSelection(): void {
    const { r0,c0,r1,c1 } = this.sel;
    const sheet = this.currentSheet();
    for (let r=Math.min(r0,r1); r<=Math.max(r0,r1); r++)
      for (let c=Math.min(c0,c1); c<=Math.max(c0,c1); c++) {
        const addr = cellAddr(r,c);
        const cell = sheet.cells[addr];
        if (cell?.style) sheet.cells[addr] = { v:null, f:null, style:cell.style };
        else delete sheet.cells[addr];
        this.refreshCell(r,c);
      }
    this.markDirty();
  }

  // ─── Cell editing ─────────────────────────────────────────────────────────────

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

    // Save original content to restore on Escape
    const origContent = td.innerHTML;
    const origStyle = { padding: td.style.padding, overflow: td.style.overflow };

    td.style.padding  = "0";
    td.style.overflow = "visible";
    td.innerHTML      = "";

    const input = td.createEl("input") as HTMLInputElement;
    input.type  = "text";
    input.value = initialChar !== null ? initialChar : current;
    input.style.cssText = "width:100%;height:100%;min-width:80px;border:none;" +
      "outline:2px solid #1f78d1;background:var(--background-primary);" +
      "font-family:var(--font-monospace);font-size:12px;padding:0 3px;" +
      "color:var(--text-normal);box-sizing:border-box";
    input.focus();
    if (initialChar === null) input.select(); else input.setSelectionRange(1,1);

    this.formulaInput.value = input.value;
    input.oninput = () => { this.formulaInput.value = input.value; };

    const commit = (newR: number, newC: number) => {
      const val = input.value;
      this.editingCell = null;
      this.setCellRaw(r, c, val);
      // setCellRaw will refresh r,c — just move selection
      this.setSelection(newR, newC, newR, newC);
    };

    const cancel = () => {
      this.editingCell = null;
      td.innerHTML      = origContent;
      td.style.padding  = origStyle.padding;
      td.style.overflow = origStyle.overflow;
      this.tableEl.focus();
    };

    input.onkeydown = (e) => {
      if (e.key === "Enter")  { e.preventDefault(); e.stopPropagation(); commit(r+1, c); }
      if (e.key === "Tab")    { e.preventDefault(); e.stopPropagation(); commit(r, c+(e.shiftKey?-1:1)); }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }
    };
    input.onblur = () => {
      if (this.editingCell?.r === r && this.editingCell?.c === c) {
        this.editingCell = null;
        this.setCellRaw(r, c, input.value);
      }
    };
  }

  /**
   * Core cell update — called after every edit.
   * Only rebuilds HyperFormula if the cell is a formula; otherwise just
   * updates the cell in the data model and refreshes the single <td>.
   */
  private setCellRaw(r: number, c: number, raw: string): void {
    const addr   = cellAddr(r,c);
    const sheet  = this.currentSheet();
    const existing = sheet.cells[addr];
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

    const isFormula = !!sheet.cells[addr]?.f;

    // Only rebuild HF if this is a formula cell (or was one)
    if (isFormula || wasFormula) {
      this.updateHFCell(r, c);
      // Dependents need refreshing too — for now refresh all formula cells
      this.refreshAllFormulaCells();
    } else {
      // Plain value — just update this one cell
      this.refreshCell(r, c);
    }

    this.markDirty();
    this.refreshFormulaBar();
  }

  /** Refresh only cells that have formulas (not plain values). */
  private refreshAllFormulaCells(): void {
    const sheet = this.currentSheet();
    for (const [addr, cell] of Object.entries(sheet.cells)) {
      if (!cell?.f) continue;
      const p = parseAddr(addr);
      if (p) this.refreshCell(p.row, p.col);
    }
    // Also refresh the edited cell even if it's now plain
    this.refreshCell(this.sel.r1, this.sel.c1);
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
      }
    }
    switch(e.key) {
      case "ArrowUp":    e.preventDefault(); e.shiftKey?this.extendSelection(r1-1,c1):this.setSelection(r1-1,c1,r1-1,c1); break;
      case "ArrowDown":  e.preventDefault(); e.shiftKey?this.extendSelection(r1+1,c1):this.setSelection(r1+1,c1,r1+1,c1); break;
      case "ArrowLeft":  e.preventDefault(); e.shiftKey?this.extendSelection(r1,c1-1):this.setSelection(r1,c1-1,r1,c1-1); break;
      case "ArrowRight": e.preventDefault(); e.shiftKey?this.extendSelection(r1,c1+1):this.setSelection(r1,c1+1,r1,c1+1); break;
      case "Tab":    e.preventDefault(); e.shiftKey?this.setSelection(r1,c1-1,r1,c1-1):this.setSelection(r1,c1+1,r1,c1+1); break;
      case "Enter":  e.preventDefault(); e.shiftKey?this.setSelection(r1-1,c1,r1-1,c1):this.setSelection(r1+1,c1,r1+1,c1); break;
      case "Delete": case "Backspace": e.preventDefault(); this.clearSelection(); break;
      case "F2": { e.preventDefault(); const td=this.cellEls[r1]?.[c1]; if(td) this.startEdit(r1,c1,td); break; }
      case "Escape": this.clipboard=null; break;
    }
  }

  // ─── Formatting ───────────────────────────────────────────────────────────────

  private applyStyle(updater: (style: CellStyle) => void): void {
    const { r0,c0,r1,c1 } = this.sel;
    const sheet = this.currentSheet();
    for (let r=Math.min(r0,r1); r<=Math.max(r0,r1); r++)
      for (let c=Math.min(c0,c1); c<=Math.max(c0,c1); c++) {
        const addr = cellAddr(r,c);
        if (!sheet.cells[addr]) sheet.cells[addr] = { v:null, f:null };
        sheet.cells[addr].style ??= {};
        updater(sheet.cells[addr].style!);
        this.refreshCell(r,c);
      }
    this.markDirty();
    this.syncFormatControls();
  }

  private toggleFormat(prop: "bold"|"italic"|"underline"): void {
    const { r1,c1 } = this.sel;
    const current = this.currentSheet().cells[cellAddr(r1,c1)]?.style?.[prop] ?? false;
    this.applyStyle(s => { s[prop] = !current; });
  }

  private syncFormatControls(): void {
    if (!this.fmtSelect) return;
    const cell = this.currentSheet().cells[cellAddr(this.sel.r1,this.sel.c1)];
    this.fmtSelect.value = cell?.style?.format ?? "General";
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

  // ─── Row / Column operations ──────────────────────────────────────────────────

  private shiftCells(sheet: SheetData, axis: "row"|"col", fromIdx: number, delta: 1|-1): Record<string,CellData> {
    const nc: Record<string,CellData> = {};
    for (const [addr,cell] of Object.entries(sheet.cells)) {
      const p = parseAddr(addr);
      if (!p) continue;
      const key = axis==="row" ? p.row : p.col;
      if (delta===1 && key>=fromIdx) nc[axis==="row"?cellAddr(p.row+1,p.col):cellAddr(p.row,p.col+1)] = cell;
      else if (delta===-1 && key===fromIdx) { /* deleted */ }
      else if (delta===-1 && key>fromIdx)  nc[axis==="row"?cellAddr(p.row-1,p.col):cellAddr(p.row,p.col-1)] = cell;
      else nc[addr] = cell;
    }
    return nc;
  }

  // Row/col ops all rebuild grid since structure changes
  private insertRow():      void { const r=Math.min(this.sel.r0,this.sel.r1); const s=this.currentSheet(); s.cells=this.shiftCells(s,"row",r,1); s.numRows++; this.switchSheet(); }
  private insertRowBelow(): void { const r=Math.max(this.sel.r0,this.sel.r1)+1; const s=this.currentSheet(); s.cells=this.shiftCells(s,"row",r,1); s.numRows++; this.switchSheet(); }
  private deleteRow():      void { const r=Math.min(this.sel.r0,this.sel.r1); const s=this.currentSheet(); s.cells=this.shiftCells(s,"row",r,-1); s.numRows=Math.max(1,s.numRows-1); this.switchSheet(); }
  private insertCol():      void { const c=Math.min(this.sel.c0,this.sel.c1); const s=this.currentSheet(); s.cells=this.shiftCells(s,"col",c,1); s.numCols++; this.switchSheet(); }
  private insertColRight(): void { const c=Math.max(this.sel.c0,this.sel.c1)+1; const s=this.currentSheet(); s.cells=this.shiftCells(s,"col",c,1); s.numCols++; this.switchSheet(); }
  private deleteCol():      void { const c=Math.min(this.sel.c0,this.sel.c1); const s=this.currentSheet(); s.cells=this.shiftCells(s,"col",c,-1); s.numCols=Math.max(1,s.numCols-1); this.switchSheet(); }

  // ─── Sheet operations ─────────────────────────────────────────────────────────

  /** Full rebuild — used only on sheet switch or structural change (add/del row/col). */
  private switchSheet(): void {
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
    const varName = prompt(`Export cell ${addr} to Variable Store.\nEnter variable name (leave empty to remove):`, existing);
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

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  private currentSheet(): SheetData {
    return this.fileData.sheets[this.activeSheet] ?? this.fileData.sheets[0];
  }
}
