"use client";

import { RiCalendarScheduleLine, RiErrorWarningLine, RiTimeZoneLine } from "@remixicon/react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/base/buttons/button";
import { HintText } from "@/components/base/input/hint-text";
import { Input } from "@/components/base/input/input";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import * as Modal from "@/components/base/modal/modal";
import { Select, SelectItem } from "@/components/base/select/select";
import * as Textarea from "@/components/base/textarea/textarea";
import { useEnabledEngineConfig } from "@/components/chat/engine-picker";
import { modelLabel, type EngineId } from "@/components/chat/types";
import { loadRepoList } from "@/lib/repo-list";
import { loadRepositoryFileProjects, type RepositoryFileProject } from "@/lib/repository-files";
import { RepoMultiPicker, type RepoItem } from "@/app/(workspace)/agent/new/repo-multi-picker";
import { cx } from "@/utils/cx";
import type { CreateScheduleInput } from "./schedules-api";
import {
  automationEditorEngineOptions,
  cadenceLabel,
  reconcileAutomationEngine,
  type ScheduleRecord,
} from "./schedules-data";

const CADENCE_PRESETS = [
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Daily", cron: "0 9 * * *" },
  { label: "Weekdays", cron: "0 9 * * 1-5" },
  { label: "Weekly", cron: "0 9 * * 1" },
] as const;

function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function looksLikeCron(value: string): boolean {
  return value.trim().split(/\s+/).length === 5;
}

