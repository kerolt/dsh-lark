/**
 * Registers the module-loader hook that scripts/e2e-settings.mts needs: the
 * hook appends scripts/e2e-stub.mjs to the channel bundle as that bundle loads,
 * so the booted tree drives a fake transport instead of a real Lark connection.
 * Test plumbing, not part of the plugin. Register with:
 *   node --import ./scripts/e2e-register.mjs ...
 */
import { register } from 'node:module'

register('./e2e-hooks.mjs', import.meta.url)
