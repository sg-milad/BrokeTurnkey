import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema:  './libs/db/src/schema/index.ts',
  out:     './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
