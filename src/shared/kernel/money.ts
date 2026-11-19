/** Money is ALWAYS whole paise (integers). Never floats: 0.1 + 0.2 != 0.3 is how ledgers and invoices go wrong. */
export type Paise = number;

/** Rupees (possibly with float noise) -> whole paise. Only for prices typed or configured in rupees. */
export const rupeesToPaise = (rupees: number): Paise => Math.round(rupees * 100);
