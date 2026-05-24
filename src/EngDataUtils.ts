import { App, TFile } from "obsidian";
import { HyperFormula } from "hyperformula";
import { VariableStore, VariableVisibility } from "./VariableStore";

type TagResolver = (filePath: string) => string[];

export interface ParsedConfig {
  [key: string]: unknown;
}

interface EngCellData {
  v: string | number | boolean | null;
  f: string | null;
}

interface EngSheetData {
  name: string;
  cells: Record<string, EngCellData>;
  numRows: number;
  numCols: number;
}

interface EngSheetFile {
  version: number;
  sheets: EngSheetData[];
}

export interface RangeCoords {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export function parseFenceConfig(source: string): ParsedConfig {
  const lines = source.split(/\r?\n/);
  const cfg: ParsedConfig = {};
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      i++;
      continue;
    }
    const top = parseKeyValue(trimmed);
    if (!top) {
      i++;
      continue;
    }
    const key = top.key;
    const inline = top.value;

    if (inline) {
      cfg[key] = parseScalar(inline);
      i++;
      continue;
    }

    if (key === "series") {
      const { value, next } = parseSeriesBlock(lines, i + 1);
      cfg[key] = value;
      i = next;
      continue;
    }

    const { value, next, consumed } = parseObjectBlock(lines, i + 1, 2);
    if (consumed) {
      cfg[key] = value;
      i = next;
      continue;
    }
    cfg[key] = "";
    i++;
  }

  return cfg;
}

function parseSeriesBlock(lines: string[], start: number): { value: ParsedConfig[]; next: number } {
  const series: ParsedConfig[] = [];
  let i = start;
  let current: ParsedConfig | null = null;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const indent = leadingSpaces(line);
    if (indent < 2) break;
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      if (current) series.push(current);
      current = {};
      const remainder = trimmed.slice(2).trim();
      if (remainder) {
        const kv = parseKeyValue(remainder);
        if (kv) current[kv.key] = parseScalar(kv.value);
      }
      i++;
      continue;
    }
    if (!current) current = {};
    const kv = parseKeyValue(trimmed);
    if (kv) current[kv.key] = parseScalar(kv.value);
    i++;
  }
  if (current) series.push(current);
  return { value: series, next: i };
}

function parseObjectBlock(
  lines: string[],
  start: number,
  minIndent: number
): { value: ParsedConfig; next: number; consumed: boolean } {
  const obj: ParsedConfig = {};
  let i = start;
  let consumed = false;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const indent = leadingSpaces(line);
    if (indent < minIndent) break;
    const trimmed = line.trim();
    const kv = parseKeyValue(trimmed);
    if (kv) {
      consumed = true;
      obj[kv.key] = parseScalar(kv.value);
    }
    i++;
  }
  return { value: obj, next: i, consumed };
}

function parseKeyValue(line: string): { key: string; value: string } | null {
  const m = line.match(/^([^:=]+)\s*[:=]\s*(.*)$/);
  if (!m) return null;
  return { key: m[1].trim(), value: m[2].trim() };
}

