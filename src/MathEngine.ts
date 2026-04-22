/**
 * MathEngine — evaluates <<...>> variable substitutions in math blocks.
 *
 * SYNTAX
 * ------
 *   <<varname>>                  read a variable value
 *   <<varname:.2e>>              read with format spec
 *   <<result = expression>>      compute, display, write back to store
 *   <<result = expression:.4f>>  compute+assign with format spec
 *
 * FORMAT SPECS (printf-style, suffix after colon):
 *   .Nf  fixed decimal:    <<delta:.5f>>  → 0.00017
 *   .Ne  scientific:       <<E:.2e>>      → 2.00 \times 10^{11}
 *   .Ng  general (auto):   <<nu:.3g>>     → 0.3
 *   .Nd  integer (round):  <<n:.0d>>      → 42
 *
 * TWO RENDERING PATHS
 * -------------------
 *
 * PRIMARY — emath code fence (always reliable):
 *
 *   ```emath
 *   \delta = \frac{FL^3}{48EI} = <<delta = F*L**3/(48*E*I):.4f>>\ \text{m}
 *   ```
 *
 *   Obsidian passes the raw fence content directly to our handler via
 *   registerMarkdownCodeBlockProcessor. No timing or parser interference.
 *
 * SECONDARY — inline $<<...>>$ math:
 *
 *   The load is $F = <<F>>$ N over span $L = <<L>>$ m.
 *
 *   Uses a pre-built fileSourceCache (populated whenever a file is read by
 *   parseAllFiles or the vault modify handler) so the synchronous post-
 *   processor can scan raw markdown without async vault reads. Falls back
 *   to ctx.getSectionInfo() when Obsidian provides it.
 *
 * WHY <<...>> DELIMITERS?
 * -----------------------
 *   [[...]] → converted to wikilinks by Obsidian before post-processors run
 *   {...}   → LaTeX grouping characters, breaks MathJax parsing
 *   <<...>> → no special meaning in Obsidian or LaTeX, passes through intact
 *
 * LIVE UPDATES
 * ------------
 * Store changes trigger a debounced (200ms) previewMode.rerender(false) on
 * all open Reading View panes. rerender(false) rebuilds from source, re-
 * running the full post-processor pipeline with fresh variable values.
 */

import { MarkdownPostProcessorContext, MarkdownView, Plugin } from "obsidian";
import { VariableStore } from "./VariableStore";
import * as math from "mathjs";

const SUBSTITUTION_REGEX = /<<([^<>]+?)>>/g;
const DISPLAY_MATH_REGEX = /\$\$([\s\S]+?)\$\$/g;
const INLINE_MATH_REGEX = /(?<!\$)\$(?!\$)([^$\n]+?)\$(?!\$)/g;

type TagResolver = (filePath: string) => string[];

export class MathEngine {
  private store: VariableStore;
  private plugin: Plugin;
  private rerenderTimer: ReturnType<typeof setTimeout> | null = null;
  tagResolver?: TagResolver;

  calcColor = "teal";
  errColor  = "red";

  /**
   * Cache of filePath → full file content.
   * Populated by cacheFileSource() (called from parseAllFiles and the vault
   * modify handler) so the synchronous post-processor can find <<...>>
   * patterns in the raw markdown without needing async vault reads.
   */
  fileSourceCache: Map<string, string> = new Map();

  constructor(plugin: Plugin, store: VariableStore) {
    this.plugin = plugin;
    this.store = store;
  }

  /**
   * Store file content for use by processSection.
   * Only caches files that actually contain <<, saving memory.
   * Called by the main plugin whenever it reads a markdown file.
   */
  cacheFileSource(filePath: string, content: string): void {
    if (content.includes("<<")) {
      this.fileSourceCache.set(filePath, content);
    } else {
      this.fileSourceCache.delete(filePath);
    }
  }

  // ─── Registration ──────────────────────────────────────────────────────────

