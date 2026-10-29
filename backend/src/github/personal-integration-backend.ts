// Register the personal-token connection with the shared integration catalog.
import type { DelegatedConnectionBackend } from "../integrations/backend";
import { GITHUB_PERSONAL_CONNECTION_BINDING } from "./personal-connection";

export const githubPersonalIntegrationBackend: DelegatedConnectionBackend = {
  kind: "delegated", catalogBackend: "native", catalogAuthMethod: "api_key",
  runtimeBindingId: GITHUB_PERSONAL_CONNECTION_BINDING, disconnectSupported: false,
  supports: (provider) => provider === "github",
  async listConnectableProviders() { return []; },
  async startConnect() { throw new Error("Connect GitHub with the token form in Settings"); },
  async completeConnect() { throw new Error("Connect GitHub with the token form in Settings"); },
  async disconnect() { throw new Error("Disconnect GitHub with the token form in Settings"); },
  async listActions() { return []; },
  async executeAction() { throw new Error("GitHub token integration actions are unavailable"); },
};
