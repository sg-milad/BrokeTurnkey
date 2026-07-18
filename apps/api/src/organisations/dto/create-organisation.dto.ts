import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class CreateOrganisationDto {
    @ApiProperty({ example: 'My Organisation' })
    @IsString()
    @MinLength(1)
    name!: string;

    @ApiProperty({ example: 'y-organisation' })
    @IsString()
    @MinLength(1)
    slug!: string;
}