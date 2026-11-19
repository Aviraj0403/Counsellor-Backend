/**
 * Tiny dependency-free PDF writer: A4 pages, Helvetica / Helvetica-Bold, text, right-aligned text, horizontal rules.
 * Enough for invoices and simple reports. Not a layout engine: you place content top-down with a moving cursor.
 * Text is limited to Latin-1 (other characters become "?"); write "Rs." instead of the rupee sign.
 * Output is a Buffer: "%PDF-1.4" header, objects, a classic xref table with exact byte offsets, trailer, "%%EOF".
 */
export interface TextOpts {
  size?: number;
  bold?: boolean;
  /** x position from the left edge in points (default: left margin) */
  x?: number;
  /** "right" aligns the text's END at x (default x = right margin) */
  align?: 'left' | 'right';
}

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 40;

const esc = (s: string): string =>
  s
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');

/** Rough Helvetica width (average glyph ~0.5 em, bold slightly wider); only used to right-align. */
const approxWidth = (s: string, size: number, bold: boolean): number => s.length * size * (bold ? 0.56 : 0.52);
const num = (n: number): string => n.toFixed(2);

export class PdfDoc {
  readonly width = PAGE_W;
  readonly leftX = MARGIN;
  readonly rightX = PAGE_W - MARGIN;
  private pages: string[][] = [[]];
  private y = PAGE_H - MARGIN;

  private get ops(): string[] {
    return this.pages[this.pages.length - 1]!;
  }

  /** Moves the cursor down; starts a new page when the content would run past the bottom margin. */
  private advance(h: number): void {
    if (this.y - h < MARGIN) {
      this.pages.push([]);
      this.y = PAGE_H - MARGIN;
    }
    this.y -= h;
  }

  /** One line of text; moves the cursor down by the line height. */
  text(s: string, o: TextOpts = {}): this {
    const size = o.size ?? 10;
    this.advance(size * 1.4);
    this.put(s, size, !!o.bold, o.align === 'right' ? (o.x ?? this.rightX) - approxWidth(s, size, !!o.bold) : (o.x ?? MARGIN));
    return this;
  }

  /** Several cells on the same line, e.g. a table row. `x` is the left edge, or the right edge when align is "right". */
  row(cells: Array<{ text: string; x: number; align?: 'left' | 'right' }>, o: { size?: number; bold?: boolean } = {}): this {
    const size = o.size ?? 10;
    this.advance(size * 1.5);
    for (const c of cells) {
      const w = approxWidth(c.text, size, !!o.bold);
      this.put(c.text, size, !!o.bold, c.align === 'right' ? c.x - w : c.x);
    }
    return this;
  }

  /** Thin horizontal rule across the page. */
  rule(): this {
    this.advance(6);
    this.ops.push(`0.5 w ${num(MARGIN)} ${num(this.y + 3)} m ${num(PAGE_W - MARGIN)} ${num(this.y + 3)} l S`);
    return this;
  }

  space(h = 8): this {
    this.advance(h);
    return this;
  }

  private put(s: string, size: number, bold: boolean, x: number): void {
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${num(x)} ${num(this.y)} Td (${esc(s)}) Tj ET`);
  }

  toBuffer(): Buffer {
    // object numbers: 1 catalog, 2 pages, 3 F1, 4 F2, then per page: page object + content stream
    const objs: string[] = [];
    const n = this.pages.length;
    const kids = this.pages.map((_, i) => `${5 + i * 2} 0 R`).join(' ');
    objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`;
    objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
    this.pages.forEach((ops, i) => {
      const content = ops.join('\n');
      const pageNo = 5 + i * 2;
      objs[pageNo] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageNo + 1} 0 R >>`;
      objs[pageNo + 1] = `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
    });

    const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
    let offset = parts[0]!.length;
    const offsets: number[] = [];
    for (let i = 1; i < objs.length; i++) {
      const b = Buffer.from(`${i} 0 obj\n${objs[i]}\nendobj\n`, 'latin1');
      offsets[i] = offset;
      offset += b.length;
      parts.push(b);
    }
    const count = objs.length; // objects 1..count-1 plus the free entry 0
    let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let i = 1; i < count; i++) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    xref += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`;
    parts.push(Buffer.from(xref, 'latin1'));
    return Buffer.concat(parts);
  }
}
