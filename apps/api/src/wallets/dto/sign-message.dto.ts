import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class SignMessageDto {
  @ApiProperty({
    example: 'Hello, World!',
    description: 'UTF-8 string or 0x-prefixed hex bytes to sign',
  })
  @IsString()
  @MaxLength(4096)
  message!: string;
}
