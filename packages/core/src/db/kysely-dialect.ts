import {
  CompiledQuery,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type QueryResult,
} from 'kysely';
import type { DatabaseSync } from 'node:sqlite';

/**
 * A Kysely dialect backed by the existing `node:sqlite` connection.
 *
 * Better Auth talks to its store through Kysely, and Kysely's bundled SQLite
 * dialect is written against better-sqlite3 — a native module whose install step
 * downloads or compiles a binary. Adding it would mean a second SQLite library
 * holding the same database file open, and an install that fails on any machine
 * where npm's script policy blocks postinstall hooks (verified: with
 * `--ignore-scripts`, better-sqlite3 ships no usable binary at all).
 *
 * Only the driver is missing — Kysely exports the SQLite adapter, compiler and
 * introspector, and they are reused unchanged. What remains is translating
 * between Kysely's query objects and node:sqlite's statement API, which is small
 * enough to read in one sitting and fails loudly rather than subtly when wrong.
 *
 * Note this does not hand-roll authentication. Better Auth still owns password
 * hashing, session issuance and verification; this only lets it reach the
 * database we already have open.
 */

/**
 * node:sqlite accepts null, numbers, bigints, strings and Uint8Array, and rejects
 * anything else outright.
 *
 * Booleans are the one that matters: Better Auth stores `emailVerified` as a
 * boolean, and binding one throws "Provided value cannot be bound to SQLite
 * parameter". SQLite has no boolean type, so 0/1 is the standard representation.
 * Dates are normalised to ISO strings so stored timestamps match the format the
 * rest of the schema uses rather than depending on an implicit coercion.
 */
function toBindable(value: unknown): null | number | bigint | string | Uint8Array {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') {
    return value;
  }
  if (value instanceof Uint8Array) return value;
  // Objects and arrays reach here only if a caller stores JSON without
  // serialising it. Failing here names the offending value; letting it through
  // would surface as an opaque binding error with no indication of which column.
  throw new TypeError(`Cannot bind value of type ${typeof value} to a SQLite parameter.`);
}

/**
 * Whether a statement produces rows.
 *
 * node:sqlite has no equivalent of better-sqlite3's `stmt.reader`, and the two
 * paths are not interchangeable: `run()` on a SELECT discards the rows, while
 * `all()` on an INSERT returns an empty array and no change count. The keyword
 * test covers the forms Kysely emits — including `INSERT ... RETURNING`, which
 * Better Auth uses to read back inserted rows.
 */
function returnsRows(sql: string): boolean {
  const head = sql.trimStart().slice(0, 12).toLowerCase();
  if (head.startsWith('select') || head.startsWith('with') || head.startsWith('pragma')) {
    return true;
  }
  return /\breturning\b/i.test(sql);
}

class NodeSqliteConnection implements DatabaseConnection {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const { sql, parameters } = compiledQuery;
    const statement = this.#db.prepare(sql);
    const bound = parameters.map(toBindable);

    if (returnsRows(sql)) {
      return { rows: statement.all(...bound) as R[] };
    }

    const result = statement.run(...bound);
    return {
      rows: [],
      numAffectedRows: BigInt(result.changes),
      insertId: BigInt(result.lastInsertRowid),
    };
  }

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    // node:sqlite is synchronous and Better Auth never streams. Throwing beats a
    // silent partial implementation that would appear to work on small tables.
    throw new Error('Streaming is not supported by the node:sqlite dialect.');
  }
}

class NodeSqliteDriver implements Driver {
  readonly #db: DatabaseSync;
  readonly #connection: NodeSqliteConnection;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#connection = new NodeSqliteConnection(db);
  }

  async init(): Promise<void> {}

  /**
   * One connection, reused. node:sqlite is synchronous, so nothing can interleave
   * mid-statement, and a pool would add contention on a single file for no gain.
   */
  async acquireConnection(): Promise<DatabaseConnection> {
    return this.#connection;
  }

  async beginTransaction(): Promise<void> {
    this.#db.exec('BEGIN');
  }

  async commitTransaction(): Promise<void> {
    this.#db.exec('COMMIT');
  }

  async rollbackTransaction(): Promise<void> {
    this.#db.exec('ROLLBACK');
  }

  async releaseConnection(): Promise<void> {}

  /** The connection is owned by db/client.ts, so closing it is not this driver's call. */
  async destroy(): Promise<void> {}
}

export function nodeSqliteDialect(db: DatabaseSync): Dialect {
  return {
    createDriver: () => new NodeSqliteDriver(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
    createAdapter: () => new SqliteAdapter(),
    createIntrospector: (kysely) => new SqliteIntrospector(kysely),
  };
}
