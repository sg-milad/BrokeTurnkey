import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsArray,
    IsOptional,
    IsString,
    MaxLength,
    MinLength,
} from 'class-validator';

export class CreateApiKeyDto {
    @ApiProperty({
        example: 'Production signer',
        description: 'Human-readable name for the API key',
        maxLength: 100,
    })
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    name!: string;

    @ApiProperty({
        example: '-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----',
        description: 'Raw public key to bind to this API key',
    })
    @IsString()
    @MinLength(1)
    publicKey!: string;

    @ApiPropertyOptional({
        example: ['key:write', 'key:read'],
        description:
            'Scopes granted to this API key. Defaults to ["*"] (unrestricted) when omitted.',
        type: [String],
    })
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    scopes?: string[];
}