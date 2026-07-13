import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createDrizzleClient, DrizzleClient } from './db';

export const DRIZZLE_CLIENT = Symbol('DRIZZLE_CLIENT');

@Global()
@Module({
  providers: [
    {
      provide: DRIZZLE_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): DrizzleClient => {
        const url = config.getOrThrow<string>('DATABASE_URL');
        return createDrizzleClient(url);
      },
    },
  ],
  exports: [DRIZZLE_CLIENT],
})
export class DatabaseModule {}
