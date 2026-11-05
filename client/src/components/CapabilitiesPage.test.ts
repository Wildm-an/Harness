import { describe, expect, it } from "vitest";
import { connectorSummary, matches, mcpSummary, providerOf, skillStatus, skillsOfGroup } from "./CapabilitiesPage";
import { placeOf } from "../layout/history";
import { findGroupOf, parseLayout } from "../layout/model";
import type { CommandItem, ConnectorItem, McpServerItem } from "../daemon/protocol";

const skill = (extra: Partial<CommandItem> = {}): CommandItem => ({
  name: "greet",
  description: "Greet a person.",
  "argument-hint": "",
  source: "project",
  builtin: false,
  ...extra,
});

const server = (extra: Partial<McpServerItem> = {}): McpServerItem => ({
  name: "github",
  scope: "project",
  transport: "stdio",
  target: "npx github-mcp",
  state: "connected",
  error: null,
  server_name: null,
  tools: [{ name: "list", agent_name: "mcp__github__list", description: "" }],
  ...extra,
});

describe("the Capabilities page", () => {
  it("gives each skill a status from its frontmatter", () => {
    expect(skillStatus(skill())).toBe("enabled");
    expect(skillStatus(skill({ "model-invocable": false }))).toBe("command");
    expect(skillStatus(skill({ "user-invocable": false }))).toBe("model");
    expect(skillStatus(skill({ "user-invocable": false, "model-invocable": false }))).toBe("disabled");
  });

  it("describes a server with its tool count only when it is connected", () => {
    expect(mcpSummary(server())).toBe("1 tool · stdio · project");
    expect(mcpSummary(server({ state: "stopped", transport: "http", scope: "user" }))).toBe("http · user");
  });

  it("filters with all the words, in any field, with no case", () => {
    expect(matches("", "anything")).toBe(true);
    expect(matches("GIT list", "github", "mcp__github__list")).toBe(true);
    expect(matches("git deploy", "github", "list")).toBe(false);
  });

  it("is a place in the back and forward history", () => {
    expect(placeOf("capabilities", null)).toEqual({ screen: "capabilities" });
  });

  it("drops the Skills and MCP panes of a saved layout", () => {
    const saved = {
      type: "split",
      id: "s1",
      direction: "row",
      sizes: [0.5, 0.5],
      children: [
        { type: "group", id: "g1", tabs: ["chat"], active: "chat" },
        { type: "group", id: "g2", tabs: ["skills", "mcp"], active: "mcp" },
      ],
    };
    const layout = parseLayout(saved);
    expect(layout).not.toBeNull();
    expect(findGroupOf(layout!, "chat")).not.toBeNull();
    expect(JSON.stringify(layout)).not.toMatch(/"skills"|"mcp"/);
  });
});

describe("skillsOfGroup", () => {
  it("puts the bundled skills in Built-in and all other skills in Added", () => {
    const items = [skill({ name: "docx", bundled: true }), skill({ name: "greet" }), skill({ name: "mine", bundled: false })];
    expect(skillsOfGroup(items, "builtin").map((i) => i.name)).toEqual(["docx"]);
    expect(skillsOfGroup(items, "added").map((i) => i.name)).toEqual(["greet", "mine"]);
  });
});

describe("connectorSummary", () => {
  const github = (extra: Partial<ConnectorItem> = {}): ConnectorItem => ({
    id: "github",
    name: "GitHub",
    description: "Repositories and issues.",
    kind: "token",
    signing_in: false,
    url: "https://api.githubcopilot.com/mcp/",
    installed: false,
    source: null,
    login: null,
    gh_available: false,
    token_url: "https://github.com/settings/personal-access-tokens/new",
    token_help: "A token.",
    ...extra,
  });

  it("shows what the connector gives before it connects", () => {
    expect(connectorSummary(github())).toBe("Repositories and issues.");
  });

  it("shows the account and the token source after it connects", () => {
    expect(connectorSummary(github({ source: "gh", login: "octo", installed: true }))).toBe("@octo · GitHub CLI");
    expect(connectorSummary(github({ source: "token", login: null }))).toBe("Connected · personal access token");
  });

  it("shows the account type and read-only for a device connector", () => {
    const outlook = github({ id: "outlook", kind: "device", source: "device", login: "pat@outlook.com" });
    const pat = { login: "pat@outlook.com", type: "personal" as const, read_only: false };
    const jo = { login: "jo@contoso.com", type: "work" as const, read_only: true };
    expect(connectorSummary({ ...outlook, accounts: [pat] })).toBe("pat@outlook.com · Personal account");
    expect(connectorSummary({ ...outlook, accounts: [jo] })).toBe("jo@contoso.com · Work or school account · read-only");
    expect(connectorSummary({ ...outlook, accounts: [jo, pat] })).toBe("2 accounts · jo@contoso.com, pat@outlook.com");
  });
});

describe("the Email connector", () => {
  const providers = [
    { id: "gmail", name: "Gmail", domains: ["gmail.com", "googlemail.com"], imap: ["imap.gmail.com", 993, "ssl"], smtp: ["smtp.gmail.com", 465, "ssl"], password_url: "", help: "" },
    { id: "other", name: "Other IMAP server", domains: [], imap: ["", 993, "ssl"], smtp: ["", 465, "ssl"], password_url: "", help: "" },
  ] as ConnectorItem["providers"] & object;

  it("chooses the mail service from the address", () => {
    expect(providerOf("Pat@GMail.com ", providers)).toBe("gmail");
    expect(providerOf("pat@example.org", providers)).toBe("other");
    expect(providerOf("pat", providers)).toBe("other");
  });

  it("names the mail service of an account in the summary", () => {
    const item: ConnectorItem = {
      id: "email", name: "Email (IMAP)", description: "Mail.", kind: "mail", signing_in: false, url: "", installed: true,
      source: "mail", login: "pat@gmail.com", providers,
      accounts: [{ login: "pat@gmail.com", type: "gmail", read_only: true }],
    };
    expect(connectorSummary(item)).toBe("pat@gmail.com · Gmail · read-only");
  });
});
