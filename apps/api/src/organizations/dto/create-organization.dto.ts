import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class CreateOrganizationDto {
    @ApiProperty({ example: 'My organization' })
    @IsString()
    @MinLength(1)
    name!: string;

    @ApiProperty({ example: 'y-organization' })
    @IsString()
    @MinLength(1)
    slug!: string;
}