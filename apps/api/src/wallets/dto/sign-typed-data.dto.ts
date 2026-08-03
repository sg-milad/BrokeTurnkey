import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, IsObject, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class DomainDto {
  @ApiProperty({ required: false })
  name?: string;

  @ApiProperty({ required: false })
  version?: string;

  @ApiProperty({ required: false })
  chainId?: number;

  @ApiProperty({ required: false })
  verifyingContract?: string;

  @ApiProperty({ required: false })
  salt?: string;
}

export class SignTypedDataDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  @IsString()
  @IsUUID()
  orgId!: string;

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
