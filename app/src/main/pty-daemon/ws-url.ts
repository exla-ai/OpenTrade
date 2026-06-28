// Terminal WebSocket URL format, shared by the daemon (parse) and the main
// process (build). Kept dependency-free (no `ws` import) so importing the
// builder into the main process doesn't drag the WebSocket server into that
// bundle. The path/query shape (`/sessions/<id>?token=&replay=`) is part of
// the contract a cloud terminal host implements.

export interface ParsedTerminalWsUrl {
  id: string;
  token: string;
  replay: boolean;
}

/** Parse an incoming upgrade request URL. Returns null if it isn't ours. */
export function parseTerminalWsUrl(reqUrl: string | undefined): ParsedTerminalWsUrl | null {
  if (!reqUrl) return null;
  let url: URL;
  try {
    url = new URL(reqUrl, "http://localhost");
  } catch {
    return null;
  }
  const match = url.pathname.match(/^\/sessions\/(.+)$/);
  if (!match) return null;
  return {
    id: decodeURIComponent(match[1]),
    token: url.searchParams.get("token") ?? "",
    replay: url.searchParams.get("replay") === "1",
  };
}

/** Build the endpoint URL for a session. `base` is e.g. `ws://127.0.0.1:1234`. */
export function buildTerminalWsUrl(
  base: string,
  agentId: string,
  token: string,
  replay = true,
): string {
  const q = new URLSearchParams({ token });
  if (replay) q.set("replay", "1");
  return `${base}/sessions/${encodeURIComponent(agentId)}?${q.toString()}`;
}
