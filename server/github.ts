import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { InboxWorkspace, PullRequestClaim, Verification } from "./inbox-types.ts";
import { prEvidencePrefix } from "./reporting.ts";

const exec = promisify(execFile);
const slug = "[a-z0-9][a-z0-9-]{0,38}/[a-z0-9_.-]{1,100}";
const originPattern = new RegExp(`^(?:https://github\\.com/|git@github\\.com:|ssh://git@github\\.com/)(${slug})/?$`, "i");
const prPattern = new RegExp(`^https://github\\.com/(${slug})/pull/([1-9]\\d{0,9})$`, "i");

export function githubOrigin(remote: string) {
  return originPattern.exec(remote.trim().replace(/\.git\/?$/i, ""))?.[1].toLowerCase() ?? null;
}

export async function readOrigin(workspace: InboxWorkspace) {
  try {
    const { stdout } = await exec("git", ["-C", workspace.directory, "remote", "get-url", "origin"], {
      timeout: 5_000,
      maxBuffer: 8192,
    });
    return githubOrigin(stdout);
  } catch (error) {
    // A failed Git query may mean the directory is not a checkout or has no origin.
    if (error instanceof Error && "code" in error && typeof error.code === "number") return null;
    throw error;
  }
}

const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  url: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  headRefOid: z.string(),
  body: z.string(),
  commits: z.array(z.object({ oid: z.string() })),
});

type VerifyInput = PullRequestClaim & { workspace: InboxWorkspace; repository: string };

export function createPullRequestVerifier(
  origin: (workspace: InboxWorkspace) => Promise<string | null>,
  readPullRequest: (repository: string, number: string) => Promise<unknown>,
) {
  return async ({ workspace, repository, url, revision, batchId, itemId }: VerifyInput): Promise<Verification> => {
    const claim = prPattern.exec(url);
    if (!claim || claim[1].toLowerCase() !== repository) {
      return { status: "rejected", detail: "The reported pull request is outside this workspace’s GitHub origin." };
    }
    if (!/^[a-f\d]{40}$/.test(revision)) {
      return { status: "rejected", detail: "The reported revision is missing a full commit SHA." };
    }
    try {
      if (await origin(workspace) !== repository) {
        return { status: "rejected", detail: "The workspace GitHub origin changed before verification." };
      }
      const record = pullRequestSchema.parse(await readPullRequest(repository, claim[2]));
      const canonical = prPattern.exec(record.url);
      if (!canonical || canonical[1].toLowerCase() !== repository ||
          canonical[2] !== claim[2] || record.number !== Number(claim[2])) {
        return { status: "rejected", detail: "GitHub returned a pull request outside the reported repository or number." };
      }
      if (record.state !== "OPEN" || record.isDraft) {
        return { status: "rejected", detail: "The reported pull request is not open and ready for review." };
      }
      if (record.headRefOid.toLowerCase() !== revision) {
        return { status: "rejected", detail: "The pull request head differs from the reported revision." };
      }
      const marker = `${prEvidencePrefix} ${batchId} ${itemId} `;
      const evidence = record.body.split(/\r?\n/).filter((line) => line.startsWith(marker));
      const fixRevision = evidence[0]?.slice(marker.length);
      if (evidence.length !== 1 || !fixRevision || !/^[a-f\d]{40}$/.test(fixRevision) ||
          !record.commits.some(({ oid }) => oid.toLowerCase() === fixRevision)) {
        return { status: "rejected", detail: "The pull request has no valid commit evidence for this bug." };
      }
      return { status: "verified", url: record.url, revision, fixRevision };
    } catch {
      return { status: "retry", detail: "GitHub pull request verification is unavailable. Check access on the Paseo host." };
    }
  };
}

export const verifyPullRequest = createPullRequestVerifier(readOrigin, async (repository, number) => {
  const { stdout } = await exec("gh", [
    "pr", "view", number, "--repo", `github.com/${repository}`,
    "--json", "number,url,state,isDraft,headRefOid,body,commits",
  ], { timeout: 10_000, maxBuffer: 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
  return JSON.parse(stdout) as unknown;
});
