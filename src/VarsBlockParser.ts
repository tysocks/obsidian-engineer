/**
 * VarsBlockParser — parses ---vars blocks and loads variables into the store.
 *
 * SYNTAX
 * ------
 * Place a ---vars block anywhere in a note (typically near the top):
 *
 *   ---vars
 *   # Material properties
 *   E: 200e9          # Pa
 *   nu: 0.3
 *   G: E / (2*(1+nu)) # Pa  ← can reference earlier vars in the same block
 *
 *   # Section
 *   I: 113e-6         # m⁴
 *   A: 0.0127         # m²
 *
 *   # Loading
 *   F: 50000          # N
 *   L: 6.0            # m
 *   ---
 *
 * VALUE TYPES
 *   Numbers:           E: 200e9
 *   Expressions:       G: E / (2 * (1 + nu))
 *   Strings (quoted):  material: "Steel S275"
 *   Arrays:            loads: [10000, 15000, 8000]
 *
 * UNIT EXTRACTION
 * The comment after # is scanned for a leading unit token (Pa, N, m, kN, etc).
 * If found it is stored in the entry and shown in the Variable Store sidebar.
 *
 * EVALUATION ORDER
 * Lines are evaluated top-to-bottom with an accumulating mathjs scope, so a
 * later variable can reference any earlier one in the same block.
 */

import { App, TFile } from "obsidian";
import { VariableStore } from "./VariableStore";
import * as math from "mathjs";

const VARS_BLOCK_REGEX = /(?:^|\n)---vars\s*\n([\s\S]*?)\n---/;
const VAR_LINE_REGEX = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.+?)(?:\s*#\s*(.*))?$/;

const KNOWN_SCOPES: Array<{ keyword: RegExp; visibility: "global" | "file" | "folder" | "tag" }> = [
  { keyword: /\bfile\b/i,   visibility: "file"   },
  { keyword: /\blocal\b/i,  visibility: "file"   },  // backward-compatible alias
  { keyword: /\bfolder\b/i, visibility: "folder" },
  { keyword: /\btag\b/i,    visibility: "tag"    },
  { keyword: /\bglobal\b/i, visibility: "global" },
];

const KNOWN_UNITS = [
  "Pa", "kPa", "MPa", "GPa",
  "N", "kN", "MN",
  "m", "mm", "cm", "km",
  "m2", "m²", "mm2", "mm²",
  "m3", "m³", "mm3", "mm³",
  "m4", "m⁴", "mm4", "mm⁴",
  "kg", "g", "t",
  "s", "ms",
  "K", "°C", "°F",
  "J", "kJ", "MJ",
  "W", "kW", "MW",
  "rad", "deg", "°",
  "Hz", "kHz", "MHz",
  "A", "V", "Ω",
];

export interface ParseResult {
  variables: Record<string, { value: unknown; unit?: string }>;
  errors: Array<{ line: string; message: string }>;
}

type TagResolver = (filePath: string) => string[];

export class VarsBlockParser {
  private app: App;
  private store: VariableStore;
  tagResolver?: TagResolver;

  constructor(app: App, store: VariableStore) {
    this.app = app;
    this.store = store;
  }

  parseAndLoad(content: string, filePath: string): ParseResult {
    const result: ParseResult = { variables: {}, errors: [] };

    const match = content.match(VARS_BLOCK_REGEX);
    if (!match) {
      this.store.clearFromSource(filePath);
      return result;
    }

    const lines = match[1].split("\n");

    // Accumulating scope: later lines can reference earlier variables.
    // Pass tagResolver so tag-scoped vars from other files are available.
    const scope: Record<string, unknown> = {
      ...this.store.getAll(filePath, this.tagResolver),
    };

    let blockIndex = 0;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;

      const lineMatch = line.match(VAR_LINE_REGEX);
      if (!lineMatch) {
        result.errors.push({ line, message: "Could not parse variable definition" });
        continue;
      }

      const [, key, rawValue, comment] = lineMatch;
      const unit = this.extractUnit(comment);
      const { visibility, scopeTag, scopeFolder } = this.extractScope(comment);

      let value: unknown;
      try {
        const evaluated = math.evaluate(rawValue.trim(), scope as math.MathJsInstance);
        value = this.toPlainJS(evaluated);
      } catch {
        value = rawValue.trim().replace(/^["']|["']$/g, "");
      }

      scope[key] = value;
      result.variables[key] = { value, unit };

      this.store.set(key, value, unit, filePath, `vars-${blockIndex}`, "global", visibility, scopeTag, scopeFolder);
      blockIndex++;
    }

    return result;
  }

  async parseAllFiles(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    for (const file of files) {
      const content = await this.app.vault.read(file);
      if (content.includes("---vars")) {
        this.parseAndLoad(content, file.path);
      }
    }
  }

  async parseFile(file: TFile): Promise<ParseResult> {
    const content = await this.app.vault.read(file);
    return this.parseAndLoad(content, file.path);
  }

  private extractScope(comment?: string): {
    visibility: "global" | "file" | "folder" | "tag";
    scopeTag?: string;
    scopeFolder?: string;
  } {
    if (!comment) return { visibility: "global" };
    // tag:tagname
    const tagMatch = comment.match(/\btag:\s*([^\s,]+)/i);
    if (tagMatch) return { visibility: "tag", scopeTag: tagMatch[1] };
    // folder:path/to/folder — explicit folder scope target
    const folderMatch = comment.match(/\bfolder:\s*([^\s,]+)/i);
    if (folderMatch) return { visibility: "folder", scopeFolder: folderMatch[1] };
    for (const { keyword, visibility } of KNOWN_SCOPES) {
      if (keyword.test(comment)) return { visibility };
    }
    return { visibility: "global" };
  }

  private extractUnit(comment?: string): string | undefined {
    if (!comment) return undefined;
    const trimmed = comment.trim();
    for (const unit of KNOWN_UNITS) {
      if (
        trimmed === unit ||
        trimmed.startsWith(unit + " ") ||
        trimmed.startsWith(unit + ",") ||
        trimmed.startsWith(unit + "—") ||
        trimmed.startsWith(unit + " —")
      ) {
        return unit;
      }
    }
    return undefined;
  }

  private toPlainJS(value: unknown): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === "object" && "toArray" in value) {
      return (value as { toArray(): unknown }).toArray();
    }
    if (typeof value === "object" && "toString" in value) {
      const str = (value as { toString(): string }).toString();
      const num = parseFloat(str);
      if (!isNaN(num) && str === String(num)) return num;
      return str;
    }
    return value;
  }
}
