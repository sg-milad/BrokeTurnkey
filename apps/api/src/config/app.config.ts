import { registerAs } from '@nestjs/config';

export const appConfig = registerAs('app', () => {
  const nodeEnv = process.env.NODE_ENV ?? 'development';

  return {
    port: parseInt(process.env.PORT ?? '3000', 10),
    nodeEnv,

    database: {
      host: process.env.DB_HOST ?? 'localhost',
      port: parseInt(process.env.DB_PORT ?? '5432', 10),
      name: process.env.DB_NAME ?? 'walletmvp',
      user: process.env.DB_USER ?? 'postgres',
      // No hardcoded fallback in production — a missing password must fail
      // loudly instead of silently connecting with a well-known default.
      password:
        process.env.DB_PASSWORD ?? (nodeEnv === 'production' ? '' : 'postgres'),
    },
    rpcUrl: process.env.RPC_URL,
  };
});
