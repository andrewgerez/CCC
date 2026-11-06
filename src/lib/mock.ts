/* Browser-only IPC mock. Loaded via dynamic import ONLY when window.__TAURI_INTERNALS__ is absent.
 * Implements the same surface @tauri-apps/api uses (invoke, transformCallback, event plugin)
 * and simulates a realistic event stream so the UI can be previewed with `npm run dev`. */
import type {
  AccountConfig, AccountId, AgentNode, Approval, AuthStatus, ChatBody, ChatItem, MetricsSnapshot, Overview, RepoInfo, SessionSummary, Settings, TaskItem, UiEvent, McpServer,
} from "./contract";
import { EVENTS_CHANNEL } from "./contract";

type Cb = (payload: unknown) => void;
const callbacks = new Map<number, Cb>();
const listeners = new Map<number, { event: string; cb: number }>();
let cbSeq = 1;
let listenSeq = 1;
let seq = 1000;
const now = () => Date.now();
const HOME = "/home/you";

function emit(batch: UiEvent[]) {
  for (const [id, l] of listeners) {
    if (l.event !== EVENTS_CHANNEL) continue;
    callbacks.get(l.cb)?.({ event: EVENTS_CHANNEL, id, payload: batch });
  }
}

// ---------- fixtures ----------
const settings: Settings = { maxConcurrent: 2, idleTimeoutSecs: 45, sandboxEnforce: true, eventRetentionPerSession: 5000, includePartialMessages: true };
const toolchains = [".nvm", ".cargo", ".rustup", ".local/bin", ".gitconfig"].map((p) => `${HOME}/${p}`);
const accounts: AccountConfig[] = [
  { id: "personal", label: "Pessoal", email: "you@example.com", workspaceRoot: `${HOME}/personal`, configDir: `${HOME}/.claude-personal`, extraReadPaths: toolchains, extraWritePaths: [], defaultModel: null, defaultPermissionMode: "auto" },
  { id: "work", label: "Trabalho", email: "you@company.example", workspaceRoot: `${HOME}/work`, configDir: `${HOME}/.claude-work`, extraReadPaths: toolchains, extraWritePaths: [], defaultModel: null, defaultPermissionMode: "auto" },
];
const auth: Record<AccountId, AuthStatus> = {
  personal: { account: "personal", state: "verified", email: "you@example.com", expectedEmail: "you@example.com", orgName: null, subscription: "max", expiresAt: "2026-11-14T21:56:32Z", checkedAt: now(), message: null },
  work: { account: "work", state: "verified", email: "you@company.example", expectedEmail: "you@company.example", orgName: "Example Co", subscription: "team", expiresAt: "2026-11-25T07:55:10Z", checkedAt: now(), message: null },
};
const repos: Record<AccountId, RepoInfo[]> = {
  personal: [
    { path: `${HOME}/personal/saas/booking-app`, name: "booking-app", relPath: "saas/booking-app", branch: "feat/appointments-v2", isWorktree: false },
    { path: `${HOME}/personal/saas/newsletter`, name: "newsletter", relPath: "saas/newsletter", branch: "main", isWorktree: false },
    { path: `${HOME}/personal/saas/inventory-api`, name: "inventory-api", relPath: "saas/inventory-api", branch: "develop", isWorktree: false },
    { path: `${HOME}/personal/pdf-tools`, name: "pdf-tools", relPath: "pdf-tools", branch: "main", isWorktree: false },
  ],
  work: [
    { path: `${HOME}/work/apps/web-player`, name: "web-player", relPath: "apps/web-player", branch: "live-current-program", isWorktree: false },
    { path: `${HOME}/work/http-client`, name: "http-client", relPath: "http-client", branch: "main", isWorktree: false },
    { path: `${HOME}/work/android-app`, name: "android-app", relPath: "android-app", branch: "release/3.2", isWorktree: false },
  ],
};

