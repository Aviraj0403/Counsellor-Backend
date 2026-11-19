// PUBLIC API of the `students` module.
export { getStudent, studentExists } from './application/student.service.js';
export { studentRoutes } from './http/student.routes.js';
/** Students needs no event listeners or hooks of its own (other modules hook into 'student.export' / 'student.erased'). */
export const registerEvents = (): void => {};
