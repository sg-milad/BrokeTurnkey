import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsUUID,
  MinLength,
  IsOptional,
  IsInt,
  Min,
  Max,
} from 'class-validator';

export class DeriveWalletDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  @IsString()
  @IsUUID()
  orgId!: string;

  @ApiPropertyOptional({ example: '660e8400-e29b-41d4-a716-446655440001' })
  @IsOptional()
  @IsString()
  @IsUUID()
  userId?: string;

  @ApiProperty({ example: 'Treasury wallet' })
  @IsString()
  @MinLength(1)
  label!: string;

  @ApiPropertyOptional({
    example: 84532,
    description: 'Chain ID — defaults to 1 (Ethereum Mainnet)',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(999999)
  chainId?: number;
}
