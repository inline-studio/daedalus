import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// IMP-04 / SEC-08: write a file atomically — temp file in the same directory, then rename — so
// an interrupted write can never leave a half-written or truncated config / secret file (which
// could lose merged-in secrets on the next `dae install`). `mode` sets the new file's
// permissions (0o600 for secret files; the parent dir is then created 0o700). rename is atomic,
// so a concurrent reader sees either the old file or the complete new one, never a partial.
export async function atomicWrite(
  filePath: string,
  data: string,
  opts: { mode?: number } = {},
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, ...(opts.mode ? { mode: 0o700 } : {}) });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${crypto.randomBytes(6).toString("hex")}`);
  try {
    await fs.writeFile(tmp, data, { encoding: "utf8", ...(opts.mode ? { mode: opts.mode } : {}) });
    // mode on writeFile is subject to umask; chmod pins it (best-effort so an exotic fs can't
    // break setup).
    if (opts.mode) await fs.chmod(tmp, opts.mode).catch(() => undefined);
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
