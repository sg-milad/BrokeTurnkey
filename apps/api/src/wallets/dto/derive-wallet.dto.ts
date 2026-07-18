import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, MinLength } from 'class-validator';

export class DeriveWalletDto {
    @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
    @IsString()
    @IsUUID()
    orgId!: string;

    @ApiProperty({ example: '660e8400-e29b-41d4-a716-446655440001' })
    @IsString()
    @IsUUID()
    userId!: string;

    @ApiProperty({ example: 'Treasury wallet' })
    @IsString()
    @MinLength(1)
    label!: string;
}