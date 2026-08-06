import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsObject,
  ValidateNested,
  IsOptional,
  IsNumber,
} from 'class-validator';
import { Type } from 'class-transformer';

class DomainDto {
  // All fields must carry a validator decorator — the global ValidationPipe
  // runs with whitelist:true, which strips undecorated properties.
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  version?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  chainId?: number;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  verifyingContract?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  salt?: string;
}

export class SignTypedDataDto {
  @ApiProperty({ type: DomainDto })
  @ValidateNested()
  @Type(() => DomainDto)
  domain!: Record<string, unknown>;

  @ApiProperty({ description: 'EIP-712 types object (excluding EIP712Domain)' })
  @IsObject()
  types!: Record<string, unknown>;

  @ApiProperty({ example: 'Mail' })
  @IsString()
  primaryType!: string;

  @ApiProperty({ description: 'The message to sign according to the types' })
  @IsObject()
  message!: Record<string, unknown>;
}
