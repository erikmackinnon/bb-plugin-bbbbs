import { randomBytes, timingSafeEqual } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { SessionManager } from "./src/session-manager";
import { handleSchema, passwordSchema, settingDescriptors, zoomSchema } from "./src/settings";
import type { AccountSettings } from "./src/settings";

export const rpcContract = defineRpcContract({
  account: {
    input: z.null(),
    output: z.object({ serverUrl: z.string(), handle: z.string(), hasCredential: z.boolean(), allowAgents: z.boolean(), crt: z.boolean(), sound: z.boolean(), zoom: z.number() }).strict(),
  },
  recover: {
    // Field formats are checked by the handler so each failure comes back as a distinct `error` the app can explain.
    // `replaceUnsaved` needs `confirmToken`, which only the app's terminal socket receives: agents and the CLI can't discard an unsaved account.
    input: z.object({ handle: z.string().max(256), password: z.string().max(256), replaceUnsaved: z.boolean().optional(), confirmToken: z.string().max(64).optional() }).strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), handle: z.string() }).strict(),
      z.object({ ok: z.literal(false), error: z.enum(["invalid-handle", "invalid-password", "unsaved-account", "caller-not-allowed"]) }).strict(),
    ]),
  },
  recoveryPassword: {
    // Lets the user see their password again from the app or CLI. Other plugins are refused.
    input: z.null(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), handle: z.string(), password: z.string() }).strict(),
      z.object({ ok: z.literal(false), error: z.enum(["no-account", "caller-not-allowed"]) }).strict(),
    ]),
  },
  startNewAccount: {
    // Way out of an interrupted registration: forget this bb's credentials so the next open registers afresh.
    input: z.object({ replaceUnsaved: z.boolean().optional(), confirmToken: z.string().max(64).optional() }).strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true) }).strict(),
      z.object({ ok: z.literal(false), error: z.enum(["unsaved-account", "caller-not-allowed"]) }).strict(),
    ]),
  },
  appearance: {
    input: z.object({ crt: z.boolean().optional(), sound: z.boolean().optional(), zoom: zoomSchema.optional() }).strict(),
    output: z.object({ crt: z.boolean(), sound: z.boolean(), zoom: z.number() }).strict(),
  },
});

