/**
 * This row's durable state, written where this deployment keeps plugin
 * configuration.
 *
 * A DSH profile is a stack of patch layers over the profile root, and the
 * `settings` service is the dashboard over it: it reads each active entry's
 * schema and live values, and merges field edits back into the profile's own
 * patch document. An entry is addressed by the id the profile gave it, which is
 * the last segment of the id the Loader gave this plugin's fiber — a profile
 * patch keyed `lark-channel` inside a nested include belongs to the entry whose
 * composed id is `include:lark-channel`.
 *
 * The one rule the service enforces is that a write may only name
 * schema-declared volatile fields; ordinary configuration is refused rather
 * than silently restarted. That is why everything written here is volatile:
 * the field lands in the document AND reaches this running process.
 * @module dsh-lark-channel/settings
 */

import type { Context } from '@deepseek-ai/cordis'
import type { HostSettings } from './host.ts'

/** The separator the Loader joins nested entry ids with. */
const ENTRY_SEPARATOR = ':'

/**
 * The profile entry id this plugin's own fiber was mounted from.
 *
 * The Loader stamps every fiber it starts with the entry that owns it; the
 * composed id names the whole path, while a profile patch — and so the settings
 * service — addresses the row by its own last segment. Absent when something
 * mounts this plugin directly, as the tests and a hand-written composition do.
 * @param ctx - this plugin's own context.
 * @returns the row id, or undefined outside a profile.
 */
function profileEntryId(ctx: Context): string | undefined {
  const fiber = ctx.fiber as { readonly entry?: { readonly id?: string } }
  const composed = fiber.entry?.id
  if (composed === undefined) return undefined
  const parts = composed.split(ENTRY_SEPARATOR)
  return parts[parts.length - 1]
}

/** The patch writer the channel's state stores call. */
export type PersistState = (patch: object) => Promise<boolean>

/** One row's writer, and the read-back a settled profile allows. */
export interface SettingsAttachment {
  /** Merge one patch into the row's configuration. */
  readonly patch: PersistState
  /**
   * The row's volatile fields as they currently resolve, by name. Read on
   * demand: a host write — including one this plugin did not make, like the
   * legacy `settings.yaml` import — is committed into the running entry and
   * visible to the next call.
   */
  readonly read: () => Record<string, unknown>
}

/** Whether a value is a plain record, which a schema node and a user layer are. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a value is a schema node, which schemastery builds as a callable. */
function isNode(value: unknown): value is Record<string, unknown> {
  return isRecord(value) || typeof value === 'function'
}

/**
 * One schema's shape: its fields, each reduced to the type it declares, the
 * metadata that describes it, and its elements.
 *
 * A schema states that shape in several ways, and all of them reach here: a
 * schemastery schema, the `{uid, refs}` envelope its `toJSON()` writes, the
 * projected form the settings service reads back out of one, one of those
 * nested inside another, or a map of field names to any of them. `refs` is how
 * a schema shares one node between several fields — the envelope names it once
 * and addresses it by uid — so every read resolves an address rather than
 * trusting that it received the node itself.
 *
 * The `volatile` mark is dropped: it is what asks for a projection, so two
 * forms of the same fields agree whether or not either still declares it.
 * @param schema - one of those forms.
 * @returns the shape as text.
 */
function shapeOf(schema: unknown): string {
  const envelope = schema as { toJSON?: () => unknown }
  const source = typeof envelope?.toJSON === 'function' ? envelope.toJSON() : schema
  const refs = isRecord(source) && isRecord(source.refs) ? source.refs : undefined

  /**
   * The node one value names, and the table its children are addressed in.
   *
   * A node arrives as an address into a table, as a schema, or as the node
   * itself. One walk reads all three: an address reads its table, a schema
   * serializes into an envelope, and an envelope's own root is the node. The
   * table that comes back is the envelope's, which is where a child's address
   * was written and so where it is read.
   */
  const resolve = (node: unknown, table = refs): { node: unknown, table?: Record<string, unknown> | undefined } => {
    if (typeof node === 'number' || (typeof node === 'string' && table !== undefined)) {
      const addressed = table?.[String(node)]
      return addressed === undefined ? { node: undefined, table } : resolve(addressed, table)
    }
    const envelope = node as { uid?: unknown, refs?: Record<string, unknown>, toJSON?: () => unknown }
    if (typeof envelope?.toJSON === 'function') return resolve(envelope.toJSON(), table)
    if (isRecord(envelope) && envelope.uid !== undefined && isRecord(envelope.refs)) {
      return { node: envelope.refs[String(envelope.uid)], table: envelope.refs }
    }
    return { node, table }
  }

  const nodeOf = (value: unknown, seen: Set<unknown>, table?: Record<string, unknown>): Record<string, unknown> => {
    const resolved = resolve(value, table ?? refs)
    const here = isRecord(resolved.node) ? resolved.node : {}
    const meta = isRecord(here.meta) ? { ...here.meta } : {}
    delete meta.volatile
    const shape = { type: here.type, ...Object.keys(meta).length === 0 ? {} : { meta } }
    if (seen.has(here)) return shape
    seen.add(here)
    const children = isRecord(here.dict)
      ? Object.fromEntries(Object.entries(here.dict).map(([key, child]) => [key, nodeOf(child, seen, resolved.table)]))
      : undefined
    const inner = here.inner === undefined ? undefined : nodeOf(here.inner, seen, resolved.table)
    return {
      ...shape,
      ...children === undefined ? {} : { dict: children },
      ...inner === undefined ? {} : { inner },
      ...!Array.isArray(here.list) ? {} : { list: here.list.map(child => nodeOf(child, seen, resolved.table)) },
    }
  }

  // The root is either one schema node or the map of fields itself.
  const root = resolve(source).node
  const dict = isNode(root) && isRecord(root.dict) ? root.dict : isFields(root) ? root : undefined
  if (dict === undefined) return JSON.stringify(nodeOf(root, new Set()))
  return JSON.stringify(Object.fromEntries(Object.entries(dict).map(([key, field]) => [key, nodeOf(field, new Set())])))
}

