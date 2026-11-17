export interface ProbeTargetConfig {
  label: string;
  url: string;
  checkHealthJson?: boolean;
}

export interface TargetCheckResult {
  label: string;
  ok: boolean;
  text: string;
}

export interface ProbeRunResult {
  summary: string;
  allOk: boolean;
  pushed: boolean;
  status?: number;
}

export const TARGETS: ProbeTargetConfig[];
export function checkTarget(target: ProbeTargetConfig): Promise<TargetCheckResult>;
export function runProbeAndPush(
  env: Record<string, string | undefined>,
  logger?: { log?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void },
): Promise<ProbeRunResult>;

