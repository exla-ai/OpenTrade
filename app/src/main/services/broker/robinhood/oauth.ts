import { eq } from "drizzle-orm";
import type { Db } from "../../../db/client";
import { settings } from "../../../db/schema";

/**
 * Read/write the settings kv. Values are stored as plaintext JSON: the backend
 * runs headless under ELECTRON_RUN_AS_NODE where Electron `safeStorage` is
 * unavailable. Confidentiality rests on the DB file + ~/.opentrade being 0600;
 * OS-keychain encryption is noted as future hardening.
 */
class SecureStore {
  constructor(private db: Db) {}

  private raw(key: string): string | undefined {
    return this.db.select().from(settings).where(eq(settings.key, key)).get()?.value;
  }

  private put(key: string, value: string) {
    this.db
      .insert(settings)
      .values({ key, value })
      .onConflictDoUpdate({ target: settings.key, set: { value } })
      .run();
  }

  getSecret<T>(key: string): T | undefined {
    const stored = this.raw(key);
    if (!stored) return undefined;
    try {
      return JSON.parse(stored) as T;
    } catch {
      return undefined;
    }
  }

  setSecret(key: string, value: unknown) {
    this.put(key, JSON.stringify(value));
  }

  clear(key: string) {
    this.db.delete(settings).where(eq(settings.key, key)).run();
  }
}

// OAuth provider state keys.
const K_TOKENS = "rh_oauth_tokens";
const K_CLIENT = "rh_oauth_client";
const K_VERIFIER = "rh_oauth_verifier";

// Minimal structural types mirroring the MCP SDK's OAuth shapes (avoids a hard
// type import; the SDK validates these at runtime).
interface OAuthTokens {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}
interface OAuthClientInformation {
  client_id: string;
  client_secret?: string;
  [k: string]: unknown;
}

export interface OAuthProviderOptions {
  db: Db;
  redirectUrl: string;
  /** Open the consent URL in the user's browser. */
  openBrowser: (url: string) => void;
}

/**
 * App-side OAuthClientProvider for the Robinhood MCP: dynamic client
 * registration + loopback redirect + PKCE, with tokens/client-info persisted as
 * plaintext in the app DB (0600; no safeStorage under ELECTRON_RUN_AS_NODE — see
 * SecureStore). Shape matches the MCP SDK's OAuthClientProvider.
 */
export class BrokerOAuthProvider {
  private store: SecureStore;

  constructor(private opts: OAuthProviderOptions) {
    this.store = new SecureStore(opts.db);
  }

  get redirectUrl(): string {
    return this.opts.redirectUrl;
  }

  get clientMetadata() {
    return {
      client_name: "OpenTrade (read-only portfolio client)",
      redirect_uris: [this.opts.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "read",
    };
  }

  state() {
    return "opentrade";
  }

  clientInformation(): OAuthClientInformation | undefined {
    return this.store.getSecret<OAuthClientInformation>(K_CLIENT);
  }

  saveClientInformation(info: OAuthClientInformation) {
    this.store.setSecret(K_CLIENT, info);
  }

  tokens(): OAuthTokens | undefined {
    return this.store.getSecret<OAuthTokens>(K_TOKENS);
  }

  saveTokens(tokens: OAuthTokens) {
    this.store.setSecret(K_TOKENS, tokens);
  }

  redirectToAuthorization(url: URL) {
    this.opts.openBrowser(url.toString());
  }

  saveCodeVerifier(verifier: string) {
    this.store.setSecret(K_VERIFIER, verifier);
  }

  codeVerifier(): string {
    const v = this.store.getSecret<string>(K_VERIFIER);
    if (!v) throw new Error("missing PKCE code verifier");
    return v;
  }

  hasTokens(): boolean {
    return this.tokens() !== undefined;
  }

  reset() {
    this.store.clear(K_TOKENS);
    this.store.clear(K_CLIENT);
    this.store.clear(K_VERIFIER);
  }
}
