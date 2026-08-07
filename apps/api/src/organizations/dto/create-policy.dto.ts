import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreatePolicyDto {
  @ApiProperty({
    example: 'No transfer to blacklisted addresses',
    description: 'Human-readable name for the policy',
    maxLength: 100,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({
    example: 'Blocks any transfer to the exchange drainer address',
    description: 'Optional description of the policy',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    example: 'address_blocklist',
    description:
      'Type of rule to enforce. Supported types: address_allowlist, address_blocklist, spend_limit, time_lock.',
    enum: [
      'address_allowlist',
      'address_blocklist',
      'spend_limit',
      'time_lock',
    ],
    maxLength: 50,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  @IsIn(['address_allowlist', 'address_blocklist', 'spend_limit', 'time_lock'])
  ruleType!: string;

  @ApiProperty({
    example: {
      addresses: ['0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'],
    },
    description:
      'Rule configuration. Shapes per ruleType:\n' +
      '- address_allowlist / address_blocklist: { "addresses": string[] }\n' +
      '- spend_limit: { "max_amount_wei": string }\n' +
      '- time_lock: { "start_time": ISO string, "end_time": ISO string }',
    type: Object,
  })
  @IsObject()
  ruleConfig!: Record<string, unknown>;

  @ApiPropertyOptional({
    example: 'all',
    description: 'What the policy applies to. Defaults to "all" when omitted.',
    maxLength: 20,
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  appliesTo?: string;

  @ApiPropertyOptional({
    example: '123e4567-e89b-12d3-a456-426614174000',
    description:
      'UUID of the specific entity the policy targets (e.g. a wallet ID) when appliesTo is not "all".',
  })
  @IsOptional()
  @IsUUID()
  targetId?: string;

  @ApiPropertyOptional({
    example: 0,
    description:
      'Evaluation priority. Lower numbers are evaluated first. Defaults to 0.',
    minimum: -1000000000,
    maximum: 1000000000,
  })
  @IsOptional()
  @IsInt()
  @Min(-1000000000)
  @Max(1000000000)
  priority?: number;
}
