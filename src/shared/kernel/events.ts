import { logger } from '../infra/logger.js';

/**
 * DOMAIN EVENTS: how modules react to each other WITHOUT importing each other.
 * Example: `leads` announces "lead.stage_changed"; `metaAds`, `whatsapp` and `publicApi` (webhooks) each listen.
 * `leads` never needs to know they exist, so no module cycles and a new listener is a new folder, not an edit to leads.
 *
 * Rules:
 *  - Add an event here (name + payload) before using it. Payloads are plain data: ids and small values, never whole documents.
 *  - Handlers must be fast and must not throw into the publisher: errors are caught and logged here.
 *    Slow work (HTTP calls) belongs in the handler's own background step, not in the request.
 *  - Handlers are registered once at start-up by the composition root (src/app/events.ts), never at import time.
 */
export interface DomainEvents {
  'lead.created': { tenantId: string; leadId: string; channel: string; actorId?: string };
  'lead.stage_changed': { tenantId: string; leadId: string; from: string; to: string; actorId?: string };
  'lead.assigned': { tenantId: string; leadId: string; assigneeId: string; actorId?: string };
  'student.created': { tenantId: string; studentId: string; leadId?: string; actorId?: string };
  'student.erased': { tenantId: string; studentId: string; actorId?: string };
  'application.created': { tenantId: string; applicationId: string; studentId: string; collegeId: string; actorId?: string };
  'application.status_changed': { tenantId: string; applicationId: string; studentId: string; collegeId: string; from: string; to: string; actorId?: string };
  'document.uploaded': { tenantId: string; documentId: string; studentId: string; applicationId?: string; actorId?: string };
  'document.verified': { tenantId: string; documentId: string; studentId: string; applicationId?: string; actorId?: string };
  'document.rejected': { tenantId: string; documentId: string; studentId: string; applicationId?: string; reason: string; actorId?: string };
  'commission.accrued': { tenantId: string; applicationId: string; collegeId: string; counsellorId?: string; totalPaise: number };
  'appointment.booked': { tenantId: string; appointmentId: string; typeId: string; counsellorId: string; start: string; source: string; leadId?: string; actorId?: string };
  'appointment.cancelled': { tenantId: string; appointmentId: string; typeId: string; counsellorId: string; start: string; cancelledBy: string; leadId?: string; actorId?: string };
  'appointment.rescheduled': { tenantId: string; appointmentId: string; previousAppointmentId: string; typeId: string; counsellorId: string; start: string; previousStart: string; previousCounsellorId: string; leadId?: string; actorId?: string };
  'appointment.completed': { tenantId: string; appointmentId: string; typeId: string; counsellorId: string; leadId?: string; actorId?: string };
  'appointment.no_show': { tenantId: string; appointmentId: string; typeId: string; counsellorId: string; leadId?: string; actorId?: string };
  'appointment.reminder_due': { tenantId: string; appointmentId: string; typeId: string; start: string; offsetMin: number; leadId?: string };
  'bot.handoff': { tenantId: string; conversationId: string; reason: string; leadId?: string; assigneeId?: string };
  'bot.lead_captured': { tenantId: string; conversationId: string; leadId: string; band: string };
}

export type EventName = keyof DomainEvents;
type Handler<K extends EventName> = (payload: DomainEvents[K]) => void | Promise<void>;

const handlers = new Map<EventName, Handler<any>[]>();

export const subscribe = <K extends EventName>(name: K, handler: Handler<K>): void => {
  handlers.set(name, [...(handlers.get(name) ?? []), handler]);
};

/** Runs every listener (in registration order). A failing listener is logged and never breaks the others or the caller. */
export const publish = async <K extends EventName>(name: K, payload: DomainEvents[K]): Promise<void> => {
  for (const h of handlers.get(name) ?? []) {
    try {
      await h(payload);
    } catch (err) {
      logger.error({ err, event: name }, 'event handler failed');
    }
  }
};

/** For tests and for re-wiring: forget every listener. */
export const clearEventHandlers = (): void => {
  handlers.clear();
};

export const listenerCount = (name: EventName): number => handlers.get(name)?.length ?? 0;
