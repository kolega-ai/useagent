"use client";

import { useEffect, useState } from "react";
import { RiKey2Line } from "@remixicon/react";
import { Button } from "@/components/base/buttons/button";
import { InputBase } from "@/components/base/input/input";
import { backendFetch } from "@/lib/backend-fetch";
import { useOrgChanges } from "@/hooks/use-org-changes";
import { SettingsCard, SettingsRow } from "./settings-rows";

/** Organization admins connect a write-only token for the agent's CLI. */
export function SourceControlConnection({ provider }: { provider: "github" | "gitlab" }) {
  const label = provider === "github" ? "GitHub" : "GitLab";
  const [connected, setConnected] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [account, setAccount] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const response = await backendFetch(`/api/${provider}/connection`);
    if (!response.ok) throw new Error("status unavailable");
    const result = await response.json() as { connected?: boolean; account?: string | null };
    setConnected(result.connected === true);
    setAccount(typeof result.account === "string" ? result.account : null);
    setLoaded(true);
  }

  useEffect(() => { void refresh().catch(() => setError(`${label} connection status is unavailable.`)); }, [provider]);
  useOrgChanges((change) => {
    if (change.type === "integration_connection" && change.provider === provider) void refresh().catch(() => setError(`${label} connection status is unavailable.`));
  });

  async function save() {
    if (!token.trim()) return;
    setBusy(true); setError(null);
    try {
      const response = await backendFetch(`/api/${provider}/connection`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: token.trim() }),
      });
      if (!response.ok) throw new Error("connection failed");
      setToken("");
      await refresh();
    } catch { setError(`Could not connect ${label}. Check your token, account access, and organization role.`); }
    finally { setBusy(false); }
  }

  async function disconnect() {
    setBusy(true); setError(null);
    try {
      const response = await backendFetch(`/api/${provider}/connection`, { method: "DELETE" });
      if (!response.ok) throw new Error("disconnect failed");
      setToken("");
      await refresh();
    } catch { setError(`Could not disconnect ${label}. An organization admin must change this connection.`); }
    finally { setBusy(false); }
  }

  return (
    <div className="mt-4">
      <SettingsCard>
        <SettingsRow label={`${label} repositories`} description={!loaded ? "Checking connection..." : connected ? `Connected${account ? ` as ${account}` : ""}` : "Connect a personal access token for agents to use."}>
          {connected ? <Button variant="secondary" size="small" disabled={busy} onClick={() => void disconnect()}>Disconnect</Button> : null}
        </SettingsRow>
        <form className="flex flex-col gap-2 py-3 sm:flex-row" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <InputBase aria-label={`${label} access token`} type="password" autoComplete="off" spellCheck={false}
            leadingIcon={RiKey2Line} placeholder={connected ? `Replace ${label} token` : `${label} access token`}
            value={token} onChange={(event) => setToken(event.target.value)} />
          <Button type="submit" variant="secondary" size="small" disabled={busy || !token.trim()}>Save token</Button>
        </form>
        {error ? <p className="py-2 text-caption-1-regular text-text-error-primary">{error}</p> : null}
      </SettingsCard>
    </div>
  );
}
