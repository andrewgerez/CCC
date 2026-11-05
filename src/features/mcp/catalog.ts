/** One-click MCP servers. "oauth" ones sign in through the browser (`claude mcp login`);
 *  "key" ones need a token pasted once. URLs are the vendors' official hosted endpoints. */
export interface CatalogField {
  key: string;
  label: string;
  placeholder: string;
  secret?: boolean;
  initial?: string;
}

export interface CatalogItem {
  id: string;
  /** Server name written to the account config. */
  name: string;
  title: string;
  description: string;
  /** Tile colours: background, foreground. */
  color: [string, string];
  monogram: string;
  auth: "oauth" | "key" | "none";
  fields?: CatalogField[];
  /** Where to create the token, for "key" servers. */
  keyHelp?: { label: string; url: string };
  build: (v: Record<string, string>) => Record<string, unknown>;
  unavailable?: string;
}

const http = (url: string, headers?: Record<string, string>) => ({ type: "http", url, ...(headers ? { headers } : {}) });

/** True when an installed server no longer matches the catalog entry (e.g. a vendor moved its endpoint).
 *  Entries with user-specific fields (GitLab host) are never flagged. */
export function isOutdated(item: CatalogItem, installed: { transport: string; target: string }): boolean {
  if (item.unavailable || item.fields?.some((f) => !f.secret)) return false;
  const v = Object.fromEntries((item.fields ?? []).map((f) => [f.key, "x"]));
  const cfg = item.build(v) as { type?: string; url?: string };
  return cfg.type !== installed.transport || cfg.url !== installed.target;
}

export const CATALOG: CatalogItem[] = [
  {
    id: "monday", name: "monday", title: "monday.com", description: "Boards, itens, updates e docs",
    color: ["#ffe9ec", "#e2445c"], monogram: "m", auth: "oauth",
    build: () => http("https://mcp.monday.com/mcp"),
  },
  {
    id: "atlassian", name: "atlassian", title: "Jira e Confluence", description: "Issues, sprints e páginas (Atlassian Cloud)",
    color: ["#e6efff", "#0c66e4"], monogram: "J", auth: "oauth",
    // v1 (/v1/sse, HTTP+SSE) is being phased out by Atlassian; v2 is Streamable HTTP.
    build: () => http("https://mcp.atlassian.com/v2/mcp"),
  },
  {
    id: "gitlab", name: "gitlab", title: "GitLab", description: "Projetos, merge requests e pipelines",
    color: ["#fff0e8", "#e24329"], monogram: "GL", auth: "oauth",
    fields: [{ key: "host", label: "Instância", placeholder: "gitlab.com", initial: "gitlab.com" }],
    build: (v) => http(`https://${(v.host || "gitlab.com").replace(/^https?:\/\//, "").replace(/\/+$/, "")}/api/v4/mcp`),
  },
  {
    id: "github", name: "github", title: "GitHub", description: "Repos, issues, PRs e Actions",
    color: ["#eeeeec", "#1f2328"], monogram: "GH", auth: "key",
    fields: [{ key: "token", label: "Personal access token", placeholder: "github_pat_…", secret: true }],
    keyHelp: { label: "Criar token no GitHub", url: "https://github.com/settings/personal-access-tokens/new" },
    build: (v) => http("https://api.githubcopilot.com/mcp/", { Authorization: `Bearer ${v.token.trim()}` }),
  },
  {
    id: "sentry", name: "sentry", title: "Sentry", description: "Erros, issues e performance",
    color: ["#f1ecf8", "#584774"], monogram: "S", auth: "oauth",
    build: () => http("https://mcp.sentry.dev/mcp"),
  },
  {
    id: "linear", name: "linear", title: "Linear", description: "Issues, projetos e ciclos",
    color: ["#eef0fd", "#5e6ad2"], monogram: "L", auth: "oauth",
    build: () => http("https://mcp.linear.app/mcp"),
  },
  {
    id: "notion", name: "notion", title: "Notion", description: "Páginas e bancos do workspace",
    color: ["#f1f1ef", "#191919"], monogram: "N", auth: "oauth",
    build: () => http("https://mcp.notion.com/mcp"),
  },
  {
    id: "bitmovin", name: "bitmovin-encoding", title: "Bitmovin Encoding", description: "Encodings e configurações (somente leitura)",
    color: ["#e8f6fd", "#1fabe2"], monogram: "B", auth: "key",
    fields: [{ key: "key", label: "API key", placeholder: "Dashboard › Account › API Keys", secret: true }],
    keyHelp: { label: "Abrir Bitmovin Dashboard", url: "https://dashboard.bitmovin.com/" },
    build: (v) => http("https://agentic.bitmovin.com/encoding/mcp", { "x-api-key": v.key.trim() }),
  },
  {
    id: "bitmovin-docs", name: "bitmovin-docs", title: "Bitmovin Docs", description: "Documentação e exemplos públicos",
    color: ["#e8f6fd", "#1fabe2"], monogram: "BD", auth: "none",
    build: () => http("https://agentic.bitmovin.com/documentation/mcp"),
  },
  {
    id: "teams", name: "teams", title: "Microsoft Teams", description: "Chats e canais",
    color: ["#eeeffb", "#4b53bc"], monogram: "T", auth: "oauth",
    unavailable: "A Microsoft ainda não tem um servidor MCP oficial para o Teams.",
    build: () => ({}),
  },
];
