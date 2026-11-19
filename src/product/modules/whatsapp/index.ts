// PUBLIC API of the `whatsapp` module.
export { sendMessage, dispatchDue, type SendInput } from './application/whatsapp.service.js';
export { registerEvents } from './application/whatsapp.rules.js';
export { whatsappRoutes } from './http/whatsapp.routes.js';
export { whatsappPublicRoutes } from './http/whatsapp.public.routes.js';