function parseScalar(raw: string): unknown {
  const s = stripInlineComment(raw).trim();
  if (!s) return "";
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  const lower = s.toLowerCase();
  if (["true", "yes", "on"].includes(lower)) return true;
  if (["false", "no", "off"].includes(lower)) return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith("[") && s.endsWith("]")) {
    return splitTopLevel(s.slice(1, -1)).map((part) => parseScalar(part));
  }
  if (s.startsWith("{") && s.endsWith("}")) {
    const obj: ParsedConfig = {};
    for (const part of splitTopLevel(s.slice(1, -1))) {
      const m = part.match(/^([^:]+):\s*(.*)$/);
      if (!m) continue;
      obj[m[1].trim().replace(/^["']|["']$/g, "")] = parseScalar(m[2].trim());
    }
    return obj;
  }
  return s;
}

function stripInlineComment(raw: string): string {
  let q: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (q) {
      if (ch === q && raw[i - 1] !== "\\") q = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      continue;
    }
    if (ch === "#") return raw.slice(0, i);
  }
  return raw;
}

function splitTopLevel(raw: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let q: '"' | "'" | null = null;
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (q) {
      cur += ch;
      if (ch === q && raw[i - 1] !== "\\") q = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
      continue;
    }
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function leadingSpaces(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") n++;
  return n;
}

export function normalizeVaultPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function resolveVaultPath(sourcePath: string, notePath: string): string {
  if (!sourcePath) return sourcePath;
  if (sourcePath.includes("://")) return sourcePath;
  const normalized = normalizeVaultPath(sourcePath);
  if (!normalized.startsWith(".") && !normalized.startsWith("..")) return normalized;
  const baseParts = normalizeVaultPath(notePath).split("/");
  baseParts.pop();
  for (const part of normalized.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") baseParts.pop();
    else baseParts.push(part);
  }
  return baseParts.join("/");
}

export function columnToIndex(col: string): number {
  let n = 0;
  for (const ch of col.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

export function indexToColumn(idx: number): string {
  let s = "";
  let n = idx + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function parseCellAddr(addr: string): { row: number; col: number } | null {
  const m = addr.trim().toUpperCase().match(/^([A-Z]+)(\d+)$/);
  if (!m) return null;
  return { col: columnToIndex(m[1]), row: parseInt(m[2], 10) - 1 };
}

/** Merge duplicate cell keys that denote the same address (case/whitespace variants). */
export function normalizeEngSheetCellKeys<T extends object>(
  cells: Record<string, T>
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of Object.entries(cells)) {
    const p = parseCellAddr(k);
    if (p) out[indexToColumn(p.col) + (p.row + 1)] = v;
    else out[k.trim() || k] = v;
  }
  return out;
}

export interface ParsedExportFormula {
  expr: string;
  varName: string;
  unit?: string;
  scope?: string;
}

export interface ExportScopeOptions {
  visibility: VariableVisibility;
  scopeTag?: string;
  explicitFolder?: string;
}

/** Split on commas outside parentheses and quoted strings (for EXPORT argument lists). */
function splitTopLevelArgs(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote && input[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth--;
      continue;
    }
    if (ch === "," && depth === 0) {
      parts.push(input.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(input.slice(start).trim());
  return parts;
}

function unquoteExportArg(raw: string): string {
  const t = raw.trim();
  const m = t.match(/^["'](.*)["']$/s);
  return m ? m[1] : t;
}

/** True when the third EXPORT argument is a visibility scope, not a unit (backward compatible). */
export function isExportScopeToken(raw: string): boolean {
  const lower = raw.trim().toLowerCase();
  if (!lower) return false;
  if (lower.startsWith("folder:") || lower.startsWith("tag:")) return true;
  return /^(global|folder|tag|file|local)$/.test(lower);
}

/**
 * Parse =EXPORT(expr, "varname"[, "unit"][, "scope"]).
 * With three arguments, the third is scope when it matches a scope token; otherwise it is a unit.
 */
export function parseExportFormula(formula: string): ParsedExportFormula | null {
  const trimmed = formula.trim();
  if (!trimmed.startsWith("=")) return null;
  const body = trimmed.slice(1).trim();
  if (!/^EXPORT\s*\(/i.test(body)) return null;
  const open = body.indexOf("(");
  const close = body.lastIndexOf(")");
  if (open < 0 || close <= open) return null;
  const args = splitTopLevelArgs(body.slice(open + 1, close));
  if (args.length < 2) return null;

  const expr = args[0];
  const varName = unquoteExportArg(args[1]);
  if (!varName) return null;

  let unit: string | undefined;
  let scope: string | undefined;
  if (args.length === 3) {
    const third = unquoteExportArg(args[2]);
    if (isExportScopeToken(third)) scope = third;
    else if (third) unit = third;
  } else if (args.length >= 4) {
    const third = unquoteExportArg(args[2]);
    const fourth = unquoteExportArg(args[3]);
    if (third) unit = third;
    scope = fourth;
  }

  return { expr, varName, unit, scope };
}

/** Map EXPORT scope strings to Variable Store visibility (aligned with ---vars block comments). */
export function parseExportScope(scopeRaw?: string): ExportScopeOptions {
  const raw = (scopeRaw ?? "global").trim();
  const lower = raw.toLowerCase();
  if (lower.startsWith("tag:")) {
    return { visibility: "tag", scopeTag: raw.slice(4).trim() || undefined };
  }
  if (lower.startsWith("folder:")) {
    return { visibility: "folder", explicitFolder: raw.slice(7).trim() || undefined };
  }
  if (lower === "folder") return { visibility: "folder" };
  if (lower === "tag") return { visibility: "tag" };
  if (lower === "file" || lower === "local") return { visibility: "file" };
  return { visibility: "global" };
}

/** Replace EXPORT(...) with its inner expression for HyperFormula evaluation. */
export function stripExportWrapper(formula: string): string {
  const parsed = parseExportFormula(formula);
  if (parsed) {
    const expr = parsed.expr.trim();
    if (!expr) return formula;
    return expr.startsWith("=") ? expr : `=${expr}`;
  }
  return formula.replace(
    /EXPORT\s*\(\s*([^,]+?)\s*,\s*["'][^"']*["']\s*(?:,\s*["'][^"']*["']\s*){0,2}\)/gi,
    (_m, expr) => expr.trim()
  );
}

export function parseRange(range: string): RangeCoords | null {
  const raw = range.trim();
  if (!raw) return null;
  const [a, b] = raw.split(":");
  const p1 = parseCellAddr(a);
  const p2 = parseCellAddr(b ?? a);
  if (!p1 || !p2) return null;
  return {
    r0: Math.min(p1.row, p2.row),
    c0: Math.min(p1.col, p2.col),
    r1: Math.max(p1.row, p2.row),
    c1: Math.max(p1.col, p2.col),
  };
}

export function formatCell(value: unknown, precision?: number): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" && Number.isFinite(value) && precision !== undefined) {
    return value.toFixed(Math.max(0, precision));
  }
  if (typeof value === "object") {
    if ("value" in (value as object)) return formatCell((value as { value: unknown }).value, precision);
    return "#ERR";
  }
  return String(value);
}

export async function readCsvFile(app: App, path: string): Promise<string[][]> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) throw new Error(`CSV file not found: ${path}`);
  const text = await app.vault.read(file);
  return parseDelimited(text, ",");
}

export function parseDelimited(text: string, delimiter: "," | "\t"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 2;
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length > 0 && rows[rows.length - 1].every((c) => c === "")) rows.pop();
  return rows;
}

export function csvColumn(rows: string[][], selector: string): string[] {
  if (rows.length === 0) return [];
  const trimmed = selector.trim();
  const header = rows[0];
  let idx = header.findIndex((h) => h.trim() === trimmed);
  if (idx < 0 && /^[A-Za-z]+$/.test(trimmed)) idx = columnToIndex(trimmed);
  if (idx < 0) return [];
  return rows.slice(1).map((r) => r[idx] ?? "");
}

export async function readEngSheetRange(
  app: App,
  store: VariableStore,
  filePath: string,
  sheetName: string | undefined,
  range: RangeCoords,
  tagResolver?: TagResolver
): Promise<unknown[][]> {
  const file = app.vault.getAbstractFileByPath(filePath);
  if (!(file instanceof TFile)) throw new Error(`EngSheet file not found: ${filePath}`);
  const parsed = JSON.parse(await app.vault.read(file)) as EngSheetFile;
  const sheet = pickSheet(parsed, sheetName);
  if (!sheet) throw new Error(`Sheet not found: ${sheetName ?? "Sheet1"}`);
  sheet.cells = normalizeEngSheetCellKeys(sheet.cells ?? {});

  let maxCellR = -1;
  let maxCellC = -1;
  for (const addr of Object.keys(sheet.cells ?? {})) {
    const p = parseCellAddr(addr);
    if (!p) continue;
    if (p.row > maxCellR) maxCellR = p.row;
    if (p.col > maxCellC) maxCellC = p.col;
  }
  const rows = Math.max(sheet.numRows, range.r1 + 1, maxCellR >= 0 ? maxCellR + 1 : 0);
  const cols = Math.max(sheet.numCols, range.c1 + 1, maxCellC >= 0 ? maxCellC + 1 : 0);
  const data: (string | number | boolean | null)[][] = Array.from({ length: rows }, () =>
    Array(cols).fill(null)
  );
  for (const [addr, cell] of Object.entries(sheet.cells ?? {})) {
    const p = parseCellAddr(addr);
    if (!p || p.row >= rows || p.col >= cols) continue;
    data[p.row][p.col] = cell.f
      ? resolveCustomFormula(cell.f, store, filePath, tagResolver)
      : (cell.v ?? null);
  }
  const hf = HyperFormula.buildFromArray(data, { licenseKey: "gpl-v3" });
  const out: unknown[][] = [];
  for (let r = range.r0; r <= range.r1; r++) {
    const row: unknown[] = [];
    for (let c = range.c0; c <= range.c1; c++) {
      let raw: unknown;
      try {
        raw = hf.getCellValue({ sheet: 0, row: r, col: c });
      } catch {
        raw = null;
      }
      if (raw !== null && typeof raw === "object" && "value" in (raw as object)) {
        row.push((raw as { value: unknown }).value);
      } else {
        row.push(raw);
      }
    }
    out.push(row);
  }
  return out;
}

function pickSheet(data: EngSheetFile, name?: string): EngSheetData | undefined {
  if (!data.sheets || data.sheets.length === 0) return undefined;
  if (!name) return data.sheets[0];
  return data.sheets.find((s) => s.name === name) ?? data.sheets[0];
}

function resolveCustomFormula(
  formula: string,
  store: VariableStore,
  filePath: string,
  tagResolver?: TagResolver
): string {
  let out = formula.replace(/STORE\s*\(\s*["']([^"']+)["']\s*\)/gi, (_m, name) => {
    const val = store.get(name, filePath, tagResolver);
    if (val === undefined || val === null) return "0";
    if (typeof val === "number") return String(val);
    if (typeof val === "boolean") return val ? "TRUE" : "FALSE";
    return `"${String(val).replace(/"/g, '""')}"`;
  });
  out = stripExportWrapper(out);
  return out;
}
