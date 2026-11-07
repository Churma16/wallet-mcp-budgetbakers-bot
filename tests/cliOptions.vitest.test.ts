import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  formatDoctorHelp,
  formatSetupHelp,
  parseDoctorCliArgs,
  parseSetupCliArgs,
} from '../src/cli/cliOptions.js';

describe('cliOptions parser', () => {
  describe('parseSetupCliArgs', () => {
    it('returns default options when no arguments are provided', () => {
      const options = parseSetupCliArgs([], '/custom/workspace');
      expect(options.envFile).toBe('.env');
      expect(options.targetPath).toBe(path.join('/custom/workspace', '.env'));
      expect(options.isDev).toBe(false);
      expect(options.isDryRun).toBe(false);
      expect(options.isDebug).toBe(false);
      expect(options.showHelp).toBe(false);
    });

    it.each([
      ['--dev'],
      ['-dev'],
      ['dev'],
      ['-d'],
    ])('detects dev flag %s and targets .env.dev', (flag) => {
      const options = parseSetupCliArgs([flag], '/workspace');
      expect(options.isDev).toBe(true);
      expect(options.envFile).toBe('.env.dev');
      expect(options.targetPath).toBe(path.join('/workspace', '.env.dev'));
      expect(options.isDryRun).toBe(false);
    });

    it.each([
      ['--advanced'],
      ['-advanced'],
      ['-a'],
      ['advanced'],
    ])('detects advanced flag %s', (flag) => {
      const options = parseSetupCliArgs([flag], '/workspace');
      expect(options.isAdvanced).toBe(true);
      expect(options.envFile).toBe('.env');
      expect(options.isDryRun).toBe(false);
    });

    it.each([
      ['--dry-run'],
      ['-dry-run'],
      ['--dryrun'],
      ['-dryrun'],
      ['dry-run'],
      ['dryrun'],
      ['-n'],
    ])('detects dry-run flag %s without mutating target file', (flag) => {
      const options = parseSetupCliArgs([flag], '/workspace');
      expect(options.isDryRun).toBe(true);
      expect(options.envFile).toBe('.env');
    });

    it.each([
      ['--debug'],
      ['-debug'],
      ['debug'],
    ])('detects debug flag %s and defaults to dry-run when targeting default .env', (flag) => {
      const options = parseSetupCliArgs([flag], '/workspace');
      expect(options.isDebug).toBe(true);
      expect(options.isDryRun).toBe(true);
      expect(options.envFile).toBe('.env');
    });

    it('enables debug with dev target without forcing dry-run', () => {
      const options = parseSetupCliArgs(['--dev', '--debug'], '/workspace');
      expect(options.isDev).toBe(true);
      expect(options.isDebug).toBe(true);
      expect(options.isDryRun).toBe(false);
      expect(options.envFile).toBe('.env.dev');
    });

    it('allows combining --dev and --dry-run', () => {
      const options = parseSetupCliArgs(['--dev', '--dry-run'], '/workspace');
      expect(options.isDev).toBe(true);
      expect(options.isDryRun).toBe(true);
      expect(options.envFile).toBe('.env.dev');
    });

    it.each([
      [['--env', '.env.staging'], '.env.staging'],
      [['-e', '.env.local'], '.env.local'],
      [['--env=.env.test'], '.env.test'],
      [['-e=.env.qa'], '.env.qa'],
    ])('parses custom env file arguments %j as %s', (args, expectedFile) => {
      const options = parseSetupCliArgs(args, '/workspace');
      expect(options.envFile).toBe(expectedFile);
      expect(options.targetPath).toBe(path.join('/workspace', expectedFile));
    });

    it('handles absolute target paths without prepending workspace', () => {
      const absolutePath = '/etc/wallet-mcp/.env.production';
      const options = parseSetupCliArgs(['--env', absolutePath], '/workspace');
      expect(options.envFile).toBe(absolutePath);
      expect(options.targetPath).toBe(absolutePath);
    });

    it('gives explicit --env flag precedence over --dev', () => {
      const options = parseSetupCliArgs(['--dev', '--env', '.env.custom'], '/workspace');
      expect(options.isDev).toBe(true);
      expect(options.envFile).toBe('.env.custom');
      expect(options.targetPath).toBe(path.join('/workspace', '.env.custom'));
    });

    it.each([
      ['--help'],
      ['-help'],
      ['-h'],
      ['help'],
    ])('detects help flag %s', (flag) => {
      const options = parseSetupCliArgs([flag], '/workspace');
      expect(options.showHelp).toBe(true);
    });
  });

  describe('parseDoctorCliArgs', () => {
    it('returns default options when no arguments are provided', () => {
      const options = parseDoctorCliArgs([], '/workspace');
      expect(options.envFile).toBe('.env');
      expect(options.targetPath).toBe(path.join('/workspace', '.env'));
      expect(options.isDev).toBe(false);
      expect(options.showHelp).toBe(false);
    });

    it.each([
      ['--dev'],
      ['-dev'],
      ['dev'],
      ['-d'],
    ])('detects dev flag %s and targets .env.dev', (flag) => {
      const options = parseDoctorCliArgs([flag], '/workspace');
      expect(options.isDev).toBe(true);
      expect(options.envFile).toBe('.env.dev');
      expect(options.targetPath).toBe(path.join('/workspace', '.env.dev'));
    });

    it.each([
      [['--env', '.env.local'], '.env.local'],
      [['--env=.env.prod'], '.env.prod'],
    ])('parses custom env file arguments %j as %s', (args, expectedFile) => {
      const options = parseDoctorCliArgs(args, '/workspace');
      expect(options.envFile).toBe(expectedFile);
      expect(options.targetPath).toBe(path.join('/workspace', expectedFile));
    });

    it.each([
      ['--help'],
      ['-help'],
      ['-h'],
      ['help'],
    ])('detects help flag %s', (flag) => {
      const options = parseDoctorCliArgs([flag], '/workspace');
      expect(options.showHelp).toBe(true);
    });
  });

  describe('help formatters', () => {
    it('formats setup help text with required flags and examples', () => {
      const help = formatSetupHelp();
      expect(help).toContain('Usage: npm run setup');
      expect(help).toContain('--dev');
      expect(help).toContain('--dry-run');
      expect(help).toContain('--advanced');
      expect(help).toContain('--debug');
      expect(help).toContain('--env');
    });

    it('formats doctor help text with required flags and examples', () => {
      const help = formatDoctorHelp();
      expect(help).toContain('Usage: npm run doctor');
      expect(help).toContain('--dev');
      expect(help).toContain('--env');
      expect(help).toContain('doctor:dev');
    });
  });
});
