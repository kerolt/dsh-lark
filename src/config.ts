/**
 * Serializable configuration, schema, and direct-call defaults.
 * @module dsh-lark-channel/config
 */

import z from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import { DEFAULT_BOT_HOPS } from './botchat.ts'
import type { SessionScope } from './session.ts'

/**
 * Tools whose answer cannot reach a chat.
 *
 * Empty now. Both tools that used to sit here — `ask_user_question` and
 * `exit_plan_mode` — ask through `ctx.userQuestions`, whose single provider
 * belongs to whichever UI registered it first, so their answers would surface
 * where nobody in this chat is watching. Each is shadowed per agent instead
 * and asks here, as a card. A deployment may still name either one, and that
 * denial wins; so does the fallback, which re-denies a tool whose shadow could
 * not be registered.
 */
const DEFAULT_DENY_TOOLS = [] as const

/**
 * The fields this plugin lets the settings service write back, and the only
 * ones the Loader hands over as live references.
 *
 * Named here as well as in the schema because {@link PlainConfig} has to know
 * which fields a document writes as values: the schema declares the behaviour,
 * and this list is what lets a reader's type treat those fields as data.
 */
type VolatileFields =
  | 'appId'
  | 'appSecret'
  | 'appSecretRef'
  | 'registeredBy'
  | 'chatWorkspaces'
  | 'chatModels'
  | 'chatEpochs'
  | 'chatSessions'

/**
 * Plugin configuration as it reaches this plugin: what {@link ConfigSchema}
 * validates, and what {@link apply} receives.
 *
 * This is the shape this plugin's documentation describes. Absent is
 * `undefined` rather than a missing key, because the Loader keeps the key, and
 * a volatile field arrives as the live reference {@link ConfigSchema} declares
 * — a document, and a direct caller, supply plain values instead.
 * {@link resolveConfig} reads every one of them through {@link dereference}.
 */
