import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateUserDto {
  @ApiProperty({ example: 'customer-123' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  externalId!: string;

  @ApiPropertyOptional({ example: 'customer@example.com' })
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @ApiPropertyOptional({ example: 'member' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  role?: string;
}
