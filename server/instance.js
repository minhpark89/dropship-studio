import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { StudioError } from "./store.js";

// The desktop shell may find a live server from an earlier launch. Include a
// compact source identity in the lock and API descriptor so a new shell never
// silently attaches to a stale backend with different runtime behavior.
const BUILD_ID = createHash("sha256")
  .update(fs.readFileSync(fileURLToPath(import.meta.url)))
  .digest("hex")
  .slice(0, 16);

function locations(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const root = fs.realpathSync(directory);
  return { root, file: path.join(root, ".server-instance.json") };
}

function readOwner(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

export function claimInstance(directory) {
  const { root, file } = locations(directory);
  const identity = {
    app: "dropship-studio",
    build: BUILD_ID,
    id: randomUUID(),
    pid: process.pid,
    root,
    address: null,
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    let descriptor;
    try {
      descriptor = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(identity), "utf8");
      fs.fsyncSync(descriptor);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const previous = readOwner(file);
      const recentIncomplete =
        !previous && Date.now() - fs.statSync(file).mtimeMs < 30000;
      if (recentIncomplete || isAlive(previous?.pid)) {
        throw new StudioError(
          "Dữ liệu này đang được một cửa sổ Dropship Studio sử dụng. Mở cửa sổ đang chạy để tiếp tục.",
          "INSTANCE_RUNNING",
          409,
        );
      }
      // Only remove this app's stale lock file, never any project or profile data.
      fs.unlinkSync(file);
      continue;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    return {
      identity,
      setAddress(address) {
        identity.address = address;
        fs.writeFileSync(file, JSON.stringify(identity), { mode: 0o600 });
      },
      release() {
        if (readOwner(file)?.id === identity.id) fs.unlinkSync(file);
      },
    };
  }
  throw new StudioError(
    "Chưa thể mở dữ liệu ứng dụng. Hãy thử mở lại.",
    "INSTANCE_RUNNING",
    409,
  );
}

export async function findInstance(directory) {
  const { root, file } = locations(directory);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (!fs.existsSync(file)) return null;
    const owner = readOwner(file);
    if (owner && !isAlive(owner.pid)) return null;
    if (owner?.address && /^http:\/\/127\.0\.0\.1:\d+$/.test(owner.address)) {
      try {
        const response = await fetch(`${owner.address}/api/instance`, {
          signal: AbortSignal.timeout(1500),
        });
        const live = await response.json();
        if (
          response.ok &&
          live.app === "dropship-studio" &&
          live.build === BUILD_ID &&
          owner.build === BUILD_ID &&
          live.id === owner.id &&
          live.root === root
        ) {
          return { address: owner.address, root };
        }
      } catch {
        // The owner may still be starting or closing its HTTP listener.
      }
    }
    await delay(200);
  }
  return null;
}
