/**
 * Runtime boundary and Cordis activation for the plugin.
 * @module dsh-lark-channel/runtime
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createLarkChannel, registerApp } from '@larksuite/channel'
import type { LarkChannelOptions, PolicyConfig } from '@larksuite/channel'
import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig } from './config.ts'
import type { RawConfig, ResolvedConfig } from './config.ts'
import { installBridge, type ChannelPort } from './bridge.ts'
import { migrateAppSecret, resolveAppSecret, storeAppSecret } from './credentials.ts'
import type { HostCredentials } from './credentials.ts'
import { instanceIdentity } from './instance.ts'
import type { CotEvent, CotHandle } from './cot.ts'
import type { PanelCommand } from './slash-panel.ts'
import { beginOnboarding } from './onboarding.ts'
import type { LarkCredentials, OnboardedApp, RegisterAppPort } from './onboarding.ts'
import { describeAuthorization, resolveAuthorization } from './authorization.ts'
import type { Authorization } from './authorization.ts'
import type { HostLoader, HostSettings } from './host.ts'
import { attachSettings } from './settings.ts'
import type { SettingsAttachment } from './settings.ts'
import { dshHome } from './provision.ts'

/** Resolved configuration whose credentials are present; the transport can be built. */
export type ChannelConfig = ResolvedConfig & LarkCredentials

/** The app-config endpoint for the bot's slash-command panel; the SDK has no method for it. */
const SLASH_COMMAND_API = '/open-apis/application/v7/app_slash_commands'

/**
 * The thinking-process endpoint: `POST` opens one, `PUT` appends events, and a
 * terminal `RUN_FINISHED` closes it without a further call.
 */
const COT_API = '/open-apis/im/v1/message_cot'

/**
 * Narrow a resolved configuration to one carrying live credentials.
 * @param config - resolved plugin configuration.
 * @returns whether both credential fields are non-empty strings.
 */
function hasCredentials(config: ResolvedConfig): config is ChannelConfig {
  return typeof config.appId === 'string' && config.appId !== ''
    && typeof config.appSecret === 'string' && config.appSecret !== ''
}

/**
 * Overlay the volatile fields a settings row currently holds onto a resolved
 * configuration. Absent fields leave the resolved value in place; a blanked
 * secret is a value too.
 * @param durable - the row's attachment to the settings service.
 * @returns the fields the row describes, with absent ones dropped.
 */
function resolveImport(durable: SettingsAttachment): Partial<ResolvedConfig> {
  const value = durable.read()
  const text = (field: 'appId' | 'appSecret' | 'appSecretRef' | 'registeredBy') => {
    const held = value[field]
    return typeof held === 'string' ? { [field]: held } : {}
  }
  const map = (field: 'chatWorkspaces' | 'chatModels' | 'chatEpochs' | 'chatSessions') => {
    const held = value[field]
    return typeof held === 'object' && held !== null && !Array.isArray(held)
      ? { [field]: held as Record<string, string> } : {}
  }
  return {
    ...text('appId'),
    ...text('appSecret'),
    ...text('appSecretRef'),
    ...text('registeredBy'),
    ...map('chatWorkspaces'),
    ...map('chatModels'),
    ...map('chatEpochs'),
    ...map('chatSessions'),
  }
}

/**
 * The transport options one deployment runs under.
 *
 * Separated from the client it configures so the decisions here — who the
 * transport itself will accept, and whether it may merge a chat's messages —
 * can be read and tested without a network client.
 * @param config - resolved plugin configuration with credentials.
 * @param authorization - who this deployment answers.
 * @returns the options for `createLarkChannel`.
 */
export function channelOptions(config: ChannelConfig, authorization: Authorization): LarkChannelOptions {
  // Transport-level defense in depth. The plugin's own inbound check is the
  // authority (it runs where the agent is driven), but leaving the transport at
  // its `dmMode: 'open'` default would let unauthorized traffic reach this
  // process at all — and an allowlist the transport enforces never depends on
  // this plugin's handler being reached.
  const policy: PolicyConfig = { requireMention: config.requireMention }
  // Only narrow when a deployment asked to. Who may open a conversation with
  // the bot at all is the app's visibility scope, set in the developer console;
  // restricting again here by default would duplicate that decision.
  if (authorization.directSenders.size > 0) {
    policy.dmMode = 'allowlist'
    policy.dmAllowlist = [...authorization.directSenders]
  }
  if (config.groupAllowlist.length > 0) policy.groupAllowlist = config.groupAllowlist
  const options: LarkChannelOptions = {
    appId: config.appId,
    appSecret: config.appSecret,
    policy,
    source: 'dsh-lark-channel',
    respectProxyEnv: true,
  }
  // The transport batches by CHAT: messages arriving within its window are
  // merged into one, `{...last, content: joined}` — the LAST sender's name on
  // everyone's words. This channel prefixes each group message with who said
  // it, so a merge does not just blur a burst, it misattributes it: A's
  // sentence reaches the model labelled B. Under a finer session scope it is
  // worse still, handing one conversation another's words. Nothing is lost by
  // closing the window: the agent's own inbox already drains several queued
  // messages into a single turn.
  options.safety = { batch: { text: { delayMs: 0 }, media: { delayMs: 0 } } }
  if (config.domain !== undefined) options.domain = config.domain
  return options
}

