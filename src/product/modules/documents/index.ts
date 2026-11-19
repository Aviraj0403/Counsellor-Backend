// PUBLIC API of the `documents` module.
import { registerEvents as registerDocumentEvents, registerHooks as registerDocumentHooks } from './application/document.service.js';

export { checklistFor, getDocumentMeta, issueDownloadLinkFor, listDocumentsForStudent, storeDocument } from './application/document.service.js';
export { documentPublicRoutes, documentRoutes } from './http/document.routes.js';

export const registerHooks = (): void => registerDocumentHooks();
export const registerEvents = (): void => registerDocumentEvents();
