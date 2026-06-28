import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildAgentEnv } from "../../services/terminal/env";
import { publicProcedure, router } from "../trpc";

const execFileAsync = promisify(execFile);

async function probeClaude(): Promise<{ found: boolean; version: string | null }> {
  try {
    // Use the same PATH agents get, so we find `claude` wherever it lives.
    const env = buildAgentEnv("onboarding");
    const { stdout } = await execFileAsync("claude", ["--version"], { env, timeout: 5000 });
    return { found: true, version: stdout.trim() };
  } catch {
    return { found: false, version: null };
  }
}

export const onboardingRouter = router({
  state: publicProcedure.query(async ({ ctx }) => {
    const claude = await probeClaude();
    return {
      claude,
      brokerStatus: ctx.broker.getStatus(),
      brokerAuthorized: ctx.broker.isAuthorized(),
      brokerAccount: ctx.broker.getAccount(),
    };
  }),

  checkClaudeCli: publicProcedure.query(() => probeClaude()),

  /** Runs the Robinhood OAuth consent flow (opens browser) and starts polling. */
  connectBroker: publicProcedure.mutation(async ({ ctx }) => {
    await ctx.broker.connect();
    return { status: ctx.broker.getStatus(), account: ctx.broker.getAccount() };
  }),
});