function mkSession(p: Partial<SessionSummary> & Pick<SessionSummary, "id" | "account" | "repoPath" | "title" | "status">): SessionSummary {
  const name = p.repoPath.split("/").pop()!;
  return {
    repoName: name, worktreePath: null, model: "sonnet", permissionMode: "default", priority: 0,
    createdAt: now() - 3_600_000, updatedAt: now() - 60_000, lastActivity: null, totalCostUsd: 0,
    inputTokens: 0, outputTokens: 0, turns: 0, pendingApprovals: 0, lastError: null, pid: null, resumable: true, ...p,
  };
}
const sessions: Record<string, SessionSummary> = {};
const mcps: Record<AccountId, McpServer[]> = {
  work: [{ name: "sentry", transport: "http", target: "https://mcp.sentry.dev/mcp", secrets: [] }],
  personal: [],
};
const add = (s: SessionSummary) => (sessions[s.id] = s);
add(mkSession({ id: "5cb5967f-p1", account: "personal", repoPath: repos.personal[0].path, title: "Refatorar módulo de agendamentos", status: "running", createdAt: now() - 640_000, updatedAt: now(), lastActivity: "Grep · appointments", totalCostUsd: 0.4123, inputTokens: 182_400, outputTokens: 12_930, turns: 3, pid: 48211 }));
add(mkSession({ id: "a12f-p2", account: "personal", repoPath: repos.personal[1].path, title: "Corrigir paginação do tRPC", status: "idle", totalCostUsd: 0.0912, inputTokens: 40_120, outputTokens: 3_200, turns: 2, updatedAt: now() - 7_200_000 }));
add(mkSession({ id: "c77e-p3", account: "personal", repoPath: repos.personal[2].path, title: "Migrar modelos de inventário", status: "queued", priority: 1, resumable: false, updatedAt: now() - 30_000 }));
add(mkSession({ id: "9e01-w1", account: "work", repoPath: repos.work[0].path, title: "Descrição do programa atual no player", status: "awaiting_approval", pendingApprovals: 1, totalCostUsd: 0.2771, inputTokens: 98_300, outputTokens: 8_040, turns: 2, pid: 48390, updatedAt: now() - 5_000, lastActivity: "AskUserQuestion" }));
add(mkSession({ id: "3b4c-w2", account: "work", repoPath: repos.work[1].path, title: "Revisar retries do client HTTP", status: "waiting_input", totalCostUsd: 0.0533, inputTokens: 21_000, outputTokens: 1_840, turns: 1, pid: 48402, updatedAt: now() - 90_000 }));
add(mkSession({ id: "77aa-w3", account: "work", repoPath: repos.work[2].path, title: "Atualizar SDK do ExoPlayer", status: "archived", totalCostUsd: 1.204, inputTokens: 512_000, outputTokens: 40_200, turns: 9, updatedAt: now() - 86_400_000 }));

const agents: Record<string, Record<string, AgentNode>> = {};
function mkAgent(p: Partial<AgentNode> & Pick<AgentNode, "id" | "sessionId" | "name" | "status">): AgentNode {
  return { parentId: null, kind: "subagent", description: null, currentTool: null, activity: null, startedAt: now() - 300_000, endedAt: null, toolUses: 0, tokens: null, toolUseId: null, ...p };
}
function putAgent(a: AgentNode) { (agents[a.sessionId] ??= {})[a.id] = a; }
putAgent(mkAgent({ id: "5cb5967f-p1", sessionId: "5cb5967f-p1", kind: "orchestrator", name: "Claude", description: "Orquestrador da sessão", status: "running", activity: "Coordenando subagentes", toolUses: 14, tokens: 182_400, startedAt: now() - 640_000 }));
putAgent(mkAgent({ id: "a8eb358e", sessionId: "5cb5967f-p1", parentId: "5cb5967f-p1", name: "Explore", description: "Mapear chamadas de appointments", status: "tool", currentTool: "Grep", activity: "appointments.service", toolUses: 6, tokens: 21_400 }));
putAgent(mkAgent({ id: "b19c02d1", sessionId: "5cb5967f-p1", parentId: "5cb5967f-p1", name: "general-purpose", description: "Escrever testes de integração", status: "running", activity: "Escrevendo appointments.e2e.ts", toolUses: 3, tokens: 9_800 }));
putAgent(mkAgent({ id: "9e01-w1", sessionId: "9e01-w1", kind: "orchestrator", name: "Claude", status: "awaiting_approval", currentTool: "AskUserQuestion", toolUses: 9, tokens: 98_300 }));
putAgent(mkAgent({ id: "c0de9a11", sessionId: "9e01-w1", parentId: "9e01-w1", name: "code-reviewer", description: "Revisar EPG parser", status: "done", toolUses: 11, tokens: 30_100, endedAt: now() - 120_000 }));
putAgent(mkAgent({ id: "f00dface", sessionId: "9e01-w1", parentId: "9e01-w1", name: "Explore", description: "Iniciado em background", status: "unknown", toolUses: 0 }));
putAgent(mkAgent({ id: "3b4c-w2", sessionId: "3b4c-w2", kind: "orchestrator", name: "Claude", status: "idle", toolUses: 4, tokens: 21_000 }));

