/**
 * The form comparison {@link attachSettings} uses to recognize this plugin's
 * profile row, held to the forms a deployment actually hands it: a real
 * `settings` service hands back an entry's schema projected to its volatile
 * fields, while this plugin holds the schema itself.
 */
import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.ts'
import { matchesOwnEntry } from '../src/settings.ts'

/**
 * One field of the form, as a service that read it back out would state it:
 * the same node with the `volatile` mark it was projected for dropped.
 */
function projectedNode(schema: unknown): Record<string, unknown> {
  const node = schema as {
    type?: string
    meta?: Record<string, unknown>
    inner?: unknown
    list?: readonly unknown[]
    dict?: Record<string, unknown>
  }
  const meta = { ...(node?.meta ?? {}) }
  delete meta.volatile
  return {
    type: node?.type,
    ...Object.keys(meta).length === 0 ? {} : { meta },
    ...node?.dict === undefined
      ? {}
      : { dict: Object.fromEntries(Object.entries(node.dict).map(([key, child]) => [key, projectedNode(child)])) },
    ...node?.inner === undefined ? {} : { inner: projectedNode(node.inner) },
    ...node?.list === undefined ? {} : { list: node.list.map(projectedNode) },
  }
}

/** The volatile fields of this plugin's Config, as the service would describe them. */
function projectedForm(schema: unknown = plugin.Config): Record<string, unknown> {
  const dict = (schema as { dict?: Record<string, { meta?: { volatile?: boolean } }> }).dict ?? {}
  return Object.fromEntries(Object.entries(dict)
    .filter(([, field]) => field.meta?.volatile === true)
    .map(([name, field]) => [name, projectedNode(field)]))
}

describe('row recognition', () => {
  it('recognizes the projected form of its own schema', () => {
    expect(matchesOwnEntry({ schema: projectedForm() }, plugin.Config)).toBe(true)
  })

  it('recognizes a row whose fields resolved to nothing', () => {
    // A first boot: the service omits a field it resolved to undefined, so the
    // row that most needs its writer is the one with the least to show.
    expect(matchesOwnEntry({ schema: projectedForm() }, plugin.Config)).toBe(true)
  })

  it('refuses a row declaring other fields', () => {
    expect(matchesOwnEntry({ schema: { enabled: { type: 'boolean' } } }, plugin.Config)).toBe(false)
  })

  it('refuses another plugin declaring the same field names differently', () => {
    const theirs = { ...projectedForm() }
    theirs.appId = { type: 'number' }
    expect(matchesOwnEntry({ schema: theirs }, plugin.Config)).toBe(false)
  })

  it('refuses a schema with no volatile field at all', () => {
    expect(matchesOwnEntry({ schema: projectedForm({ dict: { plain: { type: 'string' } } }) }, plugin.Config)).toBe(false)
  })
})
