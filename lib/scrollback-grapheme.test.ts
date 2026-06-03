/**
 * Scrollback Grapheme Row-Mismatch Tests
 *
 * Reproduces a rendering bug where, while the viewport is scrolled up
 * (viewportY > 0), multi-codepoint grapheme cells render the WRONG glyph.
 *
 * Root cause (lib/renderer.ts):
 *   - The cell LINE is fetched with a scroll-adjusted row index
 *     (getScrollbackLine(scrollbackOffset) for the scrollback portion, or
 *     buffer.getLine(y - floor(viewportY)) for the visible-screen portion).
 *   - But the grapheme STRING for a cell with grapheme_len > 0 is fetched via
 *     currentBuffer.getGraphemeString(y, x) using the raw ON-SCREEN row `y`.
 *
 * getGraphemeString() resolves against the live active grid (terminal.ts wires
 * it straight to wasmTerm.getGraphemeString), so when scrolled the two indices
 * disagree by the scroll offset and the renderer paints a grapheme from a
 * different row than the cell it is drawing. In the app this surfaces as stray
 * "?" / wrong glyphs over scrolled content that appear and disappear depending
 * on scroll position. Plain single-codepoint cells are unaffected because they
 * render from cell.codepoint directly.
 */

import { describe, expect, test } from 'bun:test';
import { CanvasRenderer, type IRenderable, type IScrollbackProvider } from './renderer';
import { type GhosttyCell } from './types';

const COLS = 4;
const ROWS = 4;

function blankCell(): GhosttyCell {
  return {
    codepoint: 32, // space
    fg_r: 0,
    fg_g: 0,
    fg_b: 0,
    bg_r: 0,
    bg_g: 0,
    bg_b: 0,
    fgIsDefault: true,
    bgIsDefault: true,
    flags: 0,
    width: 1,
    hyperlink_id: 0,
    grapheme_len: 0,
  };
}

function blankLine(): GhosttyCell[] {
  return Array.from({ length: COLS }, blankCell);
}

/** A cell that carries a multi-codepoint grapheme (grapheme_len > 0). */
function graphemeCell(baseCodepoint: number): GhosttyCell {
  return { ...blankCell(), codepoint: baseCodepoint, grapheme_len: 1 };
}

/**
 * Spy on the renderer's 2D context fillText so we can assert which glyph
 * strings were actually drawn. happy-dom's mock context exposes fillText as a
 * no-op; we replace it on the renderer's own ctx instance.
 */
function spyFillText(renderer: CanvasRenderer): string[] {
  const drawn: string[] = [];
  // ctx is private; access it for test instrumentation only.
  const ctx = (renderer as unknown as { ctx: CanvasRenderingContext2D }).ctx;
  ctx.fillText = ((text: string) => {
    drawn.push(text);
  }) as CanvasRenderingContext2D['fillText'];
  return drawn;
}

describe('Scrollback grapheme row mismatch', () => {
  test('visible-screen grapheme keeps its glyph when scrolled up', () => {
    // Active grid: a grapheme cell "é" (e + combining acute) lives at row 0,
    // col 0. Every other active-grid position resolves to a distinct sentinel
    // glyph "#" so a row-index mix-up is unmistakable.
    const GRAPHEME = 'é'; // U+0065 U+0301
    const SENTINEL = '#';

    const activeGrid: GhosttyCell[][] = [
      // row 0: the grapheme cell at col 0
      [graphemeCell(0x65), blankCell(), blankCell(), blankCell()],
      blankLine(), // row 1
      blankLine(), // row 2
      blankLine(), // row 3
    ];

    const buffer: IRenderable = {
      getLine: (y) => activeGrid[y] ?? null,
      getCursor: () => ({ x: 0, y: 0, visible: false }),
      getDimensions: () => ({ cols: COLS, rows: ROWS }),
      isRowDirty: () => true,
      clearDirty: () => {},
      // Mirrors wasmTerm.getGraphemeString: indexes the live ACTIVE grid only.
      // Returns the real grapheme at the active-grid origin, and a sentinel
      // everywhere else so a wrong row is visible in the output.
      getGraphemeString: (row, col) => (row === 0 && col === 0 ? GRAPHEME : SENTINEL),
    };

    const scrollback: IScrollbackProvider = {
      getScrollbackLength: () => 10,
      getScrollbackLine: () => blankLine(),
    };

    const canvas = document.createElement('canvas');
    const renderer = new CanvasRenderer(canvas, { fontFamily: 'monospace', fontSize: 14 });
    const drawn = spyFillText(renderer);

    // Scroll up by 2 rows. Render loop maps screen rows >= viewportY to the
    // visible screen via getLine(y - floor(viewportY)); so the grapheme at
    // active-grid row 0 is displayed at screen row 2. The buggy code then looks
    // its grapheme string up at getGraphemeString(screenRow=2, 0) instead of
    // getGraphemeString(0, 0).
    const VIEWPORT_Y = 2;
    renderer.render(buffer, /* forceAll */ true, VIEWPORT_Y, scrollback, /* scrollbarOpacity */ 0);

    expect(drawn).toContain(GRAPHEME); // the grapheme must survive the scroll
    expect(drawn).not.toContain(SENTINEL); // and must NOT be pulled from another row
  });
});
