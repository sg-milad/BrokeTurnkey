import { ApiProperty } from '@nestjs/swagger';
import {
  IsEthereumAddress,
  IsInt,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

// uint256 max is 78 decimal digits — anything longer can never be a valid
// EVM amount and would only burn CPU in BigInt parsing downstream.
const VALUE_MAX_DIGITS = 78;
// Cap calldata at 32 KiB of bytes (64 KiB of hex chars + "0x" prefix).
const DATA_MAX_BYTES = 32 * 1024;
const DATA_MAX_HEX_LENGTH = 2 + DATA_MAX_BYTES * 2;

class TxFieldsDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  @Max(99999999)
  chainId!: number;

  @ApiProperty({ example: '0x...' })
  @IsEthereumAddress()
  to!: string;

  @ApiProperty({ example: '1000000000000000000' })
  @Matches(/^(0|[1-9]\d*)$/, {
    message: 'value must be a non-negative decimal wei string',
  })
  @MaxLength(VALUE_MAX_DIGITS, {
    message: `value must be at most ${VALUE_MAX_DIGITS} digits (uint256 max)`,
  })
  value!: string;

  @ApiProperty({ example: '0x' })
  @Matches(/^0x(?:[0-9a-fA-F]{2})*$/, {
    message: 'data must be 0x-prefixed, even-length hexadecimal bytes',
  })
  @MaxLength(DATA_MAX_HEX_LENGTH, {
    message: `data must be at most ${DATA_MAX_BYTES} bytes of calldata`,
  })
  data!: string;
}

export class SignTransactionDto {
  @ApiProperty({ type: TxFieldsDto })
  @ValidateNested()
  @Type(() => TxFieldsDto)
  txFields!: TxFieldsDto;
}
