export type RelativeTimePeriodName = 'subuh' | 'pagi' | 'siang' | 'sore' | 'malam';

export interface RepresentativeTimeConfiguration {
  readonly hour: number;
  readonly minute: number;
}

export const PERIOD_REPRESENTATIVE_HOURS: Readonly<Record<RelativeTimePeriodName, RepresentativeTimeConfiguration>> = {
  subuh: { hour: 5, minute: 0 },
  pagi: { hour: 8, minute: 0 },
  siang: { hour: 12, minute: 30 },
  sore: { hour: 16, minute: 30 },
  malam: { hour: 20, minute: 0 },
};

export interface ParsedRelativeTimeResult {
  readonly resolvedUtcIso: string;
  readonly matchedExpression: string;
  readonly hasExplicitTime: boolean;
  readonly targetDateString: string;
  readonly targetHour: number;
  readonly targetMinute: number;
  readonly periodName?: RelativeTimePeriodName;
  readonly dayReference: 'today' | 'yesterday';
}
