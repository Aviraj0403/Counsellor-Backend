import type { Principal } from '../../contracts/port.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by `validate()` */
      valid: { body?: any; query?: any; params?: any };
      /** Set by `authenticate` */
      principal?: Principal;
    }
  }
}

export {};
