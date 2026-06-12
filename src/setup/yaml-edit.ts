import fs from "node:fs/promises";
import YAML, { type Document, type YAMLMap, type Node } from "yaml";
import { atomicWrite } from "./atomic-write.js";

// Comment-preserving YAML edit. Reads the file as a Document, applies a mutator,
// writes back with comments and formatting intact.
export async function editYamlFile(
  filePath: string,
  mutate: (doc: Document) => void | Promise<void>,
): Promise<void> {
  const text = await fs.readFile(filePath, "utf8");
  const doc = YAML.parseDocument(text);
  await mutate(doc);
  // IMP-04: atomic write so an interrupted edit can't truncate the config.
  await atomicWrite(filePath, doc.toString({ lineWidth: 0 }));
}

// Helper: ensure a path exists as a YAMLMap, creating intermediates.
export function ensureMap(doc: Document, keyPath: string[]): YAMLMap {
  let cur: Node | YAMLMap | null = doc.contents as Node | null;
  if (!cur || !YAML.isMap(cur)) {
    cur = doc.createNode({}) as YAMLMap;
    doc.contents = cur;
  }
  let node = cur as YAMLMap;
  for (const key of keyPath) {
    let next = node.get(key, true) as Node | undefined;
    if (!next || !YAML.isMap(next)) {
      const m = doc.createNode({}) as YAMLMap;
      node.set(key, m);
      next = m;
    }
    node = next as YAMLMap;
  }
  return node;
}

// Set a leaf value at a path, creating intermediate maps as needed.
export function setIn(doc: Document, keyPath: string[], value: unknown): void {
  if (keyPath.length === 0) return;
  const parent = ensureMap(doc, keyPath.slice(0, -1));
  parent.set(keyPath[keyPath.length - 1]!, value);
}

// Delete a key at the given path. Walks intermediate maps; missing keys are silently ignored
// (idempotent). Comments and unrelated keys are preserved by the underlying yaml AST.
export function deleteIn(doc: Document, keyPath: string[]): void {
  if (keyPath.length === 0) return;
  let cur: Node | YAMLMap | null = doc.contents as Node | null;
  if (!cur || !YAML.isMap(cur)) return;
  let node = cur as YAMLMap;
  for (let i = 0; i < keyPath.length - 1; i++) {
    const next = node.get(keyPath[i]!, true) as Node | undefined;
    if (!next || !YAML.isMap(next)) return;
    node = next as YAMLMap;
  }
  node.delete(keyPath[keyPath.length - 1]!);
}
