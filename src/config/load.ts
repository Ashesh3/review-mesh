import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parse } from "smol-toml";
import {
  repositoryPolicySchema,
  trustedConfigSchema,
  type RepositoryPolicy,
  type TrustedConfig,
} from "./schemas.js";
import { getAppPaths } from "./paths.js";

export interface LoadConfigFilesInput {
  configFile?: string;
  workspace: string;
}

export interface LoadedConfigFiles {
  trusted: TrustedConfig;
  repository?: RepositoryPolicy;
}

function isWithinDirectory(directory: string, target: string): boolean {
  const path = relative(directory, target);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

async function resolveInstructionFiles(
  trusted: TrustedConfig,
  configFile: string,
): Promise<TrustedConfig> {
  const trustedDirectory = dirname(await realpath(configFile));
  const profiles = await Promise.all(
    Object.entries(trusted.reviewer_profiles).map(async ([id, profile]) => {
      if (profile.instructions_file === undefined) {
        return [id, profile] as const;
      }
      const instructionFile = await realpath(
        resolve(trustedDirectory, profile.instructions_file),
      );
      if (!isWithinDirectory(trustedDirectory, instructionFile)) {
        throw new Error(
          `instruction file escapes trusted configuration directory: ${profile.instructions_file}`,
        );
      }
      const { instructions_file: _instructionsFile, ...remainingProfile } =
        profile;
      return [
        id,
        {
          ...remainingProfile,
          instructions: await readFile(instructionFile, "utf8"),
        },
      ] as const;
    }),
  );

  return trustedConfigSchema.parse({
    ...trusted,
    reviewer_profiles: Object.fromEntries(profiles),
  });
}

export async function loadConfigFiles(
  input: LoadConfigFilesInput,
): Promise<LoadedConfigFiles> {
  const configFile = input.configFile ?? getAppPaths().configFile;
  const trusted = trustedConfigSchema.parse(
    parse(await readFile(configFile, "utf8")),
  );
  const repositoryFile = resolve(input.workspace, ".review-mesh.toml");
  let repository: RepositoryPolicy | undefined;
  try {
    repository = repositoryPolicySchema.parse(
      parse(await readFile(repositoryFile, "utf8")),
    );
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      repository = undefined;
    } else {
      throw error;
    }
  }

  return {
    trusted: await resolveInstructionFiles(trusted, configFile),
    ...(repository === undefined ? {} : { repository }),
  };
}
