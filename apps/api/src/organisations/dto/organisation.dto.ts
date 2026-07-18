import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class OrganisationDto {
    @ApiProperty({ example: 'My Organisation' })
    @IsString()
    @MinLength(1)
    name!: string;

    @ApiProperty({ example: 'y-organisation' })
    @IsString()
    @MinLength(1)
    slug!: string;

    @ApiProperty({ example: 'active', enum: ['active', 'inactive'] })
    @IsString()
    status!: 'active' | 'inactive';

    @ApiProperty({ example: 'starter', enum: ['starter', 'pro', 'enterprise'] })
    @IsString()
    plan!: 'starter' | 'pro' | 'enterprise';

    @ApiProperty({ example: '2023-01-01T00:00:00Z' })
    created_at!: string;

    @ApiProperty({ example: '2023-01-01T00:00:00Z' })
    updated_at!: string;

}