const RECOVERY_PENDING_KEY = "recovery-pending";
const REGISTRATION_INTERRUPTED_KEY = "registration-interrupted";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define(settingDescriptors);
  let allowAgents = (await settings.get()).allowAgents;
  // Credential values the plugin wrote itself, recent first per key. Recorded before each write and kept
  // afterwards: bb may deliver onChange after the write resolves, and overlapping writes may notify late.
  const credentials = ["serverUrl", "handle", "secret"] as const;
  type Credential = (typeof credentials)[number];
  const own = new Map<Credential, unknown[]>();
  const isOwn = (key: Credential, value: unknown) => own.get(key)?.includes(value) ?? false;
  // `null` unsets a stored value; the effective value is then the default.
  const write = async (values: { [K in keyof AccountSettings]?: AccountSettings[K] | null }) => {
    const written = credentials.filter((key) => key in values).map((key) => {
      const value = values[key] ?? undefined;
      own.set(key, [value, ...(own.get(key) ?? [])].slice(0, 8));
      return [key, value] as const;
    });
    // A write that never landed must not count as the plugin's own.
    try { return await settings.experimental_set(values); } catch (error) {
      for (const [key, value] of written) {
        const recorded = own.get(key) ?? [];
        const at = recorded.indexOf(value);
        if (at >= 0) recorded.splice(at, 1);
      }
      throw error;
    }
  };
  const clearRecoveryFlags = async () => {
    await bb.storage.kv.set(RECOVERY_PENDING_KEY, false);
    await bb.storage.kv.set(REGISTRATION_INTERRUPTED_KEY, false);
  };
  // Per process; reaches only views attached to the local-auth terminal socket.
  const confirmToken = randomBytes(24).toString("base64url");
  const confirmed = (replaceUnsaved?: boolean, token?: string) =>
    !!replaceUnsaved && !!token && token.length === confirmToken.length && timingSafeEqual(Buffer.from(token), Buffer.from(confirmToken));
  const unsavedAccount = async (replaceUnsaved?: boolean, token?: string) => !confirmed(replaceUnsaved, token) && !!await bb.storage.kv.get<boolean>(RECOVERY_PENDING_KEY);
  const manager = new SessionManager({
    get: () => settings.get(),
    async save(values) { await write(values); },
    async recoveryPending() { return (await bb.storage.kv.get<boolean>(RECOVERY_PENDING_KEY)) ?? false; },
    async setRecoveryPending(value) { await bb.storage.kv.set(RECOVERY_PENDING_KEY, value); },
    async registrationInterrupted() { return (await bb.storage.kv.get<boolean>(REGISTRATION_INTERRUPTED_KEY)) ?? false; },
    async setRegistrationInterrupted(value) { await bb.storage.kv.set(REGISTRATION_INTERRUPTED_KEY, value); },
  }, confirmToken);

  settings.onChange((next, previous) => {
    allowAgents = next.allowAgents;
    if (!next.allowAgents) manager.resetAgents();
    const external = credentials.filter((key) => next[key] !== previous[key] && !isOwn(key, next[key]));
    if (external.length) {
      for (const key of external) own.delete(key);
      manager.resetAll();
      void clearRecoveryFlags().catch(() => {});
    }
    bb.realtime.publish("account-changed", { handle: next.handle, allowAgents: next.allowAgents });
  });
  bb.rpc.register(rpcContract, {
    async account() {
      const account = await settings.get();
      return { serverUrl: account.serverUrl, handle: account.handle, hasCredential: !!account.secret, allowAgents: account.allowAgents, crt: account.crt, sound: account.sound, zoom: account.zoom };
    },
    async recover({ handle: input, password, replaceUnsaved, confirmToken: token }, { experimental_caller }) {
      const handle = input.trim();
      // Other plugins may never swap credentials. Discarding an unsaved account needs the app's confirm token.
      // Recovering with the unsaved account's own password discards nothing (e.g. after an interrupted registration).
      if (experimental_caller.kind === "plugin") return { ok: false, error: "caller-not-allowed" } as const;
      if (!handleSchema.min(1).safeParse(handle).success) return { ok: false, error: "invalid-handle" } as const;
      if (!passwordSchema.safeParse(password).success) return { ok: false, error: "invalid-password" } as const;
      if (password !== (await settings.get()).secret && await unsavedAccount(replaceUnsaved, token)) return { ok: false, error: "unsaved-account" } as const;
      manager.resetAll();
      await write({ handle, secret: password });
      await clearRecoveryFlags();
      return { ok: true, handle } as const;
    },
    async recoveryPassword(_input, { experimental_caller }) {
      if (experimental_caller.kind === "plugin") return { ok: false, error: "caller-not-allowed" } as const;
      const { handle, secret } = await settings.get();
      return secret ? { ok: true, handle, password: secret } as const : { ok: false, error: "no-account" } as const;
    },
    async startNewAccount({ replaceUnsaved, confirmToken: token }, { experimental_caller }) {
      if (experimental_caller.kind === "plugin") return { ok: false, error: "caller-not-allowed" } as const;
      if (await unsavedAccount(replaceUnsaved, token)) return { ok: false, error: "unsaved-account" } as const;
      manager.resetAll();
      await write({ handle: "", secret: null });
      await clearRecoveryFlags();
      return { ok: true } as const;
    },
    async appearance(input) {
      const account = await settings.experimental_set(input);
      return { crt: account.crt, sound: account.sound, zoom: account.zoom };
    },
  });
  bb.http.experimental_websocket("/terminal", () => ({
    onOpen: (socket) => manager.attach(socket),
    onMessage: (socket, data) => manager.receive(socket, data),
    onClose: (socket) => manager.detach(socket),
    onError: (socket) => manager.detach(socket),
  }), { auth: "local" });

  bb.agents.registerTool({
    name: "bbs_screen",
    description: "Read your separate 80×25 BBS bot terminal: plain text, cursor, and whether the screen changed since your last read. Requires owner opt-in.",
    parameters: z.object({}).strict(),
    async execute(_input, { threadId, signal }) { return JSON.stringify(await manager.agentScreen(threadId, signal)); },
  });
  bb.agents.registerTool({
    name: "bbs_keys",
    description: "Send literal text then named keys to your separate BBS bot session. Keys: Enter, Esc, arrows, Backspace, Tab, Home, End, Delete, PageUp/PageDown, Ctrl-A…Ctrl-Z. waitMs: 0–5000 for output to settle. No spam: 1 chat line/30 s, no board posts.",
    parameters: z.object({ text: z.string().max(4096).optional(), keys: z.array(z.string().max(32)).max(64).optional(), waitMs: z.number().int().min(0).max(5000).default(250) }).strict(),
    async execute(input, { threadId, signal }) { return JSON.stringify(await manager.agentKeys(threadId, input, signal)); },
  });
  bb.agents.configure(() => allowAgents
    ? { tools: ["bbs_screen", "bbs_keys"], skills: ["bbbbs"], instructions: "Each BBS thread uses its own assigned bot slot (<handle>.bot, <handle>.bot2, <handle>.bot3, and so on). The server allows 3 concurrent slots per owner by default; the plugin bounds local sessions to 8. Reconnect may assign a different slot: read the current screen before typing. All your owner's bot slots share one chat line per 30 seconds; never post to boards. Agent capacity errors are final with no automatic retry; report full and wait for a free slot." }
    : { tools: [], skills: [] });
  bb.events.on("thread.archived", ({ thread }) => manager.closeAgent(thread.id));
  bb.events.on("thread.deleted", ({ thread }) => manager.closeAgent(thread.id));
  bb.onDispose(() => manager.dispose());
}
