import fs from "node:fs";
import path from "node:path";
import type { AgentManifest, ArtemisConfig } from "../config/schema.js";
import { HostRuntime } from "./host.js";
import { DockerRuntime } from "./docker.js";
import type { Runtime } from "./base.js";

export function buildRuntime(agent: AgentManifest, config: ArtemisConfig): Runtime {
  // Per-agent container takes precedence over the global default.
  if (agent.container) {
    const binds: Array<{ host: string; container: string; readOnly?: boolean }> = [];
    binds.push({
      host: path.resolve(config.brain.path),
      container: "/brain",
      readOnly: !config.brain.writable,
    });
    // Cross-agent shared writable workspace.
    if (config.runtime.shared.enabled) {
      const sharedHost = path.resolve(config.runtime.shared.hostPath);
      fs.mkdirSync(sharedHost, { recursive: true });
      binds.push({
        host: sharedHost,
        container: config.runtime.shared.containerPath,
        readOnly: false,
      });
    }
    for (const spec of agent.container.bind) {
      // Format: "host:container[:ro]". On Windows the host may have a drive letter
      // (e.g. C:/foo) so use indexOf rather than naive split.
      const firstColon = spec.indexOf(":", spec.length > 1 && spec[1] === ":" ? 2 : 0);
      const lastColon = spec.lastIndexOf(":");
      let host: string, container: string, flag: string | undefined;
      if (firstColon === -1) continue;
      host = spec.slice(0, firstColon);
      if (lastColon !== firstColon && (spec.slice(lastColon + 1) === "ro" || spec.slice(lastColon + 1) === "rw")) {
        container = spec.slice(firstColon + 1, lastColon);
        flag = spec.slice(lastColon + 1);
      } else {
        container = spec.slice(firstColon + 1);
      }
      if (!host || !container) continue;
      // Resolve relative host paths against cwd so `./workspace:/workspace` works.
      const absHost = path.isAbsolute(host) ? host : path.resolve(process.cwd(), host);
      binds.push({ host: absHost, container, readOnly: flag === "ro" });
    }
    return new DockerRuntime({
      image: agent.container.image,
      ...(agent.container.network ? { defaultNetwork: agent.container.network } : {}),
      binds,
      workdir: agent.container.workdir,
      ...(config.runtime.docker?.bin ? { bin: config.runtime.docker.bin } : {}),
      ...(config.runtime.docker?.socket ? { socket: config.runtime.docker.socket } : {}),
    });
  }

  if (config.runtime.default === "docker") {
    // Generic docker runtime with no image — agent must set one or tools must override.
    throw new Error(
      `Runtime default is 'docker' but agent '${agent.name}' has no container.image. Set one in the agent manifest.`,
    );
  }

  return new HostRuntime();
}
