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

export const signInRequestSchema = z.object({
  email: z.email(),
  password: z.string().min(8).max(200),
});
export type SignInRequest = z.infer<typeof signInRequestSchema>;

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
