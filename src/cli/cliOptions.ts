import path from 'path';

export interface SetupCliOptions {
  readonly envFile: string;
  readonly targetPath: string;
  readonly isDev: boolean;
  readonly isDryRun: boolean;
  readonly isDebug: boolean;
  readonly isAdvanced: boolean;
  readonly showHelp: boolean;
}

export interface DoctorCliOptions {
  readonly envFile: string;
  readonly targetPath: string;
  readonly isDev: boolean;
  readonly showHelp: boolean;
}

interface CommonParsedArgs {
  readonly isDev: boolean;
  readonly isDryRun: boolean;
  readonly isDebug: boolean;
  readonly isAdvanced: boolean;
  readonly showHelp: boolean;
  readonly customEnvFile?: string;
}

function parseCliTokens(args: readonly string[]): CommonParsedArgs {
  let isDev = false;
  let isDryRun = false;
  let isDebug = false;
  let isAdvanced = false;
  let showHelp = false;
  let customEnvFile: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const rawArg = args[i].trim();
    const lowerArg = rawArg.toLowerCase();

    if (lowerArg === '--help' || lowerArg === '-help' || lowerArg === '-h' || lowerArg === 'help') {
      showHelp = true;
    } else if (lowerArg === '--dev' || lowerArg === '-dev' || lowerArg === '-d' || lowerArg === 'dev') {
      isDev = true;
    } else if (
      lowerArg === '--dry-run' ||
      lowerArg === '-dry-run' ||
      lowerArg === '--dryrun' ||
      lowerArg === '-dryrun' ||
      lowerArg === '-n' ||
      lowerArg === 'dry-run' ||
      lowerArg === 'dryrun'
    ) {
      isDryRun = true;
    } else if (
      lowerArg === '--advanced' ||
      lowerArg === '-advanced' ||
      lowerArg === '-a' ||
      lowerArg === 'advanced'
    ) {
      isAdvanced = true;
    } else if (lowerArg === '--debug' || lowerArg === '-debug' || lowerArg === 'debug') {
      isDebug = true;
    } else if (lowerArg === '--env' || lowerArg === '-e') {
      const nextArg = args[i + 1]?.trim();
      if (nextArg && !nextArg.startsWith('-')) {
        customEnvFile = nextArg;
        i++;
      }
    } else if (lowerArg.startsWith('--env=')) {
      customEnvFile = rawArg.slice('--env='.length).trim();
    } else if (lowerArg.startsWith('-e=')) {
      customEnvFile = rawArg.slice('-e='.length).trim();
    }
  }

  return {
    isDev,
    isDryRun,
    isDebug,
    isAdvanced,
    showHelp,
    customEnvFile,
  };
}

export function parseSetupCliArgs(
  args: readonly string[],
  workingDirectory: string = process.cwd()
): SetupCliOptions {
  const parsed = parseCliTokens(args);
  let isDryRun = parsed.isDryRun;

  // Default to dry-run when debug mode is enabled without an explicit target
  if (parsed.isDebug && !parsed.customEnvFile && !parsed.isDev) {
    isDryRun = true;
  }

  const envFile = parsed.customEnvFile || (parsed.isDev ? '.env.dev' : '.env');
  const targetPath = path.isAbsolute(envFile) ? envFile : path.join(workingDirectory, envFile);

  return {
    envFile,
    targetPath,
    isDev: parsed.isDev,
    isDryRun,
    isDebug: parsed.isDebug,
    isAdvanced: parsed.isAdvanced,
    showHelp: parsed.showHelp,
  };
}

export function parseDoctorCliArgs(
  args: readonly string[],
  workingDirectory: string = process.cwd()
): DoctorCliOptions {
  const parsed = parseCliTokens(args);
  const envFile = parsed.customEnvFile || (parsed.isDev ? '.env.dev' : '.env');
  const targetPath = path.isAbsolute(envFile) ? envFile : path.join(workingDirectory, envFile);

  return {
    envFile,
    targetPath,
    isDev: parsed.isDev,
    showHelp: parsed.showHelp,
  };
}

export function formatSetupHelp(): string {
  return [
    'Usage: npm run setup [options]',
    '',
    'Interactive setup wizard for Wallet MCP Bookkeeper.',
    '',
    'Options:',
    '  --dev, -dev, dev        Target .env.dev instead of .env (safe development test)',
    '  --dry-run, -dry-run     Simulate setup without writing any files to disk',
    '  --advanced, -a          Show advanced tuning prompts (MCP URL, custom IMAP host/port/lookback)',
    '  --debug, -debug, debug  Run in debug mode (enables dry-run and prints preview)',
    '  --env, -e <filename>    Specify a custom environment file target',
    '  --help, -h, help        Display this help message',
    '',
    'Examples:',
    '  npm run setup',
    '  npm run setup:dev               (or npm run setup -- --dev)',
    '  npm run setup:dry-run           (or npm run setup -- --dry-run)',
    '  npm run setup -- --advanced     (or npm run setup -- -a)',
    '  npm run setup -- --env .env.staging',
  ].join('\n');
}

export function formatDoctorHelp(): string {
  return [
    'Usage: npm run doctor [options]',
    '',
    'Diagnostics tool for Wallet MCP Bookkeeper configuration and services.',
    '',
    'Options:',
    '  --dev, -dev, dev        Validate .env.dev instead of .env',
    '  --env, -e <filename>    Specify a custom environment file to validate',
    '  --help, -h, help        Display this help message',
    '',
    'Examples:',
    '  npm run doctor',
    '  npm run doctor:dev              (or npm run doctor -- --dev)',
    '  npm run doctor -- --env .env.staging',
  ].join('\n');
}
