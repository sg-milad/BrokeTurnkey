import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, MaxLength } from 'class-validator';

export class SignMessageDto {
  @ApiProperty({ example: '550e8400-e29b-41d4-a716-446655440000' })
  @IsString()
  @IsUUID()
  orgId!: string;

  @ApiProperty({
    example: 'Hello, World!',
    description: 'UTF-8 string or 0x-prefixed hex bytes to sign',
  })
  @IsString()
  @MaxLength(4096)
  message!: string;
}
