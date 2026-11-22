/** Every storage key under `${userId}/` inside a value — nested arrays and JSON included. */
export function collectOwnedPaths(values: unknown, userId: string): string[] {
  const paths = new Set<string>();
  const prefix = `${userId}/`;

  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.startsWith(prefix)) paths.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>)) {
        visit(item);
      }
    }
  };

  visit(values);
  return [...paths];
}