  register(): void {
    // PRIMARY: code fence — Obsidian hands us the raw LaTeX directly
    this.plugin.registerMarkdownCodeBlockProcessor(
      "emath",
      (source, el, ctx) => this.renderEmath(source.trim(), el, ctx.sourcePath)
    );

    // SECONDARY: post-processor for inline $<<...>>$ math
    this.plugin.registerMarkdownPostProcessor(
      (el, ctx) => this.processSection(el, ctx),
      100
    );

    this.store.on("change", () => this.scheduleRerender());
  }

  // ─── Code fence renderer ───────────────────────────────────────────────────

  private renderEmath(source: string, el: HTMLElement, sourcePath: string): void {
    if (!source) return;
    const { latex: substituted, assignments } = this.substituteInLatex(source, sourcePath);
    this.commitAssignments(assignments, sourcePath);
    try {
      const obsidian = require("obsidian");
      const rendered = obsidian.renderMath(substituted, true);
      obsidian.finishRenderMath(rendered);
      el.appendChild(rendered);
    } catch (e) {
      el.createEl("span", {
        text: "Engineer math error: " + String(e),
        attr: { style: "color: red; font-size: 12px;" }
      });
    }
  }

  // ─── Inline post-processor ─────────────────────────────────────────────────

  /**
   * Find all .math elements in the section, locate their source LaTeX using
   * the fileSourceCache (or ctx.getSectionInfo as a fallback), substitute
   * <<...>> patterns, and replace the rendered elements with fresh renders.
   *
   * This is synchronous — the cache must be populated before rendering.
   * The main plugin calls cacheFileSource() in parseAllFiles() and the
   * vault modify handler so the cache is always fresh.
   */
  private processSection(el: HTMLElement, ctx: MarkdownPostProcessorContext): void {
    const sourcePath = ctx.sourcePath;

    // Fast exit: no math elements in this section
    const mathEls = Array.from(el.querySelectorAll<HTMLElement>(".math"));
    if (mathEls.length === 0) return;

    let source = "";
    const info = ctx.getSectionInfo(el);
    if (info?.text) {
      // getSectionInfo already provides this section's raw markdown text.
      // If it has no << substitutions, skip this section.
      // Do NOT fall back to full-file source in this branch; that would
      // contaminate this section with patterns from elsewhere in the file.
      source = info.text;
      if (!source.includes("<<")) return;
    } else {
      // getSectionInfo gave nothing — fall back to full file cache.
      source = this.fileSourceCache.get(sourcePath) ?? "";
      if (!source.includes("<<")) return;
    }

    // Build ALL math spans (with and without <<) so index into blockEls/inlineEls
    // stays aligned with the rendered .math elements. Only process those with hasSubst.
    const spans: Array<{ latex: string; isBlock: boolean; index: number; hasSubst: boolean }> = [];
    let m: RegExpExecArray | null;

    DISPLAY_MATH_REGEX.lastIndex = 0;
    while ((m = DISPLAY_MATH_REGEX.exec(source)) !== null) {
      spans.push({ latex: m[1], isBlock: true, index: m.index, hasSubst: m[1].includes("<<") });
    }

    INLINE_MATH_REGEX.lastIndex = 0;
    while ((m = INLINE_MATH_REGEX.exec(source)) !== null) {
      spans.push({ latex: m[1], isBlock: false, index: m.index, hasSubst: m[1].includes("<<") });
    }

    // Sort by position so they match rendered elements in source order
    spans.sort((a, b) => a.index - b.index);
    if (!spans.some(s => s.hasSubst)) return;

    // Match spans to rendered .math elements by type and order.
    // Advance bi/ii for EVERY span so pure-LaTeX spans consume their slot.
    const blockEls = mathEls.filter(e => e.classList.contains("math-block"));
    const inlineEls = mathEls.filter(e => e.classList.contains("math-inline"));
    let bi = 0, ii = 0;

    const obsidian = require("obsidian");

    for (const span of spans) {
      const target = span.isBlock ? blockEls[bi++] : inlineEls[ii++];
      if (!target || !span.hasSubst) continue;

      const { latex: substituted, assignments } = this.substituteInLatex(span.latex, sourcePath);
      this.commitAssignments(assignments, sourcePath);
      if (substituted === span.latex) continue;

      try {
        const rendered = obsidian.renderMath(substituted, span.isBlock);
        obsidian.finishRenderMath(rendered);
        target.replaceWith(rendered);
      } catch (e) {
        console.warn("[Engineer] renderMath error:", e, substituted);
      }
    }
  }

