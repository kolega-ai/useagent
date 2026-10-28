"use client";

// A person reviews a frozen workspace change before the control plane writes to GitLab.
import { useEffect, useState } from "react";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import * as Modal from "@/components/base/modal/modal";
import { backendFetch } from "@/lib/backend-fetch";

interface Publication {
  id: string; repository: string; targetBranch: string; sourceBranch: string; title: string;
  draft: boolean; state: string; mergeRequestUrl: string | null; error: string | null; expiresAt: string;
  files: { path: string; action: string }[];
}

export function GitLabPublicationDialog({ open, onOpenChange, runId, repositories }: {
  open: boolean; onOpenChange: (open: boolean) => void; runId: string; repositories: readonly string[];
}) {
  const [repository, setRepository] = useState(repositories[0] ?? "");
  const [title, setTitle] = useState("");
  const [draft, setDraft] = useState(true);
  const [publication, setPublication] = useState<Publication | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    void backendFetch(`/api/gitlab/publications/latest/${encodeURIComponent(runId)}`)
      .then(async (response) => response.ok ? await response.json() as { publication?: Publication | null } : null)
      .then((data) => { if (!cancelled) setPublication(data?.publication ?? null); })
      .catch(() => { if (!cancelled) setError("Could not load publication status."); });
    return () => { cancelled = true; };
  }, [open, runId]);

  async function request(path: string, body: unknown) {
    setBusy(true); setError(null);
    try {
      const response = await backendFetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await response.json() as { publication?: Publication; error?: string };
      if (!response.ok || !data.publication) throw new Error(data.error || "Could not complete the request.");
      setPublication(data.publication);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not reach the server.");
      if (publication) {
        // A timeout may follow a successful GitLab write. Show the persisted
        // reconciliation state instead of suggesting a new publication.
        try {
          const status = await backendFetch(`/api/gitlab/publications/${encodeURIComponent(publication.id)}`);
          if (status.ok) {
            const data = await status.json() as { publication?: Publication };
            if (data.publication) setPublication(data.publication);
          }
        } catch { /* Preserve the original error if status is also unavailable. */ }
      }
    }
    finally { setBusy(false); }
  }

  async function downloadPatch() {
    if (!publication) return;
    setError(null);
    try {
      const response = await backendFetch(`/api/gitlab/publications/${encodeURIComponent(publication.id)}/patch`);
      if (!response.ok) throw new Error("Could not download the changes.");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url; link.download = "changes.patch"; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not download the changes."); }
  }

  const settled = publication?.state === "published";
  return (
    <Modal.Root open={open} onOpenChange={onOpenChange}>
      <Modal.Content className="max-w-[520px] rounded-2xl border border-border-button-default bg-background-primary-default shadow-dropdown">
        <Modal.Header title="Create GitLab merge request" description="Review the frozen changes before publishing them." />
        <Modal.Body className="flex max-h-[60dvh] flex-col gap-3 overflow-y-auto pt-3">
          {!publication ? (
            <>
              {repositories.length > 1 ? <div role="group" aria-label="GitLab project" className="flex flex-wrap gap-2">
                {repositories.map((item) => <Button key={item} variant={item === repository ? "primary" : "secondary"} size="small"
                  aria-pressed={item === repository} onClick={() => setRepository(item)}>{item}</Button>)}
              </div> : <p className="text-body-2-medium text-text-primary">{repository}</p>}
              <Input label="Merge request title" value={title} onChange={setTitle} maxLength={220} isDisabled={busy} />
              <Checkbox size="sm" isSelected={draft} onChange={setDraft} isDisabled={busy}>Create as draft</Checkbox>
            </>
          ) : settled ? (
            <p className="text-body-2-regular text-text-primary">Merge request created: {publication.mergeRequestUrl ?
              <a className="underline" href={publication.mergeRequestUrl} target="_blank" rel="noreferrer">Open in GitLab</a> : "Check GitLab for the result."}</p>
          ) : (
            <>
              <p className="text-body-2-medium text-text-primary">{publication.title}{publication.draft ? " (draft)" : ""}</p>
              <p className="text-caption-1-regular text-text-secondary">{publication.repository}<br />{publication.sourceBranch} → {publication.targetBranch}</p>
              <ul className="max-h-52 overflow-y-auto rounded-lg border border-border-button-default p-2 text-caption-1-regular text-text-primary">
                {publication.files.map((file) => <li key={file.path} className="break-all py-0.5">{file.action}: {file.path}</li>)}
              </ul>
              <Button variant="secondary" size="small" onClick={() => void downloadPatch()}>Download full patch to review</Button>
              {publication.state === "reconcile_required" ? <p className="text-caption-1-regular text-text-secondary">The result is uncertain. Retry to check GitLab before creating anything else.</p> : null}
              {publication.state === "publishing" ? <p className="text-caption-1-regular text-text-secondary">Publication is in progress. Check its status; recovery can take a few minutes if the connection was interrupted.</p> : null}
              {publication.error ? <p className="text-caption-1-regular text-text-secondary">{publication.error}</p> : null}
            </>
          )}
          {error ? <p role="alert" className="text-caption-1-regular text-text-error-primary">{error}</p> : null}
        </Modal.Body>
        <Modal.Footer className="justify-end">
          <Button variant="secondary" size="small" onClick={() => onOpenChange(false)}>Close</Button>
          {settled ? <Button variant="secondary" size="small" onClick={() => { setPublication(null); setTitle(""); }}>Prepare another</Button> :
            publication ? <>
              {publication.state === "pending" || publication.state === "failed" ? <Button variant="secondary" size="small" disabled={busy}
                onClick={() => setPublication(null)}>Prepare new</Button> : null}
              <Button variant="primary" size="small" disabled={busy}
                onClick={() => void request(`/api/gitlab/publications/${encodeURIComponent(publication.id)}/publish`, { approved: true })}>
                {busy ? "Publishing..." : publication.state === "reconcile_required" || publication.state === "publishing" ? "Check and retry" : "Approve and create"}
              </Button>
            </> : <Button variant="primary" size="small" disabled={busy || !repository || !title.trim()}
              onClick={() => void request("/api/gitlab/publications/prepare", { runId, repository, title, draft })}>
              {busy ? "Preparing..." : "Prepare review"}
            </Button>}
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
