import type { z } from "zod";

/** Thrown when environment variables are missing or invalid. Lists variable names only, never values. */
export class EnvError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid environment configuration: ${issues.join("; ")}`);
    this.name = "EnvError";
    this.issues = issues;
  }
}

/**
 * Parses environment variables against a Zod object schema.
 * Error messages name the variable and the problem but never echo the value, so secrets cannot leak into logs.
 */
export function loadEnv<T extends z.ZodType>(
  schema: T,
  source: Readonly<Record<string, string | undefined>>,
): z.output<T> {
  const result = schema.safeParse(source);
  if (result.success) {
    return result.data;
  }
  const issues = result.error.issues.map((issue) => {
    const key = issue.path.map(String).join(".") || "(root)";
    return `${key}: ${issue.message}`;
  });
  throw new EnvError(issues);
}
