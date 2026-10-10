/**
 * End-to-end check against a real DSH installation: boot the lark profile from
 * a temporary home with a stubbed transport, let the plugin onboard through the
 * real `settings` service and the real credentials provider, then report where
 * the values landed.
 *
 * It exists because the unit suite's `settings` service is a fake of this
 * plugin's own making: an API the deployment no longer has would look exactly
 * like one it has. This run uses the installed one.
 *
 * Requires an installed `dsh` and a provisioned lark profile for it. The boot
 * reuses a copy of that profile — nothing of the real bot's is touched, and the
 * transport is stubbed, so no connection is opened.
 *
 * Run with `pnpm run e2e:settings`.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const dshHome = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
const realProfile = join(dshHome, 'profiles', process.env.DSH_E2E_PROFILE ?? 'lark')

/** Absolute path of the installed launcher, the way the shell would find it. */
function dshBin(): string {
  const which = spawnSync('which', ['dsh'], { encoding: 'utf8' }).stdout.trim()
  if (which === '') return process.env.DSH_E2E_BIN ?? ''
  const launcher = realpathSync(which)
  const installed = resolve(dirname(launcher), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  return existsSync(installed) ? installed : launcher
}

const bin = dshBin()

if (!existsSync(realProfile)) {
  process.stderr.write(`e2e-settings: no profile at ${realProfile}; provision it first (dsh-lark-channel start)\n`)
  process.exit(1)
}
if (bin === '') {
  process.stderr.write('e2e-settings: no `dsh` on PATH and no DSH_E2E_BIN given\n')
  process.exit(1)
}

// A temporary home carrying the profile's composition and its installed
// packages, with this checkout's build staged as the plugin package.
const home = join(tmpdir(), `dsh-e2e-${String(process.pid)}`)
const profile = join(home, 'profiles', 'lark')
rmSync(home, { recursive: true, force: true })
mkdirSync(profile, { recursive: true })
cpSync(realProfile, profile, {
  recursive: true,
  filter: source => !source.endsWith('cordis.patch.yml'),
})
// A first boot: no credentials and an empty user layer, so a scan is what runs.
writeFileSync(join(profile, 'cordis.patch.yml'), "- id: lark-channel\n  name: 'dsh-lark-channel'\n")
const staged = join(profile, 'node_modules', 'dsh-lark-channel')
cpSync(join(repo, 'lib'), join(staged, 'lib'), { recursive: true })
writeFileSync(join(staged, 'package.json'), readFileSync(join(repo, 'package.json')))
writeFileSync(join(staged, 'cordis.patch.yml'), readFileSync(join(repo, 'cordis.patch.yml')))

/**
 * One boot, stopped once it has had time to settle: a mounted tree never exits
 * on its own. The loader hook registered here is what swaps the transport.
 * @returns the boot's console output.
 */
function boot(): string {
  const run = spawnSync(process.execPath, [
    '--import', join(repo, 'scripts', 'e2e-register.mjs'),
    bin,
    '--profile', 'lark',
  ], {
    encoding: 'utf8',
    timeout: 40_000,
    env: { ...process.env, DSH_HOME: home, DSH_E2E_STUB: join(repo, 'scripts', 'e2e-stub.mjs') },
  })
  return `${run.stdout ?? ''}${run.stderr ?? ''}`
}

const first = boot()
const patch = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')
const credentialsPath = join(home, '.credentials.yaml')
const credentials = existsSync(credentialsPath) ? readFileSync(credentialsPath, 'utf8') : '(absent)'
process.stdout.write(`\n=== first boot ===\n${first}\n`)
process.stdout.write(`=== profile patch ===\n${patch}\n`)
process.stdout.write(`=== credentials ===\n${credentials}\n`)

const failures = []
if (!/appId: cli_e2e/.test(patch)) failures.push('the scanned appId did not reach the profile patch')
if (!/registeredBy: ou_e2e_scanner/.test(patch)) failures.push('who scanned did not reach the profile patch')
if (!/appSecretRef: LARK_APP_SECRET/.test(patch)) failures.push('the credential reference did not reach the profile patch')
if (/appSecret: e2e-secret/.test(patch)) failures.push('the app secret was written into the profile patch')
if (!/LARK_APP_SECRET: e2e-secret/.test(credentials)) failures.push('the app secret did not reach the credentials document')

const second = boot()
process.stdout.write(`=== second boot ===\n${second}\n`)
if (/注册成功/.test(second)) failures.push('the second boot scanned again instead of reusing the stored credential')

// A third boot as an upgraded deployment: the profile knows nothing, the
// credentials store is empty, and a settings.yaml written by the dsh whose
// settings service kept one document per namespace is still sitting in the
// home. The host imports it only after the loader settles, so the channel's
// onboarding decision has to wait for that import rather than ask for a scan.
writeFileSync(join(profile, 'cordis.patch.yml'), "- id: lark-channel\n  name: 'dsh-lark-channel'\n")
rmSync(credentialsPath, { force: true })
writeFileSync(join(home, 'settings.yaml'), 'lark-channel:\n  appId: cli_legacy\n  appSecret: legacy-secret\n')
const third = boot()
const upgradedPatch = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')
const upgradedCredentials = readFileSync(credentialsPath, 'utf8')
process.stdout.write(`=== upgraded boot ===\n${third}\n`)
process.stdout.write(`=== upgraded profile patch ===\n${upgradedPatch}\n`)
process.stdout.write(`=== upgraded credentials ===\n${upgradedCredentials}\n`)
if (/注册成功/.test(third)) failures.push('an upgraded deployment was asked for a scan it does not owe')
if (!/createPort called for cli_legacy/.test(third)) failures.push('the upgraded deployment did not connect with its imported appId')
if (!/appId: cli_legacy/.test(upgradedPatch)) failures.push('the imported appId did not reach the profile patch')
if (/appSecret: legacy-secret/.test(upgradedPatch)) failures.push('the imported app secret stayed in the profile patch')
if (!/appSecretRef: LARK_APP_SECRET/.test(upgradedPatch)) failures.push('the imported secret was not moved behind its reference')
if (!/LARK_APP_SECRET: legacy-secret/.test(upgradedCredentials)) failures.push('the imported app secret did not reach the credentials document')

rmSync(home, { recursive: true, force: true })
if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`e2e-settings: ${failure}\n`)
  process.exit(1)
}
process.stdout.write('e2e-settings: ok\n')
