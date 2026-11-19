import type { PlatformPort } from './port.js';

/**
 * Where the product finds the platform core at run time. The composition root (src/app/platform.ts) wires it once at start-up.
 * Product code never imports the core, it asks for "the platform" here, so the core can be local code today
 * and a remote service tomorrow without touching a single product file.
 */
let current: PlatformPort | null = null;

export const setPlatform = (port: PlatformPort): void => {
  current = port;
};

export const getPlatform = (): PlatformPort => {
  if (!current) throw new Error('Platform port is not wired. Call setPlatform() in the composition root (src/app/platform.ts).');
  return current;
};
