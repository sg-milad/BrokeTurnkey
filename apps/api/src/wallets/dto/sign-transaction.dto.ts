import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsNumber,
  IsUUID,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class TxFieldsDto {
  @ApiProperty({ example: 1 })
  @IsNumber()
  chainId!: number;

  // The server reserves nonces itself (atomic per-wallet counter) — clients
  // must not supply one. Kept for schema compatibility with the docs.
  @ApiProperty({ example: 42, required: false })
  @IsOptional()
  @IsNumber()
  nonce?: number;

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
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  @IsString()
  @IsUUID()
  orgId!: string;

  @ApiProperty({ type: TxFieldsDto })
  @ValidateNested()
  @Type(() => TxFieldsDto)
  txFields!: TxFieldsDto;
}
