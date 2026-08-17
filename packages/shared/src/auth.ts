import { z } from 'zod';
import { timestampSchema } from './common.ts';

/**
 * Two roles, checked server-side on every protected route.
 *
 * `user` may search and ask questions. `admin` may additionally view the
 * dashboard, list and manage documents, and trigger ingestion. The role lives on
 * the user record and is resolved from the session on the server — never read
 * from a client-supplied header or body.
 */
export const roleSchema = z.enum(['user', 'admin']);
export type Role = z.infer<typeof roleSchema>;

export const sessionUserSchema = z.object({
  id: z.string(),
  email: z.email(),
  name: z.string(),
  role: roleSchema,
  createdAt: timestampSchema,
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

// There is deliberately no sign-in request schema here. Better Auth owns the
// sign-in endpoint and validates its own body, so a second definition of that
// shape would have no validator to be, and the one written earlier had no
// consumer in either workspace. The session *response* below is different: it is
// this application's own route, and the browser reads it.

export const sessionResponseSchema = z.object({
  user: sessionUserSchema.nullable(),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

/** Permissions are derived from the role in one place so the API and the UI cannot disagree. */
export const PERMISSIONS = {
  'search:run': ['user', 'admin'],
  'answer:generate': ['user', 'admin'],
  'dashboard:view': ['admin'],
  'documents:manage': ['admin'],
  'ingestion:trigger': ['admin'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role | undefined, permission: Permission): boolean {
  if (!role) return false;
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}
