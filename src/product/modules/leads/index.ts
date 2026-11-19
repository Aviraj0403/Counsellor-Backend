// PUBLIC API of the `leads` module.
export { countLeads, leadCountsByStageAndChannel } from './application/lead.stats.js';
export { createLead, findLeadById, findLeadByPhone, type CreateLeadInput } from './application/lead.service.js';
export { leadRoutes } from './http/lead.routes.js';