export interface RawConfig {
  /**
   * Names this row when a deployment composes more than one, so two bots keep
   * separate app-secret credentials and separate session ids — two bots in one
   * group would otherwise share an agent. Each row's workspace, model, epoch,
   * and session maps live in its own profile entry, which needs no name here.
   *
   * Absent is the original single-row deployment, whose identifiers are
   * unchanged: name the SECOND row, never the first, and nothing already
   * stored moves.
   */
  instance?: string
  /**
   * Lark/Feishu app id (`cli_…`); absent (with no stored credential) starts
   * first-boot QR registration.
   *
   * Managed state as far as the settings service is concerned: a completed scan
   * writes what it registered here, so the next boot reaches the same app
   * without another scan. Hence volatile — a config editor may write this field
   * into the profile and hand the new value to the running plugin, which is
   * also why it is the one field of the pair that may live in a document people
   * read: the secret is a credential.
   */
  appId?: Volatile<string | undefined> | undefined
  /**
   * Lark/Feishu app secret paired with {@link appId}. A deployment that
   * injects one here keeps owning it; a completed scan stores what it scanned
   * behind {@link RawConfig.appSecretRef} and blanks this field, and a
   * deployment without a credentials provider keeps the secret here instead —
   * both are writes into the profile, which is what makes the field volatile.
   */
  appSecret?: Volatile<string | undefined> | undefined
  /**
   * Name of the credential holding the app secret, resolved through
   * `ctx.credentials` on every boot: an environment variable, a dotenv entry,
   * or the provider's own store, whichever is configured. Written by
   * onboarding, which is what makes it volatile.
   */
  appSecretRef?: Volatile<string | undefined> | undefined
  /**
   * Managed state, not configuration: the open id of the user whose scan
   * created or re-authorized this app, recorded by onboarding for the
   * operator's reference. It narrows nothing on its own; put it into
   * `senderAllowlist` or `approvers` to restrict who may drive the bot.
   */
  registeredBy?: Volatile<string | undefined> | undefined
  /** Open-platform domain: `https://open.feishu.cn` (default) or `https://open.larksuite.com`. */
  domain?: string
  /** Absolute workspace directory for chat-driven agents; defaults to the host process cwd. */
  cwd?: string
  /**
   * Directory prefixes `/cd` may point a conversation at; empty allows any
   * existing directory. The platform already decides who can reach the bot at
   * all, so this only narrows where those people may aim it — set it when the
   * bot serves a room whose members should not roam the filesystem.
   */
  workspaceRoots?: string[]
  /**
   * Managed state, not configuration: the workspace each conversation was
   * `/cd`-ed to, keyed by conversation key, written back through the settings
   * service. An empty-string value marks "explicitly the default" — the
   * persistence layer deep-merges patches, so entries are overwritten rather
   * than deleted.
   */
  chatWorkspaces?: Volatile<Record<string, string> | undefined> | undefined
  /**
   * Managed state, not configuration: the `provider/model` route each
   * conversation asked for via `/model use`, keyed by conversation key, with
   * the same empty-string default marker as {@link chatWorkspaces}.
   */
  chatModels?: Volatile<Record<string, string> | undefined> | undefined
  /**
   * Managed state, not configuration: how many times each conversation has
   * started over with `/new`, keyed by the session id it derives at epoch
   * zero. Absent is the first session, whose id is unchanged.
   */
  chatEpochs?: Volatile<Record<string, string> | undefined> | undefined
  /**
   * Managed state, not configuration: the session each conversation was
   * explicitly bound to via /session <id>, keyed by conversation key. An
   * empty-string value marks automatic derivation (the override was reset).
   */
  chatSessions?: Volatile<Record<string, string> | undefined> | undefined
  /** Provider route override for chat agents; defaults to the host `agentDefaultModel` selection. */
  provider?: string
  /** Model id override for chat agents; defaults to the host `agentDefaultModel` selection. */
  model?: string
  /**
   * Agent preset chat agents join, when the deployment composes a roster.
   * Absent joins the roster default. A deployment WITH a roster keeps every
   * model-facing row on the agent plane, so joining nothing would reach the
   * model with no tools at all.
   */
  preset?: string
  /**
   * Which conversation facet owns one agent session. The session id is derived
   * from that facet alone, so a restarted process reaches the conversation's
   * stored session instead of starting it over. `chat` gives a group one shared
   * agent; `chat-thread` gives each topic thread its own, so parallel topics
   * stop overwriting each other's context; `chat-sender` gives each person in a
   * shared chat their own.
   */
  sessionScope?: SessionScope
  /**
   * How assistant output reaches the chat. `cot` (default) shows the process as
   * a native thinking-process message — reasoning, tool calls with icons,
   * results as code — and sends the answer as an ordinary message, which is
   * where the platform says a final answer belongs. It needs a client new
   * enough to render one (PC 7.70, mobile 7.74); `stream` keeps the whole turn
   * in one typewriter card, for clients older than that surface.
   */
  output?: 'cot' | 'stream'
  /**
   * Show what the agent did on its way to an answer: its reasoning and the
   * tools it called. Off sends the answer alone.
   */
  showProcess?: boolean
  /**
   * Pass images a chat sends on to the model.
   *
   * Off by default, and deliberately: a route that cannot take images rejects
   * the whole request, the image is already in the session log by then, and
   * every later turn resends it — so one screenshot ends the conversation for
   * good, with no way back from the chat, because compaction sends that history
   * too. The host exposes no way to ask a route whether it accepts images, so
   * the deployment that knows its route is a vision one says so here.
   *
   * This is the division of labour with {@link receiveFiles}: this field says
   * whether an image's bytes reach the model's context, where token cost and
   * pixel-borne prompt injection are the things to weigh; {@link receiveFiles}
   * says whether the file behind any attachment — images included — lands on
   * disk so the agent has a path to it, with the content never entering
   * context either way. That split is also why there is no `attachFiles`:
   * attaching and landing are different operations with different risk
   * profiles, and one name should not paper over both.
   */
  attachImages?: boolean
  /**
   * Save files a chat sends into `.dsh-lark/inbox/` under the current
   * conversation's workspace, so the agent gets a path to work with instead
   * of a resource descriptor it has no way to read.
   *
   * On by default: a file's bytes never enter the model's context this way —
   * only its path does — so turning this on does not widen what the model can
   * see or do. It only fixes a worse status quo, where the transport already
   * tells the model a file's name and leaves it with no way to reach the
   * content behind it.
   */
  receiveFiles?: boolean
  /**
   * Ceiling, in bytes, on one inbound file; a file over it is discarded
   * rather than landed anyway.
   *
   * A whole message's total is capped too, at three times this number — a
   * message shipping twenty files each just under the per-file limit would
   * otherwise write twenty times as much to disk in one shot. That multiplier
   * is not its own setting: its only reason to exist is to track this one, so
   * letting it drift on its own would just reopen the same hole from a
   * different angle.
   */
  maxReceiveFileBytes?: number
  /**
   * Let chat agents send files out of their workspace back into the chat on
   * their own initiative.
   *
   * On by default: the risk this would otherwise carry is already handled
   * structurally rather than left for a deployment to opt into — a direct
   * message reaches only the person whose authorization is driving the agent,
   * so there is no exfiltration boundary to cross, while a group chat instead
   * gets an approval card on every send. A gate that only takes effect once a
   * deployment remembers to flip it is not a gate at all. There is
   * deliberately no setting here to turn the group approval off: that would
   * be an official back door for a prompt-injection exfiltration chain.
   */
  sendFiles?: boolean
  /**
   * Ceiling, in bytes, on one outbound file.
   *
   * An outbound file is read whole into a `Buffer` before the SDK ever sees
   * it, rather than handed over by path, so this number bounds how much of
   * the process's heap one send can claim — it is a memory safety limit
   * first, and only a courtesy to the recipient second.
   */
  maxSendFileBytes?: number
  /**
   * Let the platform drop the process once its run finishes, leaving only the
   * answer in the conversation. `cot` output only.
   */
  hideProcessWhenDone?: boolean
  /**
   * Register this channel's commands on the bot so Feishu offers them when a
   * user types `/`. Reconciling: the panel ends up offering exactly what this
   * channel accepts, so an entry it no longer offers is removed rather than
   * left to answer "unknown command". Off means commands still work, typed
   * from memory, and a hand-curated panel is left untouched.
   */
  syncSlashCommands?: boolean
  /**
   * Tools chat agents may not call, denied per agent at execution with a
   * reason that redirects the model to the chat.
   *
   * The default names the two human-interaction tools whose answers cannot
   * reach this channel: `ctx.userQuestions` admits ONE provider per context,
   * so when any other UI registered it (the Web app's BFF claims every
   * agent-owned question) a chat agent's question would wait on a surface its
   * human is not watching. Asking in the chat is the native equivalent — a
   * reply is an ordinary message this bridge already turns into the next turn.
   */
  denyTools?: string[]
  /**
   * Bot open ids this channel answers, when a deployment wants only certain
   * ones. Empty — the default — narrows nothing, exactly like every other list
   * here: a bot someone added to a room this channel already serves is part of
   * that room's arrangement. {@link botHops} is what bounds the exchange.
   */
  botPeers?: string[]
  /**
   * Consecutive bot-sourced turns one conversation may run before this channel
   * stops answering. A human message refills it. Without a bound, two agents
   * answer each other until someone notices the bill.
   */
  botHops?: number
  /** In group chats, only respond when the bot is @-mentioned. */
  requireMention?: boolean
  /**
   * Open ids (`ou_…`) allowed to send direct messages, when a deployment wants
   * to narrow them further. Empty serves anyone who can reach the bot at all,
   * which the platform already decides: an app's visibility scope is what says
   * who in the tenant may open a conversation with it, and that decision
   * belongs in the developer console rather than duplicated here.
   */
  senderAllowlist?: string[]
  /**
   * When non-empty, only these group chat ids (`oc_…`) are served. Empty serves
   * any group the bot is added to. Group members are NOT gated individually:
   * a group is a room someone deliberately put the bot in, so the gate that
   * matters is which rooms, and {@link requireMention} decides what counts as
   * addressing it.
   */
  groupAllowlist?: string[]
  /**
   * Open ids (`ou_…`) allowed to answer approval questions. Empty lets whoever
   * may drive that chat answer it too, which in a group is the room; the
   * settled card names who decided either way. When the callback omits a name,
   * the channel may best-effort resolve it from the chat roster and safely
   * falls back to the open id. Set this when an escalation should need a named
   * human — it grants more power than the sandbox allows.
   */
  approvers?: string[]
}

