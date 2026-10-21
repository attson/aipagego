import type { PairPayload, PairingDecision, TrustRecord } from "@aipagego/shared/pairing";

/**
 * Install-level trust store.
 *
 * Trust is granted to an installation, not to a session or a directory: the
 * secret lives in the user's home directory, so anything able to read it could
 * claim any session id or working directory it liked. `sessionId` and `label`
 * are therefore carried for display and management only.
 *
 * What this protects against is a local process silently taking control of the
 * browser. What it cannot protect against is a process that can read
 * `~/.aipagego/` — which could already do considerably worse.
 */

const KEY = "aipagego.pairing.trusted";

async function readAll(): Promise<TrustRecord[]> {
  try {
    const got = await chrome.storage.local.get(KEY);
    const raw = got?.[KEY];
    return Array.isArray(raw) ? (raw as TrustRecord[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(records: TrustRecord[]): Promise<void> {
  await chrome.storage.local.set({ [KEY]: records });
}

/** Length-independent comparison — this is a credential, not a label. */
function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function decidePairing(payload: PairPayload): Promise<PairingDecision> {
  const known = (await readAll()).find((r) => r.installId === payload.installId);
  if (!known) return "ask";
  if (!secretsMatch(known.secret, payload.secret)) {
    // The likely cause is another process having taken the remembered port and
    // claiming an install id it cannot back up.
    console.warn(
      "[aipagego] pairing: known installId with a mismatched secret — asking the user",
      payload.installId
    );
    return "ask";
  }
  return "trusted";
}

export async function approve(payload: PairPayload): Promise<void> {
  const records = (await readAll()).filter((r) => r.installId !== payload.installId);
  records.push({
    installId: payload.installId,
    secret: payload.secret,
    approvedAt: Date.now()
  });
  await writeAll(records);
}

export async function listTrusted(): Promise<TrustRecord[]> {
  return readAll();
}

export async function revokeTrust(installId: string): Promise<void> {
  await writeAll((await readAll()).filter((r) => r.installId !== installId));
}
