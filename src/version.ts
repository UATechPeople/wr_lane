import pkg from "../package.json";

export type BuildInfo = {
  version: string;
  commit: string | null;
  builtAt: string | null;
};

export const buildInfo: BuildInfo = {
  version: (pkg as { version?: string }).version ?? "0.0.0",
  commit: process.env.BUILD_COMMIT?.trim() || null,
  builtAt: process.env.BUILD_TIME?.trim() || null,
};
