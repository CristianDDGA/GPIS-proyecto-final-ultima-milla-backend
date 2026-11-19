export interface PackageMigration { name: string; sql: string; checksum: string }
export function readZip(buffer: Buffer): Map<string, Buffer>;
export function loadCanonicalMigrations(zipPath: string | URL, manifestPath: string | URL): PackageMigration[];
export function hashPassword(password: string): Promise<string>;
export function sslOptionFromEnv(env?: Record<string, string | undefined>): { rejectUnauthorized: boolean; ca?: string } | undefined;
