import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNumber, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class TxFieldsDto {
  @ApiProperty({ example: 1 })
  @IsNumber()
  chainId!: number;

  @ApiProperty({ example: '0x...' })
  @IsString()
  to!: string;

  @ApiProperty({ example: '1000000000000000000' })
  @IsString()
  value!: string;

  @ApiProperty({ example: 21000 })
  @IsNumber()
  gasLimit!: number;

  @ApiProperty({ example: '30000000000' })
  @IsString()
  maxFeePerGas!: string;

  @ApiProperty({ example: '1000000000' })
  @IsString()
  maxPriorityFeePerGas!: string;

  @ApiProperty({ example: '0x' })
  @IsString()
  data!: string;
}

export class SignTransactionDto {
  @ApiProperty({ type: TxFieldsDto })
  @ValidateNested()
  @Type(() => TxFieldsDto)
  txFields!: TxFieldsDto;
}
