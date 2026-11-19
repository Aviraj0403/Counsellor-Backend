import { env } from '../../../../config/env.js';
import type { ModuleConfigStatus } from '../../../../shared/kernel/configStatus.js';

/** Is the vault able to store files at all? (server-level setting; the organisation has nothing to configure.) No file names or counts of someone's documents. */
export const configStatus = async (_tenantId: string): Promise<ModuleConfigStatus> => {
  const encryption = !!env.ENCRYPTION_KEY;
  const items = [
    { label: 'Encryption key set on the server', value: encryption },
    { label: 'Storage', value: 'server folder' },
  ];
  if (!encryption) return { configured: false, health: 'attention', summary: 'Document vault is on but the server has no encryption key, so uploads will be refused.', items, nextStep: 'Set ENCRYPTION_KEY on the server.' };
  return { configured: true, health: 'ok', summary: 'Document storage is ready.', items };
};
