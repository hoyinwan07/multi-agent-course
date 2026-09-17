/**
 * pino, and the request id that makes one request greppable end to end (§10.3).
 *
 * The gateway generates or reuses `X-Request-Id` and forwards it. Binding it to a child
 * logger here is what lets `grep <requestId>` across both services tell the whole story
 * instead of half of it.
 */
import pino from 'pino';
import { env } from '../env.js';

export const baseLog = pino({ level: env.logLevel });

export type Log = pino.Logger;

export const logFor = (requestId: string, userId?: string): Log =>
  baseLog.child({ requestId, ...(userId ? { userId } : {}) });
