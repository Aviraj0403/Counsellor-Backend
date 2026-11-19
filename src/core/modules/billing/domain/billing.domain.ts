import { rupeesToPaise } from '../../../../shared/kernel/money.js';
import type { ModuleDef } from '../../catalog/index.js';

export { rupeesToPaise };

/**
 * BILLING RULES (pure code, no database). All money is integer PAISE.
 *
 * Monthly charge for one organisation =
 *   plan base price
 * + every add-on module that is switched on, built (stage "live"), not bundled in the plan, with a price > 0
 * then GST on top.
 *
 * Deliberately NOT billed: modules still marked "coming soon" (we never charge for a feature that does not exist),
 * core modules, and modules the plan already includes.
 */

/** GST in basis points: 1800 = 18%. Confirm the rate and your invoice format with your accountant. */
export const GST_RATE_BPS = 1800;

export interface PlanLike {
  name: string;
  basePricePaise: number;
  includedModules: string[];
}

export interface ChargeLine {
  code: string;
  label: string;
  amountPaise: number;
}

export interface GstSplit {
  gstRateBps: number;
  /** same state: CGST + SGST; different (or unknown) state: IGST */
  supply: 'intra' | 'inter';
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  gstPaise: number;
}

const norm = (s?: string | null): string => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/** Same-state test. If either state is missing we cannot claim intra-state supply, so it is treated as inter-state (IGST). */
export const isSameState = (seller?: string | null, buyer?: string | null): boolean => !!norm(seller) && norm(seller) === norm(buyer);

/**
 * Splits GST on a taxable amount. Total GST = round(taxable x rate). Intra-state: CGST = floor(half), SGST = the rest,
 * so CGST + SGST always equals the total (an odd paisa goes to SGST, none is lost). Inter-state: all of it is IGST.
 */
export const splitGst = (taxablePaise: number, gstRateBps: number, sellerState?: string | null, buyerState?: string | null): GstSplit => {
  const gstPaise = Math.round((taxablePaise * gstRateBps) / 10_000);
  if (isSameState(sellerState, buyerState)) {
    const cgstPaise = Math.floor(gstPaise / 2);
    return { gstRateBps, supply: 'intra', cgstPaise, sgstPaise: gstPaise - cgstPaise, igstPaise: 0, gstPaise };
  }
  return { gstRateBps, supply: 'inter', cgstPaise: 0, sgstPaise: 0, igstPaise: gstPaise, gstPaise };
};

export interface Charge extends GstSplit {
  lines: ChargeLine[];
  subtotalPaise: number;
  totalPaise: number;
}

export const computeCharge = (input: {
  plan: PlanLike | null;
  /** resolved module switches (resolveModules output) */
  enabled: Record<string, boolean>;
  catalog: ModuleDef[];
  /** negotiated RUPEE price per module for this customer; 0 means free for them */
  priceOverridesInr?: Record<string, number>;
  /** defaults to GST_RATE_BPS */
  gstRateBps?: number;
  sellerState?: string | null;
  buyerState?: string | null;
}): Charge => {
  const lines: ChargeLine[] = [];
  if (input.plan && input.plan.basePricePaise > 0) {
    lines.push({ code: 'plan', label: `${input.plan.name} plan`, amountPaise: input.plan.basePricePaise });
  }
  for (const m of input.catalog) {
    if (m.core || !m.optIn || !input.enabled[m.key]) continue;
    if (m.stage === 'soon') continue;
    if (input.plan?.includedModules.includes(m.key)) continue;
    const inr = input.priceOverridesInr?.[m.key] ?? m.priceMonthlyInr ?? 0;
    if (!(inr > 0)) continue;
    lines.push({ code: `module:${m.key}`, label: m.label, amountPaise: rupeesToPaise(inr) });
  }
  const subtotalPaise = lines.reduce((s, l) => s + l.amountPaise, 0);
  const gst = splitGst(subtotalPaise, input.gstRateBps ?? GST_RATE_BPS, input.sellerState, input.buyerState);
  return { lines, subtotalPaise, ...gst, totalPaise: subtotalPaise + gst.gstPaise };
};

export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const currentPeriod = (now = new Date()): string => `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
