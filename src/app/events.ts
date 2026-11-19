/**
 * Cross-module wiring: the ONE place where event listeners, guards and export contributors are registered, once, at start-up.
 * A module exposes `registerEvents()` (and/or `registerHooks()`) from its index.ts; this file calls them.
 * Modules never register themselves at import time, so the wiring is visible here and tests can start from a clean slate.
 *
 * To wire a module: import { registerEvents as registerFollowups } from '../product/modules/followups/index.js' and call it in wire().
 */
import { registerEvents as registerFollowups } from '../product/modules/followups/index.js';
import { registerEvents as registerWhatsapp } from '../product/modules/whatsapp/index.js';

import { registerEvents as registerMetaAds } from '../product/modules/metaAds/index.js';
import { registerEvents as registerPublicApi } from '../product/modules/publicApi/index.js';

import { registerEvents as registerApplications, registerHooks as registerApplicationHooks } from '../product/modules/applications/index.js';
import { registerEvents as registerCommissions } from '../product/modules/commissions/index.js';
import { registerEvents as registerDocuments, registerHooks as registerDocumentHooks } from '../product/modules/documents/index.js';
import { registerEvents as registerPortal } from '../product/modules/portal/index.js';
import { registerEvents as registerAppointments, registerHooks as registerAppointmentHooks } from '../product/modules/appointments/index.js';

import { registerEvents as registerBots, registerHooks as registerBotHooks } from '../product/modules/bots/index.js';

let wired = false;

export const registerCrossModuleWiring = (): void => {
  if (wired) return;
  wired = true;
  // ---- product modules (add one line per module that listens to events or registers hooks)
  registerFollowups();
  registerWhatsapp();
  registerMetaAds();
  registerPublicApi();
  registerApplicationHooks();
  registerApplications();
  registerCommissions();
  registerDocumentHooks();
  registerDocuments();
  registerPortal();
  registerAppointmentHooks();
  registerAppointments();
  registerBotHooks();
  registerBots();
};

/** Tests that need a clean slate call this together with clearEventHandlers() / clearHooks(). */
export const resetCrossModuleWiring = (): void => {
  wired = false;
};
