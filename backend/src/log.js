import pino from 'pino';
import { config } from './config.js';

const pretty = process.env.NODE_ENV !== 'production' && process.stdout.isTTY;

export const log = pino({
  level: config.logLevel,
  redact: ['*.sessionid', '*.apiKey', '*.apiToken', 'req.headers.authorization', 'req.headers.cookie', 'req.headers["x-api-token"]'],
  ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
});
