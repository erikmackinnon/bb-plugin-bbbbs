import { z } from "zod";
import { HANDLE_RULE, PASSWORD_RULE } from "./messages";

export const DEFAULT_SERVER_URL = "wss://bbs.gravytrain.ca/v1/term";
export const DEV_SERVER_URL = "ws://localhost:8023/v1/term";

export const serverUrlSchema = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return (url.protocol === "wss:" || (url.protocol === "ws:" && local))
      && !url.username && !url.password && !url.hash && !url.search
      && url.pathname === "/v1/term";
  } catch { return false; }
}, "Use wss://…/v1/term, or ws://localhost:8023/v1/term for development.");

export const handleSchema = z.string().max(20).refine(
  (value) => value === "" || /^[A-Za-z0-9_-]{2,20}$/.test(value), HANDLE_RULE,
);
export const zoomSchema = z.number().int().refine((value) => value === 0 || (value >= 10 && value <= 96), "Use 0 (fit) or 10–96.");
export const passwordSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, PASSWORD_RULE);

export const settingDescriptors = {
  serverUrl: { type: "string", label: "Server URL", default: DEFAULT_SERVER_URL, experimental_schema: serverUrlSchema },
  handle: { type: "string", label: "Handle", default: "", experimental_schema: handleSchema },
  secret: { type: "string", label: "Recovery password", secret: true, description: "Generated on first open. To recover an account, enter its handle and saved recovery password.", experimental_schema: passwordSchema },
  allowAgents: { type: "boolean", label: "Allow my agents into the BBS", default: false, description: "Agents use a separate .bot account. Chat is limited to one line per 30 seconds; board posts are disabled." },
  crt: { type: "boolean", label: "CRT effects", default: true },
  sound: { type: "boolean", label: "Modem sound", default: false },
  zoom: {
    type: "number", label: "Terminal zoom", default: 0,
    description: "0 fits the pane. Otherwise the terminal font size in pixels (10–96), set with A−/A+ on the terminal.",
    experimental_schema: zoomSchema,
  },
} as const;

export interface AccountSettings {
  serverUrl: string;
  handle: string;
  secret?: string;
  allowAgents: boolean;
  crt: boolean;
  sound: boolean;
  zoom: number;
}

export interface SettingsStore {
  get(): Promise<AccountSettings>;
  save(values: Partial<AccountSettings>): Promise<void>;
  recoveryPending(): Promise<boolean>;
  setRecoveryPending(value: boolean): Promise<void>;
  /** A drop after the register hello and before `registered`: the secret may already own an account. */
  registrationInterrupted(): Promise<boolean>;
  setRegistrationInterrupted(value: boolean): Promise<void>;
}