const chat: Record<string, ChatItem[]> = {};
function pushChat(sessionId: string, body: ChatBody, agentId: string | null = null, ts = now()): ChatItem {
  const item = { seq: seq++, sessionId, ts, agentId, body };
  (chat[sessionId] ??= []).push(item);
  return item;
}
{
  const s = "5cb5967f-p1";
  const t0 = now() - 600_000;
  pushChat(s, { kind: "user_text", text: "Refatore o módulo de agendamentos para usar o novo serviço de disponibilidade. Use subagentes para mapear as chamadas e escrever testes." }, null, t0);
  pushChat(s, { kind: "assistant_text", messageId: "m1", text: "Vou dividir o trabalho:\n\n1. **Explore** mapeia todas as chamadas de `appointments.service`\n2. **general-purpose** escreve testes de integração\n\nEnquanto isso, analiso o schema do Prisma." }, s, t0 + 4000);
  pushChat(s, { kind: "tool_use", toolUseId: "tu1", name: "Read", input: JSON.stringify({ file_path: "backend/prisma/schema.prisma" }, null, 2) }, s, t0 + 6000);
  pushChat(s, { kind: "tool_result", toolUseId: "tu1", content: "model Appointment {\n  id        String   @id @default(uuid())\n  startsAt  DateTime\n  ...\n}", isError: false }, s, t0 + 6500);
  pushChat(s, { kind: "tool_use", toolUseId: "tu2", name: "Agent", input: JSON.stringify({ subagent_type: "Explore", description: "Mapear chamadas de appointments" }, null, 2) }, s, t0 + 9000);
  pushChat(s, { kind: "turn_result", costUsd: 0.1841, durationMs: 48_210, inputTokens: 82_000, outputTokens: 5_400, cacheRead: 61_000, cacheWrite: 9_200, isError: false, numTurns: 4, subtype: "success" }, s, t0 + 50_000);
  pushChat(s, { kind: "system", text: "Sandbox Landlock ativo · ABI 8 · escrita restrita a saas/booking-app", level: "info" }, null, t0 - 1000);
}
{
  const s = "9e01-w1";
  pushChat(s, { kind: "user_text", text: "Mostre a descrição do programa atual no overlay do player." }, null, now() - 400_000);
  pushChat(s, { kind: "assistant_text", messageId: "w1m1", text: "Encontrei dois lugares possíveis para buscar a descrição. Preciso que você escolha a fonte." }, s, now() - 20_000);
  pushChat(s, { kind: "approval", requestId: "req-w1", toolName: "AskUserQuestion", summary: "Qual fonte usar para a descrição?", decision: null }, s, now() - 5_000);
}
{
  const s = "3b4c-w2";
  pushChat(s, { kind: "user_text", text: "Revise a política de retries do client HTTP." }, null, now() - 200_000);
  pushChat(s, { kind: "assistant_text", messageId: "w2m1", text: "A política atual faz retry em **qualquer** 5xx sem jitter. Sugiro backoff exponencial com jitter completo e limite de 3 tentativas.\n\n```ts\nconst delay = Math.random() * Math.min(cap, base * 2 ** attempt);\n```\n\nQuer que eu aplique?" }, s, now() - 95_000);
  pushChat(s, { kind: "turn_result", costUsd: 0.0533, durationMs: 21_000, inputTokens: 21_000, outputTokens: 1_840, cacheRead: 12_000, cacheWrite: 3_000, isError: false, numTurns: 1, subtype: "success" }, s, now() - 94_000);
}

