import { App } from "obsidian";
import * as math from "mathjs";
import { VariableStore } from "./VariableStore";

interface UnitIssue {
  severity: "warn" | "error";
  file: string;
  context: string;
  message: string;
}

interface UnitDef {
  dim: Record<string, number>;
}

const VAR_BLOCK_G = /(?:^|\n)---vars\s*\n([\s\S]*?)\n---/g;
const VAR_LINE = /^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.+?)(?:\s*#\s*(.*))?$/;

const UNIT_DIMENSIONS: Record<string, UnitDef> = {
  m: { dim: { L: 1 } }, mm: { dim: { L: 1 } }, cm: { dim: { L: 1 } }, km: { dim: { L: 1 } },
  s: { dim: { T: 1 } }, ms: { dim: { T: 1 } },
  kg: { dim: { M: 1 } }, g: { dim: { M: 1 } }, t: { dim: { M: 1 } },
  N: { dim: { M: 1, L: 1, T: -2 } }, kN: { dim: { M: 1, L: 1, T: -2 } }, MN: { dim: { M: 1, L: 1, T: -2 } },
  Pa: { dim: { M: 1, L: -1, T: -2 } }, kPa: { dim: { M: 1, L: -1, T: -2 } }, MPa: { dim: { M: 1, L: -1, T: -2 } }, GPa: { dim: { M: 1, L: -1, T: -2 } },
  J: { dim: { M: 1, L: 2, T: -2 } }, kJ: { dim: { M: 1, L: 2, T: -2 } }, MJ: { dim: { M: 1, L: 2, T: -2 } },
  W: { dim: { M: 1, L: 2, T: -3 } }, kW: { dim: { M: 1, L: 2, T: -3 } }, MW: { dim: { M: 1, L: 2, T: -3 } },
  Hz: { dim: { T: -1 } }, kHz: { dim: { T: -1 } }, MHz: { dim: { T: -1 } },
  rad: { dim: {} }, deg: { dim: {} }, "°": { dim: {} },
  K: { dim: { Temp: 1 } }, "°C": { dim: { Temp: 1 } }, "°F": { dim: { Temp: 1 } },
  A: { dim: { I: 1 } }, V: { dim: { M: 1, L: 2, T: -3, I: -1 } }, "Ω": { dim: { M: 1, L: 2, T: -3, I: -2 } },
  m2: { dim: { L: 2 } }, "m²": { dim: { L: 2 } }, mm2: { dim: { L: 2 } }, "mm²": { dim: { L: 2 } },
  m3: { dim: { L: 3 } }, "m³": { dim: { L: 3 } }, mm3: { dim: { L: 3 } }, "mm³": { dim: { L: 3 } },
  m4: { dim: { L: 4 } }, "m⁴": { dim: { L: 4 } }, mm4: { dim: { L: 4 } }, "mm⁴": { dim: { L: 4 } },
};

export class UnitEngine {
  private app: App;
  private store: VariableStore;

  constructor(app: App, store: VariableStore) {
    this.app = app;
    this.store = store;
  }

  async validateVault(): Promise<UnitIssue[]> {
    const issues: UnitIssue[] = [];
    this.validateStoreUnitConflicts(issues);
    const files = this.app.vault.getMarkdownFiles();
    for (const file of files) {
      const content = await this.app.vault.read(file);
      this.validateVarsBlocks(file.path, content, issues);
    }
    return issues;
  }

  private validateStoreUnitConflicts(issues: UnitIssue[]): void {
    const byKey = new Map<string, Set<string>>();
    for (const { key, entry } of this.store.getAllEntries()) {
      if (!entry.unit) continue;
      if (!byKey.has(key)) byKey.set(key, new Set<string>());
      byKey.get(key)!.add(this.dimSignature(entry.unit));
    }
    for (const [key, dims] of byKey.entries()) {
      if (dims.size > 1) {
        issues.push({
          severity: "warn",
          file: "(store)",
          context: key,
          message: `Variable has conflicting dimensions across sources: ${[...dims].join(", ")}`,
        });
      }
    }
  }

  private validateVarsBlocks(filePath: string, content: string, issues: UnitIssue[]): void {
    const scopeUnits = new Map<string, string | undefined>();
    for (const m of content.matchAll(VAR_BLOCK_G)) {
      const lines = m[1].split("\n");
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const vm = line.match(VAR_LINE);
        if (!vm) continue;
        const [, key, expr, comment] = vm;
        const unit = this.extractLeadingUnit(comment);
        const inferred = this.inferExprUnit(expr.trim(), scopeUnits, filePath, issues);
        if (unit && inferred && !this.sameDimension(unit, inferred)) {
          issues.push({
            severity: "warn",
            file: filePath,
            context: key,
            message: `Declared unit \`${unit}\` does not match inferred expression dimension \`${inferred}\`.`,
          });
        }
        scopeUnits.set(key, unit ?? inferred);
      }
    }
  }

  private inferExprUnit(
    expr: string,
    scopeUnits: Map<string, string | undefined>,
    filePath: string,
    issues: UnitIssue[]
  ): string | undefined {
    let node: math.MathNode;
    try {
      node = math.parse(expr);
    } catch {
      return undefined;
    }
    return this.inferNode(node, scopeUnits, filePath, issues);
  }

  private inferNode(
    node: math.MathNode,
    scopeUnits: Map<string, string | undefined>,
    filePath: string,
    issues: UnitIssue[]
  ): string | undefined {
    if (node.type === "ConstantNode") return undefined;
    if (node.type === "SymbolNode") {
      const name = (node as math.SymbolNode).name;
      if (scopeUnits.has(name)) return scopeUnits.get(name);
      const entry = this.store.getEntry(name, filePath);
      return entry?.unit;
    }
    if (node.type === "ParenthesisNode") {
      return this.inferNode((node as math.ParenthesisNode).content, scopeUnits, filePath, issues);
    }
    if (node.type === "OperatorNode") {
      const opNode = node as math.OperatorNode;
      const args = opNode.args.map((a) => this.inferNode(a, scopeUnits, filePath, issues));
      if (opNode.op === "+" || opNode.op === "-") {
        const left = args[0];
        const right = args[1];
        if (left && right && !this.sameDimension(left, right)) {
          issues.push({
            severity: "error",
            file: filePath,
            context: opNode.toString(),
            message: `Unit mismatch in additive expression: \`${left}\` vs \`${right}\`.`,
          });
        }
        return left ?? right;
      }
      if (opNode.op === "*") return this.combineUnits(args[0], args[1], 1);
      if (opNode.op === "/") return this.combineUnits(args[0], args[1], -1);
      if (opNode.op === "^") {
        const base = args[0];
        const powerNode = opNode.args[1];
        if (!base || powerNode.type !== "ConstantNode") return base;
        const p = Number((powerNode as math.ConstantNode).value);
        return Number.isFinite(p) ? `${base}^${p}` : base;
      }
      return args[0];
    }
    if ((node as { args?: math.MathNode[] }).args) {
      const args = (node as { args: math.MathNode[] }).args;
      return args.length > 0 ? this.inferNode(args[0], scopeUnits, filePath, issues) : undefined;
    }
    return undefined;
  }

  private combineUnits(a?: string, b?: string, sign = 1): string | undefined {
    if (a && b) return sign > 0 ? `${a}*${b}` : `${a}/${b}`;
    return a ?? b;
  }

  private extractLeadingUnit(comment?: string): string | undefined {
    if (!comment) return undefined;
    const first = comment.trim().split(/[,\s]/)[0];
    return first || undefined;
  }

  private sameDimension(a?: string, b?: string): boolean {
    if (!a || !b) return true;
    return this.dimSignature(a) === this.dimSignature(b);
  }

  private dimSignature(unit: string): string {
    const norm = unit.trim();
    const exact = UNIT_DIMENSIONS[norm];
    if (exact) return this.dimToString(exact.dim);
    if (norm.includes("*") || norm.includes("/")) {
      const dim = this.parseCompositeDim(norm);
      if (dim) return this.dimToString(dim);
    }
    const exp = norm.match(/^(.+)\^(-?\d+(?:\.\d+)?)$/);
    if (exp) {
      const base = UNIT_DIMENSIONS[exp[1].trim()];
      const p = Number(exp[2]);
      if (base && Number.isFinite(p)) {
        const scaled: Record<string, number> = {};
        for (const [k, v] of Object.entries(base.dim)) scaled[k] = v * p;
        return this.dimToString(scaled);
      }
    }
    return `unknown:${norm.toLowerCase()}`;
  }

  private parseCompositeDim(raw: string): Record<string, number> | null {
    const tokens = raw.split(/([*/])/).map((s) => s.trim()).filter(Boolean);
    const out: Record<string, number> = {};
    let sign = 1;
    for (const t of tokens) {
      if (t === "*") {
        sign = 1;
        continue;
      }
      if (t === "/") {
        sign = -1;
        continue;
      }
      const m = t.match(/^(.+?)(?:\^(-?\d+(?:\.\d+)?))?$/);
      if (!m) return null;
      const base = UNIT_DIMENSIONS[m[1].trim()];
      if (!base) return null;
      const p = Number(m[2] ?? "1") * sign;
      for (const [k, v] of Object.entries(base.dim)) out[k] = (out[k] ?? 0) + v * p;
    }
    return out;
  }

  private dimToString(dim: Record<string, number>): string {
    const entries = Object.entries(dim).filter(([, v]) => Math.abs(v) > 1e-10).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) return "dimensionless";
    return entries.map(([k, v]) => `${k}:${v}`).join("|");
  }
}
