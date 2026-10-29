// A named encrypted file and its repository-relative destination.
export interface RepositoryFile {
  readonly name: string;
  readonly path: string;
}

// The thread pins its selected mappings, while the encrypted value may rotate.
export interface ThreadWorkspaceFile extends RepositoryFile {
  readonly repository: string;
  readonly versionId: string;
}
