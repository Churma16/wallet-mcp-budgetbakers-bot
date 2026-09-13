import { loadEnvironmentConfiguration } from '../config/environmentConfig.js';
import {
  renderDoctorResult,
  runDoctorDiagnostics,
} from '../diagnostics/doctorService.js';

async function runDoctor(): Promise<void> {
  console.log('====================================================');
  console.log('[INFO] Wallet MCP Bookkeeper doctor');
  console.log('====================================================');

  let configuration: ReturnType<typeof loadEnvironmentConfiguration>;
  try {
    configuration = loadEnvironmentConfiguration();
  } catch {
    console.error('[ERROR] Configuration: failed to load .env values. Check formatting and configured identifiers.');
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

runDoctor().catch(() => {
  console.error('[ERROR] Doctor failed unexpectedly. Re-run after checking configuration and network access.');
  process.exitCode = 1;
});
