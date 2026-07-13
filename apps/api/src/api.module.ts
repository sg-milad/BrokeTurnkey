import { Module } from '@nestjs/common';
import { ApiController } from './api.controller';
import { ApiService } from './api.service';
import { DatabaseModule } from '@app/db';
import { ConfigModule } from '@nestjs/config';
import { appConfig } from './config/app.config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      envFilePath: '.env',
    }), DatabaseModule],
  controllers: [ApiController],
  providers: [ApiService],
})
export class ApiModule { }
