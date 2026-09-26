import { parseArgs } from 'node:util';
import { inspectMigrationSource, copyMigrationData, migrationSummary, MigrationError } from '../src/runtime/data-migration.ts';

const help = `Windows data migration prototype (no application installation or registration).

Use the bundled Node.js 22.16.0 with --experimental-strip-types.
  data-migration.mjs inspect <SillyTavern directory>
  data-migration.mjs copy <SillyTavern directory> <NEW destination> --source-stopped

Options:
  --data-root <directory>   Explicit data directory used by the old launcher.
  --allow-external-data    Permit a data directory outside the selected installation.
  --include-secrets        Explicitly include secrets.json files (excluded by default).
  --source-stopped         Confirm that the old SillyTavern is not writing data.
  --help                   Show this help.

Copy never overwrites a destination, starts code, registers an instance, or deletes source data.
This prototype supports 1.12+ data layouts in SillyTavern 1.x; ZIP and legacy layouts are not supported.
`;

const controller = new AbortController();
process.once('SIGINT', () => controller.abort());

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      'data-root': { type: 'string' },
      'allow-external-data': { type: 'boolean' },
      'include-secrets': { type: 'boolean' },
      'source-stopped': { type: 'boolean' },
    },
  });
  if (values.help) {
    console.log(help);
  } else {
    const [command, source, destination] = positionals;
    if (!source || !['inspect', 'copy'].includes(command)
        || (command === 'inspect' && positionals.length !== 2)
        || (command === 'copy' && positionals.length !== 3)) {
      throw new MigrationError('USAGE', help);
    }
    const options = {
      dataRoot: values['data-root'],
      allowExternalData: values['allow-external-data'],
      includeSecrets: values['include-secrets'],
      signal: controller.signal,
    };
    if (command === 'inspect') {
      console.log(JSON.stringify(migrationSummary(await inspectMigrationSource(source, options)), null, 2));
    } else {
      const result = await copyMigrationData(source, destination, {
        ...options,
        sourceStopped: Boolean(values['source-stopped']),
        onProgress(progress) {
          if (process.stderr.isTTY) {
            process.stderr.write(`\r${progress.phase}: ${progress.completedFiles}/${progress.totalFiles} files`);
          }
        },
      });
      if (process.stderr.isTTY) process.stderr.write('\n');
      console.log(JSON.stringify(result, null, 2));
    }
  }
} catch (error) {
  const code = error instanceof MigrationError ? error.code : 'SOURCE_ACCESS_FAILED';
  const message = error instanceof MigrationError ? error.message : 'Unable to access the source or destination. No metadata contents were logged.';
  console.error(JSON.stringify({ code, message }));
  process.exitCode = code === 'CANCELLED' ? 130 : 1;
}
