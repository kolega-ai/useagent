// Register the native token connection with the shared integration catalog.
import type { DelegatedConnectionBackend } from "../integrations/backend";
import { GITLAB_CONNECTION_BINDING } from "./connection";

export const gitlabIntegrationBackend: DelegatedConnectionBackend = {
  kind: "delegated", catalogBackend: "native", catalogAuthMethod: "api_key",
  runtimeBindingId: GITLAB_CONNECTION_BINDING, disconnectSupported: false,
  supports: (provider) => provider === "gitlab",
  async listConnectableProviders() { return []; },
  async startConnect() { throw new Error("Connect GitLab with the token form in Settings"); },
  async completeConnect() { throw new Error("Connect GitLab with the token form in Settings"); },
  async disconnect() { throw new Error("Disconnect GitLab with the token form in Settings"); },
  async listActions() { return []; },
  async executeAction() { throw new Error("GitLab integration actions are unavailable"); },
};
