import { basename } from "node:path";
import type { RepoIdentity } from "./event.ts";

export interface ProjectIdentity {
  key: string;
  kind: "repo" | "dir";
  label: string;
  repo: RepoIdentity | null;
  dir: string | null;
}

/** Hosts where owner and repository names are case-insensitive. */
const CASE_INSENSITIVE_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org"]);

/** The git repository when there is one, otherwise the project directory (decision Q15). */
export function identityOf(repo: RepoIdentity | null, dir: string | null): ProjectIdentity | null {
  if (repo !== null) {
    const host = repo.host.toLowerCase();
    const path = `${repo.owner}/${repo.name}`;
    const keyPath = CASE_INSENSITIVE_HOSTS.has(host) ? path.toLowerCase() : path;
    return { key: `repo:${host}/${keyPath}`, kind: "repo", label: path, repo, dir };
  }
  if (dir !== null) return { key: `dir:${dir}`, kind: "dir", label: basename(dir) || dir, repo: null, dir };
  return null;
}
