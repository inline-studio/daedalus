import path from "node:path";

// SEC-16: defence-in-depth for brain file resolution. Names reaching the loaders today come
// from directory listings or manifest-declared / enum-constrained values (trusted), so this is
// not currently reachable — but it closes the latent path-traversal if a future caller ever
// passes a user-influenced name (e.g. "../../etc/passwd"). Throws if the resolved target escapes
// the brain directory.
export function assertUnderBrain(brainPath: string, target: string): void {
  const root = path.resolve(brainPath);
  const resolved = path.resolve(target);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`refusing to load '${target}': path escapes the brain directory`);
  }
}
