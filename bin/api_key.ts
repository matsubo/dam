import { parseArgs } from 'node:util';
import { sql } from '@dam/db/client';
import { issueKey, revoke } from '@dam/db/repo/api_keys';

async function main(): Promise<void> {
  const sub = process.argv[2];
  const argv = process.argv.slice(3).filter((a) => a !== '--');
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      email: { type: 'string' },
      label: { type: 'string' },
      tier: { type: 'string' },
      id: { type: 'string' },
    },
  });

  if (sub === 'issue') {
    if (!values.email) throw new Error('--email required');
    const tier = (values.tier ?? 'free') as 'free' | 'partner' | 'admin';
    const r = await issueKey({
      email: values.email,
      label: values.label,
      tier,
    });
    console.log(JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
    return;
  }

  if (sub === 'revoke') {
    if (!values.id) throw new Error('--id required');
    await revoke(BigInt(values.id));
    console.log('revoked');
    return;
  }

  if (sub === 'list') {
    const rows =
      await sql`SELECT id, prefix, email, label, tier, active, created_at FROM api_keys ORDER BY id`;
    console.log(JSON.stringify(rows, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    return;
  }

  console.error('Usage: bun run bin/api_key.ts <issue|revoke|list> [flags]');
  process.exit(2);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => sql.end({ timeout: 5 }));