/**
 * Create the production Lark transport from resolved configuration.
 * @param config - resolved plugin configuration with credentials.
 * @param authorization - who this deployment answers.
 * @returns the real `@larksuite/channel` client behind the bridge's port surface.
 */
export function createLarkChannelPort(config: ChannelConfig, authorization: Authorization): ChannelPort {
  const channel = createLarkChannel(channelOptions(config, authorization))
  // The slash-command panel has no SDK method; it is a plain app-config API,
  // reached through the transport's own authenticated client.
  const raw = channel.rawClient as {
    request(payload: { method: string; url: string; data?: unknown }): Promise<unknown>
  }
  return Object.assign(channel, {
    async listSlashCommands(): Promise<PanelCommand[]> {
      // The collection route requires a paging query; without one it 404s.
      const response = await raw.request({
        method: 'GET',
        url: `${SLASH_COMMAND_API}?page_size=50`,
      }) as { data?: { items?: { command?: string; command_id?: string }[] } }
      return (response.data?.items ?? [])
        .filter((item): item is { command: string; command_id: string } =>
          typeof item.command === 'string' && typeof item.command_id === 'string')
        .map(item => ({ command: item.command, commandId: item.command_id }))
    },
    async deleteSlashCommand(commandId: string): Promise<void> {
      await raw.request({ method: 'DELETE', url: `${SLASH_COMMAND_API}/${commandId}` })
    },
    async createCot(chatId: string, options: { replyTo?: string; hidden: boolean }): Promise<CotHandle> {
      const response = await raw.request({
        method: 'POST',
        url: `${COT_API}?receive_id_type=chat_id`,
        data: {
          receive_id: chatId,
          ...options.replyTo === undefined ? {} : { origin_message_id: options.replyTo },
          cot_hidden: options.hidden,
          // A thinking process is not news: it must not raise an unread badge
          // or pull the conversation to the top of the list on every turn.
          enable_badge: false,
          update_feed_rank: false,
        },
      }) as { data?: { cot_id?: string; message_id?: string } }
      const cotId = response.data?.cot_id
      const messageId = response.data?.message_id
      if (cotId === undefined || messageId === undefined) {
        throw new Error('lark-channel: the platform returned no cot_id/message_id')
      }
      return { cotId, messageId }
    },
    async writeCotEvents(handle: CotHandle, events: readonly CotEvent[]): Promise<void> {
      await raw.request({
        method: 'PUT',
        url: COT_API,
        data: { events, message_id: handle.messageId, cot_id: handle.cotId },
      })
    },
    async createSlashCommand(command: string, description: string): Promise<void> {
      await raw.request({
        method: 'POST',
        url: SLASH_COMMAND_API,
        data: { command, description: { default_value: description } },
      })
    },
  })
}

/** Substitutable production boundaries; tests replace them with fakes. */
export const internals: {
  createPort: (config: ChannelConfig, authorization: Authorization) => ChannelPort
  registerApp: RegisterAppPort
  /** Operator console line; the default profile composes no logger printer. */
  notify: (line: string) => void
  /** Shortest gap between two issued QR codes; absent keeps the onboarding default. */
  reissueFloorMs?: number
  /** How long an upgraded deployment is given for its settings import; absent keeps the default. */
  legacyImportWindowMs?: number
  /** Reconnect-watchdog deadline override; absent keeps the bridge default. */
  reconnectDeadlineMs?: number
  /** How an onboarded secret is stored; substituted in tests. */
  storeSecret: typeof storeAppSecret
} = {
  createPort: createLarkChannelPort,
  registerApp,
  storeSecret: storeAppSecret,
  // Stamped because the incident this console exists for was dated off a file
  // mtime: the log itself could not answer WHEN its last line was written.
  notify: (line) => void process.stderr.write(`[${new Date().toLocaleString('sv-SE')}] ${line}\n`),
}

/** How long an upgraded deployment is given for its `settings.yaml` import to land. */
const LEGACY_IMPORT_WINDOW_MS = 10 * 1000

/**
 * Apply the plugin to its Cordis context. With credentials configured (entry
 * config or a credential a previous scan stored) the transport connects
 * directly; without them the official QR registration flow runs first and
 * persists what it scanned through the settings service and the credentials
 * seam when the deployment composes them.
 * @param ctx - Scoped plugin context; requires the `agents` service.
 * @param config - Configuration resolved by Cordis from the exported schema.
 */
