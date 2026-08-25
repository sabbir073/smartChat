import { Prisma, PrismaClient } from '@prisma/client';
import { newId } from './ids.js';

export { Prisma };
export type { Prisma as PrismaTypes } from '@prisma/client';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

/**
 * Fill in missing primary keys with a UUIDv7.
 *
 * Descends only into relation wrappers (`create`, `createMany.data`), so nested writes get ids
 * too, while `where`, `connect` and `update` clauses are left untouched.
 */
function assignIds(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) assignIds(item);
    return;
  }
  if (!isPlainObject(node)) return;

  if (node['id'] === undefined) node['id'] = newId();

  for (const value of Object.values(node)) {
    if (!isPlainObject(value)) continue;
    if ('create' in value) assignIds(value['create']);
    if (isPlainObject(value['createMany'])) {
      assignIds((value['createMany'] as Record<string, unknown>)['data']);
    }
  }
}

export interface CreatePrismaOptions {
  databaseUrl: string;
  logQueries?: boolean;
  onQuery?: (event: Prisma.QueryEvent) => void;
  onWarning?: (message: string) => void;
}

/**
 * Build the Prisma client used by every process.
 *
 * The id extension is the reason no caller ever has to remember to generate a primary key —
 * a rule that would otherwise be forgotten exactly once, in the one place it matters.
 */
export function createPrismaClient(options: CreatePrismaOptions) {
  const base = new PrismaClient({
    datasources: { db: { url: options.databaseUrl } },
    log: options.logQueries
      ? [
          { emit: 'event', level: 'query' },
          { emit: 'event', level: 'warn' },
          { emit: 'event', level: 'error' },
        ]
      : [
          { emit: 'event', level: 'warn' },
          { emit: 'event', level: 'error' },
        ],
  });

  if (options.logQueries && options.onQuery) {
    base.$on('query', options.onQuery);
  }
  if (options.onWarning) {
    base.$on('warn', (event) => options.onWarning?.(event.message));
    base.$on('error', (event) => options.onWarning?.(event.message));
  }

  return base.$extends({
    name: 'uuidv7-primary-keys',
    query: {
      $allModels: {
        create({ args, query }) {
          assignIds(args.data);
          return query(args);
        },
        createMany({ args, query }) {
          assignIds(args.data);
          return query(args);
        },
        createManyAndReturn({ args, query }) {
          assignIds(args.data);
          return query(args);
        },
        upsert({ args, query }) {
          assignIds(args.create);
          return query(args);
        },
      },
    },
  });
}

export type Database = ReturnType<typeof createPrismaClient>;

/**
 * A transaction handle. Repositories accept `Database | DatabaseTransaction` so the same function
 * works inside and outside a transaction — which is what makes "persist message and bump the
 * conversation counter atomically" expressible without duplicating query code.
 */
export type DatabaseTransaction = Omit<
  Database,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;

export type DatabaseOrTransaction = Database | DatabaseTransaction;

/** Prisma's unique-constraint violation. Used to make idempotent inserts explicit. */
export function isUniqueViolation(error: unknown, target?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code !== 'P2002') return false;
  if (!target) return true;
  const meta = error.meta as { target?: string[] | string } | undefined;
  const fields = Array.isArray(meta?.target) ? meta.target : meta?.target ? [meta.target] : [];
  return fields.some((field) => field.includes(target));
}

export function isForeignKeyViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';
}

export function isNotFoundError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}

export type JsonObject = Prisma.InputJsonObject;
export type JsonValue = Prisma.InputJsonValue;

/**
 * Narrow an arbitrary metadata bag to Prisma's JSON input type.
 *
 * Callers build metadata as `Record<string, unknown>` because that is what the domain produces;
 * this is the single place that conversion happens, rather than a cast at every call site.
 */
export function toJson(value: Record<string, unknown> | undefined | null): Prisma.InputJsonObject {
  return (value ?? {}) as Prisma.InputJsonObject;
}

/**
 * SQL NULL for a nullable Json column.
 *
 * Prisma distinguishes SQL NULL (`Prisma.DbNull`) from the JSON value `null` (`Prisma.JsonNull`),
 * and a plain `null` is rejected by the generated types. Exported here so callers do not have to
 * import the Prisma namespace just to clear a Json field.
 */
export const dbNull = Prisma.DbNull;
