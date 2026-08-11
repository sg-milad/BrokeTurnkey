import { ApiProperty } from '@nestjs/swagger';
import {
  IsEthereumAddress,
  IsInt,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

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
  value!: string;

  @ApiProperty({ example: '0x' })
  @Matches(/^0x(?:[0-9a-fA-F]{2})*$/, {
    message: 'data must be 0x-prefixed, even-length hexadecimal bytes',
  })
  data!: string;
}

export class SignTransactionDto {
  @ApiProperty({ type: TxFieldsDto })
  @ValidateNested()
  @Type(() => TxFieldsDto)
  txFields!: TxFieldsDto;
}
