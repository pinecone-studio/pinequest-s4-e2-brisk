/** Minimal D1 surface used by evidence accessors (matches @cloudflare/workers-types). */

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run(): Promise<D1RunResult>;
  all<T = unknown>(): Promise<D1Result<T>>;
}

export interface D1RunResult {
  success: boolean;
  meta?: Record<string, unknown>;
  error?: string;
}

export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta?: Record<string, unknown>;
  error?: string;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
}