/**
 * Loader-visible configuration schema and defaults.
 *
 * The fields the settings service writes back — this row's app id, the
 * credential reference holding its secret, and the per-conversation state —
 * are `volatile`: the Loader hands a changed value to the running plugin
 * without remounting it, which is what lets a `/cd` or a completed scan reach
 * disk and still take effect in the same process. Everything hand-configured
 * stays ordinary, so a configuration form keeps editing it by restart.
 *
 * The input side is annotated `any` because a schema's accepted input is not
 * the shape it produces: every optional field also admits `null`, which this
 * plugin's own type does not, and naming that union here would document a
 * contract nobody wants. The output side is {@link RawConfig}, which is
 * checked.
 */
export const Config: z<any, RawConfig> = z.object({
  instance: z.string(),
  appId: z.string().volatile(),
  appSecret: z.string().role('secret').volatile(),
  appSecretRef: z.string().volatile(),
  registeredBy: z.string().volatile(),
  domain: z.string(),
  cwd: z.string(),
  workspaceRoots: z.array(String),
  chatWorkspaces: z.dict(String).default({}).volatile(),
  chatModels: z.dict(String).default({}).volatile(),
  chatEpochs: z.dict(String).default({}).volatile(),
  chatSessions: z.dict(String).default({}).volatile(),
  provider: z.string(),
  model: z.string(),
  preset: z.string(),
  sessionScope: z.union(['chat', 'chat-thread', 'chat-sender'] as const).default('chat'),
  output: z.union(['cot', 'stream'] as const).default('cot'),
  showProcess: z.boolean().default(true),
  attachImages: z.boolean().default(false),
  receiveFiles: z.boolean().default(true),
  maxReceiveFileBytes: z.number().default(20 * 1024 * 1024),
  sendFiles: z.boolean().default(true),
  maxSendFileBytes: z.number().default(20 * 1024 * 1024),
  hideProcessWhenDone: z.boolean().default(false),
  syncSlashCommands: z.boolean().default(true),
  denyTools: z.array(String).default([...DEFAULT_DENY_TOOLS]),
  botPeers: z.array(String).default([]),
  botHops: z.number().default(DEFAULT_BOT_HOPS),
  requireMention: z.boolean().default(true),
  senderAllowlist: z.array(String),
  groupAllowlist: z.array(String),
  approvers: z.array(String),
})