const approvals: Record<string, Approval> = {
  "req-w1": {
    requestId: "req-w1", sessionId: "9e01-w1", account: "work", agentId: "9e01-w1", toolName: "AskUserQuestion", toolUseId: "tuq",
    input: { questions: [{ question: "Qual fonte usar para a descrição do programa?", header: "Fonte", multiSelect: false, options: [{ label: "EPG (XMLTV)", description: "Atualizado a cada 6h, já cacheado no player" }, { label: "API de metadados", description: "Tempo real, +1 request por troca de canal" }] }] },
    description: null, suggestions: [], createdAt: now() - 5_000,
  },
};

type MockProject = { id: string; name: string; dirs: string[]; createdAt: number };
const projects: Record<string, MockProject[]> = { personal: [], work: [] };
const tasks: TaskItem[] = [
  { id: "t1", account: "personal", repoPath: repos.personal[0].path, title: "Cobrir finance com testes", prompt: "Escreva testes para o módulo finance", priority: 1, status: "todo", sessionId: null, createdAt: now() - 86_400_000 },
  { id: "t2", account: "personal", repoPath: repos.personal[0].path, title: "Limpar warnings do Prisma", prompt: "Resolva warnings do prisma generate", priority: 0, status: "done", sessionId: "a12f-p2", createdAt: now() - 2 * 86_400_000 },
];

const DIFF = `diff --git a/backend/src/modules/appointments/appointments.service.ts b/backend/src/modules/appointments/appointments.service.ts
index 3f1a2b9..8c0d4e1 100644
--- a/backend/src/modules/appointments/appointments.service.ts
+++ b/backend/src/modules/appointments/appointments.service.ts
@@ -12,14 +12,19 @@ export class AppointmentsService {
 export class AppointmentsService {
-  constructor(private prisma: PrismaService) {}
+  constructor(
+    private prisma: PrismaService,
+    private availability: AvailabilityService,
+  ) {}
 
   async create(dto: CreateAppointmentDto) {
-    const clash = await this.prisma.appointment.findFirst({ where: { startsAt: dto.startsAt } });
-    if (clash) throw new ConflictException("slot taken");
+    const free = await this.availability.isFree(dto.mechanicId, dto.startsAt, dto.durationMin);
+    if (!free) throw new ConflictException("Horário indisponível");
     return this.prisma.appointment.create({ data: dto });
   }
`;

function overview(): Overview {
  return {
    accounts: accounts.map((c) => ({
      config: c, auth: auth[c.id], workspaceExists: true, defaultModel: c.id === "work" ? "opus[1m]" : null,
      warnings: c.id === "work" ? ["~/.claude é o diretório padrão global; não use para contas isoladas"].slice(0, 0) : [],
    })),
    settings, landlockAbi: 8, claudePath: `${HOME}/.local/share/claude/versions/2.1.318`, claudeVersion: "2.1.318", configError: null,
  };
}

let cpuPhase = 0;
function metrics(): MetricsSnapshot {
  cpuPhase += 1;
  const live = Object.values(sessions).filter((s) => s.pid);
  return {
    ts: now(),
    app: { pid: 48000, rssBytes: 38 * 1024 * 1024, cpuPercent: 0.4, procs: 1 },
    webviewRssBytes: 112 * 1024 * 1024,
    sessions: live.map((s, i) => ({ sessionId: s.id, account: s.account, stat: { pid: s.pid!, rssBytes: (180 + i * 40 + (cpuPhase % 5) * 3) * 1024 * 1024, cpuPercent: s.status === "running" ? 18 + ((cpuPhase * 7) % 20) : 0.3, procs: s.status === "running" ? 3 : 1 } })),
    scheduler: { limit: settings.maxConcurrent, running: Object.values(sessions).filter((s) => ["running", "awaiting_approval", "waiting_input", "starting"].includes(s.status)).length, queuedPersonal: Object.values(sessions).filter((s) => s.status === "queued" && s.account === "personal").length, queuedWork: Object.values(sessions).filter((s) => s.status === "queued" && s.account === "work").length },
  };
}

