import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GasService } from './gas.service';

@Module({
  imports: [ConfigModule],
  providers: [GasService],
  exports: [GasService],
})
export class GasModule {}
