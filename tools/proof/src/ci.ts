import { execFileSync } from "node:child_process";

// The latest finished run of the repository's CI on main, read through the GitHub CLI: each job's
// result, and the test counts its logs print.

export interface CiJob {
  readonly name: string;
  readonly conclusion: string;
}

export interface CiRun {
  readonly id: number;
  readonly url: string;
  readonly commit: string;
  readonly finishedAt: string;
  readonly conclusion: string;
  readonly jobs: readonly CiJob[];
  // "Ran N test suites ...: X tests passed, Y failed" lines from the contract jobs, and the summed
  // "ℹ pass" and "ℹ fail" lines from the TypeScript job.
  readonly contractTests: { readonly passed: number; readonly failed: number } | null;
  readonly typescriptTests: { readonly passed: number; readonly failed: number } | null;
}

const REPO = "winsznx/vayle";

function gh(args: readonly string[]): string {
  return execFileSync("gh", [...args, "--repo", REPO], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

// Sums every forge summary line's passed and failed counts.
export function forgeCounts(log: string): { passed: number; failed: number } | null {
  let passed = 0;
  let failed = 0;
  let seen = false;
  for (const m of log.matchAll(/Ran \d+ test suites? in .*?: (\d+) tests passed, (\d+) failed/g)) {
    passed += Number(m[1]);
    failed += Number(m[2]);
    seen = true;
  }
  return seen ? { passed, failed } : null;
}

// Sums node --test's "ℹ pass N" and "ℹ fail N" summary lines.
export function nodeCounts(log: string): { passed: number; failed: number } | null {
  let passed = 0;
  let failed = 0;
  let seen = false;
  for (const m of log.matchAll(/ℹ pass (\d+)/g)) {
    passed += Number(m[1]);
    seen = true;
  }
  for (const m of log.matchAll(/ℹ fail (\d+)/g)) failed += Number(m[1]);
  return seen ? { passed, failed } : null;
}

export function latestCiRun(): CiRun | null {
  const runs = JSON.parse(
    gh([
      "run",
      "list",
      "--workflow",
      "ci",
      "--branch",
      "main",
      "--status",
      "completed",
      "--limit",
      "1",
      "--json",
      "databaseId,url,headSha,updatedAt,conclusion",
    ]),
  ) as {
    databaseId: number;
    url: string;
    headSha: string;
    updatedAt: string;
    conclusion: string;
  }[];
  const run = runs[0];
  if (run === undefined) return null;
  const { jobs } = JSON.parse(gh(["run", "view", String(run.databaseId), "--json", "jobs"])) as {
    jobs: { name: string; conclusion: string }[];
  };
  const log = gh(["run", "view", String(run.databaseId), "--log"]);
  return {
    id: run.databaseId,
    url: run.url,
    commit: run.headSha,
    finishedAt: run.updatedAt,
    conclusion: run.conclusion,
    jobs: jobs.map((j) => ({ name: j.name, conclusion: j.conclusion })),
    contractTests: forgeCounts(log),
    typescriptTests: nodeCounts(log),
  };
}
