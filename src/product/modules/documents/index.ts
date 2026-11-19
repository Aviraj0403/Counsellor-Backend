// PUBLIC API of the `documents` module.
import { registerConfigStatus } from '../../../shared/kernel/configStatus.js';
import { registerEvents as registerDocumentEvents, registerHooks as registerDocumentHooks } from './application/document.service.js';
import { configStatus } from './application/config.status.js';

export { checklistFor, getDocumentMeta, issueDownloadLinkFor, listDocumentsForStudent, storeDocument } from './application/document.service.js';
export { configStatus } from './application/config.status.js';
export { documentPublicRoutes, documentRoutes } from './http/document.routes.js';

export const registerHooks = (): void => {
  registerDocumentHooks();
  registerConfigStatus('documents', configStatus);
};
export const registerEvents = (): void => registerDocumentEvents();
