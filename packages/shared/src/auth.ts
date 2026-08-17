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

/**
 * An OAuth client, as shown on the consent screen.
 *
 * Only the two facts a person needs in order to decide: what the application calls
 * itself, and where it will send the authorization code. The name is self-declared at
 * registration and therefore untrusted, which is exactly why the redirect host is
 * shown beside it — a client claiming to be a familiar tool while pointing at an
 * unfamiliar host is the case a consent screen exists to catch.
 *
 * No client secret is in this shape, and there is nowhere for one to leak into.
 */
export const oauthClientSchema = z.object({
  clientId: z.string().min(1),
  name: z.string().min(1),
  redirectUris: z.array(z.string()),
});
export type OauthClient = z.infer<typeof oauthClientSchema>;

/**
 * An account as the admin user list shows it.
 *
 * `disabled` is here and deliberately not on `sessionUserSchema`: a disabled account
 * has no session to describe, because the session lookup refuses it. This shape
 * describes accounts to an administrator, which is a different question.
 *
 * No password field exists anywhere in this contract, hashed or otherwise. There is
 * nothing for one to leak into.
 */
export const adminUserSchema = z.object({
  id: z.string(),
  email: z.email(),
  name: z.string(),
  role: roleSchema,
  disabled: z.boolean(),
  createdAt: timestampSchema,
  /** True for the account making the request, which the UI must not offer to break. */
  isSelf: z.boolean(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;

export const listUsersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  /** Substring match against name and email. */
  q: z.string().trim().max(200).optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

/**
 * Creating an account.
 *
 * Called "add", not "invite", because there is no mail service in this system — the
 * administrator sets an initial password and passes it on out of band. Naming it
 * "invite" would imply an email that never arrives.
 *
 * The password minimum matches Better Auth's configured `minPasswordLength`. Stated
 * here so the form can refuse a short one before a round trip, while the server still
 * enforces it independently.
 */
export const createUserRequestSchema = z.object({
  email: z.email(),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(8).max(200),
  role: roleSchema,
});
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;

/**
 * Changing an account. Both fields optional, at least one required.
 *
 * Split from creation because they are different authorities: creating an account
 * needs a password, and changing a role must never touch one.
 */
export const updateUserRequestSchema = z
  .object({
    role: roleSchema.optional(),
    disabled: z.boolean().optional(),
  })
  .refine((body) => body.role !== undefined || body.disabled !== undefined, {
    message: 'Provide role, disabled, or both.',
  });
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

/** Permissions are derived from the role in one place so the API and the UI cannot disagree. */
export const PERMISSIONS = {
  'search:run': ['user', 'admin'],
  'answer:generate': ['user', 'admin'],
  'dashboard:view': ['admin'],
  'documents:manage': ['admin'],
  'ingestion:trigger': ['admin'],
  'users:manage': ['admin'],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: Role | undefined, permission: Permission): boolean {
  if (!role) return false;
  return (PERMISSIONS[permission] as readonly Role[]).includes(role);
}