function upsertSession(id: string, patch: Partial<SessionSummary>): UiEvent {
  sessions[id] = { ...sessions[id], ...patch, updatedAt: now() };
  return { type: "sessionUpsert", session: sessions[id] };
}
function upsertAgent(sessionId: string, id: string, patch: Partial<AgentNode>): UiEvent {
  const a = { ...agents[sessionId][id], ...patch };
  agents[sessionId][id] = a;
  return { type: "agentUpsert", account: sessions[sessionId].account, agent: a };
}
function chatEv(sessionId: string, body: ChatBody, agentId: string | null = null): UiEvent {
  return { type: "chat", account: sessions[sessionId].account, item: pushChat(sessionId, body, agentId) };
}

// ---------- simulation ----------
const STREAM = "Mapeamento concluído. Encontrei **7 chamadas** a `appointments.service` em 4 arquivos. O controller ainda usa a checagem antiga de conflito; vou trocar pela chamada ao `AvailabilityService` e manter o contrato da API. Em seguida rodo os testes do módulo.";
function simulateTurn(sessionId: string, text: string, onDone?: () => void) {
  const acc = sessions[sessionId].account;
  const messageId = `sim-${seq}`;
  const words = text.split(/(?<= )/);
  let i = 0;
  const step = () => {
    if (i < words.length) {
      const chunk = words.slice(i, i + 3).join("");
      i += 3;
      emit([{ type: "delta", account: acc, sessionId, agentId: sessionId, messageId, text: chunk }]);
      setTimeout(step, 90);
    } else {
      emit([chatEv(sessionId, { kind: "assistant_text", messageId, text }, sessionId)]);
      onDone?.();
    }
  };
  step();
}

function runScript() {
  const P = "5cb5967f-p1";
  const at = (ms: number, fn: () => void) => setTimeout(fn, ms);
  at(1200, () => simulateTurn(P, STREAM));
  at(2600, () => emit([upsertAgent(P, "a8eb358e", { currentTool: "Read", activity: "appointments.controller.ts", toolUses: 7 })]));
  at(4200, () => emit([upsertAgent(P, "a8eb358e", { status: "done", currentTool: null, activity: "7 chamadas mapeadas", endedAt: now() })]));
  at(5200, () => {
    const id = "d4e5f6a7";
    agents[P][id] = mkAgent({ id, sessionId: P, parentId: "b19c02d1", name: "Explore", description: "Localizar fixtures de teste", status: "running", startedAt: now(), toolUseId: "tu9" });
    emit([{ type: "agentUpsert", account: "personal", agent: agents[P][id] }, chatEv(P, { kind: "tool_use", toolUseId: "tu9", name: "Agent", input: JSON.stringify({ subagent_type: "Explore", description: "Localizar fixtures de teste" }, null, 2) }, "b19c02d1")]);
  });
  at(7000, () => emit([upsertAgent(P, "d4e5f6a7", { status: "tool", currentTool: "Glob", activity: "**/*.fixture.ts" })]));
  at(8200, () => {
    approvals["req-p1"] = { requestId: "req-p1", sessionId: P, account: "personal", agentId: "b19c02d1", toolName: "Bash", toolUseId: "tu10", input: { command: "npm test -- appointments", description: "Rodar testes do módulo" }, description: "Rodar testes do módulo", suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "npm test:*" }], behavior: "allow", destination: "session" }], createdAt: now() };
    emit([
      { type: "approval", approval: approvals["req-p1"] },
      upsertAgent(P, "b19c02d1", { status: "awaiting_approval", currentTool: "Bash", activity: "npm test -- appointments" }),
      upsertSession(P, { status: "awaiting_approval", pendingApprovals: 1, lastActivity: "Bash · npm test" }),
      chatEv(P, { kind: "approval", requestId: "req-p1", toolName: "Bash", summary: "npm test -- appointments", decision: null }, "b19c02d1"),
    ]);
  });
  at(9500, () => emit([upsertAgent(P, "d4e5f6a7", { status: "done", currentTool: null, endedAt: now(), activity: "3 fixtures" })]));
}

