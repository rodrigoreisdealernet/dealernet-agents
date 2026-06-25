import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

type YamlDocument = Record<string, unknown>;

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "../../../../../");

const FACTORY_CONFIG_PATH = join(REPO_ROOT, ".github/factory.yml");
const WORKFLOW_PATH = join(REPO_ROOT, ".github/workflows/pipeline-hourly.yml");
const GUARDIAN_WORKFLOW_PATH = join(REPO_ROOT, ".github/workflows/agent-cluster-guardian.yml");
const AGENT_PROMPT_PATH = join(REPO_ROOT, ".github/agents/cluster-guardian.agent.md");
const REMEDIATOR_PROMPT_PATH = join(REPO_ROOT, ".github/agents/cluster-remediator.agent.md");

function loadYamlFile(path: string): YamlDocument {
  const parsed = yaml.load(readFileSync(path, "utf8"));
  expect(parsed).toBeTruthy();
  return parsed as YamlDocument;
}

describe("cluster guardian foundations", () => {
  it("enables kubernetes-app and defines dia-* namespace scope in factory config", () => {
    const config = loadYamlFile(FACTORY_CONFIG_PATH);
    const factory = config["factory"] as YamlDocument;
    const stack = config["stack"] as YamlDocument;
    const profiles = stack["deployment_profiles"] as string[];
    const guardian = config["cluster_guardian"] as YamlDocument;
    const allowedNamespaces = guardian["allowed_namespaces"] as string[];
    const runnerLabels = ((config["runners"] as YamlDocument)["self_hosted"] as YamlDocument)[
      "cluster_guardian"
    ] as string[];

    expect(factory["active_runner_profile"]).toBe("kubernetes-app");
    expect(profiles).toContain("kubernetes-app");
    expect(allowedNamespaces.length).toBeGreaterThan(0);
    expect(allowedNamespaces.every((ns) => ns.startsWith("dia-"))).toBe(true);
    expect(runnerLabels).toContain("factory-cluster-guardian");
  });

  it("splits hourly monitoring into public and private lanes", () => {
    const workflow = loadYamlFile(WORKFLOW_PATH);
    const jobs = workflow["jobs"] as YamlDocument;
    const publicLane = jobs["pipeline_public"] as YamlDocument;
    const privatePreflight = jobs["private_lane_preflight"] as YamlDocument;
    const privateLane = jobs["pipeline_private"] as YamlDocument;
    const degradedLane = jobs["private_lane_degraded"] as YamlDocument;
    const publicSteps = publicLane["steps"] as YamlDocument[];
    const preflightSteps = privatePreflight["steps"] as YamlDocument[];
    const preflightStep = preflightSteps.find((step) => step["id"] === "preflight");
    const privateSteps = privateLane["steps"] as YamlDocument[];
    const publicOpsStep = publicSteps.find((step) => step["id"] === "ops_manager_public");
    const privateOpsStep = privateSteps.find((step) => step["id"] === "ops_manager_private");
    const privateGuardianStep = privateSteps.find(
      (step) => step["id"] === "cluster_guardian_private",
    );
    const degradedSteps = degradedLane["steps"] as YamlDocument[];
    const degradedStep = degradedSteps.find((step) =>
      String(step["name"] ?? "").includes("degraded-monitoring"),
    );

    expect(workflow["name"]).toBe("Pipeline — Hourly");
    expect(publicLane["runs-on"]).toBe("ubuntu-latest");
    expect(publicOpsStep?.["continue-on-error"]).toBe(true);
    expect(publicOpsStep?.["env"]).toMatchObject({ OPS_CHECK_SCOPE: "public" });
    expect(
      publicSteps.some((step) => String(step["id"] ?? "").includes("cluster_guardian")),
    ).toBe(false);

    expect(privatePreflight["runs-on"]).toBe("ubuntu-latest");
    expect(privatePreflight["outputs"]).toMatchObject({
      private_ready: "${{ steps.preflight.outputs.private_ready }}",
    });
    expect(preflightStep?.["run"]).toContain("/actions/runners?per_page=100");
    expect(preflightStep?.["run"]).not.toContain("KUBE_CONFIG_DEV");

    expect(privateLane["runs-on"]).toEqual([
      "self-hosted",
      "linux",
      "x64",
      "factory-cluster-guardian",
    ]);
    expect(privateLane["if"]).toBe("needs.private_lane_preflight.outputs.private_ready == 'true'");
    expect(privateOpsStep?.["env"]).toMatchObject({ OPS_CHECK_SCOPE: "private" });
    expect(privateGuardianStep?.["continue-on-error"]).toBe(true);
    expect(privateGuardianStep?.["timeout-minutes"]).toBe(18);
    expect(privateGuardianStep?.["working-directory"]).toBe(".github/tools/shared");
    expect(privateGuardianStep?.["run"]).toBe("npx tsx src/run-agent.ts --agent cluster-guardian");

    expect(degradedLane["if"]).toBe("needs.private_lane_preflight.outputs.private_ready != 'true'");
    expect(degradedStep?.["run"]).toContain("Degraded monitoring");
  });

  it("keeps scheduled guardian prompt read-only and isolates mutating guidance to remediator", () => {
    const prompt = readFileSync(AGENT_PROMPT_PATH, "utf8");
    const remediatorPrompt = readFileSync(REMEDIATOR_PROMPT_PATH, "utf8");

    expect(prompt).toContain("Supabase self-hosted");
    expect(prompt).toContain("Temporal Python worker");
    expect(prompt).toContain("Vite frontend");
    expect(prompt).toContain("Do not copy signatures from other projects' baselines");
    expect(prompt).toContain("Detection-only mode");
    expect(prompt).toContain("No Helm rollback.");
    expect(prompt).toContain("No pod force-delete.");
    expect(prompt).toContain("No scale actions (up or down).");
    expect(prompt).toContain("fingerprint-cli.ts");
    expect(prompt).toContain("search before create");

    expect(remediatorPrompt).toContain("Roll back a Helm release");
    expect(remediatorPrompt).toContain("Force-delete a clearly stuck `Terminating` pod");
    expect(remediatorPrompt).toContain("Scale a crashlooping deployment **down to 0 only**");
    expect(remediatorPrompt).toContain("No scale-up actions.");
  });
});