export function AutomationEditorModal({
  open,
  schedule,
  onClose,
  onSave,
}: {
  open: boolean;
  schedule: ScheduleRecord | null;
  onClose: () => void;
  onSave: (input: CreateScheduleInput) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [cron, setCron] = useState<string>(CADENCE_PRESETS[2].cron);
  const [timezone, setTimezone] = useState(localZone);
  const { engines: enabledEngines, models, runtimes } = useEnabledEngineConfig();
  const engineOptions = useMemo(
    () => automationEditorEngineOptions(enabledEngines, schedule?.engine),
    [enabledEngines, schedule?.engine],
  );
  const [engine, setEngine] = useState("");
  const [model, setModel] = useState("");
  const [codeMode, setCodeMode] = useState<"none" | "agent" | "publish" | "review">("none");
  const [codeRepo, setCodeRepo] = useState("");
  const [codeDraft, setCodeDraft] = useState(true);
  const [allowSandboxActions, setAllowSandboxActions] = useState(true);
  const [repos, setRepos] = useState<RepoItem[]>([]);
  const [projects, setProjects] = useState<RepositoryFileProject[]>([]);
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(schedule?.name ?? "");
    setPrompt(schedule?.prompt ?? "");
    setCron(schedule?.cron ?? CADENCE_PRESETS[2].cron);
    setTimezone(schedule ? (schedule.timezone ?? "") : localZone());
    setEngine(schedule?.engine ?? "");
    setModel(schedule?.model ?? "");
    setCodeMode(schedule?.code_policy?.mode ?? "none");
    setCodeRepo(schedule?.code_policy?.repository ?? "");
    setCodeDraft(schedule?.code_policy?.draft ?? true);
    setAllowSandboxActions(schedule?.code_policy?.allowSandboxActions ?? true);
    setSelectedFiles(schedule?.workspace_file_selection ?? []);
    setBusy(false);
    setError(null);
  }, [open, schedule]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void loadRepoList().then((items) => {
      if (!cancelled) setRepos(items.map((item) => ({ full_name: item.full_name, name: item.name ?? item.full_name.split("/").at(-1) ?? item.full_name,
        default_branch: item.default_branch ?? "main", private: item.private })));
    }).catch(() => { if (!cancelled) setRepos([]); });
    void loadRepositoryFileProjects().then((items) => { if (!cancelled) setProjects(items); })
      .catch(() => { if (!cancelled) setError("Couldn't load repository files."); });
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    if (!open || schedule) return;
    setEngine((current) => reconcileAutomationEngine(engineOptions, current));
  }, [engineOptions, open, schedule]);

  const cronValid = looksLikeCron(cron);
  const needsSandboxAgent = codeMode !== "none" && runtimes[engine as EngineId]?.kind === "direct";
  const canSubmit = Boolean(name.trim() && prompt.trim() && engine && cronValid && !busy && !needsSandboxAgent && (codeMode === "none" || codeRepo));

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        prompt: prompt.trim(),
        cron: cron.trim(),
        timezone: timezone.trim() || null,
        engine,
        workspaceFileSelection: codeMode === "none" ? [] : selectedFiles,
        ...(model ? { model } : {}),
        ...(codeMode === "none" ? { codePolicy: null, ...(schedule?.code_policy ? { repos: [] } : {}) } : {
          repos: [codeRepo],
          codePolicy: codeMode === "agent"
            ? { version: 2, mode: "agent", repository: codeRepo, draft: false, allowSandboxActions }
            : { version: 1, mode: codeMode, repository: codeRepo, draft: codeDraft, allowSandboxActions },
        }),
      });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn’t save automation");
      setBusy(false);
    }
  };

  return (
    <Modal.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Modal.Content className="max-w-[620px]">
        <Modal.Header
          icon={RiCalendarScheduleLine}
          title={schedule ? "Edit automation" : "Create automation"}
          description={
            schedule
              ? "Update its instructions, agent, or cadence."
              : "Define recurring work. New automations start paused so you can review them first."
          }
        />

        <Modal.Body className="flex max-h-[70vh] flex-col gap-5 overflow-y-auto">
          <Input
            label="What should run?"
            placeholder="Weekly dependency review"
            value={name}
            onChange={setName}
          />

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="automation-instructions"
              className="text-body-2-medium text-text-primary"
            >
              Instructions
            </label>
            <Textarea.Root
              id="automation-instructions"
              simple
              rows={5}
              placeholder="Review dependency updates, run the relevant checks, and prepare a focused patch when an update is safe."
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
            <HintText>Include the repository, expected output, and success criteria.</HintText>
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-body-2-medium text-text-primary">Cadence</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {CADENCE_PRESETS.map((preset) => (
                <button
                  key={preset.cron}
                  type="button"
                  onClick={() => setCron(preset.cron)}
                  className={cx(
                    "rounded-xl border px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                    cron === preset.cron
                      ? "border-foreground-icon-primary bg-foreground-icon-primary text-background-full"
                      : "border-border-button-default bg-background-primary-default text-text-secondary hover:bg-background-secondary-default",
                  )}
                >
                  <span className="block text-body-2-medium">{preset.label}</span>
                  <span className="mt-0.5 block font-mono text-caption-1-medium opacity-70">
                    {preset.cron}
                  </span>
                </button>
              ))}
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Cron expression"
              inputClassName="font-mono"
              isInvalid={!cronValid && cron.trim().length > 0}
              value={cron}
              onChange={setCron}
              hint={cronValid ? cadenceLabel(cron) : "Use five cron fields."}
            />

            <Input
              label="Timezone"
              leadingIcon={RiTimeZoneLine}
              placeholder={schedule ? "Server timezone" : "Asia/Kolkata"}
              value={timezone}
              onChange={setTimezone}
              hint="Use an IANA timezone such as Europe/London."
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <span id="automation-agent-label" className="text-body-2-medium text-text-primary">
              Agent
            </span>
            <Select
              aria-labelledby="automation-agent-label"
              selectedKey={engine || null}
              onSelectionChange={(key) => { const next = String(key) as EngineId; setEngine(next); setModel(schedule ? (models[next]?.[0] ?? "") : ""); }}
            >
              {engineOptions.map(({ id, label }) => (
                <SelectItem key={id} id={id}>
                  {label}
                </SelectItem>
              ))}
            </Select>
          </div>

          {(models[engine as EngineId]?.length ?? 0) > 0 ? <div className="flex flex-col gap-1.5">
            <span id="automation-model-label" className="text-body-2-medium text-text-primary">Model</span>
            <Select aria-labelledby="automation-model-label" selectedKey={model || null} onSelectionChange={(key) => setModel(String(key))}>
              {(models[engine as EngineId] ?? []).map((item) => <SelectItem key={item} id={item}>{modelLabel(item, engine as EngineId)}</SelectItem>)}
            </Select>
            <HintText>Leave empty to use the agent's default model.</HintText>
          </div> : null}

          <div className="flex flex-col gap-2">
            <span id="automation-code-label" className="text-body-2-medium text-text-primary">Repository work</span>
            <Select aria-labelledby="automation-code-label" selectedKey={codeMode} onSelectionChange={(key) => setCodeMode(String(key) as "none" | "agent" | "publish" | "review")}>
              <SelectItem id="none">No repository action</SelectItem>
              <SelectItem id="agent">Agent works in a repository</SelectItem>
              {schedule?.code_policy?.version === 1 && schedule.code_policy.mode === "publish" ? <SelectItem id="publish">Existing pull or merge request workflow</SelectItem> : null}
              {schedule?.code_policy?.version === 1 && schedule.code_policy.mode === "review" ? <SelectItem id="review">Existing review and merge workflow</SelectItem> : null}
            </Select>
            {codeMode !== "none" ? <>
              {needsSandboxAgent ? <HintText isInvalid>Choose a coding agent that runs in a sandbox.</HintText> : null}
              <RepoMultiPicker repos={repos} value={codeRepo ? [codeRepo] : []} emptyLabel="Choose repository"
                onChange={(items) => { const next = items.at(-1) ?? ""; if (next !== codeRepo) setSelectedFiles([]); setCodeRepo(next); }}
                onDiscover={(repo) => setRepos((items) => items.some((item) => item.full_name === repo.full_name) ? items : [...items, repo])} />
              {codeRepo ? <p className="break-all text-caption-1-regular text-text-secondary">{codeRepo}</p> : null}
              {(projects.find((project) => project.repo_full_name === codeRepo)?.workspace_files ?? []).map((file) => (
                <Checkbox key={`${file.name}:${file.path}`} size="sm" isSelected={selectedFiles.includes(file.name)}
                  onChange={(checked) => setSelectedFiles((current) => checked ? [...new Set([...current, file.name])] : current.filter((name) => name !== file.name))}>
                  Use {file.name} at {file.path}
                </Checkbox>
              ))}
              {codeMode === "publish" ? <Checkbox size="sm" isSelected={codeDraft} onChange={setCodeDraft}>Open as draft</Checkbox> :
                codeMode === "review" ? <HintText>Reviews one open request per run and merges only the approved revision when the provider permits it.</HintText> :
                  <HintText>The agent can use connected GitHub and GitLab accounts to carry out your instructions.</HintText>}
              <Checkbox size="sm" isSelected={allowSandboxActions} onChange={setAllowSandboxActions}>{codeMode === "agent" ? "Allow agent actions without asking" : "Allow sandbox commands and file changes without asking"}</Checkbox>
              {codeMode !== "agent" ? <HintText>This setting authorizes the selected repository action without a separate approval for each request.</HintText> : null}
            </> : null}
          </div>

          {error && (
            <HintText isInvalid className="flex items-center gap-1">
              <RiErrorWarningLine className="size-4 shrink-0" aria-hidden />
              {error}
            </HintText>
          )}
        </Modal.Body>

        <Modal.Footer>
          <p className="hidden text-caption-1-regular text-text-tertiary sm:block">
            {schedule ? "Changes apply to the next run." : "Created in paused state."}
          </p>
          <div className="ml-auto flex gap-2">
            <Button variant="secondary" size="small" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="neutral"
              size="small"
              onClick={() => void submit()}
              disabled={!canSubmit}
            >
              {busy ? "Saving…" : schedule ? "Save changes" : "Create automation"}
            </Button>
          </div>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
