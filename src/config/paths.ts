import envPaths from "env-paths";
import { join } from "node:path";

export interface AppPaths {
  configFile: string;
  reviewersDirectory: string;
  runsDirectory: string;
}

export function getAppPaths(): AppPaths {
  const paths = envPaths("review-mesh", { suffix: "" });
  return {
    configFile: join(paths.config, "config.toml"),
    reviewersDirectory: join(paths.config, "reviewers"),
    runsDirectory: join(paths.data, "runs"),
  };
}