/**
 * What one value says it is: a schema node's type, an envelope's uid, or an
 * address into a table. This is what tells a field map from a single node —
 * a node's own properties are none of these.
 * @param value - a schema node, an envelope, an address, or anything else.
 * @returns the type, the uid, or the address; undefined for anything else.
 */
function nodeId(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (!isNode(value)) return undefined
  if (typeof value.type === 'string') return value.type
  return value.uid === undefined ? undefined : String(value.uid)
}

/** Whether a value is a map of field names to schema nodes, which a form is. */
function isFields(value: unknown): value is Record<string, unknown> {
  if (!isNode(value)) return false
  const fields = Object.values(value)
  return fields.length > 0 && fields.every(field => nodeId(field) !== undefined)
}

/**
 * One schema's fields, projected to the volatile ones — the form the settings
 * service offers for a row, and the form this plugin holds of its own.
 * @param schema - a Config schema.
 * @returns the form, as a plain object of field names to schema nodes.
 */
function formOf(schema: unknown): Record<string, unknown> {
  const node = schema as { dict?: Record<string, unknown> }
  return Object.fromEntries(Object.entries(node?.dict ?? {})
    .filter(([, field]) => (field as { meta?: { volatile?: boolean } }).meta?.volatile === true))
}

/**
 * Whether one entry holds the configuration this plugin was mounted with.
 *
 * Asked of the form alone: the service hands back each entry's schema projected
 * to its volatile fields, and those field names and shapes are this plugin's
 * own signature — no other plugin declares the same set at the same shape. The
 * live values are deliberately not consulted: the service omits a field it
 * resolved to undefined, so an unconfigured row is exactly the state this
 * lookup has to work in.
 *
 * Exported for the tests that hold this comparison to the forms a deployment
 * hands it.
 * @param entry - one entry's form.
 * @param own - this plugin's Config schema.
 * @returns whether the entry is a row of this plugin.
 */
export function matchesOwnEntry(entry: { readonly schema: unknown }, own: unknown): boolean {
  const form = formOf(own)
  if (Object.keys(form).length === 0) return false
  return shapeOf(entry.schema) === shapeOf(form)
}

/**
 * Attach this row to the settings service the deployment composed.
 *
 * Absent service, or a composition that mounts this plugin outside a profile
 * entry, leaves the caller without a writer: the channel then runs with the
 * entry config alone and every mutation reports itself as in-memory only.
 *
 * Every field a patch may name is `volatile` in the schema, so a write lands
 * in the profile document and reaches the running process in one pass; a
 * patch naming an ordinary field would be refused whole, app id included.
 * @param settings - the settings service, when one is composed.
 * @param ctx - this plugin's own context, which addresses the profile entry.
 * @param schema - this plugin's Config schema, identifying its rows.
 * @param report - operator console line, for a deployment that cannot persist.
 * @returns the row's writer, or undefined when this deployment has no home for it.
 */
export function attachSettings(
  settings: HostSettings | undefined,
  ctx: Context,
  schema: unknown,
  report: (line: string) => void,
): SettingsAttachment | undefined {
  if (settings === undefined) {
    report('lark-channel: no settings service is composed; state stays in memory and resets on restart')
    return undefined
  }
  const rowId = profileEntryId(ctx)
  // The row's own id decides when the profile composes several; a deployment
  // mounting a single row outside a Loader leaves only one candidate.
  const rows = settings.describe().filter(entry => matchesOwnEntry(entry, schema))
  const found = rows.find(entry => entry.ns === rowId) ?? (rows.length === 1 ? rows[0] : undefined)
  if (found === undefined) {
    report('lark-channel: the profile exposes no writable entry for this plugin; state stays in memory and resets on restart')
    return undefined
  }
  const entryId = found.ns
  return {
    patch: async (patch) => {
      await settings.update(entryId, patch)
      return true
    },
    read: () => {
      const entry = settings.describe().find(row => row.ns === entryId)
      return isRecord(entry?.value) ? { ...entry.value } : {}
    },
  }
}
