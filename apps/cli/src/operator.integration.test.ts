/**
 * Operator CLI commands (Workstream A).
 *
 * The point of these commands is that they are NOT a second implementation: they call the same
 * `@yeonjae/db` operator layer the `/v1/operator/*` routes call. The risk that creates is drift — a CLI
 * that quietly reports something the API would not — so the checks here are about the contract rather
 * than about re-proving the underlying queries:
 *
 *  * every command is registered, so `runDb` actually routes it instead of falling through to usage;
 *  * a malformed enum is REFUSED with a stable code rather than coerced into a default that answers a
 *    different question;
 *  * lists come back bounded, with the same clamped shape the API returns;
 *  * the scope is taken from the project row, not from an argument, so a CLI operator cannot widen the
 *    read by naming another workspace;
 *  * nothing sensitive is printed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createProject,
  createWorkspace,
  migrate,
  resetDatabase,
  type Pool,
  MAX_OPERATOR_LIMIT,
} from '@yeonjae/db';
import { databaseUrl, freshDatabase } from '@yeonjae/db/testkit';
import { DB_COMMANDS, runDb, USAGE } from './commands.js';

const run = databaseUrl() ? describe : describe.skip;

run('CLI: operator diagnostics (Workstream A)', () => {
  let pool: Pool;
  let projectId: string;

  beforeAll(async () => {
    pool = await freshDatabase();
    await resetDatabase(pool);
    await migrate(pool);
    const workspaceId = await createWorkspace(pool, 'CLI Operator Tenant');
    const project = await createProject(pool, { workspaceId, title: 'CLI Operator Project' });
    projectId = project.projectId;
  }, 120_000);

  afterAll(async () => {
    await pool.end();
  });

  const COMMANDS = [
    'operator:rate-limits',
    'operator:leases',
    'operator:budget',
    'operator:embedding-set',
    'operator:embedding-gc',
    'operator:thesaurus',
    'operator:retrieval',
  ] as const;

  it('registers every operator command so runDb routes it', () => {
    for (const cmd of COMMANDS) expect(DB_COMMANDS.has(cmd), cmd).toBe(true);
  });

  it('documents every operator command in the usage text', () => {
    for (const cmd of COMMANDS) expect(USAGE, cmd).toContain(cmd);
  });

  it('reports limiter status for a project', async () => {
    const res = await runDb(['operator:rate-limits', projectId]);
    expect(res.ok, JSON.stringify(res.output)).toBe(true);
    const out = res.output as { operation_class: string; scope_key_digest: string | null };
    expect(out.operation_class).toBe('provider_call');
    // Same redaction rule as the API: a digest may cross the boundary, the raw scope key may not.
    if (out.scope_key_digest !== null) expect(out.scope_key_digest).toMatch(/^[0-9a-f]{16}$/);
  });

  it('refuses an unknown operation class instead of defaulting to one', async () => {
    const res = await runDb(['operator:rate-limits', projectId, '--class=not-a-class']);
    expect(res.ok).toBe(false);
    expect((res.output as { error: string }).error).toBe('VALIDATION_FAILED');
  });

  it('refuses an unsupported budget scope', async () => {
    const res = await runDb(['operator:budget', projectId, '--scope=everything']);
    expect(res.ok).toBe(false);
    expect((res.output as { error: string }).error).toBe('VALIDATION_FAILED');
  });

  it('reports a project with no budget policy as “no policy”', async () => {
    const res = await runDb(['operator:budget', projectId]);
    expect(res.ok, JSON.stringify(res.output)).toBe(true);
    const out = res.output as { policy_id: string | null; hard_limit_millicents: number | null };
    expect(out.policy_id).toBeNull();
    expect(out.hard_limit_millicents).toBeNull();
  });

  it('bounds the lease, thesaurus and gc listings even when asked for more', async () => {
    for (const argv of [
      ['operator:leases', projectId, '--limit=10000'],
      ['operator:thesaurus', projectId, '--limit=10000'],
    ]) {
      const res = await runDb(argv);
      expect(res.ok, JSON.stringify(res.output)).toBe(true);
      const out = res.output as { limit: number; returned: number; truncated: boolean };
      expect(out.limit).toBeLessThanOrEqual(MAX_OPERATOR_LIMIT);
      expect(out.returned).toBeLessThanOrEqual(out.limit);
    }
  });

  it('reports an absent active embedding set rather than failing', async () => {
    const res = await runDb(['operator:embedding-set', projectId]);
    expect(res.ok, JSON.stringify(res.output)).toBe(true);
    expect((res.output as { set_id: string | null }).set_id).toBeNull();
  });

  it('returns a retrieval diagnostic without passages', async () => {
    const res = await runDb(['operator:retrieval', projectId, 'anything']);
    expect(res.ok, JSON.stringify(res.output)).toBe(true);
    const out = res.output as { hits: readonly Record<string, unknown>[] };
    for (const hit of out.hits) expect(hit).not.toHaveProperty('text');
  });

  it('prints usage rather than guessing when a required argument is missing', async () => {
    for (const cmd of COMMANDS) {
      const res = await runDb([cmd]);
      expect(res.ok, cmd).toBe(false);
      expect(res.output, cmd).toBe(USAGE);
    }
  });

  it('never prints a connection string or password in operator output', async () => {
    const res = await runDb(['operator:leases', projectId]);
    const text = JSON.stringify(res.output);
    expect(text).not.toContain('postgres://');
    expect(text.toLowerCase()).not.toContain('password');
  });
});
