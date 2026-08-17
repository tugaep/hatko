import { z } from 'zod';
import { timestampSchema } from './common.ts';

/**
 * Where the provider API key is coming from, and whether it works.
 *
 * `database` wins over `environment` when both are set. `unreadable` is its own state
 * rather than folded into `unset`: a stored key that will not decrypt — because
 * BETTER_AUTH_SECRET changed under it — needs to be re-entered, and telling the
 * operator "no key configured" would send them looking in the wrong place.
 */
export const secretSourceSchema = z.enum(['database', 'environment', 'unset', 'unreadable']);
export type SecretSource = z.infer<typeof secretSourceSchema>;

/**
 * Status of a stored secret. There is deliberately no field carrying the value.
 *
 * This shape crosses the boundary — `getApiKeyStatus` in @hatko/core produces it and
 * the admin settings panel renders it — so it is defined once, here, rather than as an
 * interface in core and a parser in the web app that agree only by inspection.
 */
export const secretStatusSchema = z.object({
  /** Whether a *usable* secret is available. False when one is stored but unreadable. */
  configured: z.boolean(),
  source: secretSourceSchema,
  /** Last four characters, e.g. `…a91f`. Never the key itself. */
  hint: z.string().nullable(),
  updatedAt: timestampSchema.nullable(),
  updatedBy: z.string().nullable(),
});
export type SecretStatus = z.infer<typeof secretStatusSchema>;

export const setApiKeyRequestSchema = z.object({
  // Length only. Validating against a vendor prefix would break the moment the vendor
  // changes it, and the real test is whether the provider accepts the key.
  apiKey: z.string().trim().min(20).max(400),
});
export type SetApiKeyRequest = z.infer<typeof setApiKeyRequestSchema>;
