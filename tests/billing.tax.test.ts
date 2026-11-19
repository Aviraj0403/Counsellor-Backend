import { describe, expect, it } from 'vitest';
import { MODULE_CATALOG } from '../src/core/modules/catalog/domain/moduleCatalog.js';
import { resolveModules } from '../src/core/modules/catalog/domain/resolve.js';
import { computeCharge, isSameState, splitGst } from '../src/core/modules/billing/domain/billing.domain.js';
import { formatInr, renderInvoicePdf } from '../src/core/modules/billing/application/invoicePdf.js';
import { PdfDoc } from '../src/shared/infra/pdf.js';

describe('splitGst', () => {
  it('same state: CGST + SGST, never losing a paisa (odd paisa goes to SGST)', () => {
    for (const taxable of [1, 99, 100, 12_345, 199_901, 999_999]) {
      for (const bps of [0, 500, 1200, 1800, 2800]) {
        const s = splitGst(taxable, bps, 'Karnataka', ' karnataka ');
        expect(s.supply).toBe('intra');
        expect(s.igstPaise).toBe(0);
        expect(s.cgstPaise + s.sgstPaise).toBe(s.gstPaise);
        expect(s.sgstPaise - s.cgstPaise).toBeGreaterThanOrEqual(0);
        expect(s.sgstPaise - s.cgstPaise).toBeLessThanOrEqual(1);
        expect(s.gstPaise).toBe(Math.round((taxable * bps) / 10_000));
        for (const n of [s.cgstPaise, s.sgstPaise, s.gstPaise]) expect(Number.isInteger(n)).toBe(true);
      }
    }
    const odd = splitGst(1_00_01, 1800, 'Goa', 'Goa'); // 1800.18 -> 1800 paise? exact check below
    expect(odd.gstPaise).toBe(1800);
    const odd2 = splitGst(5, 1800, 'Goa', 'Goa'); // 0.9 -> 1 paisa: SGST takes it
    expect(odd2).toMatchObject({ gstPaise: 1, cgstPaise: 0, sgstPaise: 1 });
  });
  it('different or unknown state: all IGST', () => {
    expect(splitGst(100_000, 1800, 'Karnataka', 'Delhi')).toMatchObject({ supply: 'inter', igstPaise: 18_000, cgstPaise: 0, sgstPaise: 0 });
    expect(splitGst(100_000, 1800, 'Karnataka', undefined).supply).toBe('inter');
    expect(splitGst(100_000, 1800, undefined, undefined).supply).toBe('inter');
    expect(isSameState('', '')).toBe(false);
  });
  it('computeCharge keeps the 18% default and stores the rate used', () => {
    const plan = { name: 'Starter', basePricePaise: 199_900, includedModules: [] };
    const base = computeCharge({ plan, enabled: resolveModules(MODULE_CATALOG, {}), catalog: MODULE_CATALOG });
    expect(base.gstRateBps).toBe(1800);
    expect(base.gstPaise).toBe(Math.round(199_900 * 0.18));
    const intra = computeCharge({ plan, enabled: resolveModules(MODULE_CATALOG, {}), catalog: MODULE_CATALOG, gstRateBps: 1200, sellerState: 'Goa', buyerState: 'Goa' });
    expect(intra.gstRateBps).toBe(1200);
    expect(intra.cgstPaise + intra.sgstPaise).toBe(intra.gstPaise);
    expect(intra.totalPaise).toBe(intra.subtotalPaise + intra.gstPaise);
  });
});

/** Parses the xref table back and checks every offset points at "<n> 0 obj". */
const checkXref = (buf: Buffer) => {
  const s = buf.toString('latin1');
  const start = Number(/startxref\n(\d+)\n%%EOF$/.exec(s)![1]);
  expect(s.slice(start, start + 4)).toBe('xref');
  const lines = s.slice(start).split('\n');
  const [first, count] = lines[1]!.split(' ').map(Number);
  expect(first).toBe(0);
  for (let i = 1; i < count!; i++) {
    const [off, , kind] = lines[2 + i]!.trim().split(' ');
    expect(kind).toBe('n');
    expect(s.slice(Number(off), Number(off) + `${i} 0 obj`.length)).toBe(`${i} 0 obj`);
  }
  return count!;
};

describe('pdf writer', () => {
  it('produces a valid structure with correct xref offsets, including multiple pages', () => {
    const d = new PdfDoc();
    for (let i = 0; i < 120; i++) d.text(`Line ${i} (with) \\ special chars ₹`);
    const buf = d.toBuffer();
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buf.toString('latin1').endsWith('%%EOF')).toBe(true);
    expect(checkXref(buf)).toBeGreaterThan(7); // several pages
  });
  it('renders an invoice with number, GSTIN and total', () => {
    const inv: any = {
      invoiceNo: 'CP-2026-0042',
      period: '2026-11',
      issuedAt: new Date('2026-11-01'),
      status: 'issued',
      lines: [{ code: 'plan', label: 'Starter plan', amountPaise: 12_345_600 }],
      subtotalPaise: 12_345_600,
      gstRateBps: 1800,
      cgstPaise: 1_111_104,
      sgstPaise: 1_111_104,
      igstPaise: 0,
      gstPaise: 2_222_208,
      totalPaise: 14_567_808,
      seller: { legalName: 'Acme Pvt Ltd', gstin: '29ABCDE1234F1Z5', state: 'Karnataka' },
      buyer: { legalName: 'Buyer Co', gstin: '27AAAAA0000A1Z5', state: 'Karnataka' },
    };
    const buf = renderInvoicePdf(inv);
    const s = buf.toString('latin1');
    expect(s.startsWith('%PDF-')).toBe(true);
    expect(s.endsWith('%%EOF')).toBe(true);
    expect(s).toContain('CP-2026-0042');
    expect(s).toContain('29ABCDE1234F1Z5');
    expect(s).toContain(formatInr(14_567_808));
    expect(s).toContain('Rs. 1,45,678.08');
    expect(s).toContain('CGST @ 9%');
    checkXref(buf);
  });
});
