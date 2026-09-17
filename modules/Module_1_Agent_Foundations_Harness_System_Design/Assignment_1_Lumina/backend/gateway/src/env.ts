import { config } from 'dotenv';
import { resolve } from 'node:path';

// Both services read the single .env at the assignment root.
config({ path: resolve(process.cwd(), '../../.env') });
config({ path: resolve(process.cwd(), '.env') });

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

export const env = {
  port: num(process.env.PORT_GATEWAY ?? process.env.PORT, 8787),
  agentUrl: process.env.AGENT_URL ?? 'http://localhost:8000',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  rateLimitPerMinute: num(process.env.RATE_LIMIT_PER_MINUTE, 30),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  /** Serve the built UI from the gateway in production so one host serves / and /evals. */
  webDist: resolve(process.cwd(), '../../web/dist'),
  /**
   * Where `eval/build-report.mjs` writes its output, served verbatim at
   * `GET /evals/report.json`. The gateway never generates or edits it — it is the one file
   * on this service whose contents no code of ours is allowed to have an opinion about.
   */
  reportPath: resolve(process.cwd(), '../../reports/report.json')
} as const;
