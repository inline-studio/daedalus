import fs from "node:fs/promises";

// IMP-06: list the base names of `*.md` files in a directory (extension stripped), returning []
// if the directory is missing. Shared by the agent + command loaders. (Skills are directory-
// based and the composer reads file bodies, so those keep their own listing.)
export async function listMarkdownNames(dir: string): Promise<string[]> {
  try {
    const files = await fs.readdir(dir);
    return files.filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}