/**
 * Plugin configuration as it reaches this plugin: {@link Config}'s validation
 * output, which is {@link RawConfig} with every optional field present and
 * every volatile field a live reference.
 *
 * This is what {@link apply} receives.
 */
export type ValidatedConfig = Required<RawConfig>

/**
 * A configuration a caller assembled itself: a document's own values, or one
 * this plugin's tests write out by hand. A volatile field is given as the value
 * itself, which is how a person writes it in a profile patch.
 */
export type PlainConfig = {
  [K in keyof RawConfig]: K extends VolatileFields
    ? NonNullable<RawConfig[K]> extends Volatile<infer V> ? V | undefined : never
    : RawConfig[K]
}

/** Configuration after defaults have been resolved; credentials may still be pending onboarding. */
export interface ResolvedConfig {
  instance?: string | undefined
  appId?: string | undefined
  appSecret?: string | undefined
  appSecretRef?: string | undefined
  registeredBy?: string | undefined
  domain?: string | undefined
  cwd?: string | undefined
  workspaceRoots: string[]
  chatWorkspaces: Readonly<Record<string, string>>
  chatModels: Readonly<Record<string, string>>
  chatEpochs: Readonly<Record<string, string>>
  chatSessions: Readonly<Record<string, string>>
  provider?: string | undefined
  model?: string | undefined
  preset?: string | undefined
  sessionScope: SessionScope
  output: 'cot' | 'stream'
  showProcess: boolean
  attachImages: boolean
  receiveFiles: boolean
  maxReceiveFileBytes: number
  sendFiles: boolean
  maxSendFileBytes: number
  hideProcessWhenDone: boolean
  syncSlashCommands: boolean
  denyTools: string[]
  botPeers: string[]
  botHops: number
  requireMention: boolean
  senderAllowlist: string[]
  groupAllowlist: string[]
  approvers: string[]
}