function respond(requestId: string, behavior: string) {
  const a = approvals[requestId];
  if (!a) return;
  delete approvals[requestId];
  const s = a.sessionId;
  const evs: UiEvent[] = [
    { type: "approvalResolved", account: a.account, sessionId: s, requestId, decision: behavior },
    upsertSession(s, { status: "running", pendingApprovals: 0 }),
  ];
  if (a.agentId && agents[s]?.[a.agentId]) evs.push(upsertAgent(s, a.agentId, { status: behavior === "allow" ? "tool" : "running", activity: behavior === "allow" ? a.toolName : "Ação negada" }));
  emit(evs);
  setTimeout(() => {
    const evs2: UiEvent[] = [];
    if (a.toolName === "Bash") {
      evs2.push(chatEv(s, { kind: "tool_use", toolUseId: "tu10", name: "Bash", input: JSON.stringify(a.input, null, 2) }, a.agentId));
      evs2.push(chatEv(s, { kind: "tool_result", toolUseId: "tu10", content: behavior === "allow" ? "PASS  test/appointments.e2e.ts (4.1 s)\n  ✓ cria agendamento em horário livre\n  ✓ rejeita conflito\n\nTests: 12 passed, 12 total" : "Permissão negada pelo usuário", isError: behavior !== "allow" }, a.agentId));
      if (a.agentId) evs2.push(upsertAgent(s, a.agentId, { status: "done", currentTool: null, endedAt: now(), activity: "12 testes passando" }));
    }
    emit(evs2);
    simulateTurn(s, behavior === "allow" ? "Tudo certo — todos os testes passam. Posso abrir um commit com as mudanças?" : "Entendido, não vou executar esse comando. Como prefere seguir?", () => {
      emit([
        chatEv(s, { kind: "turn_result", costUsd: 0.0712, durationMs: 31_400, inputTokens: 40_000, outputTokens: 2_100, cacheRead: 35_000, cacheWrite: 1_200, isError: false, numTurns: 3, subtype: "success" }, s),
        upsertSession(s, { status: "waiting_input", totalCostUsd: sessions[s].totalCostUsd + 0.0712, turns: sessions[s].turns + 1, lastActivity: null }),
        ...(agents[s]?.[s] ? [upsertAgent(s, s, { status: "idle", currentTool: null, activity: "Aguardando próxima mensagem" })] : []),
      ]);
    });
  }, 700);
}

