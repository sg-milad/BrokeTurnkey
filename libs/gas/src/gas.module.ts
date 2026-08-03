import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GasService } from './gas.service';
import { ChainService } from './chain.service';

@Module({
  imports: [ConfigModule],
  providers: [ChainService, GasService],
  exports: [ChainService, GasService],
})
export class GasModule {}
