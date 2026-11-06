import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadEnvironmentConfiguration } from '../config/environmentConfig.js';
import {
  renderDoctorResult,
  runDoctorDiagnostics,
} from './doctorService.js';
import {
  DoctorCliOptions,
  formatDoctorHelp,
  parseDoctorCliArgs,
} from './cliOptions.js';

export async function runDoctor(
  initialOptions?: Partial<DoctorCliOptions>,
  customWorkingDirectory?: string
): Promise<void> {
  const workingDirectory = customWorkingDirectory || process.cwd();
  const cliOptions: DoctorCliOptions = {
    ...parseDoctorCliArgs(process.argv.slice(2), workingDirectory),
    ...initialOptions,
  };

  if (cliOptions.showHelp) {
    console.log(formatDoctorHelp());
    return;
  }

  console.log('====================================================');
  console.log('[INFO] Wallet MCP Bookkeeper doctor');
  if (cliOptions.isDev || cliOptions.envFile !== '.env') {
    console.log(`[TARGET] Environment file: ${cliOptions.envFile}`);
  }
  console.log('====================================================');

  const resolvedEnvPath = cliOptions.targetPath;
  const isExplicitTarget = cliOptions.isDev || cliOptions.envFile !== '.env';
  if (isExplicitTarget && !fs.existsSync(resolvedEnvPath)) {
    console.error(`[ERROR] Configuration: Environment file '${cliOptions.envFile}' not found.`);
    if (cliOptions.isDev) {
      console.error(`[INFO] Run 'npm run setup:dev' to generate '${cliOptions.envFile}'.`);
    }
    process.exitCode = 1;
    return;
  }

  let configuration: ReturnType<typeof loadEnvironmentConfiguration>;
  try {
    configuration = fs.existsSync(resolvedEnvPath)
      ? loadEnvironmentConfiguration({ envPath: resolvedEnvPath, isolateEnv: true })
      : loadEnvironmentConfiguration();
  } catch {
    console.error(`[ERROR] Configuration: failed to load ${cliOptions.envFile} values. Check formatting and configured identifiers.`);
    process.exitCode = 1;
    return;
  }

  const results = await runDoctorDiagnostics(configuration);
  for (const result of results) {
    console.log(renderDoctorResult(result));
  }

  const errorCount = results.filter(result => result.status === 'ERROR').length;
  const warningCount = results.filter(result => result.status === 'WARN').length;

  console.log('----------------------------------------------------');
  if (errorCount > 0) {
    console.log(`[ERROR] Doctor found ${errorCount} error(s) and ${warningCount} warning(s).`);
    process.exitCode = 1;
    return;
  }

  if (warningCount > 0) {
    console.log(`[WARN] Doctor completed with ${warningCount} warning(s).`);
    return;
  }

  console.log('[SUCCESS] All configured checks passed.');
}

const invokedScriptPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const currentFilePath = fileURLToPath(import.meta.url);
const isDirectlyExecuted = Boolean(
  invokedScriptPath &&
  (invokedScriptPath === currentFilePath ||
   invokedScriptPath.endsWith('/doctor.ts') ||
   invokedScriptPath.endsWith('/doctor.js'))
);

if (isDirectlyExecuted) {
  runDoctor().catch(() => {
    console.error('[ERROR] Doctor failed unexpectedly. Re-run after checking configuration and network access.');
    process.exitCode = 1;
  });
}