describe("agent-cluster-guardian.yml preflight gate", () => {
  it("preflight validates kubernetes-app profile enablement before cluster jobs run", () => {
    const workflow = loadYamlFile(GUARDIAN_WORKFLOW_PATH);
    const jobs = workflow["jobs"] as YamlDocument;
    const preflight = jobs["preflight"] as YamlDocument;
    const steps = preflight["steps"] as YamlDocument[];
    const preflightStep = steps.find((step) => step["id"] === "preflight");

    expect(preflight["runs-on"]).toBe("ubuntu-latest");
    expect(preflight["outputs"]).toMatchObject({
      cluster_ready: "${{ steps.preflight.outputs.cluster_ready }}",
    });

    const script = preflightStep?.["run"] as string;
    expect(script).toContain("deployment_profiles");
    expect(script).toContain("kubernetes-app");
    expect(script).toContain("missing");
  });

  it("preflight validates namespace allowlist is non-empty and dia-* scoped", () => {
    const workflow = loadYamlFile(GUARDIAN_WORKFLOW_PATH);
    const jobs = workflow["jobs"] as YamlDocument;
    const preflight = jobs["preflight"] as YamlDocument;
    const steps = preflight["steps"] as YamlDocument[];
    const preflightStep = steps.find((step) => step["id"] === "preflight");

    const script = preflightStep?.["run"] as string;
    expect(script).toContain("allowed_namespaces");
    expect(script).toContain("dia-");
    expect(script).toContain("missing");
  });

  it("preflight validates dedicated runner label availability", () => {
    const workflow = loadYamlFile(GUARDIAN_WORKFLOW_PATH);
    const jobs = workflow["jobs"] as YamlDocument;
    const preflight = jobs["preflight"] as YamlDocument;
    const steps = preflight["steps"] as YamlDocument[];
    const preflightStep = steps.find((step) => step["id"] === "preflight");

    const script = preflightStep?.["run"] as string;
    expect(script).toContain("factory-cluster-guardian");
    expect(script).toContain("/actions/runners?per_page=100");
  });

  it("detection job is gated by preflight passing", () => {
    const workflow = loadYamlFile(GUARDIAN_WORKFLOW_PATH);
    const jobs = workflow["jobs"] as YamlDocument;
    const detect = jobs["detect"] as YamlDocument;

    expect((detect["needs"] as string[]) ?? [detect["needs"]]).toContain("preflight");
    expect(detect["if"]).toContain("cluster_ready == 'true'");
    expect(detect["runs-on"]).toEqual(["self-hosted", "linux", "x64", "factory-cluster-guardian"]);
  });

  it("degraded job fires with a warning (non-failing) when preflight does not pass", () => {
    const workflow = loadYamlFile(GUARDIAN_WORKFLOW_PATH);
    const jobs = workflow["jobs"] as YamlDocument;
    const degraded = jobs["detect_degraded"] as YamlDocument;
    const degradedSteps = degraded["steps"] as YamlDocument[];
    const degradedStep = degradedSteps[0] as YamlDocument;

    expect(degraded["if"]).toContain("cluster_ready != 'true'");
    expect(degradedStep?.["run"]).toContain("::warning::");
    expect(degradedStep?.["run"]).not.toContain("exit 1");
  });
});

