import { env } from '../config/env.js';
import { createGuards, setPlatform, type Guards, type PlatformPort } from '../contracts/index.js';
import { localPlatform } from '../core/localPort.js';

/**
 * THE place that decides where identity / organisations / modules come from, and the only file that connects
 * the product to the core:
 *   local  -> src/core (this repo, default)
 *   remote -> the separate shared Platform Core service (not built yet; fails loudly instead of guessing)
 */
const pickPort = (): PlatformPort => {
  if (env.PLATFORM_MODE === 'local') return localPlatform;
  throw new Error('PLATFORM_MODE=remote is not implemented yet. Use local until the core service exists (see docs/ARCHITECTURE.md).');
};

let wired: { platform: PlatformPort; guards: Guards } | null = null;

/** Idempotent: wires the platform port into the registry once and returns the route guards built on it. */
export const wirePlatform = () => {
  if (!wired) {
    const platform = pickPort();
    setPlatform(platform);
    wired = { platform, guards: createGuards(platform) };
  }
  return wired;
};
