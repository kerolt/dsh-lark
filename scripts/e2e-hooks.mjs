/**
 * A Node module-loader hook for the end-to-end check: it appends the stub
 * source named by `DSH_E2E_STUB` to the channel bundle as that bundle is
 * loaded, so the booted tree drives a fake transport instead of a real Lark
 * connection. Test plumbing, not part of the plugin.
 */
import { readFileSync } from 'node:fs'

const stubPath = process.env.DSH_E2E_STUB

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context)
  if (String(result.url).includes('dsh-lark-channel')) {
    process.stderr.write(`[hook] ${specifier} -> ${result.url} (${String(result.format)})\n`)
  }
  return result
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context)
  if (stubPath !== undefined && String(url).includes('dsh-lark-channel')) {
    process.stderr.write(`[hook] load ${url} format=${String(result.format)}\n`)
  }
  if (stubPath === undefined || !url.endsWith('/dsh-lark-channel/lib/index.js')) return result
  return { ...result, source: `${String(result.source)}\n${readFileSync(stubPath, 'utf8')}\n` }
}