describe("agent-cluster-guardian.yml remediation path guardrails", () => {
  it("remediation job only triggers on workflow_dispatch with run_remediation=true", () => {
    const workflow = loadYamlFile(GUARDIAN_WORKFLOW_PATH);
    const jobs = workflow["jobs"] as YamlDocument;
    const remediate = jobs["remediate"] as YamlDocument;

    const condition = remediate["if"] as string;
    expect(condition).toContain("workflow_dispatch");
    expect(condition).toContain("run_remediation == 'true'");
  });

  it("remediation job requires cluster-remediation approval environment", () => {
    const workflow = loadYamlFile(GUARDIAN_WORKFLOW_PATH);
    const jobs = workflow["jobs"] as YamlDocument;
    const remediate = jobs["remediate"] as YamlDocument;

    expect(remediate["environment"]).toBe("cluster-remediation");
  });

  it("remediation job uses cluster-remediator agent, not cluster-guardian", () => {
    const workflow = loadYamlFile(GUARDIAN_WORKFLOW_PATH);
    const jobs = workflow["jobs"] as YamlDocument;
    const remediate = jobs["remediate"] as YamlDocument;
    const steps = remediate["steps"] as YamlDocument[];
    const remediatorStep = steps.find((step) =>
      String(step["run"] ?? "").includes("run-agent.ts"),
    );

    expect(remediatorStep?.["run"]).toBe(
      "npx tsx src/run-agent.ts --agent cluster-remediator",
    );
    expect(remediatorStep?.["run"]).not.toContain("cluster-guardian");
  });

  it("remediation job depends on both preflight passing and detect completing", () => {
    const workflow = loadYamlFile(GUARDIAN_WORKFLOW_PATH);
    const jobs = workflow["jobs"] as YamlDocument;
    const remediate = jobs["remediate"] as YamlDocument;
    const needs = (remediate["needs"] as string[]) ?? [remediate["needs"]];

    expect(needs).toContain("preflight");
    expect(needs).toContain("detect");
  });

  it("workflow_dispatch exposes run_remediation input defaulting to false", () => {
    const workflow = loadYamlFile(GUARDIAN_WORKFLOW_PATH);
    const on = workflow["on"] as YamlDocument;
    const dispatch = on["workflow_dispatch"] as YamlDocument;
    const inputs = dispatch["inputs"] as YamlDocument;
    const remediationInput = inputs["run_remediation"] as YamlDocument;

    expect(remediationInput).toBeTruthy();
    expect(remediationInput["default"]).toBe("false");
    const options = remediationInput["options"] as string[];
    expect(options).toContain("false");
    expect(options).toContain("true");
  });

  it("remediation job runs on the same dedicated runner as detection", () => {
    const workflow = loadYamlFile(GUARDIAN_WORKFLOW_PATH);
    const jobs = workflow["jobs"] as YamlDocument;
    const detect = jobs["detect"] as YamlDocument;
    const remediate = jobs["remediate"] as YamlDocument;

    expect(remediate["runs-on"]).toEqual(detect["runs-on"]);
    expect((remediate["runs-on"] as string[]).join(",")).toContain("factory-cluster-guardian");
  });
});

describe("cluster guardian namespace scoping and dedupe invariants", () => {
  it("guardian prompt forbids operations outside configured dia-* namespaces", () => {
    const prompt = readFileSync(AGENT_PROMPT_PATH, "utf8");

    expect(prompt).toContain("allowed_namespaces");
    expect(prompt).toContain("dia-");
    expect(prompt).toContain("No operations outside configured");
  });

  it("remediator prompt forbids operations outside configured dia-* namespaces", () => {
    const remediatorPrompt = readFileSync(REMEDIATOR_PROMPT_PATH, "utf8");

    expect(remediatorPrompt).toContain("allowed_namespaces");
    expect(remediatorPrompt).toContain("dia-");
    expect(remediatorPrompt).toContain("No operations outside configured");
  });

  it("guardian prompt enforces fingerprint-based search before creating a new incident", () => {
    const prompt = readFileSync(AGENT_PROMPT_PATH, "utf8");

    expect(prompt).toContain("fingerprint-cli.ts");
    expect(prompt).toContain("search before create");
    expect(prompt).toContain("auto:cluster");
    expect(prompt).toContain("gh issue list --state open --label");
  });

  it("guardian prompt scopes incident label to auto:cluster and caps new issues per run", () => {
    const prompt = readFileSync(AGENT_PROMPT_PATH, "utf8");

    expect(prompt).toContain("auto:cluster");
    expect(prompt).toMatch(/max\s+\d+\s+new\s+issues?\s+per\s+run/i);
  });

  it("factory config issue_label matches auto:cluster used in guardian prompt", () => {
    const config = loadYamlFile(FACTORY_CONFIG_PATH);
    const guardian = config["cluster_guardian"] as YamlDocument;

    expect(guardian["issue_label"]).toBe("auto:cluster");

    const prompt = readFileSync(AGENT_PROMPT_PATH, "utf8");
    expect(prompt).toContain(guardian["issue_label"] as string);
  });
});
