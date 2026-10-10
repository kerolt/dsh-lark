// Appended to the channel bundle by scripts/e2e-hooks.mjs: a transport that
// reaches nothing, and an app-registration flow that returns a fixed pair, so
// the boot exercises persistence without a live Lark connection.
process.stderr.write(`[stub] installing fake transport: ${Object.keys(internals).join(',')}\n`)
internals.createPort = (config) => {
  process.stderr.write(`[stub] createPort called for ${String(config.appId)}\n`)
  return {
    connect: async () => {},
    disconnect: async () => {},
    send: async () => ({ messageId: 'om_stub' }),
    stream: async () => ({ messageId: 'om_stub' }),
    updateCard: async () => {},
    listSlashCommands: async () => [],
    createSlashCommand: async () => {},
    deleteSlashCommand: async () => {},
    createCot: async () => ({ cotId: 'cot', messageId: 'om_stub' }),
    writeCotEvents: async () => {},
    downloadResourceToFile: async () => ({ bytesWritten: 0 }),
    downloadResourceWithMeta: async () => ({ buffer: new Uint8Array() }),
    on: () => () => {},
  }
}
internals.registerApp = async () => ({ client_id: 'cli_e2e', client_secret: 'e2e-secret', user_info: { open_id: 'ou_e2e_scanner' } })
internals.reissueFloorMs = 0
internals.notify = (line) => process.stderr.write(`[notify] ${line}\n`)
