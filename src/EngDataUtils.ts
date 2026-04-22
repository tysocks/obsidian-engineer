import { App, TFile } from "obsidian";
import { HyperFormula } from "hyperformula";
import { VariableStore } from "./VariableStore";

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
    const top = trimmed.match(/^([^:]+):\s*(.*)$/);
    if (!top) {
      i++;
      continue;
    }
    const key = top[1].trim();
    const inline = top[2].trim();

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
        const m = remainder.match(/^([^:]+):\s*(.*)$/);
        if (m) current[m[1].trim()] = parseScalar(m[2].trim());
      }
      i++;
      continue;
    }
    if (!current) current = {};
    const m = trimmed.match(/^([^:]+):\s*(.*)$/);
    if (m) current[m[1].trim()] = parseScalar(m[2].trim());
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
    const m = trimmed.match(/^([^:]+):\s*(.*)$/);
    if (m) {
      consumed = true;
      obj[m[1].trim()] = parseScalar(m[2].trim());
    }
    i++;
  }
  return { value: obj, next: i, consumed };
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

  const rows = Math.max(sheet.numRows, range.r1 + 1);
  const cols = Math.max(sheet.numCols, range.c1 + 1);
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
  out = out.replace(
    /EXPORT\s*\(\s*([^,]+?)\s*,\s*["'][^"']*["']\s*(?:,\s*["'][^"']*["']\s*)?\)/gi,
    (_m, expr) => expr.trim()
  );
  return out;
}