export function apply(ctx: Context, config: RawConfig): void {
  let active = true
  let started = false
  ctx.effect(() => () => { active = false }, 'lark:lifetime')

  // Decided BEFORE the loader settles: a home that still carries a
  // settings.yaml belongs to a deployment upgraded from the dsh whose
  // settings service kept one document per namespace. The current host
  // imports that document into the active profile, but only once the Loader
  // has settled — the very event this bootstrap awaits. A `settings.yaml`
  // that boot order is about to rename must make the onboarding decision
  // wait for the import, or the operator is shown a QR code the stored
  // credentials were arriving to prevent.
  const legacyImportPending = existsSync(join(dshHome(), 'settings.yaml'))

  /**
   * Install the bridge once credentials are known, stating this channel's reach
   * on the console: who it serves is a security fact its operator must see, and
   * a groups-only channel (no owner configured yet) is a valid deployment.
   */
  // Durable plugin state (an onboarded app, workspace switches) goes into the
  // profile through the settings service; false tells the writer the value
  // lives in memory only.
  let persistState = async (_patch: object): Promise<boolean> => false

  const start = (resolved: ChannelConfig): void => {
    if (!active || started) return
    started = true
    const authorization = resolveAuthorization(resolved)
    internals.notify(describeAuthorization(authorization))
    installBridge(
      ctx,
      resolved,
      internals.createPort(resolved, authorization),
      internals.notify,
      authorization,
      persistState,
      internals.reconnectDeadlineMs === undefined ? undefined : { deadlineMs: internals.reconnectDeadlineMs },
    )
  }

  const bootstrap = async (): Promise<void> => {
    // Loader siblings mount concurrently; whether the optional settings
    // service exists is only decided once the application settles.
    await (ctx.get('loader') as HostLoader | undefined)?.await()
    if (!active) return

    let resolved = resolveConfig(config)
    // A named row keys its credential and its session ids apart from every
    // other row; an unnamed one keeps the original identifiers.
    const identity = instanceIdentity(resolved.instance)
    let persist = async (_app: OnboardedApp): Promise<boolean> => false
    const credentials = ctx.get('credentials') as HostCredentials | undefined
    const durable = attachSettings(ctx.get('settings') as HostSettings | undefined, ctx, Config, internals.notify)

    if (legacyImportPending && durable !== undefined && !hasCredentials(resolved)) {
      // The import runs as a fire-and-forget task keyed on the same loader
      // settlement this bootstrap awaited, and each imported field is carried
      // by a volatile entry of this schema — committed into this fiber as the
      // import writes it, and visible in the row's described value. Poll it:
      // either the credentials arrive, or the window closes and onboarding
      // proceeds as it would have.
      const deadline = Date.now() + (internals.legacyImportWindowMs ?? LEGACY_IMPORT_WINDOW_MS)
      while (Date.now() < deadline) {
        await delay(100)
        if (!active) return
        resolved = { ...resolved, ...resolveImport(durable) }
        if (hasCredentials(resolved)) break
      }
    }

    if (durable !== undefined) {
      persistState = durable.patch
      // Onboarding hands the secret to the credentials seam and records only
      // the reference, so the profile document never learns it. Only where no
      // seam took it does the secret stay in the patch — and then it is the
      // one place left to keep a bot that onboarded working.
      persist = async (app) => {
        const stored = await internals.storeSecret(credentials, app.appSecret, internals.notify, identity.secretRef)
        if (stored.ref === undefined) {
          // The secret is going into the same document people read and copy
          // around. The scan should not be told it landed behind a reference.
          internals.notify('lark-channel: no credentials provider is composed; the app secret was written into the profile document, readable by anyone who can read that file')
        }
        return persistState({
          appId: app.appId,
          ...app.registeredBy === undefined ? {} : { registeredBy: app.registeredBy },
          ...stored.ref === undefined ? { appSecret: app.appSecret } : { appSecretRef: stored.ref },
          // Blanked rather than omitted, because the patch deep-merges and an
          // empty secret is an absent one everywhere here.
          ...stored.ref !== undefined ? { appSecret: '' } : {},
        })
      }
    }

    // A secret already sitting in the profile moves behind a reference on this
    // boot, so a bot onboarded before the seam was used is repaired by
    // restarting rather than by scanning again.
    const migratedRef = await migrateAppSecret(credentials, resolved, persistState, internals.notify, identity.secretRef)
    if (migratedRef !== undefined) resolved = { ...resolved, appSecret: '', appSecretRef: migratedRef }

    const secret = await resolveAppSecret(credentials, resolved, internals.notify)
    if (secret !== undefined) resolved = { ...resolved, appSecret: secret }

    if (hasCredentials(resolved)) {
      start(resolved)
      return
    }
    const base = resolved
    beginOnboarding({
      ctx,
      register: internals.registerApp,
      notify: internals.notify,
      persist,
      onCredentials: app => { start({ ...base, ...app }) },
      ...resolved.appId === undefined ? {} : { appId: resolved.appId },
      ...identity.name === undefined ? {} : { instance: identity.name },
      ...internals.reissueFloorMs === undefined ? {} : { reissueFloorMs: internals.reissueFloorMs },
    })
  }

  void bootstrap().catch((error: unknown) => {
    ctx.logger.error('lark-channel bootstrap failed: %s', error instanceof Error ? error.message : error)
  })
}