  // ─── Substitution ──────────────────────────────────────────────────────────

  substituteInLatex(
    latex: string,
    sourcePath: string
  ): { latex: string; assignments: Record<string, unknown> } {
    if (!latex.includes("<<")) return { latex, assignments: {} };

    const scope = this.store.getAll(sourcePath, this.tagResolver) as Record<string, unknown>;
    const assignments: Record<string, unknown> = {};

    const result = latex.replace(SUBSTITUTION_REGEX, (_match, inner: string) => {
      const trimmed = inner.trim();

      // Pattern A: assignment  <<varname = expression>>  or  <<varname = expression:.2e>>
      const assignMatch = trimmed.match(
        /^([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(.+?)(?::([.0-9efgdEFGD]+))?$/
      );
      if (assignMatch) {
        const [, varName, expr, spec] = assignMatch;
        const value = this.evalExpr(expr.trim(), scope);
        if (value !== null) {
          assignments[varName] = value;
          scope[varName] = value;
          return this.formatValue(value, this.store.getEntry(varName, sourcePath)?.unit, spec);
        }
        return this.errPlaceholder(trimmed);
      }

      // Pattern B: expression with format spec  <<expression:.2e>>
      const specMatch = trimmed.match(/^(.+?):([.0-9efgdEFGD]+)$/);
      if (specMatch) {
        const [, expr, spec] = specMatch;
        const value = this.evalExpr(expr.trim(), scope);
        if (value !== null) {
          const isVar = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(expr.trim());
          const unit = isVar ? this.store.getEntry(expr.trim(), sourcePath)?.unit : undefined;
          return this.formatValue(value, unit, spec);
        }
        return this.errPlaceholder(trimmed);
      }

      // Pattern C: plain variable or expression  <<E>>  <<F*L/4>>
      const value = this.evalExpr(trimmed, scope);
      if (value !== null) {
        const isVar = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed);
        const unit = isVar ? this.store.getEntry(trimmed, sourcePath)?.unit : undefined;
        return this.formatValue(value, unit);
      }
      return this.errPlaceholder(trimmed);
    });

    return { latex: result, assignments };
  }

  private commitAssignments(
    assignments: Record<string, unknown>,
    sourcePath: string
  ): void {
    for (const [key, value] of Object.entries(assignments)) {
      // Look up the best entry visible from the source file.
      // If there's a same-file ---vars pre-declaration (e.g. `delta: 0 # m, folder`),
      // inherit its visibility, unit, and scopeTag so re-renders don't reset to global.
      const existing = this.store.getEntry(key, sourcePath, this.tagResolver);
      const fromSameFile = existing?.source === sourcePath;
      this.store.set(
        key, value,
        existing?.unit,
        sourcePath,
        "math-block",
        "global",
        fromSameFile ? existing!.visibility : "global",
        fromSameFile ? existing!.scopeTag   : undefined,
        fromSameFile ? existing!.scopeFolder : undefined,
      );
    }
  }

  // ─── Evaluation ────────────────────────────────────────────────────────────

  private evalExpr(
    expr: string,
    scope: Record<string, unknown>
  ): number | string | unknown[] | null {
    try {
      const result = math.evaluate(expr, scope as math.MathJsInstance);
      return this.toPlainJS(result);
    } catch {
      return null;
    }
  }

  // ─── Formatting ────────────────────────────────────────────────────────────

  formatValue(value: unknown, unit?: string, spec?: string): string {
    const unitStr = unit ? `\\ \\text{${unit}}` : "";

    if (typeof value === "number") {
      let s: string;
      if (!isFinite(value)) {
        s = value > 0 ? "\\infty" : "-\\infty";
      } else if (spec) {
        s = this.applySpec(value, spec);
      } else if (Number.isInteger(value) && Math.abs(value) < 1e15) {
        s = String(value);
      } else {
        const abs = Math.abs(value);
        if (abs === 0) {
          s = "0";
        } else if (abs >= 1e-3 && abs < 1e4) {
          s = String(parseFloat(value.toPrecision(4)));
        } else {
          const exp = Math.floor(Math.log10(abs));
          const mantissa = parseFloat((value / Math.pow(10, exp)).toPrecision(4));
          s = `${mantissa} \\times 10^{${exp}}`;
        }
      }
      return `{\\color{${this.toLatexColor(this.calcColor)}}{${s}}}${unitStr}`;
    }

    if (typeof value === "string") return `\\text{${value}}${unitStr}`;

    if (Array.isArray(value)) {
      return `\\left[${value.map(v => this.formatValue(v)).join(",\\ ")}\\right]${unitStr}`;
    }

    return String(value);
  }

  private toLatexColor(color: string): string {
    // Hex #RRGGBB → [HTML]{RRGGBB} for xcolor; named colors pass through
    const hex = color.match(/^#([0-9a-fA-F]{6})$/);
    if (hex) return `[HTML]{${hex[1].toUpperCase()}}`;
    return color;
  }

  private applySpec(value: number, spec: string): string {
    const m = spec.match(/^\.?(\d+)?([efgdEFGD])?$/);
    if (!m) return String(parseFloat(value.toPrecision(4)));
    const prec = m[1] !== undefined ? parseInt(m[1]) : 4;
    const type = (m[2] ?? "g").toLowerCase();

    const toLatexSci = (s: string) =>
      s.replace(/e([+-]?)(\d+)$/, (_m, sign, exp) =>
        ` \\times 10^{${sign === "-" ? "-" : ""}${parseInt(exp)}}`
      );

    switch (type) {
      case "f": return value.toFixed(prec);
      case "e": return toLatexSci(value.toExponential(prec));
      case "g": {
        const s = parseFloat(value.toPrecision(prec || 4)).toString();
        return s.includes("e") ? toLatexSci(s) : s;
      }
      case "d": return String(Math.round(value));
      default:  return String(parseFloat(value.toPrecision(prec)));
    }
  }

  private errPlaceholder(expr: string): string {
    const safe = expr.replace(/[\\{}_^$&%#]/g, "?").slice(0, 24);
    return `\\textcolor{${this.toLatexColor(this.errColor)}}{\\text{? ${safe}}}`;
  }

  // ─── Rerender ──────────────────────────────────────────────────────────────

  private scheduleRerender(): void {
    if (this.rerenderTimer) clearTimeout(this.rerenderTimer);
    this.rerenderTimer = setTimeout(() => {
      this.rerenderTimer = null;
      this.rerenderAll();
    }, 200);
  }

  rerenderAll(): void {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
      const view = leaf.view as MarkdownView;
      if (view?.previewMode) {
        view.previewMode.rerender(false);
      }
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private toPlainJS(value: unknown): number | string | unknown[] | null {
    if (typeof value === "number") return value;
    if (typeof value === "string") return value;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (value !== null && typeof value === "object" && "toArray" in value) {
      return (value as { toArray(): unknown[] }).toArray();
    }
    if (value !== null && typeof value === "object" && "valueOf" in value) {
      const v = (value as { valueOf(): unknown }).valueOf();
      if (typeof v === "number") return v;
    }
    return null;
  }
}
