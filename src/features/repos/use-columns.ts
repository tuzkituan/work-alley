import { createContext, useContext } from 'react'
import type { ColumnId } from './columns'

/**
 * Which columns the table is rendering right now.
 *
 * A context rather than a store read, because the answer is not the user's choice
 * alone — it is that choice narrowed by how wide the table actually is, and only
 * the table can measure itself. Every row must agree with the header and with the
 * `grid-template-columns` on the table, or cells land in the wrong tracks.
 *
 * Defaults to an empty set so a row rendered outside a table (a test, a future
 * embed) shows name and actions rather than throwing.
 */
export const ColumnsContext = createContext<ReadonlySet<ColumnId>>(new Set())

export function useColumns(): ReadonlySet<ColumnId> {
  return useContext(ColumnsContext)
}
