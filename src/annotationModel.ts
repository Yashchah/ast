import type { Annotation, AnnotationSource } from './contracts';
import { mdEscape } from './tempo';

/**
 * Decision logic of the LineAnnotationManager (spec V1-4). Pure: src/annotations.ts owns the
 * decoration types and the comment controller and renders whatever render() returns.
 *
 * - At most one after-text per line, by priority hint > spec > own-predict > what-if.
 *   Lower-priority texts fold into that line's hover.
 * - After-text is capped at 52 characters. Longer (or multi-line) hint text goes to a comment
 *   thread, never a truncated line. Other sources are clipped, with the full text in the hover.
 * - An annotation clears when its anchored line text changes. Anchors follow lines inserted or
 *   deleted above them.
 *
 * Lines are 0-based, like vscode.Position.line and TextDocumentContentChangeEvent ranges.
 */

export const AFTER_TEXT_MAX = 52;

const RANK: Record<AnnotationSource, number> = { hint: 0, spec: 1, 'own-predict': 2, 'what-if': 3 };
const LABEL: Record<AnnotationSource, string> = { hint: 'Hint', spec: 'Spec', 'own-predict': 'Your prediction', 'what-if': 'What if' };

/** Where an annotation shows: after-text, a comment thread, or folded into a higher owner's hover. */
export type Route = 'after' | 'thread' | 'folded';

export interface LineView {
  uri: string;
  line: number;
  owner: AnnotationSource;
  /** The owner's after-text (<= 52 chars, one line). Absent when the owner went to a comment thread. */
  afterText?: string;
  /** Full hint text for a comment thread on this line. */
  thread?: string;
  /** Markdown: the owner's hover, then each lower-priority text folded in, in priority order. */
  hover: string;
  /** Every source on the line, owner first. */
  sources: AnnotationSource[];
}

/** One entry of TextDocumentChangeEvent.contentChanges, flattened (ranges refer to the text before this change). */
export interface LineChange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  text: string;
}

interface Anchored extends Annotation {
  /** Text of the anchored line when the annotation was set. */
  lineText: string;
}

function len(s: string): number {
  return [...s].length;
}

function isMultiline(text: string): boolean {
  return /[\r\n]/.test(text.trim());
}

/** Route of a text on its own (ignoring other sources on its line). */
export function routeText(source: AnnotationSource, text: string): 'after' | 'thread' {
  return source === 'hint' && (isMultiline(text) || len(text.trim()) > AFTER_TEXT_MAX) ? 'thread' : 'after';
}

/** One line, at most 52 characters (an ellipsis marks a clip). */
export function toAfterText(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (len(one) <= AFTER_TEXT_MAX) return one;
  return [...one].slice(0, AFTER_TEXT_MAX - 1).join('').trimEnd() + '…';
}

function sameLineText(a: string, b: string | undefined): boolean {
  // Trailing whitespace (format-on-save, a stray space) is not a change to what the line says.
  return b !== undefined && a.trimEnd() === b.trimEnd();
}

function lineBreaks(text: string): number {
  return text.match(/\r\n|\r|\n/g)?.length ?? 0;
}

export class AnnotationModel {
  private items: Anchored[] = [];

  /**
   * Add or replace the `a.source` annotation on its line. `lineText` is the anchored line's
   * current text. Returns where it shows right now.
   */
  set(a: Annotation, lineText: string): Route {
    this.items = this.items.filter((x) => !(x.uri === a.uri && x.line === a.line && x.source === a.source));
    this.items.push({ ...a, lineText });
    return this.routeOf(a.uri, a.line, a.source) ?? 'after';
  }

  /** Current route of one annotation, or undefined when there is none. */
  routeOf(uri: string, line: number, source: AnnotationSource): Route | undefined {
    const here = this.at(uri, line);
    const mine = here.find((x) => x.source === source);
    if (!mine) return undefined;
    if (here[0] !== mine) return 'folded';
    return routeText(source, mine.text);
  }

  /** Annotations on one line, highest priority first. */
  at(uri: string, line: number): Annotation[] {
    return this.items.filter((x) => x.uri === uri && x.line === line).sort((a, b) => RANK[a.source] - RANK[b.source]);
  }

  /** Every annotation (e.g. to find threads to dispose). */
  all(): Annotation[] {
    return [...this.items];
  }

  uris(): string[] {
    return [...new Set(this.items.map((x) => x.uri))];
  }

  /** Remove annotations by source and/or uri and/or line (no filter = everything). Returns the removed ones. */
  clear(filter: { source?: AnnotationSource; uri?: string; line?: number } = {}): Annotation[] {
    const hit = (x: Anchored) =>
      (filter.source === undefined || x.source === filter.source) &&
      (filter.uri === undefined || x.uri === filter.uri) &&
      (filter.line === undefined || x.line === filter.line);
    const removed = this.items.filter(hit);
    this.items = this.items.filter((x) => !hit(x));
    return removed.map(strip);
  }

  /**
   * A document changed. Changes are applied in order (as VS Code applies contentChanges):
   * anchors below an edit move with it; then any annotation whose anchored line no longer has
   * its original text is removed. Returns the removed annotations (dispose their threads).
   */
  onDidChange(uri: string, changes: LineChange[], lineText: (line: number) => string | undefined): Annotation[] {
    const mine = this.items.filter((x) => x.uri === uri);
    if (!mine.length) return [];
    for (const c of changes) {
      const delta = lineBreaks(c.text) - (c.endLine - c.startLine);
      if (!delta) continue;
      for (const x of mine) {
        // The edit ends before this line's content starts: the whole line moves.
        if (c.endLine < x.line || (c.endLine === x.line && c.endCharacter === 0)) x.line += delta;
      }
    }
    const gone = mine.filter((x) => x.line < 0 || !sameLineText(x.lineText, lineText(x.line)));
    this.items = this.items.filter((x) => !gone.includes(x));
    return gone.map(strip);
  }

  /** What to draw for one document: one view per annotated line. */
  render(uri: string): LineView[] {
    const lines = [...new Set(this.items.filter((x) => x.uri === uri).map((x) => x.line))].sort((a, b) => a - b);
    return lines.map((line) => {
      const [owner, ...lower] = this.at(uri, line);
      const route = routeText(owner.source, owner.text);
      const sections: string[] = [];
      const ownerText = owner.text.replace(/\s+/g, ' ').trim();
      // A clipped after-text keeps its full wording in the hover.
      if (route === 'after' && toAfterText(owner.text) !== ownerText) sections.push(mdEscape(ownerText));
      if (owner.hover.trim()) sections.push(owner.hover);
      for (const x of lower) {
        const text = `**${LABEL[x.source]}:** ${mdEscape(x.text.replace(/\s+/g, ' ').trim())}`;
        sections.push(x.hover.trim() ? `${text}\n\n${x.hover}` : text);
      }
      return {
        uri,
        line,
        owner: owner.source,
        afterText: route === 'after' ? toAfterText(owner.text) : undefined,
        thread: route === 'thread' ? owner.text.trim() : undefined,
        hover: sections.join('\n\n---\n\n'),
        sources: [owner.source, ...lower.map((x) => x.source)],
      };
    });
  }
}

function strip(x: Anchored): Annotation {
  return { uri: x.uri, line: x.line, source: x.source, text: x.text, hover: x.hover };
}