/**
 * Read one volatile field as the value it currently holds.
 *
 * A volatile field is a live reference, so a reader that captured the snapshot
 * would keep serving the value the process booted with. Everything downstream
 * of {@link resolveConfig} works on snapshots: the in-memory maps the chat
 * commands maintain are the authority between boots, and this plugin writes
 * through to the profile rather than reading it back mid-flight.
 * @param field - the field's current value, reference or plain.
 * @returns the value itself, or undefined when the field is absent.
 */
function dereference<T>(field: Volatile<T> | T | undefined): T | undefined {
  if (typeof field === 'object' && field !== null && 'get' in field && typeof field.get === 'function') {
    return (field as Volatile<T>).get() as T | undefined
  }
  return field as T | undefined
}

/**
 * Resolve the same defaults for direct callers that bypass Cordis Loader.
 * @param config - Configuration from the Loader, or a hand-written one whose
 *   volatile fields may be given as plain values.
 * @returns Configuration with all schema defaults applied and every volatile
 *   field replaced by its current value.
 */
export function resolveConfig(config: RawConfig | PlainConfig): ResolvedConfig {
  return {
    ...config,
    appId: dereference(config.appId),
    appSecret: dereference(config.appSecret),
    appSecretRef: dereference(config.appSecretRef),
    registeredBy: dereference(config.registeredBy),
    workspaceRoots: config.workspaceRoots ?? [],
    chatWorkspaces: dereference(config.chatWorkspaces) ?? {},
    chatModels: dereference(config.chatModels) ?? {},
    chatEpochs: dereference(config.chatEpochs) ?? {},
    chatSessions: dereference(config.chatSessions) ?? {},
    sessionScope: config.sessionScope ?? 'chat',
    output: config.output ?? 'cot',
    showProcess: config.showProcess ?? true,
    attachImages: config.attachImages ?? false,
    receiveFiles: config.receiveFiles ?? true,
    maxReceiveFileBytes: config.maxReceiveFileBytes ?? 20 * 1024 * 1024,
    sendFiles: config.sendFiles ?? true,
    maxSendFileBytes: config.maxSendFileBytes ?? 20 * 1024 * 1024,
    hideProcessWhenDone: config.hideProcessWhenDone ?? false,
    syncSlashCommands: config.syncSlashCommands ?? true,
    denyTools: config.denyTools ?? [...DEFAULT_DENY_TOOLS],
    botPeers: config.botPeers ?? [],
    botHops: config.botHops ?? DEFAULT_BOT_HOPS,
    requireMention: config.requireMention ?? true,
    senderAllowlist: config.senderAllowlist ?? [],
    groupAllowlist: config.groupAllowlist ?? [],
    approvers: config.approvers ?? [],
  }
}