// ---------- invoke ----------
type Args = Record<string, unknown>;
async function handle(cmd: string, a: Args): Promise<unknown> {
  const acc = a.account as AccountId;
  switch (cmd) {
    case "plugin:event|listen": {
      const id = listenSeq++;
      listeners.set(id, { event: a.event as string, cb: a.handler as number });
      return id;
    }
    case "plugin:event|unlisten": listeners.delete(a.eventId as number); return null;
    case "get_overview": return overview();
    case "refresh_auth": auth[acc] = { ...auth[acc], checkedAt: now() }; return auth[acc];
    case "start_login": {
      setTimeout(() => emit([{ type: "authLog", account: acc, line: "Opening browser to sign in…" }]), 300);
      setTimeout(() => emit([{ type: "authLog", account: acc, line: "If the browser didn't open, visit: https://claude.ai/oauth/authorize?code=true&client_id=…" }]), 700);
      setTimeout(() => emit([{ type: "authLog", account: acc, line: "Paste code here if prompted >" }]), 900);
      return null;
    }
    case "login_input": emit([{ type: "authLog", account: acc, line: "Login successful." }, { type: "auth", status: { ...auth[acc], checkedAt: now() } }]); return null;
    case "cancel_login": return null;
    case "list_repos": return repos[acc];
    case "repo_status": return { branch: repos[acc].find((r) => r.path === a.repo)?.branch ?? "main", upstream: "origin/main", ahead: 2, behind: 0, files: [{ path: "backend/src/modules/appointments/appointments.service.ts", index: " ", worktree: "M" }, { path: "backend/test/appointments.e2e.ts", index: "?", worktree: "?" }, { path: "backend/src/modules/availability/availability.service.ts", index: "A", worktree: " " }], worktrees: [] };
    case "repo_diff": return DIFF.repeat(a.file ? 1 : 3);
    case "create_worktree": return { path: `${a.repo}-wt-${a.name}`, name: `${String(a.repo).split("/").pop()}@${a.name}`, relPath: "", branch: `ccc/${a.name}`, isWorktree: true };
    case "list_sessions": return Object.values(sessions).filter((s) => !a.account || s.account === a.account);
    case "create_session": {
      const req = a.req as { repoPath: string; prompt: string; title?: string; model?: string; permissionMode?: SessionSummary["permissionMode"]; priority?: number; worktreePath?: string };
      const id = `${Math.random().toString(16).slice(2, 10)}-new`;
      const s = mkSession({ id, account: acc, repoPath: req.repoPath, title: req.title || req.prompt.slice(0, 60), status: "queued", model: req.model ?? null, permissionMode: req.permissionMode ?? "default", priority: req.priority ?? 0, worktreePath: req.worktreePath ?? null, createdAt: now(), resumable: false });
      sessions[id] = s;
      agents[id] = {};
      setTimeout(() => {
        agents[id][id] = mkAgent({ id, sessionId: id, kind: "orchestrator", name: "Claude", status: "running", startedAt: now() });
        emit([upsertSession(id, { status: "running", pid: 49000 + (seq % 1000) }), { type: "agentUpsert", account: acc, agent: agents[id][id] }, chatEv(id, { kind: "user_text", text: req.prompt })]);
        simulateTurn(id, "Entendido. Vou analisar o repositório e propor um plano antes de editar arquivos.", () =>
          emit([upsertSession(id, { status: "waiting_input", resumable: true }), upsertAgent(id, id, { status: "idle" })]));
      }, 900);
      return s;
    }
    case "send_message": {
      const id = a.sessionId as string;
      emit([chatEv(id, { kind: "user_text", text: a.text as string, images: (a.thumbs as string[] | null) ?? undefined }), upsertSession(id, { status: "running" })]);
      simulateTurn(id, "Certo, seguindo com isso agora.", () => emit([upsertSession(id, { status: "waiting_input" })]));
      return null;
    }
    case "respond_approval": respond(a.requestId as string, (a.decision as { behavior: string }).behavior); return null;
    case "interrupt_session": emit([upsertSession(a.sessionId as string, { status: "interrupted" }), { type: "notice", level: "warn", text: "Sessão interrompida", account: acc, sessionId: a.sessionId as string }]); return null;
    case "stop_session": emit([upsertSession(a.sessionId as string, { status: "idle", pid: null })]); return null;
    case "delete_session": { delete sessions[a.sessionId as string]; emit([{ type: "sessionRemoved", account: acc, sessionId: a.sessionId as string }]); return null; }
    case "set_session_model": emit([upsertSession(a.sessionId as string, { model: (a.model as string | null) ?? null })]); return null;
    case "set_permission_mode": emit([upsertSession(a.sessionId as string, { permissionMode: a.mode as SessionSummary["permissionMode"] })]); return null;
    case "mcp_list": return mcps[acc];
    case "mcp_add": {
      const c = a.config as Record<string, unknown>;
      const kind = (c.type as McpServer["transport"]) ?? "stdio";
      const target = kind === "stdio" ? [c.command, ...((c.args as string[]) ?? [])].join(" ") : String(c.url);
      const secrets = Object.keys({ ...((c.env as object) ?? {}), ...((c.headers as object) ?? {}) }).sort();
      mcps[acc] = [...mcps[acc].filter((m) => m.name !== a.name), { name: a.name as string, transport: kind, target, secrets }].sort((x, y) => x.name.localeCompare(y.name));
      return mcps[acc];
    }
    case "mcp_login": setTimeout(() => emit([{ type: "mcpLogin", account: acc, name: a.name as string, phase: "url", text: "https://example.com/oauth/authorize" }]), 400);
      setTimeout(() => emit([{ type: "mcpLogin", account: acc, name: a.name as string, phase: "done", text: "autenticado" }]), 2500); return null;
    case "mcp_login_input": case "mcp_login_cancel": case "open_external": return null;
    case "mcp_remove": mcps[acc] = mcps[acc].filter((m) => m.name !== a.name); return mcps[acc];
    case "archive_session": emit([upsertSession(a.sessionId as string, { status: "archived", pid: null })]); return null;
    case "set_session_priority": emit([upsertSession(a.sessionId as string, { priority: a.priority as number })]); return null;
    case "get_session": {
      const id = a.sessionId as string;
      return { session: sessions[id], agents: Object.values(agents[id] ?? {}), approvals: Object.values(approvals).filter((x) => x.sessionId === id) };
    }
    case "get_chat": {
      const list = chat[a.sessionId as string] ?? [];
      const before = a.beforeSeq as number | null;
      const filtered = before == null ? list : list.filter((c) => c.seq < before);
      return filtered.slice(-(a.limit as number));
    }
    case "update_settings": Object.assign(settings, a.settings); return overview();
    case "inspect_behavior_dir": return { exists: true, skills: ["code-review", "deploy", "monday-task"], hasClaudeMd: true, isPlugin: false, agents: 2, commands: 0 };
    case "update_account": { const c = a.config as AccountConfig; const i = accounts.findIndex((x) => x.id === c.id); accounts[i] = c; return overview(); }
    case "get_metrics": return metrics();
    case "set_ui_visible": return null;
    case "list_projects": return projects[acc];
    case "save_project": {
      const p = { ...(a.project as MockProject) };
      if (!p.id) { p.id = `p${seq++}`; p.createdAt = now(); }
      const i = projects[acc].findIndex((x) => x.id === p.id);
      if (i >= 0) projects[acc][i] = p; else projects[acc].push(p);
      return p;
    }
    case "delete_project": projects[acc] = projects[acc].filter((x) => x.id !== a.projectId); return null;
    case "list_tasks": return tasks.filter((t) => t.account === acc && (!a.repo || t.repoPath === a.repo));
    case "create_task": { const t: TaskItem = { id: `t${seq++}`, account: acc, repoPath: a.repo as string, title: a.title as string, prompt: a.prompt as string, priority: a.priority as number, status: "todo", sessionId: null, createdAt: now() }; tasks.push(t); return t; }
    case "update_task": { const t = a.task as TaskItem; const i = tasks.findIndex((x) => x.id === t.id); if (i >= 0) tasks[i] = t; return null; }
    case "delete_task": { const i = tasks.findIndex((x) => x.id === a.taskId); if (i >= 0) tasks.splice(i, 1); return null; }
    case "run_task": { const t = tasks.find((x) => x.id === a.taskId)!; t.status = "running"; return handle("create_session", { account: acc, req: { repoPath: t.repoPath, prompt: t.prompt, title: t.title, priority: t.priority } }); }
    case "list_external_sessions": return [
      { id: "0f3e2d1c-ext1", title: "ajustar CI do backend", updatedAt: now() - 3 * 86_400_000, sizeBytes: 482_113 },
      { id: "8a7b6c5d-ext2", title: "investigar leak no websocket", updatedAt: now() - 9 * 86_400_000, sizeBytes: 1_204_998 },
    ];
    case "import_external_session": return mkSession({ id: a.id as string, account: acc, repoPath: a.repo as string, title: "Sessão importada do CLI", status: "idle" });
    default:
      throw { code: "not_found", message: `mock: comando desconhecido ${cmd}` };
  }
}

export function installMock() {
  const w = window as unknown as Record<string, unknown>;
  w.__CCC_MOCK__ = true;
  w.__TAURI_INTERNALS__ = {
    invoke: (cmd: string, args: Args = {}) => handle(cmd, args ?? {}),
    transformCallback: (cb: Cb) => { const id = cbSeq++; callbacks.set(id, cb); return id; },
    unregisterCallback: (id: number) => callbacks.delete(id),
    convertFileSrc: (p: string) => p,
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
  // Live-ish metrics push (mock only; the real backend pushes from Rust).
  const tick = () => { if (!document.hidden) emit([{ type: "metrics", snapshot: metrics() }]); setTimeout(tick, 2000); };
  setTimeout(tick, 2000);
  setTimeout(runScript, 1500);
}
