import { closeDb, getDb } from '../db/client.ts';
import { demoAccounts, upsertAccount } from './accounts.ts';

/**
 * `npm run seed` — create the two demo accounts, from the SEED_* values in .env.
 *
 * Idempotent: re-running resets the password and role of an existing account
 * rather than failing, so a half-finished setup can simply be repeated. The work
 * itself lives in ./accounts.ts so it is reachable from tests.
 */

const db = getDb();

try {
  for (const account of demoAccounts()) {
    const outcome = await upsertAccount(db, account);
    console.log(`  ${outcome.padEnd(8)} ${account.email.padEnd(22)} ${account.role}`);
  }

  // Names the file the passwords actually came from. This used to point at the README,
  // which does not exist yet — a setup script should not send a reader to a missing page.
  console.log('\nDemo accounts ready. Passwords are the SEED_* values in .env.');
} catch (error) {
  console.error(`\nSeeding failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  closeDb();
}
