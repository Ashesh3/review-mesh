import {
  repositoryPolicySchema,
  trustedConfigSchema,
  type RepositoryPolicy,
  type ResolvedConfig,
  type ResolvedReviewer,
  type TrustedConfig,
} from "./schemas.js";

export interface ResolveConfigInput {
  trusted: TrustedConfig;
  repository?: RepositoryPolicy;
}

function repositoryPolicyError(message: string): Error {
  return new Error(`repository policy is invalid: ${message}`);
}

function resolveProfile(
  trusted: TrustedConfig,
  profileId: string,
  id: string,
  trustedAppendInstructions?: string,
): ResolvedReviewer {
  const profile = trusted.reviewer_profiles[profileId];
  if (profile === undefined) {
    throw new Error(
      `trusted reviewer ${id} references unknown profile ${profileId}`,
    );
  }
  const adapter = trusted.adapters[profile.adapter];
  if (adapter === undefined) {
    throw new Error(
      `trusted reviewer profile ${profileId} references unknown adapter ${profile.adapter}`,
    );
  }
  if (profile.instructions === undefined) {
    throw new Error(
      `trusted reviewer profile ${profileId} has unresolved instructions_file`,
    );
  }

  const instruction_layers: ResolvedReviewer["instruction_layers"] = [
    { source: "trusted", content: profile.instructions },
  ];
  if (trustedAppendInstructions !== undefined) {
    instruction_layers.push({
      source: "trusted",
      content: trustedAppendInstructions,
    });
  }

  return {
    id,
    purpose: profile.purpose,
    adapterId: profile.adapter,
    adapter,
    model: profile.model,
    instruction_layers,
    isolationPolicy: profile.isolation,
    timeoutMs: profile.timeout_ms,
    runtime: profile.runtime ?? {},
  };
}

function applyRepositoryOverride(
  reviewer: ResolvedReviewer,
  override: NonNullable<RepositoryPolicy["reviewer_overrides"]>[number],
): void {
  if (override.append_instructions !== undefined) {
    reviewer.instruction_layers.push({
      source: "repository",
      content: override.append_instructions,
    });
  }
  if (override.timeout_ms !== undefined) {
    if (override.timeout_ms >= reviewer.timeoutMs) {
      throw repositoryPolicyError(
        "timeout_ms must be lower than trusted timeout",
      );
    }
    reviewer.timeoutMs = override.timeout_ms;
  }
  if (
    override.require_enforced === true &&
    reviewer.isolationPolicy === "prefer_enforced"
  ) {
    reviewer.isolationPolicy = "require_enforced";
  }
}

export function resolveConfig(input: ResolveConfigInput): ResolvedConfig {
  const trusted = trustedConfigSchema.parse(input.trusted);
  let repository: RepositoryPolicy | undefined;
  if (input.repository !== undefined) {
    try {
      repository = repositoryPolicySchema.parse(input.repository);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "invalid repository policy";
      throw repositoryPolicyError(message);
    }
  }
  const ids = new Set<string>();
  const reviewers: ResolvedReviewer[] = [];

  for (const definition of trusted.reviewers) {
    if (ids.has(definition.id)) {
      throw new Error(`duplicate trusted reviewer id: ${definition.id}`);
    }
    ids.add(definition.id);
    reviewers.push(
      resolveProfile(
        trusted,
        definition.profile,
        definition.id,
        definition.append_instructions,
      ),
    );
  }

  const overrideIds = new Set<string>();
  for (const override of repository?.reviewer_overrides ?? []) {
    if (overrideIds.has(override.id)) {
      throw repositoryPolicyError(
        `duplicate override for baseline reviewer ${override.id}`,
      );
    }
    overrideIds.add(override.id);
    const reviewer = reviewers.find(
      (candidate) => candidate.id === override.id,
    );
    if (reviewer === undefined) {
      throw repositoryPolicyError(
        `override references unknown baseline reviewer ${override.id}`,
      );
    }
    applyRepositoryOverride(reviewer, override);
  }

  for (const definition of repository?.reviewers ?? []) {
    const id = `repo:${definition.id}`;
    if (ids.has(definition.id) || ids.has(id)) {
      throw repositoryPolicyError(`reviewer id collision for ${definition.id}`);
    }
    ids.add(id);
    let reviewer: ResolvedReviewer;
    try {
      reviewer = resolveProfile(trusted, definition.profile, id);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "invalid repository reviewer";
      throw repositoryPolicyError(message);
    }
    if (definition.instructions !== undefined) {
      reviewer.instruction_layers.push({
        source: "repository",
        content: definition.instructions,
      });
    }
    applyRepositoryOverride(reviewer, definition);
    reviewers.push(reviewer);
  }

  return {
    execution: trusted.execution,
    diagnostics: trusted.diagnostics,
    ...(repository?.context === undefined
      ? {}
      : { repository_context: repository.context }),
    reviewers,
  };
}
