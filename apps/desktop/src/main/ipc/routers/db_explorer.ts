/**
 * `account.dbExplorer.*` — SQLiteStudio-style database browser/editor over the
 * open account's encrypted QQ NT databases. Thin tRPC skin over
 * `DbExplorerService` (see `@weq/service`); all the SQL/serialisation logic
 * lives there. Reads are `query`, writes are `mutation`. `runSql` is a mutation
 * because a hand-written statement may write.
 *
 * Values cross the wire as `DbCell` (INTEGER→string, BLOB→hex) so the renderer
 * never loses bigint precision and superjson never sees a typed array.
 */

import { z } from 'zod';
import { getAppContext, type AccountServices } from '../../context/app_context';
import { procedure, router } from '../trpc';

function requireServices(): AccountServices {
  const ctx = getAppContext();
  if (!ctx.services) {
    throw new Error('No account session open — call bootstrap.openAccount first.');
  }
  return ctx.services;
}

const dbInputValue = z.discriminatedUnion('t', [
  z.object({ t: z.literal('null') }),
  z.object({ t: z.literal('int'), v: z.string() }),
  z.object({ t: z.literal('real'), v: z.number() }),
  z.object({ t: z.literal('text'), v: z.string() }),
  z.object({ t: z.literal('blob'), hex: z.string() }),
]);

const rowKey = z.discriminatedUnion('t', [
  z.object({ t: z.literal('rowid'), rowid: z.string() }),
  z.object({
    t: z.literal('pk'),
    cols: z.array(z.object({ name: z.string().min(1), value: dbInputValue })),
  }),
]);

const dbPath = z.string().min(1);
const table = z.string().min(1);

export const dbExplorerRouter = router({
  /** Encrypted `*.db` files under the account's `nt_db` directory. */
  listDatabases: procedure.query(() => {
    return requireServices().dbExplorer.listDatabases();
  }),

  /** Tables / views / indices in one database (triggers excluded). */
  listObjects: procedure.input(z.object({ dbPath })).query(({ input }) => {
    return requireServices().dbExplorer.listObjects(input.dbPath);
  }),

  /** Column metadata for one table / view. */
  getColumns: procedure.input(z.object({ dbPath, table })).query(({ input }) => {
    return requireServices().dbExplorer.getColumns(input.dbPath, input.table);
  }),

  /** One page of rows, with per-row edit keys and a paging cursor. */
  getRows: procedure
    .input(
      z.object({
        dbPath,
        table,
        limit: z.number().int().positive().optional(),
        cursor: z.string().nullish(),
        search: z.string().nullish(),
        orderBy: z.string().nullish(),
        orderDir: z.enum(['asc', 'desc']).optional(),
      }),
    )
    .query(({ input }) => {
      return requireServices().dbExplorer.getRows(input.dbPath, input.table, {
        limit: input.limit,
        cursor: input.cursor ?? null,
        search: input.search ?? null,
        orderBy: input.orderBy ?? null,
        orderDir: input.orderDir,
      });
    }),

  /** Run a hand-written statement (SELECT returns rows, else affected count). */
  runSql: procedure
    .input(z.object({ dbPath, sql: z.string().min(1) }))
    .mutation(({ input }) => {
      return requireServices().dbExplorer.runSql(input.dbPath, input.sql);
    }),

  /** Update a single cell. */
  updateCell: procedure
    .input(
      z.object({
        dbPath,
        table,
        rowKey,
        column: z.string().min(1),
        value: dbInputValue,
      }),
    )
    .mutation(({ input }) => {
      return requireServices().dbExplorer.updateCell(
        input.dbPath,
        input.table,
        input.rowKey,
        input.column,
        input.value,
      );
    }),

  /** Insert a row (omitted columns take their default). */
  insertRow: procedure
    .input(
      z.object({
        dbPath,
        table,
        values: z.array(z.object({ name: z.string().min(1), value: dbInputValue })),
      }),
    )
    .mutation(({ input }) => {
      return requireServices().dbExplorer.insertRow(input.dbPath, input.table, input.values);
    }),

  /** Delete one row by its edit key. */
  deleteRow: procedure
    .input(z.object({ dbPath, table, rowKey }))
    .mutation(({ input }) => {
      return requireServices().dbExplorer.deleteRow(input.dbPath, input.table, input.rowKey);
    }),
});
